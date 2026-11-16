const fs = require('fs');
const path = require('path');
const { runQuery, getQuery, allQuery } = require('./db');
const { autoApply } = require('./apply');
const { verifyJobProof } = require('./proof_verifier');
const {
    checkAlreadyApplied,
    acquireApplyLock,
    releaseApplyLock,
    recordJobApplied
} = require('./pipeline/application_guard');

function getStructuredProfile() {
    const profilePath = path.join(__dirname, 'profile.json');
    if (fs.existsSync(profilePath)) {
        try {
            return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
        } catch (e) {
            return {};
        }
    }
    return {};
}

const tailoredResumesDir = path.join(__dirname, '../tailored_resumes');
const screenshotsDir = path.join(__dirname, '../public/screenshots');

// Ensure directories exist
if (!fs.existsSync(tailoredResumesDir)) {
    fs.mkdirSync(tailoredResumesDir, { recursive: true });
}
if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
}

// Simple text diff generator
function generateBasicDiff(original, tailored) {
    const originalLines = original.split('\n');
    const tailoredLines = tailored.split('\n');

    let diff = 'Resume Tailoring Changes:\n';
    let changed = false;

    // Track differences in headers/skills
    originalLines.forEach(ol => {
        if (ol.trim() !== '' && !tailoredLines.some(tl => tl.trim() === ol.trim())) {
            diff += `- Removed/reworded: ${ol.substring(0, 100)}\n`;
            changed = true;
        }
    });

    tailoredLines.forEach(tl => {
        if (tl.trim() !== '' && !originalLines.some(ol => ol.trim() === tl.trim())) {
            diff += `+ Added/emphasized: ${tl.substring(0, 100)}\n`;
            changed = true;
        }
    });

    if (!changed) {
        return 'No major line differences. Terminology optimization only.';
    }
    return diff;
}

/**
 * Creates tailored resume markdown, renders PDF, and writes DB entries.
 */
