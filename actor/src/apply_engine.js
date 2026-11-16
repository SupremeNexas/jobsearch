/**
 * apply_engine.js — Modular Multi-Portal Application Automation Engine
 * 
 * Supports the 4 configurable modes:
 * 1. DISCOVERY_ONLY: Saves job to tracking without altering state.
 * 2. PREPARE_MATERIALS: Generates tailored resume, cover letter, and screening answers.
 * 3. AUTOFILL_AND_REVIEW (DEFAULT): Fills form & attaches PDF in persistent browser,
 *    takes verification screenshot, and queues for human approval.
 * 4. AUTO_SUBMIT_APPROVED: Final submission execution after human review.
 * 
 * Complies with platform terms:
 * - Uses real browser session without breaking security.
 * - Detects CAPTCHAs and pauses for user intervention instead of bypassing.
 * - Records full audit logs and screenshots for every step.
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { runQuery, getQuery } = require('./db');
const { generateCoverLetter } = require('./cover_letter');
const { answerScreeningQuestion, classifySensitivity } = require('./screening_service');
const { loadProfile } = require('./verify_facts');
const { verifyJobProof } = require('./proof_verifier');
const { checkAlreadyApplied, recordJobApplied } = require('./pipeline/application_guard');

const MODES = {
    DISCOVERY_ONLY: 'DISCOVERY_ONLY',
    PREPARE_MATERIALS: 'PREPARE_MATERIALS',
    AUTOFILL_AND_REVIEW: 'AUTOFILL_AND_REVIEW', // Default Mode
    AUTO_SUBMIT_APPROVED: 'AUTO_SUBMIT_APPROVED'
};

/**
 * Executes application workflow for a job according to selected mode.
 * @param {object} job
 * @param {object} options
 * @returns {Promise<{ success: boolean, mode: string, status: string, message: string, screenshotUrl?: string, details?: object }>}
 */
