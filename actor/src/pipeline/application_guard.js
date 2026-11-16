/**
 * application_guard.js — Strict Duplicate Application Prevention Guard
 * 
 * Ensures that the system NEVER applies to the same job listing twice.
 * 
 * Guards against:
 * 1. Re-applying to the same job_id or external_id.
 * 2. Re-applying to identical or normalized URLs (stripping tracking query params, fragments, trailing slashes).
 * 3. Re-applying to the same company + role canonical fingerprint.
 * 4. Concurrent race conditions (in-flight mutex locks for active application sessions).
 * 5. In-browser detection (ATS portal banners indicating candidate has already applied).
 */

const { getQuery, allQuery, runQuery } = require('../db');

// In-flight active locks to prevent concurrent race conditions
const activeApplyingJobs = new Set();
const activeApplyingUrls = new Set();
const activeApplyingKeys = new Set();

/**
 * Normalizes a job URL by removing tracking query parameters, hashes, and trailing slashes.
 */
function normalizeJobUrl(rawUrl = '') {
    if (!rawUrl) return '';
    try {
        const u = new URL(String(rawUrl).trim());
        const stripParams = [
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            'ref', 'referer', 'source', 'gh_src', 'lever-source',
            'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid',
            'trkid', 'trk', 'trackingid', 'sessionid', 'currentJobId',
            '_hsenc', '_hsmi'
        ];
        // If pathname already contains a job ID in the path (/jobs/12345), gh_jid is redundant tracking
        if (/\/(jobs|positions|requisitions)\/[a-zA-Z0-9_-]+/i.test(u.pathname)) {
            stripParams.push('gh_jid');
        }

        stripParams.forEach(p => u.searchParams.delete(p));

        // Deduplicate query params (e.g. repeated gh_jid=123)
        const seen = new Set();
        const newParams = new URLSearchParams();
        for (const [k, v] of u.searchParams.entries()) {
            const pair = `${k}=${v}`;
            if (!seen.has(pair)) {
                seen.add(pair);
                newParams.append(k, v);
            }
        }
        const searchStr = newParams.toString();
        u.search = searchStr ? `?${searchStr}` : '';
        u.hash = '';
        const pathname = u.pathname.replace(/\/+$/, '');
        return `${u.protocol}//${u.host.toLowerCase()}${pathname}${u.search ? u.search : ''}`.toLowerCase();
    } catch (e) {
        return String(rawUrl).trim().toLowerCase().replace(/\/+$/, '');
    }
}

/**
 * Normalizes company name by stripping legal suffixes and punctuation.
 */