async function tailorJobApplication(jobId) {
    console.log(`[Tailoring] Initiating tailoring for job ID: ${jobId}`);

    const job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
    if (!job) {
        throw new Error(`Job not found: ${jobId}`);
    }

    const maxVersionRow = await getQuery('SELECT MAX(version) as max_v FROM resume_versions WHERE job_id = ?', [jobId]);
    const nextVersion = ((maxVersionRow && maxVersionRow.max_v) || 0) + 1;
    const jdText = `${job.role} at ${job.company}\n\n${job.description}`;

    // 1. Generate text details using AI
    const { tailorResumeText, generateCoverLetter } = require('./ai');
    const { renderResumeToPdf } = require('./tailor');
    console.log(`[Tailoring] Rewriting resume with Gemini 3.8 Flash for target ${job.role}...`);
    const tailoredMarkdown = await tailorResumeText(job.role, job.company, jdText);
    const coverLetter = await generateCoverLetter(job.role, job.company, jdText);

    // Fetch active resume setting
    const activeResumeSetting = await getQuery("SELECT value FROM settings WHERE key = 'ACTIVE_BASE_RESUME'");
    const activeResumeKey = (activeResumeSetting && activeResumeSetting.value) || 'resume_12_8_26.md';
    let baseResumePath = path.join(__dirname, '../../resumes', activeResumeKey);
    if (!fs.existsSync(baseResumePath)) {
        baseResumePath = path.join(__dirname, '../../resumes/resume_12_8_26.md');
    }
    const baseResume = fs.readFileSync(baseResumePath, 'utf8');
    const diff = generateBasicDiff(baseResume, tailoredMarkdown);

    // 2. Render to PDF buffer
    console.log(`[Tailoring] Converting output markdown into PDF...`);
    const pdfBuffer = await renderResumeToPdf(tailoredMarkdown);

    // 3. Save PDF file
    const pdfFilename = `tailored_${jobId}_v${nextVersion}.pdf`;
    const pdfFilepath = path.join(tailoredResumesDir, pdfFilename);
    if (fs.existsSync(pdfFilepath)) {
        try { fs.unlinkSync(pdfFilepath); } catch (e) {}
    }
    fs.writeFileSync(pdfFilepath, pdfBuffer);

    // 4. Update Database
    await runQuery(`
        INSERT INTO resume_versions (
            job_id, version, tailored_markdown, cover_letter, diff_from_master, pdf_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
        jobId,
        nextVersion,
        tailoredMarkdown,
        coverLetter,
        diff,
        `/tailored_resumes/${pdfFilename}`,
        new Date().toISOString()
    ]);

    await runQuery(`
        UPDATE jobs
        SET resume_version = ?, cover_letter_version = ?, status = 'RESUME_TAILORED'
        WHERE job_id = ?
    `, [nextVersion, nextVersion, jobId]);

    console.log(`[Tailoring] Job ${jobId} resume v${nextVersion} drafted successfully.`);
    return { success: true, version: nextVersion };
}

/**
 * Executes browser-automator Playwright run.
 */
async function applyToJob(jobId, options = {}) {
    console.log(`[Auto-Apply] Initiating Playwright application for job ID: ${jobId}. Options:`, options);

    const job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
    if (!job) {
        throw new Error(`Job not found: ${jobId}`);
    }

    // Strict Duplicate Application Check
    const duplicateCheck = await checkAlreadyApplied(job);
    if (duplicateCheck.alreadyApplied) {
        console.warn(`[Auto-Apply] 🛑 DUPLICATE APPLICATION BLOCKED for job ${jobId}: ${duplicateCheck.reason}`);
        
        // Ensure status is recorded as APPLIED
        if (job.status !== 'APPLIED') {
            await recordJobApplied({
                jobId: job.job_id,
                url: job.url || job.application_url,
                company: job.company,
                role: job.role,
                screenshotPath: (duplicateCheck.appliedJob && duplicateCheck.appliedJob.screenshot_path) || job.screenshot_path || '',
                notes: duplicateCheck.reason
            });
        }

        return {
            success: true,
            already_applied: true,
            submitted: false,
            manual_assisted: false,
            status: 'APPLIED',
            requires_manual: false,
            is_false_positive: false,
            reason: duplicateCheck.reason,
            message: `Skipped duplicate application: ${duplicateCheck.reason}`,
            screenshot_path: (duplicateCheck.appliedJob && duplicateCheck.appliedJob.screenshot_path) || job.screenshot_path || '',
            job_id: jobId,
            company: job.company,
            role: job.role,
            url: job.url || job.application_url,
            applied_at: (duplicateCheck.appliedJob && duplicateCheck.appliedJob.applied_at) || job.applied_at || new Date().toISOString()
        };
    }

    const targetUrl = job.url || job.application_url;
    const lockAcquired = acquireApplyLock(jobId, targetUrl, job.company, job.role);
    if (!lockAcquired) {
        console.warn(`[Auto-Apply] 🛑 CONCURRENT APPLICATION BLOCKED: Job ${jobId} is currently being applied to.`);
        return {
            success: false,
            already_applied: true,
            in_progress: true,
            status: job.status,
            message: `An application session is already active for ${job.company} - ${job.role}. Concurrent submission prevented.`,
            job_id: jobId
        };
    }

    try {
        // Fetch the latest tailored resume version details
    const versionDetails = await getQuery(`
        SELECT * FROM resume_versions
        WHERE job_id = ?
        ORDER BY version DESC, id DESC LIMIT 1
    `, [jobId]);

    let pdfBuffer;
    if (versionDetails) {
        const fullPdfPath = path.join(__dirname, '..', versionDetails.pdf_path);
        if (fs.existsSync(fullPdfPath)) {
            pdfBuffer = fs.readFileSync(fullPdfPath);
        }
    }

    if (!pdfBuffer) {
        const masterResumePath = path.resolve(__dirname, '../../resumes/master_resume.pdf');
        const rootResumePath = path.resolve(__dirname, '../test_resume_output.pdf');
        if (fs.existsSync(masterResumePath)) {
            console.log(`[Auto-Apply] Using Master Resume PDF (${masterResumePath}) for ${jobId}...`);
            pdfBuffer = fs.readFileSync(masterResumePath);
        } else if (fs.existsSync(rootResumePath)) {
            console.log(`[Auto-Apply] Using Root Resume PDF for ${jobId}...`);
            pdfBuffer = fs.readFileSync(rootResumePath);
        } else {
            console.log(`[Auto-Apply] Fallback: Building buffer for ${jobId}...`);
            pdfBuffer = Buffer.from('%PDF-1.4 Resume Document');
        }
    }

    // Read applicant profile details
    const rawSettings = await allQuery('SELECT * FROM settings');
    const settings = {};
    rawSettings.forEach(s => settings[s.key] = s.value);

    // Build applicant configuration structure from profile.json
    const profile = getStructuredProfile();
    const info = profile.personal_information || {};

    const applicant = {
        firstName: info.first_name || 'Applicant',
        lastName: info.last_name || 'Candidate',
        email: info.email || 'applicant@example.com',
        phone: info.phone || '',
        alternatePhone: info.alternate_phone || '',
        linkedin: info.linkedin || '',
        github: info.github || '',
        portfolio: info.portfolio || '',
        location: [info.location?.city, info.location?.state, info.location?.country].filter(Boolean).join(', ') || 'Remote',
        workAuthorization: (profile.work_preferences && profile.work_preferences.work_authorization) || 'Yes',
        requiresSponsorship: (profile.work_preferences && profile.work_preferences.requires_sponsorship) || 'No',
        currentCompany: (profile.experience_details && profile.experience_details[0] && profile.experience_details[0].company) || '',
        university: (profile.education_details && profile.education_details[0] && profile.education_details[0].institution) || '',
        pronouns: info.pronouns || 'Prefer not to say'
    };

    const isManualAssisted = !!(options && (options.manualAssisted || options.mode === 'manual' || options.keepOpen));
    options.jobId = jobId;
    if (isManualAssisted) {
        options.headed = true;
        options.keepOpen = true;
        options.autoSubmit = false;
        options.manualAssisted = true;
    }

    const autoSubmitSetting = settings.AUTO_APPLY_ENABLED === 'true';
    const autoApplyMode = settings.AUTO_APPLY_MODE || 'REVIEW_BEFORE_SUBMIT';

    // Determine target autoSubmit behavior:
    // If options.autoSubmit is explicitly provided, honor it. Otherwise fallback to database settings.
    const isAutoApply = isManualAssisted ? false : ((options && options.autoSubmit !== undefined) 
        ? !!options.autoSubmit 
        : (autoSubmitSetting && (autoApplyMode === 'AUTO_APPLY')));

    console.log(`[Auto-Apply] Opening browser agent for: ${job.url}. AutoSubmit mode: ${isAutoApply}, ManualAssisted: ${isManualAssisted}`);

    // Call browser apply executor
    const applyResult = await autoApply(job.url, applicant, pdfBuffer, isAutoApply, { ...options, job, jobId });

    // Save screenshot locally
    let screenshotRelativePath = '';
    if (applyResult.screenshotBuffer) {
        const screenshotFilename = `screenshot_${jobId}.png`;
        const screenshotFilepath = path.join(screenshotsDir, screenshotFilename);
        if (fs.existsSync(screenshotFilepath)) {
            try { fs.unlinkSync(screenshotFilepath); } catch (e) {}
        }
        fs.writeFileSync(screenshotFilepath, applyResult.screenshotBuffer);
        screenshotRelativePath = `/screenshots/${screenshotFilename}`;
    }

    // Update job status in database
    let newStatus = job.status;
    let message = applyResult.message;
    let isFalsePositive = false;
    let falsePositiveReason = '';

    const isCaptcha = applyResult.captcha_required || 
                      (applyResult.message && applyResult.message.toLowerCase().includes('captcha')) ||
                      applyResult.status === 'CAPTCHA_REQUIRED';

    let isConfirmedSubmitted = !!(applyResult.success && isAutoApply && applyResult.submitted);

    if (applyResult.status === 'STOPPED') {
        newStatus = job.status || 'MANUAL_REQUIRED';
        message = 'Auto-apply stopped by user.';
    } else if (isConfirmedSubmitted) {
        newStatus = 'APPLIED';
    } else if (isCaptcha) {
        newStatus = 'CAPTCHA_REQUIRED';
        message = 'CAPTCHA detected. Click "Solve CAPTCHA" in dashboard to complete.';
    } else if (isManualAssisted && applyResult.success) {
        newStatus = 'READY_TO_APPLY';
        message = 'Form autofilled & open on desktop. Ready for submit.';
    } else if (applyResult.success) {
        newStatus = 'READY_TO_APPLY';
    } else {
        // Switch to manual review if failed
        newStatus = 'MANUAL_REQUIRED';
    }

    // Verify submission proof via OmniRoute connected with Antigravity
    // to detect false positives (e.g. form still open, validation errors, CAPTCHA, login prompt)
    if (screenshotRelativePath && (isConfirmedSubmitted || newStatus === 'APPLIED')) {
        try {
            console.log(`[Auto-Apply] Inspecting proof screenshot for job ${jobId} via OmniRoute + Antigravity Vision...`);
            const verification = await verifyJobProof({
                jobId,
                screenshotBuffer: applyResult.screenshotBuffer,
                screenshotPath: screenshotRelativePath,
                company: job.company,
                role: job.role,
                url: job.url || job.application_url,
                updateDatabase: false
            });

            if (verification && verification.verified) {
                if (verification.is_false_positive) {
                    isFalsePositive = true;
                    isConfirmedSubmitted = false;
                    falsePositiveReason = verification.reason;
                    newStatus = verification.status === 'CAPTCHA_REQUIRED' ? 'CAPTCHA_REQUIRED' : 'MANUAL_REQUIRED';
                    message = `False positive detected by Antigravity Vision: ${verification.reason}`;
                    console.warn(`[Auto-Apply] ⚠️ Antigravity Vision flagged FALSE POSITIVE: ${verification.reason}`);
                } else if (verification.applied) {
                    isConfirmedSubmitted = true;
                    newStatus = 'APPLIED';
                    message = `Confirmed Applied (Antigravity Verified): ${verification.reason}`;
                    console.log(`[Auto-Apply] ✅ Antigravity Vision CONFIRMED genuine submission: ${verification.reason}`);
                }
            }
        } catch (proofErr) {
            console.error(`[Auto-Apply] OmniRoute Antigravity proof verification error:`, proofErr.message);
        }
    }

    const nowIso = new Date().toISOString();

    await runQuery(`
        UPDATE jobs
        SET status = ?,
            applied_at = ?,
            application_status = ?,
            screenshot_path = ?,
            is_false_positive = ?,
            flagged_at = ?
        WHERE job_id = ?
    `, [
        newStatus,
        isConfirmedSubmitted ? (job.applied_at || nowIso) : null,
        message,
        screenshotRelativePath,
        isFalsePositive ? 1 : 0,
        isFalsePositive ? nowIso : null,
        jobId
    ]);

    // Also sync applications table
    await runQuery(`
        UPDATE applications
        SET status = ?,
            applied_at = ?,
            screenshot_path = ?,
            is_false_positive = ?,
            flagged_at = ?,
            error_message = ?
        WHERE job_id = ? OR id = ?
    `, [
        newStatus,
        isConfirmedSubmitted ? (job.applied_at || nowIso) : null,
        screenshotRelativePath,
        isFalsePositive ? 1 : 0,
        isFalsePositive ? nowIso : null,
        isFalsePositive ? falsePositiveReason : null,
        jobId,
        jobId
    ]).catch(() => {});

        console.log(`[Auto-Apply] Completed. Result: Success=${applyResult.success}, Submitted=${isConfirmedSubmitted}, Status=${newStatus}, FalsePositive=${isFalsePositive}, ManualAssisted=${isManualAssisted}`);
        return {
            success: applyResult.success && !isFalsePositive,
            submitted: isConfirmedSubmitted,
            manual_assisted: isManualAssisted,
            status: newStatus,
            requires_manual: (applyResult.success && !isConfirmedSubmitted && !isFalsePositive),
            is_false_positive: isFalsePositive,
            false_positive_reason: falsePositiveReason,
            reason: message,
            message: message,
            screenshot_path: screenshotRelativePath,
            job_id: jobId,
            company: job.company,
            role: job.role,
            url: job.url || job.application_url
        };
    } finally {
        releaseApplyLock(jobId, targetUrl, job.company, job.role);
    }
}

module.exports = {
    tailorJobApplication,
    applyToJob
};