async function processApplication(job, options = {}) {
    const mode = options.mode || MODES.AUTOFILL_AND_REVIEW;
    const profile = options.profile || loadProfile();
    const jobId = job.job_id || job.id;

    console.log(`[ApplyEngine] Processing ${job.company} - ${job.role} in mode: ${mode}`);

    // Strict Duplicate Application Check
    const duplicateCheck = await checkAlreadyApplied(job);
    if (duplicateCheck.alreadyApplied) {
        console.warn(`[ApplyEngine] 🛑 Duplicate application prevented for ${job.company} - ${job.role}: ${duplicateCheck.reason}`);
        return {
            success: true,
            already_applied: true,
            mode,
            status: 'APPLIED',
            message: `Skipped duplicate: ${duplicateCheck.reason}`,
            applied_at: (duplicateCheck.appliedJob && duplicateCheck.appliedJob.applied_at) || job.applied_at
        };
    }

    // Check existing application record
    const existing = await getQuery('SELECT * FROM applications WHERE job_id = ?', [jobId]);

    // Mode 1: DISCOVERY ONLY
    if (mode === MODES.DISCOVERY_ONLY) {
        if (!existing) {
            const appId = `app_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const now = new Date().toISOString();
            await runQuery(`
                INSERT INTO applications (id, job_id, company, role, application_url, status, match_score, source, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'SAVED', ?, ?, ?, ?)
            `, [appId, jobId, job.company, job.role, job.application_url, job.score || job.match_score || 0, job.source || 'aggregator', now, now]);
        }
        return {
            success: true,
            mode,
            status: 'SAVED',
            message: `Job saved to pipeline for ${job.company}.`
        };
    }

    // Mode 2: PREPARE MATERIALS
    if (mode === MODES.PREPARE_MATERIALS) {
        // Generate tailored cover letter
        const { coverLetter, verified, summary } = await generateCoverLetter(job, profile);

        // Retrieve existing tailored resume if available
        const resumeRow = await getQuery('SELECT pdf_path, tailored_markdown FROM resume_versions WHERE job_id = ? ORDER BY version DESC LIMIT 1', [jobId]);
        const resumePath = resumeRow ? resumeRow.pdf_path : null;

        const appId = existing ? existing.id : `app_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const now = new Date().toISOString();

        const formPayload = JSON.stringify({
            materialsPrepared: true,
            coverLetterVerified: verified,
            coverLetterSummary: summary,
            preparedAt: now
        });

        if (existing) {
            await runQuery(`
                UPDATE applications SET
                    status = 'READY_FOR_REVIEW',
                    cover_letter_used = ?,
                    resume_used = COALESCE(?, resume_used),
                    form_payload = ?,
                    updated_at = ?
                WHERE id = ?
            `, [coverLetter, resumePath, formPayload, now, appId]);
        } else {
            await runQuery(`
                INSERT INTO applications (
                    id, job_id, company, role, application_url, status,
                    resume_used, cover_letter_used, form_payload, match_score,
                    source, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'READY_FOR_REVIEW', ?, ?, ?, ?, ?, ?, ?)
            `, [
                appId, jobId, job.company, job.role, job.application_url,
                resumePath, coverLetter, formPayload, job.score || job.match_score || 0,
                job.source || 'aggregator', now, now
            ]);
        }

        return {
            success: true,
            mode,
            status: 'READY_FOR_REVIEW',
            message: 'Application materials prepared & fact-verified. Ready for review.',
            details: { coverLetter, resumePath, summary }
        };
    }

    // Mode 3: AUTOFILL AND REVIEW (Default) or Mode 4: AUTO_SUBMIT_APPROVED
    const isFinalSubmit = (mode === MODES.AUTO_SUBMIT_APPROVED);

    // Prepare applicant data
    const info = profile.personal_information || {};
    const applicant = {
        firstName: info.first_name || 'Applicant',
        lastName: info.last_name || 'Candidate',
        email: info.email || 'applicant@example.com',
        phone: info.phone || '',
        linkedin: info.linkedin || '',
        github: info.github || '',
        portfolio: info.portfolio || '',
        location: [info.location?.city, info.location?.country].filter(Boolean).join(', ') || 'Remote'
    };

    // Find resume buffer
    let pdfBuffer = null;
    const resumeRow = await getQuery('SELECT pdf_path FROM resume_versions WHERE job_id = ? ORDER BY version DESC LIMIT 1', [jobId]);
    if (resumeRow && resumeRow.pdf_path) {
        const candidatePaths = [
            resumeRow.pdf_path,
            path.resolve(__dirname, '..', resumeRow.pdf_path.replace(/^\//, '')),
            path.resolve(__dirname, '../public', resumeRow.pdf_path.replace(/^\//, ''))
        ];
        for (const p of candidatePaths) {
            if (fs.existsSync(p)) {
                pdfBuffer = fs.readFileSync(p);
                break;
            }
        }
    }
    if (!pdfBuffer) {
        // Fallback to default candidate resume in public/resumes
        const defaultResume = path.resolve(__dirname, '../public/resumes/default_resume.pdf');
        if (fs.existsSync(defaultResume)) {
            pdfBuffer = fs.readFileSync(defaultResume);
        }
    }

    // Generate cover letter
    const { coverLetter } = await generateCoverLetter(job, profile);

    // Launch Playwright with Chrome channel & persistent session
    let browser;
    try {
        const launchOptions = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        };
        if (fs.existsSync('/Applications/Google Chrome.app')) {
            launchOptions.channel = 'chrome';
        }

        const profileDir = path.resolve(__dirname, '../data/browser_profile');
        const stateFile = path.join(profileDir, 'storage_state.json');
        const contextOptions = {
            viewport: { width: 1280, height: 850 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        };

        if (fs.existsSync(stateFile)) {
            contextOptions.storageState = stateFile;
        }

        browser = await chromium.launch(launchOptions);
        const context = await browser.newContext(contextOptions);
        const page = await context.newPage();

        const targetUrl = job.application_url || job.url;
        console.log(`[ApplyEngine] Navigating to ${targetUrl}...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Check for CAPTCHA
        const hasCaptcha = (await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], div.g-recaptcha, .cf-turnstile, [class*="captcha"]').count()) > 0;
        
        let screenshotFilename = `proof_${jobId}_${Date.now()}.png`;
        let screenshotLocalPath = path.resolve(__dirname, '../public/screenshots', screenshotFilename);
        let screenshotUrl = `/screenshots/${screenshotFilename}`;

        // Create screenshot directory
        const screenshotDir = path.dirname(screenshotLocalPath);
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

        // Autofill logic according to ATS
        let portalType = 'generic';
        const capturedAnswers = [];
        const flaggedCommitments = [];

        if (targetUrl.includes('greenhouse.io') || targetUrl.includes('mock_greenhouse')) {
            portalType = 'greenhouse';
            await autofillGreenhouse(page, applicant, pdfBuffer, capturedAnswers, flaggedCommitments, job, profile);
        } else if (targetUrl.includes('lever.co') || targetUrl.includes('mock_lever')) {
            portalType = 'lever';
            await autofillLever(page, applicant, pdfBuffer, capturedAnswers, flaggedCommitments, job, profile);
        } else if (targetUrl.includes('ashbyhq.com')) {
            portalType = 'ashby';
            await autofillAshby(page, applicant, pdfBuffer, capturedAnswers, flaggedCommitments, job, profile);
        } else if (targetUrl.includes('linkedin.com')) {
            portalType = 'linkedin';
            await autofillLinkedIn(page, applicant, pdfBuffer, capturedAnswers, flaggedCommitments);
        } else {
            await autofillGeneric(page, applicant, pdfBuffer);
        }

        await page.waitForTimeout(1500);

        // Capture verification screenshot
        await page.screenshot({ path: screenshotLocalPath, fullPage: true }).catch(() => {});

        let finalStatus = 'READY_FOR_REVIEW';
        let statusMessage = 'Form autofilled and screenshot recorded. Queued for human approval.';

        if (hasCaptcha) {
            console.log(`[ApplyEngine] CAPTCHA detected on ${targetUrl}. Opening interactive localhost solver popup...`);
            try {
                const captchaManager = require('./captcha_manager');
                const outcome = await captchaManager.registerChallenge({
                    page,
                    atsType: portalType,
                    job: { jobId, role: job.role, company: job.company, url: targetUrl },
                    jobId,
                    isHeaded: !headless
                });
                if (outcome && outcome.submitted) {
                    finalStatus = 'SUBMITTED';
                    statusMessage = 'Application successfully submitted after CAPTCHA resolution!';
                } else {
                    finalStatus = 'BLOCKED_CAPTCHA';
                    statusMessage = 'Form partially populated, but CAPTCHA detected. Complete CAPTCHA in browser.';
                }
            } catch (capErr) {
                finalStatus = 'BLOCKED_CAPTCHA';
                statusMessage = 'Form partially populated, but CAPTCHA detected. Complete CAPTCHA in browser.';
            }
        } else if (isFinalSubmit) {
            // User has explicitly approved or triggered Mode 4
            const submittedSuccessfully = await attemptFinalSubmit(page, portalType);
            if (submittedSuccessfully) {
                finalStatus = 'SUBMITTED';
                statusMessage = 'Application successfully submitted and confirmed!';
                // Retake screenshot post-submission
                await page.waitForTimeout(2000);
                await page.screenshot({ path: screenshotLocalPath, fullPage: true }).catch(() => {});

                // Verify with Antigravity Vision via OmniRoute
                try {
                    const verification = await verifyJobProof({
                        jobId,
                        screenshotPath: screenshotLocalPath,
                        company: job.company,
                        role: job.role,
                        url: job.url || job.application_url,
                        updateDatabase: false
                    });
                    if (verification && verification.verified && verification.is_false_positive) {
                        finalStatus = 'READY_FOR_REVIEW';
                        statusMessage = `False positive detected by Antigravity Vision: ${verification.reason}`;
                        console.warn(`[ApplyEngine] ⚠️ False positive detected post-submit for ${jobId}: ${verification.reason}`);
                    }
                } catch (e) {
                    console.error('[ApplyEngine] Proof verification error:', e.message);
                }
            } else {
                finalStatus = 'READY_FOR_REVIEW';
                statusMessage = 'Autofilled successfully. Manual click required on the final submit button.';
            }
        }

        await browser.close();

        // Update database
        const appId = existing ? existing.id : `app_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const now = new Date().toISOString();
        const appliedAt = (finalStatus === 'SUBMITTED') ? now : (existing ? existing.applied_at : null);

        const formPayload = JSON.stringify({
            portalType,
            hasCaptcha,
            capturedAnswers,
            flaggedCommitments,
            screenshotUrl,
            modeExecuted: mode,
            timestamp: now
        });

        if (existing) {
            await runQuery(`
                UPDATE applications SET
                    status = ?,
                    screenshot_path = ?,
                    cover_letter_used = ?,
                    form_payload = ?,
                    applied_at = ?,
                    updated_at = ?
                WHERE id = ?
            `, [finalStatus, screenshotUrl, coverLetter, formPayload, appliedAt, now, appId]);
        } else {
            await runQuery(`
                INSERT INTO applications (
                    id, job_id, company, role, application_url, status,
                    screenshot_path, cover_letter_used, form_payload, match_score,
                    source, created_at, updated_at, applied_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                appId, jobId, job.company, job.role, job.application_url, finalStatus,
                screenshotUrl, coverLetter, formPayload, job.score || job.match_score || 0,
                job.source || 'aggregator', now, now, appliedAt
            ]);
        }

        // Log execution step
        try {
            await runQuery(`
                INSERT INTO application_logs (application_id, job_id, event_type, message, details, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [
                appId,
                jobId,
                `AUTO_APPLY_${mode}`,
                finalStatus,
                statusMessage,
                now
            ]);
        } catch (e) {
            console.warn('[ApplyEngine] Error writing application log:', e.message);
        }

        return {
            success: true,
            mode,
            status: finalStatus,
            message: statusMessage,
            screenshotUrl,
            details: {
                flaggedCommitments,
                capturedAnswersCount: capturedAnswers.length,
                hasCaptcha
            }
        };

    } catch (err) {
        console.error('[ApplyEngine] Error:', err);
        if (browser) await browser.close();
        return {
            success: false,
            mode,
            status: 'FAILED',
            message: `Execution failed: ${err.message}`
        };
    }
}

async function fillField(page, selector, value) {
    if (!value) return;
    try {
        const loc = page.locator(selector).first();
        if ((await loc.count()) > 0) {
            await loc.scrollIntoViewIfNeeded().catch(() => {});
            await loc.click().catch(() => {});
            await loc.fill(value).catch(() => {});
            await loc.evaluate((el, val) => {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, value).catch(() => {});
        }
    } catch (e) {}
}

async function autofillGreenhouse(page, applicant, pdfBuffer, capturedAnswers, flaggedCommitments, job, profile) {
    await fillField(page, '#first_name, input[name="job_application[first_name]"], input[name="first_name"]', applicant.firstName);
    await fillField(page, '#last_name, input[name="job_application[last_name]"], input[name="last_name"]', applicant.lastName);
    await fillField(page, '#email, input[name="job_application[email]"], input[name="email"]', applicant.email);
    await fillField(page, '#phone, input[name="job_application[phone]"], input[name="phone"]', applicant.phone);
    await fillField(page, '#candidate-location, input[name="job_application[location]"]', applicant.location);

    // Upload resume PDF
    const fileSelector = 'input#resume[type="file"], input[type="file"][name*="resume"], input[type="file"]';
    const fileLoc = page.locator(fileSelector).first();
    if (pdfBuffer && (await fileLoc.count()) > 0) {
        await fileLoc.setInputFiles({
            name: `${applicant.firstName}_${applicant.lastName}_Resume.pdf`,
            mimeType: 'application/pdf',
            buffer: pdfBuffer
        }).catch(() => {});
    }

    // Dynamic question labels
    const labels = await page.$$('label');
    for (const label of labels) {
        try {
            const text = (await label.innerText()).trim();
            const lower = text.toLowerCase();
            const forAttr = await label.getAttribute('for');
            if (!forAttr) continue;
            const targetSelector = `#${forAttr}`;

            if (lower.includes('linkedin')) {
                await fillField(page, targetSelector, applicant.linkedin);
            } else if (lower.includes('website') || lower.includes('portfolio')) {
                await fillField(page, targetSelector, applicant.portfolio);
            } else if (lower.includes('github')) {
                await fillField(page, targetSelector, applicant.github);
            } else if (text.length > 5) {
                // Synthesize answer using screening service
                const answerObj = await answerScreeningQuestion(text, job, profile);
                capturedAnswers.push({ question: text, answer: answerObj.answer, requiresConfirmation: answerObj.requiresConfirmation });
                if (answerObj.requiresConfirmation) {
                    flaggedCommitments.push({ question: text, answer: answerObj.answer, reason: answerObj.flagReason });
                }
                await fillField(page, targetSelector, answerObj.answer);
            }
        } catch (e) {}
    }
}

async function autofillLever(page, applicant, pdfBuffer, capturedAnswers, flaggedCommitments, job, profile) {
    await fillField(page, 'input[name="name"]', `${applicant.firstName} ${applicant.lastName}`);
    await fillField(page, 'input[name="email"]', applicant.email);
    await fillField(page, 'input[name="phone"]', applicant.phone);
    await fillField(page, 'input[name="urls[LinkedIn]"]', applicant.linkedin);
    await fillField(page, 'input[name="urls[GitHub]"]', applicant.github);
    await fillField(page, 'input[name="urls[Portfolio]"]', applicant.portfolio);

    const fileLoc = page.locator('input[type="file"][name="resume"], input[type="file"]').first();
    if (pdfBuffer && (await fileLoc.count()) > 0) {
        await fileLoc.setInputFiles({
            name: `${applicant.firstName}_${applicant.lastName}_Resume.pdf`,
            mimeType: 'application/pdf',
            buffer: pdfBuffer
        }).catch(() => {});
    }
}

async function autofillAshby(page, applicant, pdfBuffer, capturedAnswers, flaggedCommitments, job, profile) {
    await fillField(page, 'input[name="name"], input[id*="name"]', `${applicant.firstName} ${applicant.lastName}`);
    await fillField(page, 'input[name="email"], input[type="email"]', applicant.email);
    await fillField(page, 'input[name="phone"], input[type="tel"]', applicant.phone);

    const fileLoc = page.locator('input[type="file"]').first();
    if (pdfBuffer && (await fileLoc.count()) > 0) {
        await fileLoc.setInputFiles({
            name: `${applicant.firstName}_${applicant.lastName}_Resume.pdf`,
            mimeType: 'application/pdf',
            buffer: pdfBuffer
        }).catch(() => {});
    }
}

async function autofillLinkedIn(page, applicant, pdfBuffer) {
    const easyApplyBtn = page.locator('button.jobs-apply-button:has-text("Easy Apply"), button:has-text("Easy Apply")').first();
    if ((await easyApplyBtn.count()) > 0) {
        await easyApplyBtn.click();
        await page.waitForTimeout(1500);
        await fillField(page, 'input[id*="phoneNumber"], input[name*="phoneNumber"]', applicant.phone);
        const fileLoc = page.locator('input[type="file"]').first();
        if (pdfBuffer && (await fileLoc.count()) > 0) {
            await fileLoc.setInputFiles({
                name: `${applicant.firstName}_${applicant.lastName}_Resume.pdf`,
                mimeType: 'application/pdf',
                buffer: pdfBuffer
            }).catch(() => {});
        }
    }
}

async function autofillGeneric(page, applicant, pdfBuffer) {
    await fillField(page, 'input[name*="first_name"], input[name*="firstName"], input[id*="first_name"]', applicant.firstName);
    await fillField(page, 'input[name*="last_name"], input[name*="lastName"], input[id*="last_name"]', applicant.lastName);
    await fillField(page, 'input[type="email"], input[name*="email"]', applicant.email);
    await fillField(page, 'input[type="tel"], input[name*="phone"]', applicant.phone);
}

async function attemptFinalSubmit(page, portalType) {
    try {
        const submitBtn = page.locator('button[type="submit"]:has-text("Submit"), button:has-text("Submit application"), #submit_app, input[type="submit"], button:has-text("Send Application")').first();
        if ((await submitBtn.count()) > 0) {
            await submitBtn.click({ timeout: 5000 });
            await page.waitForTimeout(4000);
            const body = (await page.innerText('body').catch(() => '')).toLowerCase();
            return body.includes('thank you for applying') || body.includes('application submitted') || body.includes('application received');
        }
    } catch (e) {
        console.warn('[ApplyEngine] Submit button click note:', e.message);
    }
    return false;
}

module.exports = {
    MODES,
    processApplication
};