function normalizeCompanyName(company = '') {
    return String(company || '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\b(inc|incorporated|ltd|limited|llc|technologies|technology|solutions|corp|corporation|pvt|private|group|holdings|labs|lab|co|company|pbc|gmbh)\b/gi, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

/**
 * Normalizes role title by removing parentheticals, location indicators, and punctuation.
 */
function normalizeRoleTitle(role = '') {
    return String(role || '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Computes canonical company:::role fingerprint key.
 */
function computeJobKey(company, role) {
    const comp = normalizeCompanyName(company);
    const title = normalizeRoleTitle(role);
    if (!comp || !title) return '';
    return `${comp}:::${title}`;
}

/**
 * Acquires in-flight execution lock. Returns true if acquired, false if already in progress.
 */
function acquireApplyLock(jobId, url, company, role) {
    const normUrl = normalizeJobUrl(url);
    const key = computeJobKey(company, role);

    if (jobId && activeApplyingJobs.has(String(jobId))) return false;
    if (normUrl && activeApplyingUrls.has(normUrl)) return false;
    if (key && activeApplyingKeys.has(key)) return false;

    if (jobId) activeApplyingJobs.add(String(jobId));
    if (normUrl) activeApplyingUrls.add(normUrl);
    if (key) activeApplyingKeys.add(key);

    return true;
}

/**
 * Releases in-flight execution lock.
 */
function releaseApplyLock(jobId, url, company, role) {
    const normUrl = normalizeJobUrl(url);
    const key = computeJobKey(company, role);

    if (jobId) activeApplyingJobs.delete(String(jobId));
    if (normUrl) activeApplyingUrls.delete(normUrl);
    if (key) activeApplyingKeys.delete(key);
}

/**
 * Checks whether a job has already been applied to across:
 * 1. Exact job_id / external_id in jobs table
 * 2. Exact job_id in applications table
 * 3. Normalized URL match against any applied job in DB
 * 4. Company + role canonical match against any applied job in DB
 * 5. Canonical ID match against any applied job in DB
 * 6. In-flight active apply sessions
 * 
 * @param {object|string} jobOrId
 * @returns {Promise<{ alreadyApplied: boolean, inProgress?: boolean, reason?: string, appliedJob?: object, matchType?: string }>}
 */
async function checkAlreadyApplied(jobOrId) {
    let jobId = null;
    let jobData = null;

    if (typeof jobOrId === 'string') {
        jobId = jobOrId;
        jobData = await getQuery('SELECT * FROM jobs WHERE job_id = ? OR external_id = ?', [jobId, jobId]);
        if (!jobData) {
            const app = await getQuery('SELECT * FROM applications WHERE id = ? OR job_id = ?', [jobId, jobId]);
            if (app) {
                jobData = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [app.job_id]) || app;
            }
        }
    } else if (jobOrId && typeof jobOrId === 'object') {
        jobData = jobOrId;
        jobId = jobData.job_id || jobData.id;
    }

    const company = jobData ? (jobData.company || '') : '';
    const role = jobData ? (jobData.role || jobData.title || '') : '';
    const targetUrl = jobData ? (jobData.application_url || jobData.url || jobData.source_url || '') : '';
    const normTargetUrl = normalizeJobUrl(targetUrl);
    const targetKey = computeJobKey(company, role);
    const canonicalId = jobData ? (jobData.canonical_id || null) : null;

    // 1. In-Flight Check
    if (jobId && activeApplyingJobs.has(String(jobId))) {
        return {
            alreadyApplied: true,
            inProgress: true,
            reason: `Application for job ${jobId} is currently in progress. Concurrent submission blocked.`,
            matchType: 'IN_PROGRESS'
        };
    }
    if (normTargetUrl && activeApplyingUrls.has(normTargetUrl)) {
        return {
            alreadyApplied: true,
            inProgress: true,
            reason: `Application for URL ${normTargetUrl} is currently in progress. Concurrent submission blocked.`,
            matchType: 'IN_PROGRESS'
        };
    }
    if (targetKey && activeApplyingKeys.has(targetKey)) {
        return {
            alreadyApplied: true,
            inProgress: true,
            reason: `Application for ${company} - ${role} is currently in progress. Concurrent submission blocked.`,
            matchType: 'IN_PROGRESS'
        };
    }

    // 2. Direct ID check on `jobs` table
    if (jobId) {
        const directJob = await getQuery(`
            SELECT job_id, company, role, url, application_url, status, applied_at, application_status, screenshot_path
            FROM jobs
            WHERE (job_id = ? OR external_id = ?)
              AND (
                  status = 'APPLIED'
                  OR (applied_at IS NOT NULL AND status NOT IN ('MANUAL_REQUIRED', 'READY_TO_APPLY', 'CAPTCHA_REQUIRED', 'REJECTED', 'DISCOVERED', 'EVALUATED', 'FLAGGED_FALSE_POSITIVE'))
              )
        `, [jobId, jobId]);

        if (directJob) {
            return {
                alreadyApplied: true,
                reason: `Job listing (${directJob.company} - ${directJob.role}) is already marked as APPLIED (applied at: ${directJob.applied_at || 'Recorded'}).`,
                appliedJob: directJob,
                matchType: 'DIRECT_ID'
            };
        }

        // Direct check on `applications` table
        const directApp = await getQuery(`
            SELECT id, job_id, company, role, application_url, status, applied_at, screenshot_path
            FROM applications
            WHERE (job_id = ? OR id = ?)
              AND (status IN ('APPLIED', 'SUBMITTED', 'CONFIRMED') OR applied_at IS NOT NULL)
              AND status != 'FLAGGED_FALSE_POSITIVE'
        `, [jobId, jobId]);

        if (directApp) {
            return {
                alreadyApplied: true,
                reason: `Application record exists with status ${directApp.status} (applied at: ${directApp.applied_at || 'Recorded'}).`,
                appliedJob: directApp,
                matchType: 'APPLICATION_RECORD'
            };
        }
    }

    // 3. Fetch all applied jobs once to test URL and Canonical match
    const appliedJobs = await allQuery(`
        SELECT job_id, company, role, url, application_url, source_url, status, applied_at, canonical_id, screenshot_path
        FROM jobs
        WHERE status = 'APPLIED'
           OR (applied_at IS NOT NULL AND status NOT IN ('MANUAL_REQUIRED', 'READY_TO_APPLY', 'CAPTCHA_REQUIRED', 'REJECTED', 'DISCOVERED', 'EVALUATED', 'FLAGGED_FALSE_POSITIVE'))
    `);

    // 4. Normalized URL Check
    if (normTargetUrl) {
        for (const aj of appliedJobs) {
            const ajUrl = normalizeJobUrl(aj.application_url || aj.url || aj.source_url);
            if (ajUrl && ajUrl === normTargetUrl) {
                return {
                    alreadyApplied: true,
                    reason: `Candidate already applied to this exact listing URL (${aj.company} - ${aj.role}) on ${aj.applied_at || 'earlier date'}.`,
                    appliedJob: aj,
                    matchType: 'NORMALIZED_URL'
                };
            }
        }

        // Also check applications table URLs
        const appliedApps = await allQuery(`
            SELECT id, job_id, company, role, application_url, status, applied_at
            FROM applications
            WHERE (status IN ('APPLIED', 'SUBMITTED', 'CONFIRMED') OR applied_at IS NOT NULL)
              AND status != 'FLAGGED_FALSE_POSITIVE'
        `);
        for (const app of appliedApps) {
            const appUrl = normalizeJobUrl(app.application_url);
            if (appUrl && appUrl === normTargetUrl) {
                return {
                    alreadyApplied: true,
                    reason: `Candidate already applied to this listing URL via application record (${app.company} - ${app.role}) on ${app.applied_at || 'earlier date'}.`,
                    appliedJob: app,
                    matchType: 'NORMALIZED_URL'
                };
            }
        }
    }

    // 5. Canonical Key (Company + Role) Match
    if (targetKey && targetKey.length > 5) {
        for (const aj of appliedJobs) {
            const ajKey = computeJobKey(aj.company, aj.role);
            if (ajKey && ajKey === targetKey) {
                return {
                    alreadyApplied: true,
                    reason: `Candidate has already submitted an application to ${aj.company} for '${aj.role}' (Job ID: ${aj.job_id}, Applied at: ${aj.applied_at || 'Recorded'}).`,
                    appliedJob: aj,
                    matchType: 'CANONICAL_ROLE'
                };
            }
        }
    }

    // 6. Canonical ID Match
    if (canonicalId) {
        for (const aj of appliedJobs) {
            if (aj.canonical_id && aj.canonical_id === canonicalId) {
                return {
                    alreadyApplied: true,
                    reason: `Canonical job variant (${aj.company} - ${aj.role}) was already applied to on ${aj.applied_at || 'Recorded'}.`,
                    appliedJob: aj,
                    matchType: 'CANONICAL_ID'
                };
            }
        }
    }

    return {
        alreadyApplied: false
    };
}

/**
 * Checks an in-session Playwright page to see if the ATS portal explicitly declares
 * that the candidate has already applied to this opening.
 * 
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{ alreadyAppliedOnPage: boolean, detectedText?: string }>}
 */
async function checkPageAlreadyApplied(page) {
    if (!page) return { alreadyAppliedOnPage: false };

    try {
        const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();

        const alreadyAppliedPhrases = [
            'you have already applied',
            'you already applied',
            'already applied to this job',
            'already applied for this job',
            'already applied for this position',
            'you submitted an application',
            'you\'ve already submitted an application',
            'application already submitted',
            'application already received',
            'our records indicate that you have already applied',
            'application previously submitted',
            'you applied on'
        ];

        for (const phrase of alreadyAppliedPhrases) {
            if (bodyText.includes(phrase)) {
                return {
                    alreadyAppliedOnPage: true,
                    detectedText: phrase
                };
            }
        }

        // Check explicit badge / button selectors
        const appliedBadgeCount = await page.locator([
            'button:has-text("Applied")',
            '.jobs-apply-button--applied',
            '[data-automation-id="already-applied"]',
            '.already-applied',
            'span.artdeco-inline-feedback:has-text("Applied")',
            'div:has-text("You applied on")'
        ].join(', ')).count().catch(() => 0);

        if (appliedBadgeCount > 0) {
            const firstBadge = page.locator([
                'button:has-text("Applied")',
                '.jobs-apply-button--applied',
                '[data-automation-id="already-applied"]',
                '.already-applied',
                'span.artdeco-inline-feedback:has-text("Applied")',
                'div:has-text("You applied on")'
            ].join(', ')).first();

            const isVisible = await firstBadge.isVisible().catch(() => false);
            if (isVisible) {
                const text = await firstBadge.innerText().catch(() => 'Applied badge');
                return {
                    alreadyAppliedOnPage: true,
                    detectedText: text.trim()
                };
            }
        }
    } catch (err) {
        // Non-fatal if page layout inspection fails
    }

    return { alreadyAppliedOnPage: false };
}

/**
 * Marks a job and its application record as APPLIED in SQLite.
 */
async function recordJobApplied({ jobId, url, company, role, screenshotPath = '', notes = '' }) {
    const nowIso = new Date().toISOString();
    const cleanUrl = url || '';

    await runQuery(`
        UPDATE jobs
        SET status = 'APPLIED',
            applied_at = COALESCE(applied_at, ?),
            application_status = ?,
            screenshot_path = COALESCE(NULLIF(?, ''), screenshot_path),
            is_false_positive = 0,
            flagged_at = NULL
        WHERE job_id = ? OR url = ?
    `, [nowIso, notes || 'Application confirmed & submitted', screenshotPath, jobId, cleanUrl]).catch(() => {});

    // Sync applications table
    const existingApp = await getQuery('SELECT id FROM applications WHERE job_id = ? OR id = ?', [jobId, jobId]);
    if (existingApp) {
        await runQuery(`
            UPDATE applications
            SET status = 'APPLIED',
                applied_at = COALESCE(applied_at, ?),
                screenshot_path = COALESCE(NULLIF(?, ''), screenshot_path),
                is_false_positive = 0,
                flagged_at = NULL,
                error_message = NULL,
                updated_at = ?
            WHERE id = ?
        `, [nowIso, screenshotPath, nowIso, existingApp.id]).catch(() => {});
    } else if (company && role) {
        const appId = `app_${jobId}`;
        await runQuery(`
            INSERT INTO applications (
                id, job_id, company, role, application_url, status,
                match_score, source, created_at, updated_at, applied_at, screenshot_path
            ) VALUES (?, ?, ?, ?, ?, 'APPLIED', 85, 'guard', ?, ?, ?, ?)
        `, [appId, jobId, company, role, cleanUrl, nowIso, nowIso, nowIso, screenshotPath]).catch(() => {});
    }
}

module.exports = {
    normalizeJobUrl,
    normalizeCompanyName,
    normalizeRoleTitle,
    computeJobKey,
    acquireApplyLock,
    releaseApplyLock,
    checkAlreadyApplied,
    checkPageAlreadyApplied,
    recordJobApplied
};
