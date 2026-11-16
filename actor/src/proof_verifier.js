/**
 * OmniRoute + Antigravity Proof Verifier
 * 
 * Inspects application proof screenshots using the OmniRoute API connected
 * to Antigravity vision (antigravity/gemini-3-flash) to determine if a job
 * was genuinely submitted or if it is a false positive (e.g. form still open,
 * validation errors, CAPTCHA block, login wall, or ATS rejection).
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const { getQuery, runQuery, allQuery } = require('./db');

const SCREENSHOTS_DIR = path.resolve(__dirname, '../public/screenshots');
const PUBLIC_DIR = path.resolve(__dirname, '../public');

/**
 * Resolves local image file path from various inputs.
 */
function resolveScreenshotPath(givenPath, jobId) {
    if (!givenPath && !jobId) return null;

    const candidates = [];
    if (givenPath) {
        if (path.isAbsolute(givenPath) && fs.existsSync(givenPath)) {
            return givenPath;
        }
        // relative to public
        const cleanPath = givenPath.startsWith('/') ? givenPath.slice(1) : givenPath;
        candidates.push(path.join(PUBLIC_DIR, cleanPath));
        candidates.push(path.join(SCREENSHOTS_DIR, path.basename(givenPath)));
    }

    if (jobId) {
        candidates.push(path.join(SCREENSHOTS_DIR, `screenshot_${jobId}.png`));
        // Also look for proof_${jobId}_*.png
        if (fs.existsSync(SCREENSHOTS_DIR)) {
            try {
                const files = fs.readdirSync(SCREENSHOTS_DIR);
                const match = files.find(f => f.startsWith(`proof_${jobId}_`) || f.startsWith(`screenshot_${jobId}_`));
                if (match) candidates.push(path.join(SCREENSHOTS_DIR, match));
            } catch (e) {}
        }
    }

    for (const cand of candidates) {
        if (cand && fs.existsSync(cand)) {
            try {
                const stat = fs.statSync(cand);
                if (stat.isFile() && stat.size > 500) {
                    return cand;
                }
            } catch (e) {}
        }
    }
    return null;
}

/**
 * Calls OmniRoute OpenAI-compatible chat completion endpoint with image payload.
 */
async function callOmniRouteVision(imageBuffer, promptText, options = {}) {
    const url = process.env.OMNIROUTE_URL || 'http://localhost:20128/v1';
    const apiKey = process.env.OMNIROUTE_API_KEY || 'sk-2cdc8d524108d19a-0abc42-d8f4f651';
    const targetModel = options.model || process.env.OMNIROUTE_VISION_MODEL || process.env.OMNIROUTE_MODEL || 'antigravity/gemini-3-flash';
    const timeoutMs = options.timeoutMs || 30000;

    const base64Image = imageBuffer.toString('base64');
    const dataUrl = `data:image/png;base64,${base64Image}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        console.log(`[ProofVerifier] Calling OmniRoute at ${url} using model: ${targetModel}...`);
        const response = await fetch(`${url}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: targetModel,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: promptText },
                            { type: 'image_url', image_url: { url: dataUrl } }
                        ]
                    }
                ],
                temperature: 0.1
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`OmniRoute error HTTP ${response.status}: ${errText}`);
        }

        const data = await response.json();
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
            throw new Error('Malformed completion response from OmniRoute');
        }

        return data.choices[0].message.content.trim();
    } catch (err) {
        clearTimeout(timeoutId);
        throw err;
    }
}

/**
 * Evaluates an application proof screenshot to confirm whether the job was
 * actually applied to or if it represents a false positive.
 *
 * @param {Object} params
 * @param {string} params.jobId - Target job ID
 * @param {string} [params.screenshotPath] - File path or URL of the screenshot
 * @param {Buffer} [params.screenshotBuffer] - In-memory image buffer
 * @param {string} [params.company] - Company name
 * @param {string} [params.role] - Job title
 * @param {string} [params.url] - Application URL
 * @param {boolean} [params.updateDatabase=true] - Whether to update jobs & applications tables
 * @returns {Promise<Object>} Verification details
 */
