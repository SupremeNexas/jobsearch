const crypto = require('crypto');
const path = require('path');
const { runQuery, allQuery } = require('./db');
const { scoreJob } = require('./ai');
const { crawlJobs } = require('./crawler');
const { searchJobs: tavilySearch } = require('./scanners/tavilyScanner');
const { crawlAndExtractJobs: firecrawlCrawl } = require('./scanners/firecrawlScanner');
const { parseSheet1Jobs, parseSheet2Jobs, parseDocJobs } = require('./parse_docs');
const { findExistingCanonical, addLocationToCanonical, ensureJobLocationsTable, reconcileExistingDuplicates } = require('./services/canonicalize');
const { checkAlreadyApplied } = require('./pipeline/application_guard');

function generateJobId(jobUrl) {
    return crypto.createHash('sha256').update(jobUrl).digest('hex').substring(0, 16);
}

/**
 * Runs a full discovery and scoring cycle.
 * Gets target keywords & companies, scrapes updates, screens, scores, and updates SQLite.
 * Uses canonical deduplication to group multi-location variants of the same job.
 */
async function runDiscoveryCycle() {
    console.log('[Discovery] Starting job discovery run...');

    // 1. Ensure canonicalization tables exist
    await ensureJobLocationsTable();

    // 2. Fetch current search settings
    const rawSettings = await allQuery('SELECT * FROM settings');
    const settings = {};
    rawSettings.forEach(s => settings[s.key] = s.value);

    const keywords = (settings.PREFERRED_ROLES || 'Software Engineer')
        .split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0);

    const locationPreference = settings.PREFERRED_LOCATIONS || 'Remote';

    // Target companies list (sensible defaults, including active tech & winter internship hirers)
    const targetCompanies = [
        'rubrik', 'hackerrank', 'singlestore', 'enterpret', 'mongodb',
        'composio', 'meraki-labs', 'realmalliance', 'baseten', 'cohere',
        'juspay', 'hevodata', 'groww', 'swiggy', 'cred', 'meesho',
        'postman', 'browserstack', 'nutanix', 'harness', 'sprinklr',
        'figma', 'stripe', 'openai', 'datadog', 'hashicorp',
        'grafana', 'sentry', 'vercel', 'retool', 'dbt',
        'notion', 'linear', 'supabase', 'neon', 'anthropic',
        'posthog', 'snyk', 'elastic'
    ];

    // 2. Crawl job boards (uses the crawler module)
    const crawledList = await crawlJobs(keywords, locationPreference, targetCompanies);
    console.log(`[Discovery] Scrappers found ${crawledList.length} potential matching jobs.`);

    // 2c. Add jobs from Tavily if enabled
    if (settings.USE_TAVILY === 'true') {
        try {
            const tavilyData = await tavilySearch(keywords, locationPreference);
            console.log(`[Discovery] Tavily found ${tavilyData.length} jobs.`);
            tavilyData.forEach(j => j.source_tool = 'tavily');
            crawledList.push(...tavilyData);
        } catch (tavilyErr) {
            console.error(`[Discovery] Error fetching Tavily jobs:`, tavilyErr.message);
        }
    }

    // 2d. Add jobs from Firecrawl if enabled
    if (settings.USE_FIRECRAWL === 'true') {
        try {
            const discoveredUrls = crawledList
                .filter(j => j.url && j.company)
                .map(j => j.url)
                .slice(0, 5);
            for (const url of discoveredUrls) {
                const firecrawlJobs = await firecrawlCrawl(url, keywords);
                console.log(`[Discovery] Firecrawl found ${firecrawlJobs.length} jobs from ${url}.`);
                firecrawlJobs.forEach(j => j.source_tool = 'firecrawl');
                crawledList.push(...firecrawlJobs);
            }
            if (discoveredUrls.length === 0) {
                console.log('[Discovery] No URLs to feed Firecrawl from current results.');
            }
        } catch (firecrawlErr) {
            console.error(`[Discovery] Error fetching Firecrawl jobs:`, firecrawlErr.message);
        }
    }

    // 2b. Retrieve and parse Google Sheets/Docs lists
    try {
        const path1 = path.join(process.cwd(), 'sheet1.csv');
        const path2 = path.join(process.cwd(), 'sheet2.csv');
        const pathDoc = path.join(process.cwd(), 'doc1.html');

        console.log(`[Discovery] Parsing spreadsheet and doc updates...`);
        const sheet1Jobs = parseSheet1Jobs(path1);
        const sheet2Jobs = parseSheet2Jobs(path2);
        const docJobs = parseDocJobs(pathDoc);

        crawledList.push(...sheet1Jobs);
        crawledList.push(...sheet2Jobs);
        crawledList.push(...docJobs);

        console.log(`[Discovery] Total jobs buffer (Scrapers + Spreadsheets + Docs): ${crawledList.length}`);
    } catch (parseErr) {
        console.error(`[Discovery] Error parsing document files:`, parseErr.message);
    }

    let discoveredCount = 0;
    let rejectedCount = 0;
    let evaluatedCount = 0;
    let locationVariantsMerged = 0;

    // 3. Process each job with canonical deduplication
    for (const rawJob of crawledList) {
        const jobId = generateJobId(rawJob.url);

        try {
            // Check if job already exists in DB (by job_id or url)
            const existing = await allQuery('SELECT job_id FROM jobs WHERE job_id = ? OR url = ?', [jobId, rawJob.url]);
            if (existing && existing.length > 0) {
                // Check if it's a location variant of an existing canonical job
                const canonicalId = await findExistingCanonical(rawJob);
                if (canonicalId) {
                    const added = await addLocationToCanonical(
                        canonicalId,
                        rawJob.location || 'Remote',
                        rawJob.url,
                        rawJob.application_url || rawJob.url,
                        jobId,
                        rawJob.source_job_id || rawJob.requisition_id || null
                    );
                    if (added) {
                        locationVariantsMerged++;
                        console.log(`[Discovery] Merged location variant into canonical job ${canonicalId}: ${rawJob.location}`);
                    }
                }
                continue;
            }

            // Check if this is a location variant of an existing canonical job
            const canonicalId = await findExistingCanonical(rawJob);
            if (canonicalId) {
                const added = await addLocationToCanonical(
                    canonicalId,
                    rawJob.location || 'Remote',
                    rawJob.url,
                    rawJob.application_url || rawJob.url,
                    jobId,
                    rawJob.source_job_id || rawJob.requisition_id || null
                );
                if (added) {
                    locationVariantsMerged++;
                    console.log(`[Discovery] Merged new location variant into canonical job ${canonicalId}: ${rawJob.location}`);
                }
                continue;
            }

            // This is a new canonical job
            discoveredCount++;

            // Duplicate Check: Check if candidate already applied to this listing
            const dupApplied = await checkAlreadyApplied({
                company: rawJob.company,
                role: rawJob.title,
                url: rawJob.url,
                application_url: rawJob.application_url
            });

            // Run AI Score
            console.log(`[Discovery] Scoring new job: ${rawJob.title} at ${rawJob.company}...`);
            const evaluation = await scoreJob(rawJob.title, rawJob.company, rawJob.description || '', settings);

            // Determine status (if already applied, preserve APPLIED status so it's not re-applied)
            let finalStatus = dupApplied.alreadyApplied ? 'APPLIED' : 'EVALUATED';
            let minScore = parseInt(settings.MIN_SCORE_THRESHOLD || '75', 10);

            if (!dupApplied.alreadyApplied) {
                if (evaluation.score < minScore) {
                    finalStatus = 'REJECTED';
                    rejectedCount++;
                } else {
                    evaluatedCount++;
                }
            }

            // Save to jobs table as canonical
            const now = new Date().toISOString();
            const appliedAtVal = dupApplied.alreadyApplied ? ((dupApplied.appliedJob && dupApplied.appliedJob.applied_at) || now) : null;
            await runQuery(`
                INSERT INTO jobs (
                    job_id, company, role, location, source, url, description,
                    score, score_explanation, status, discovered_at,
                    salary, employment_type, experience_level, required_skills, preferred_skills,
                    posted_date, application_url, is_canonical, canonical_id, location_count, applied_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)
            `, [
                jobId,
                rawJob.company,
                rawJob.title,
                rawJob.location || 'Remote',
                rawJob.platform || 'rss',
                rawJob.url,
                rawJob.description || '',
                evaluation.score,
                dupApplied.alreadyApplied ? dupApplied.reason : JSON.stringify({
                    classification: evaluation.classification,
                    explanation: evaluation.explanation,
                    missing_requirements: evaluation.missing_requirements || []
                }),
                finalStatus,
                now,
                rawJob.salary || 'Not specified',
                rawJob.employment_type || 'Full-time',
                rawJob.experience_level || 'Mid-Level',
                rawJob.required_skills || '[]',
                rawJob.preferred_skills || '[]',
                rawJob.posted_date || now,
                rawJob.application_url || rawJob.url,
                jobId,
                appliedAtVal
            ]);

            // Add location record for the canonical job
            await addLocationToCanonical(
                jobId,
                rawJob.location || 'Remote',
                rawJob.url,
                rawJob.application_url || rawJob.url,
                jobId,
                rawJob.source_job_id || rawJob.requisition_id || null
            );

            console.log(`[Discovery] Logged: ${rawJob.title} - Score: ${evaluation.score} -> Status: ${finalStatus}`);

            // Automatically tailor the resume if the job is evaluated/qualified
            if (finalStatus === 'EVALUATED') {
                try {
                    console.log(`[Discovery] Auto-tailoring resume immediately for new job: ${jobId}`);
                    await tailorJobApplication(jobId);
                } catch (tailorErr) {
                    console.error(`[Discovery] Immediate auto-tailoring failed for job ${jobId}: ${tailorErr.message}`);
                }
            }

        } catch (jobErr) {
            console.error(`[Discovery] Error processing job ${rawJob.url}:`, jobErr.message);
        }
    }

    console.log(`[Discovery] Cycle finished. New crawled: ${discoveredCount}. Evaluated & Qualified: ${evaluatedCount}. Auto-Rejected: ${rejectedCount}. Location variants merged: ${locationVariantsMerged}.`);
    return { discoveredCount, evaluatedCount, rejectedCount, locationVariantsMerged };
}

/**
 * Runs reconciliation on existing database to consolidate duplicates
 */
async function runCanonicalReconciliation() {
    console.log('[Reconcile] Starting canonical reconciliation of existing jobs...');
    const result = await reconcileExistingDuplicates();
    console.log(`[Reconcile] Completed: ${result.grouped} groups merged, ${result.locationsAdded} locations added.`);
    return result;
}

module.exports = {
    runDiscoveryCycle,
    runCanonicalReconciliation,
    generateJobId
};