async function verifyJobProof(params = {}) {
    const { jobId, updateDatabase = true } = params;
    let { screenshotPath, screenshotBuffer, company = '', role = '', url = '' } = params;

    // Fetch job details from DB if missing
    if (jobId && (!company || !role || !url || !screenshotPath)) {
        const jobRow = await getQuery('SELECT company, role, url, application_url, screenshot_path, status FROM jobs WHERE job_id = ?', [jobId]).catch(() => null);
        if (jobRow) {
            company = company || jobRow.company;
            role = role || jobRow.role;
            url = url || jobRow.url || jobRow.application_url;
            screenshotPath = screenshotPath || jobRow.screenshot_path;
        }
    }

    // Resolve buffer or file path
    let imageBuffer = screenshotBuffer;
    let resolvedFilePath = null;

    if (!imageBuffer) {
        resolvedFilePath = resolveScreenshotPath(screenshotPath, jobId);
        if (!resolvedFilePath) {
            return {
                success: false,
                verified: false,
                error: 'No proof screenshot could be found or read for verification.',
                is_false_positive: false,
                status: 'NO_PROOF_IMAGE'
            };
        }
        imageBuffer = fs.readFileSync(resolvedFilePath);
    }

    const verificationPrompt = `
You are an expert ATS (Applicant Tracking System) and Web Automation Verification Auditor.
Your job is to inspect the attached job application submission screenshot/proof and determine with high precision whether the application was ACTUALLY successfully submitted/received, or if it is a FALSE POSITIVE.

Job Details:
- Company: ${company || 'Unknown'}
- Role: ${role || 'Unknown'}
- URL / Portal: ${url || 'Unknown'}

Analyze the visual evidence carefully:

1. ACTUAL APPLICATION SUBMITTED (applied = true, is_false_positive = false):
- Explicit success confirmation text (e.g. "Application submitted", "Thank you for applying", "Your application has been received", "Application successfully submitted", "Thank you for your interest in ${company || 'our team'}").
- Confirmation tick/checkmark icon with submission message.
- Application reference number or candidate portal confirmation.

2. FALSE POSITIVE (applied = false, is_false_positive = true):
- The application form is still open and visible with editable input fields (First Name, Last Name, Email, Resume, etc.).
- Active "Submit Application" / "Submit" button still visible on an unsubmitted form.
- Form validation error messages (e.g. red highlighted text, "This field is required", "Please enter a valid phone number", "Upload failed").
- CAPTCHA prompt is unsolved or blocking submission (e.g. Cloudflare Turnstile, Google reCAPTCHA "Verify you are human", hCaptcha).
- Authentication or login wall (e.g. asked to sign in to Jobicy, LinkedIn, Workday, etc.).
- Error screen (404, 500, "Something went wrong", "Session timed out").
- The screenshot only shows the job posting description page with an "Apply" button, but no form was even filled or submitted.

Respond ONLY with a valid JSON object matching this schema:
{
  "applied": boolean,
  "is_false_positive": boolean,
  "confidence": number,
  "status": "CONFIRMED_APPLIED" | "FALSE_POSITIVE" | "CAPTCHA_REQUIRED" | "VALIDATION_ERROR" | "FORM_STILL_OPEN" | "JOB_VIEW_ONLY",
  "reason": "Clear explanation of what was visually detected in the screenshot"
}
`;

    try {
        const rawContent = await callOmniRouteVision(imageBuffer, verificationPrompt);
        
        // Extract JSON from response
        let parsed = null;
        try {
            const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
            parsed = JSON.parse(cleaned);
        } catch (jsonErr) {
            const match = rawContent.match(/\{[\s\S]*\}/);
            if (match) {
                parsed = JSON.parse(match[0]);
            } else {
                throw new Error(`Unable to extract JSON from OmniRoute response: ${rawContent}`);
            }
        }

        const isApplied = Boolean(parsed.applied);
        const isFalsePositive = Boolean(parsed.is_false_positive || (!isApplied && parsed.status !== 'CONFIRMED_APPLIED'));
        const reason = parsed.reason || 'No detailed reason provided.';
        const verificationStatus = parsed.status || (isApplied ? 'CONFIRMED_APPLIED' : 'FALSE_POSITIVE');
        const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 90;

        const now = new Date().toISOString();

        if (updateDatabase && jobId) {
            if (isFalsePositive) {
                const targetJobStatus = verificationStatus === 'CAPTCHA_REQUIRED' ? 'CAPTCHA_REQUIRED' : 'MANUAL_REQUIRED';
                console.warn(`[ProofVerifier] ⚠️ FALSE POSITIVE for job ${jobId} (${company} - ${role}): ${reason}`);

                await runQuery(`
                    UPDATE jobs
                    SET status = ?,
                        is_false_positive = 1,
                        flagged_at = ?,
                        application_status = ?
                    WHERE job_id = ?
                `, [targetJobStatus, now, `False positive detected by Antigravity: ${reason}`, jobId]).catch(err => {
                    console.error('[ProofVerifier DB Error jobs]', err.message);
                });

                await runQuery(`
                    UPDATE applications
                    SET status = ?,
                        is_false_positive = 1,
                        flagged_at = ?,
                        error_message = ?
                    WHERE job_id = ? OR id = ?
                `, [targetJobStatus, now, reason, jobId, jobId]).catch(err => {
                    console.error('[ProofVerifier DB Error applications]', err.message);
                });
            } else if (isApplied) {
                console.log(`[ProofVerifier] ✅ CONFIRMED APPLICATION for job ${jobId} (${company} - ${role}): ${reason}`);

                await runQuery(`
                    UPDATE jobs
                    SET status = 'APPLIED',
                        is_false_positive = 0,
                        flagged_at = NULL,
                        application_status = ?,
                        applied_at = COALESCE(applied_at, ?)
                    WHERE job_id = ?
                `, [`Confirmed applied (Antigravity Verified): ${reason}`, now, jobId]).catch(err => {
                    console.error('[ProofVerifier DB Error jobs]', err.message);
                });

                await runQuery(`
                    UPDATE applications
                    SET status = 'APPLIED',
                        is_false_positive = 0,
                        flagged_at = NULL,
                        notes = COALESCE(notes || ' | ', '') || 'Verified applied via Antigravity Vision',
                        applied_at = COALESCE(applied_at, ?)
                    WHERE job_id = ? OR id = ?
                `, [now, jobId, jobId]).catch(err => {
                    console.error('[ProofVerifier DB Error applications]', err.message);
                });
            }
        }

        return {
            success: true,
            verified: true,
            applied: isApplied,
            is_false_positive: isFalsePositive,
            status: verificationStatus,
            confidence,
            reason,
            job_id: jobId,
            company,
            role,
            screenshot_path: resolvedFilePath ? `/screenshots/${path.basename(resolvedFilePath)}` : screenshotPath
        };

    } catch (err) {
        console.error(`[ProofVerifier] Error during verification for job ${jobId}:`, err.message);
        return {
            success: false,
            verified: false,
            error: err.message,
            is_false_positive: false,
            job_id: jobId
        };
    }
}

/**
 * Scans recent applications in database and verifies proof screenshots.
 */
async function auditAppliedProofs(limit = 20) {
    const rows = await allQuery(`
        SELECT job_id, company, role, url, application_url, screenshot_path, status, is_false_positive
        FROM jobs
        WHERE (status = 'APPLIED' OR is_false_positive = 1)
          AND screenshot_path IS NOT NULL
          AND screenshot_path != ''
        ORDER BY applied_at DESC, discovered_at DESC
        LIMIT ?
    `, [limit]);

    console.log(`[ProofVerifier] Running audit on ${rows.length} jobs with proof screenshots...`);
    const results = [];
    let falsePositiveCount = 0;
    let confirmedCount = 0;

    for (const row of rows) {
        const outcome = await verifyJobProof({
            jobId: row.job_id,
            screenshotPath: row.screenshot_path,
            company: row.company,
            role: row.role,
            url: row.url || row.application_url,
            updateDatabase: true
        });

        results.push(outcome);
        if (outcome.is_false_positive) falsePositiveCount++;
        else if (outcome.applied) confirmedCount++;
    }

    return {
        total: rows.length,
        confirmed: confirmedCount,
        false_positives: falsePositiveCount,
        results
    };
}

module.exports = {
    verifyJobProof,
    auditAppliedProofs,
    callOmniRouteVision,
    resolveScreenshotPath
};
