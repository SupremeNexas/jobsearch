const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { answerFormQuestion } = require('./ai');
const { checkPageAlreadyApplied } = require('./pipeline/application_guard');

/**
 * Strict verification of ATS submission.
 * An application is ONLY considered submitted if:
 * 1. The page URL explicitly transitioned to a confirmation endpoint (/thanks, /confirmation, /applied, etc.), OR
 * 2. The DOM contains explicit confirmation text (e.g. "thank you for applying", "application submitted successfully"), OR
 * 3. A successful HTTP 200/201 response was intercepted from the ATS submission API endpoint, AND
 * 4. There are NO visible validation error messages (e.g. "is required", "please enter", etc.), AND
 * 5. There is NO visible CAPTCHA / bot challenge blocking the page.
 *
 * @param {import('playwright-core').Page} page
 * @param {import('playwright-core').Page | import('playwright-core').Frame} targetFrame
 * @param {string} atsType
 * @param {boolean} apiSubmissionConfirmed
 * @returns {Promise<{submitted: boolean, success: boolean, requires_manual: boolean, message: string, errors: string[]}>}
 */
async function verifySubmissionStrict(page, targetFrame, atsType, apiSubmissionConfirmed = false) {
    const frame = targetFrame || page;
    const currentUrl = page.url().toLowerCase();
    const frameUrl = (targetFrame && targetFrame !== page) ? targetFrame.url().toLowerCase() : currentUrl;

    // 1. Explicit URL check
    const isUrlConfirmed =
        currentUrl.includes('/thanks') ||
        currentUrl.includes('/thank-you') ||
        currentUrl.includes('/confirmation') ||
        currentUrl.includes('/applied') ||
        currentUrl.includes('/application-submitted') ||
        currentUrl.includes('/job-application-confirmation') ||
        currentUrl.includes('#thanks') ||
        currentUrl.includes('success=true') ||
        frameUrl.includes('/thanks') ||
        frameUrl.includes('/confirmation') ||
        frameUrl.includes('#thanks');

    // 2. Explicit Text check
    const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase();
    const frameText = (targetFrame && targetFrame !== page) ? (await targetFrame.innerText('body').catch(() => '')).toLowerCase() : '';
    const fullText = `${bodyText} ${frameText}`;

    const confirmationPhrases = [
        'thank you for applying',
        'thanks for applying',
        'thank you for your application',
        'your application has been submitted',
        'application submitted successfully',
        'application submitted',
        'application received',
        'we have received your application',
        'successfully submitted your application',
        'application has been received',
        'we received your application',
        'we\'ve received your application',
        'your application was sent',
        'application sent',
        'submission received',
        'thank you for your interest',
        'thanks for your interest',
        'we have received your submission',
        'your application was successfully submitted',
        'application complete',
        'submission successful',
        'mock submission cleared'
    ];
    const isTextConfirmed = confirmationPhrases.some(phrase => fullText.includes(phrase));

    // 3. CAPTCHA / Bot protection check
    const captchaLocators = page.locator('iframe[title*="challenge" i], iframe[src*="recaptcha" i], iframe[src*="challenges.cloudflare.com" i], iframe[src*="hcaptcha" i], [data-sitekey], .g-recaptcha, .cf-turnstile, #cf-turnstile, div[class*="turnstile" i], div:has-text("Verify you are human"), div:has-text("Select all images with")');
    const isInteractiveChallenge = (await captchaLocators.count().catch(() => 0) > 0) &&
                                   (await captchaLocators.first().isVisible().catch(() => false));

    if (isInteractiveChallenge) {
        return {
            submitted: false,
            success: false,
            requires_manual: true,
            captcha_required: true,
            status: 'CAPTCHA_REQUIRED',
            message: 'CAPTCHA challenge or bot protection detected. Flagged for candidate resolution.',
            errors: ['Interactive CAPTCHA verification required']
        };
    }

    // 4. Form validation errors on page
    const errorSelectors = [
        '.field-error',
        '.error-message',
        '.error',
        '[aria-invalid="true"]',
        '.input-error',
        '.invalid-feedback',
        '.has-error',
        '[class*="fieldError"]',
        '[class*="errorText"]',
        '[class*="errorMessage"]'
    ];

    const validationErrors = [];
    for (const sel of errorSelectors) {
        try {
            const loc = frame.locator(sel);
            const count = await loc.count();
            for (let i = 0; i < Math.min(count, 5); i++) {
                const el = loc.nth(i);
                if (await el.isVisible().catch(() => false)) {
                    const txt = (await el.innerText().catch(() => '')).trim();
                    if (txt && !validationErrors.includes(txt) && txt.length < 200) {
                        validationErrors.push(txt);
                    }
                }
            }
        } catch (e) {}
    }

    // Inline error phrase scans (explicit error phrases only)
    const errorPhrases = [
        'this field is required',
        'cannot read properties of undefined',
        'file must be uploaded',
        'fix the following errors',
        'please fix the errors'
    ];
    for (const ep of errorPhrases) {
        if (fullText.includes(ep) && !validationErrors.some(v => v.toLowerCase().includes(ep))) {
            validationErrors.push(ep);
        }
    }

    if (validationErrors.length > 0) {
        return {
            submitted: false,
            success: false,
            requires_manual: true,
            status: 'VALIDATION_ERROR',
            message: `Form rejected by ${atsType} validation: ${validationErrors.slice(0, 3).join('; ')}`,
            errors: validationErrors
        };
    }

    // 5. Submit button presence
    const submitBtn = frame.locator('button[type="submit"]:has-text("Submit"), button:has-text("Submit application"), button:has-text("Submit Application"), #submit_app, input[type="submit"]').first();
    const isSubmitDisabled = (typeof submitBtn.isDisabled === 'function') ? await submitBtn.isDisabled().catch(() => false) : false;
    const isSubmitStillPresent = await submitBtn.isVisible().catch(() => false) && !isSubmitDisabled;

    if (isSubmitStillPresent && !isUrlConfirmed && !isTextConfirmed) {
        return {
            submitted: false,
            success: false,
            requires_manual: true,
            status: 'FORM_STILL_OPEN',
            message: `Form autofilled, but ${atsType} submission did not complete (Submit button still active on screen).`,
            errors: ['Submission unconfirmed; submit button still visible']
        };
    }

    // ==========================================
    // RIGOROUS DECISION MATRIX:
    // ==========================================
    const isSubmissionSuccess = (isUrlConfirmed || isTextConfirmed || (apiSubmissionConfirmed && !isSubmitStillPresent));

    if (isSubmissionSuccess) {
        return {
            submitted: true,
            success: true,
            requires_manual: false,
            status: 'APPLIED',
            message: `${atsType} application confirmed & successfully submitted!`,
            errors: []
        };
    }

    return {
        submitted: false,
        success: false,
        requires_manual: true,
        status: 'UNVERIFIED',
        message: `Could not verify ${atsType} submission confirmation screen. Marked for manual review.`,
        errors: ['Unverified outcome']
    };
}

/**
 * Submits form and provides human-in-the-loop assistance window if CAPTCHA or bot challenge is detected.
 */
async function handleSubmitWithCaptchaWait(page, targetFrame, submitLocator, atsType, isHeaded, apiSubmissionConfirmed = false) {
    if (await submitLocator.count().catch(() => 0) > 0) {
        await submitLocator.click({ timeout: 6000 }).catch(e => console.log(`${atsType} click note:`, e.message));
        await page.waitForTimeout(4000);
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    }

    // Check for Email Verification / Security Code (Greenhouse, Lever, Ashby, etc.)
    const codeSelectors = '#security-input-0, input#security_code, input[id*="security-input" i], input[id*="security" i], input[name*="security" i], input[name*="code" i], input[id*="verification" i], input[placeholder*="security code" i], input[placeholder*="verification code" i], input[autocomplete="one-time-code"]';
    let codeInput = page.locator(codeSelectors).first();
    let hasCodeField = (await codeInput.count().catch(() => 0) > 0) && (await codeInput.isVisible().catch(() => false));

    if (hasCodeField) {
        console.log(`🔒 [Email Security Code] ${atsType} requested an email verification code!`);
        let codeRetrieved = false;
        try {
            const { pollForSecurityCode } = require('./services/gmailOtpService');
            console.log(`[Email Security Code] Checking configured Gmail (${process.env.GMAIL_USER || 'configured inbox'}) for code...`);
            const otpData = await pollForSecurityCode({ targetAts: atsType, timeoutMs: 15000 }).catch(() => null);
            if (otpData && otpData.code) {
                console.log(`✅ [Email Security Code] Auto-retrieved code: ${otpData.code}. Auto-filling field...`);
                await codeInput.fill(otpData.code);
                await page.waitForTimeout(1000);
                const resubmitLocator = page.locator('button[type="submit"]:has-text("Submit"), button:has-text("Submit application"), button:has-text("Resubmit"), button:has-text("Verify"), button:has-text("Confirm"), input[type="submit"]').first();
                if (await resubmitLocator.count() > 0 && await resubmitLocator.isVisible()) {
                    console.log(`[Email Security Code] Re-submitting application with verified code...`);
                    await resubmitLocator.click({ timeout: 6000 }).catch(() => {});
                    await page.waitForTimeout(4000);
                    codeRetrieved = true;
                }
            }
        } catch (otpErr) {
            console.warn(`[Email Security Code] Auto-fetch notice: ${otpErr.message}`);
        }

        if (!codeRetrieved && !isHeaded) {
            console.log(`⚠️ Email verification code required on ${atsType}! Flagging as CAPTCHA_REQUIRED.`);
            const screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
            return {
                success: false,
                submitted: false,
                requires_manual: true,
                captcha_required: true,
                status: 'CAPTCHA_REQUIRED',
                message: `${atsType} sent an 8-character security code to applicant email. Ready for code entry.`,
                screenshotBuffer
            };
        }
    }

    const captchaLocators = page.locator('iframe[title*="challenge" i], iframe[src*="recaptcha" i], iframe[src*="challenges.cloudflare.com" i], iframe[src*="hcaptcha" i], [data-sitekey], .g-recaptcha, .cf-turnstile, #cf-turnstile, div[class*="turnstile" i], div:has-text("Verify you are human"), div:has-text("Select all images with")');
    let isChallenge = (await captchaLocators.count().catch(() => 0) > 0) &&
                      (await captchaLocators.first().isVisible().catch(() => false));

    if (isChallenge) {
        console.log(`\n========================================================`);
        console.log(`👉 [Human-in-the-Loop] CAPTCHA detected on ${atsType}!`);
        console.log(`👉 Opening interactive CAPTCHA solver popup on localhost:3000...`);
        if (isHeaded) {
            console.log(`👉 (Chrome window is also open on your desktop)`);
        }
        console.log(`========================================================\n`);

        try {
            const captchaManager = require('./captcha_manager');
            const jobInfo = page._jobInfo || {
                jobId: 'active_session',
                company: atsType,
                role: 'Candidate Application',
                url: page.url()
            };

            const outcome = await captchaManager.registerChallenge({
                page,
                targetFrame,
                submitLocator,
                atsType,
                job: jobInfo,
                jobId: jobInfo.jobId || jobInfo.job_id || 'active_job',
                isHeaded,
                apiSubmissionConfirmed
            });

            if (outcome) {
                return outcome;
            }
        } catch (capErr) {
            console.error(`[CaptchaManager Error]`, capErr.message);
        }
    }

    const screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
    let verification = await verifySubmissionStrict(page, targetFrame, atsType, apiSubmissionConfirmed);

    // Double-check with Antigravity Vision via OmniRoute if Playwright thinks it was submitted
    if (verification.submitted && screenshotBuffer) {
        try {
            const { verifyJobProof } = require('./proof_verifier');
            console.log(`[Strict Verify] Running Antigravity Vision confirmation on ${atsType} proof screenshot...`);
            const aiCheck = await verifyJobProof({
                screenshotBuffer,
                company: atsType,
                updateDatabase: false
            });
            if (aiCheck && aiCheck.verified && aiCheck.is_false_positive) {
                console.warn(`[ProofVerifier] ⚠️ Overruling submission for ${atsType}: Antigravity Vision detected FALSE POSITIVE: ${aiCheck.reason}`);
                verification = {
                    submitted: false,
                    success: false,
                    requires_manual: true,
                    status: aiCheck.status === 'CAPTCHA_REQUIRED' ? 'CAPTCHA_REQUIRED' : 'MANUAL_REQUIRED',
                    captcha_required: aiCheck.status === 'CAPTCHA_REQUIRED',
                    message: `False positive caught by Antigravity Vision: ${aiCheck.reason}`
                };
            }
        } catch (vErr) {
            console.error('[ProofVerifier] Vision check error:', vErr.message);
        }
    }

    return {
        success: verification.success,
        submitted: verification.submitted,
        status: verification.status,
        captcha_required: verification.captcha_required,
        message: verification.message,
        screenshotBuffer
    };
}

const activeApplySessions = new Map();

/**
 * Halts all running Playwright application sessions immediately.
 */
async function stopAllApplySessions() {
    console.log(`[Apply] Halting all active auto-apply sessions (${activeApplySessions.size} active)...`);
    const promises = [];
    for (const [id, session] of activeApplySessions.entries()) {
        session.aborted = true;
        if (session.context) {
            promises.push(
                session.context.close().catch(e => console.log(`[Apply] Note while closing context ${id}:`, e.message))
            );
        }
    }
    activeApplySessions.clear();
    await Promise.allSettled(promises);
    return { success: true, count: promises.length };
}

/**
 * Halts a specific auto-apply session by jobId.
 */
async function stopApplySession(jobId) {
    if (!jobId) return false;
    for (const [id, session] of activeApplySessions.entries()) {
        if (session.jobId === jobId || id === jobId) {
            session.aborted = true;
            if (session.context) {
                await session.context.close().catch(() => {});
            }
            activeApplySessions.delete(id);
            return true;
        }
    }
    return false;
}

/**
 * Automates applying to Greenhouse, Lever, Ashby, or LinkedIn roles using Playwright.
 * @param {string} url Form application URL
 * @param {object} applicant Details containing name, email, socials, work auth.
 * @param {Buffer} pdfBuffer The generated PDF resume file bytes.
 * @param {boolean} autoSubmit If true, clicks submit. If false, fills and snaps a screenshot.
 * @param {object} options Optional settings: { headed: boolean, manualAssisted: boolean, keepOpen: boolean, jobId: string }
 * @returns {Promise<{success: boolean, submitted: boolean, message: string, screenshotBuffer: Buffer}>}
 */
async function autoApply(url, applicant, pdfBuffer, autoSubmit = false, options = {}) {
    const isManualAssisted = !!(options.manualAssisted || options.mode === 'manual' || options.keepOpen);
    const isHeaded = isManualAssisted || !!options.headed || process.env.HEADED === 'true';
    const effectiveAutoSubmit = isManualAssisted ? false : !!autoSubmit;
    const jobId = options.jobId || 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    console.log(`Starting Playwright browser for: ${url}... (Job: ${jobId}, Mode: ${isHeaded ? 'HEADED / Interactive' : 'HEADLESS'}${isManualAssisted ? ' [MANUAL-ASSISTED]' : ''})`);

    let context;
    let tempPdfPath = null;
    let profileDir = null;
    let sessionRecord = null;

    try {
        // Save PDF to a temporary file for reliable file chooser input
        if (pdfBuffer && Buffer.isBuffer(pdfBuffer)) {
            tempPdfPath = path.join(os.tmpdir(), `${applicant.firstName || 'Candidate'}_${applicant.lastName || 'Resume'}_${Date.now()}.pdf`);
            fs.writeFileSync(tempPdfPath, pdfBuffer);
        }

        const launchOptions = {
            headless: !isHeaded,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        };
        if (fs.existsSync('/Applications/Google Chrome.app')) {
            launchOptions.channel = 'chrome';
        }

        profileDir = path.join(os.tmpdir(), `pw_profile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        fs.mkdirSync(profileDir, { recursive: true });

        context = await chromium.launchPersistentContext(profileDir, {
            ...launchOptions,
            viewport: { width: 1280, height: 850 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        });

        sessionRecord = {
            sessionId: jobId,
            jobId: options.jobId || jobId,
            context,
            isManualAssisted,
            aborted: false,
            startTime: Date.now()
        };
        activeApplySessions.set(jobId, sessionRecord);

        const page = (context.pages().length > 0) ? context.pages()[0] : await context.newPage();
        sessionRecord.page = page;
        page._jobInfo = {
            jobId: options.jobId || (options.job && (options.job.job_id || options.job.id)) || jobId,
            company: (options.job && options.job.company) || applicant.targetCompany || '',
            role: (options.job && options.job.role) || applicant.targetRole || '',
            url
        };

        let isSubmittingActive = false;
        let apiSubmissionConfirmed = false;
        page.on('response', (response) => {
            if (!isSubmittingActive) return;
            try {
                const resUrl = response.url().toLowerCase();
                const status = response.status();
                const reqMethod = response.request().method();
                const postData = (response.request().postData() || '').toLowerCase();

                // Specifically match actual submission mutations, never page-load queries
                const isAshbySubmission = resUrl.includes('ashby') && (postData.includes('submitjobpostingapplication') || postData.includes('submitapplication'));
                const isGreenhouseSubmission = resUrl.includes('greenhouse.io') && resUrl.includes('/applications') && !resUrl.includes('tracking') && !resUrl.includes('analytics');
                const isLeverSubmission = resUrl.includes('lever.co') && (resUrl.includes('/apply') || resUrl.includes('/candidates'));

                if ((isAshbySubmission || isGreenhouseSubmission || isLeverSubmission) &&
                    (reqMethod === 'POST' || reqMethod === 'PUT') &&
                    (status >= 200 && status < 300)) {
                    console.log(`[Submission Interceptor] Genuine ATS submission HTTP ${status} confirmed for: ${resUrl}`);
                    apiSubmissionConfirmed = true;
                }
            } catch (e) {}
        });

        // 1. Go to page with robust retry / fallback
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        } catch (gotoErr) {
            console.warn(`[Apply] Navigation warning for ${url}: ${gotoErr.message}. Checking if page partially loaded...`);
            if (page.url() === 'about:blank') {
                await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
            }
        }

        let screenshotBuffer;
        let success = false;
        let submitted = false;
        let message = '';

        // On-page Duplicate Application Check: detect if ATS already received application from candidate
        const pageAppliedCheck = await checkPageAlreadyApplied(page);
        if (pageAppliedCheck && pageAppliedCheck.alreadyAppliedOnPage) {
            console.warn(`[Apply] 🛑 ATS portal confirms application already submitted: "${pageAppliedCheck.detectedText}". Aborting to prevent duplicate submission.`);
            screenshotBuffer = await page.screenshot({ fullPage: false }).catch(() => null);
            if (!isManualAssisted && context) {
                await context.close().catch(() => {});
            }
            return {
                success: true,
                already_applied: true,
                submitted: true,
                status: 'APPLIED',
                message: `Portal confirms you have already applied to this role (${pageAppliedCheck.detectedText}). Duplicate submission prevented.`,
                screenshotBuffer
            };
        }

        const currentUrl = page.url();

        // Determine platform dynamically from URL or DOM structure (including embedded ATS on career sites)
        const isGreenhouse = url.includes('greenhouse.io') || url.includes('gh_jid') || currentUrl.includes('greenhouse.io') || currentUrl.includes('gh_jid') || (await page.locator('#grnhse_app, form#application_form, [id*="greenhouse"], iframe[src*="greenhouse"]').count() > 0);
        const isLever = url.includes('lever.co') || currentUrl.includes('lever.co') || (await page.locator('.lever-form, [id*="lever"]').count() > 0);
        const isAshby = url.includes('ashbyhq.com') || url.includes('ashby') || currentUrl.includes('ashby') || (await page.locator('[data-testid*="ashby"], [class*="ashby"], form[action*="ashby"]').count() > 0);
        const isLinkedIn = url.includes('linkedin.com') || currentUrl.includes('linkedin.com');

        if (isGreenhouse) {
            console.log('Detected Greenhouse application form (direct or embedded)...');
            let targetFrame = page;
            const frames = page.frames();
            const ghFrame = frames.find(f => f.url().includes('greenhouse.io') || f.name().includes('grnhse'));
            if (ghFrame) {
                console.log('Targeting embedded Greenhouse iframe...');
                targetFrame = ghFrame;
            }

            await fillGreenhouse(targetFrame, applicant, pdfBuffer, tempPdfPath);
            await page.waitForTimeout(1500);

            if (effectiveAutoSubmit) {
                console.log('Submitting Greenhouse application...');
                isSubmittingActive = true;
                const submitLocator = targetFrame.locator('button[type="submit"]:has-text("Submit"), button:has-text("Submit application"), button:has-text("Submit Application"), #submit_app, input[type="submit"]').first();
                const outcome = await handleSubmitWithCaptchaWait(page, targetFrame, submitLocator, 'Greenhouse', isHeaded, apiSubmissionConfirmed);
                success = outcome.success;
                submitted = outcome.submitted;
                message = outcome.message;
                screenshotBuffer = outcome.screenshotBuffer;
            } else {
                screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
                success = true;
                submitted = false;
                message = isManualAssisted ? 'Greenhouse form autofilled. Window open on desktop for CAPTCHA review.' : 'Greenhouse form autofilled and screenshot recorded. Auto-submit is disabled.';
            }
        }
        else if (isLever) {
            console.log('Detected Lever application form...');
            const countApplyButtons = await page.locator('a.postings-btn:has-text("Apply")').count();
            if (countApplyButtons > 0) {
                await page.click('a.postings-btn:has-text("Apply")');
                await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
            }

            await fillLever(page, applicant, pdfBuffer, tempPdfPath);
            await page.waitForTimeout(1500);

            if (effectiveAutoSubmit) {
                console.log('Submitting Lever application...');
                isSubmittingActive = true;
                const submitLocator = page.locator('#btn-submit, button.postings-btn:not(.hidden):not([id*="hcaptcha" i]), button[type="submit"]:not(.hidden):not([id*="hcaptcha" i]), button:not(.hidden):has-text("Submit Application"), button:not(.hidden):has-text("Submit")').first();
                const outcome = await handleSubmitWithCaptchaWait(page, page, submitLocator, 'Lever', isHeaded, apiSubmissionConfirmed);
                success = outcome.success;
                submitted = outcome.submitted;
                message = outcome.message;
                screenshotBuffer = outcome.screenshotBuffer;
            } else {
                screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
                success = true;
                submitted = false;
                message = isManualAssisted ? 'Lever form autofilled. Window open on desktop for CAPTCHA review.' : 'Lever form autofilled and screenshot recorded. Auto-submit is disabled.';
            }
        }
        else if (isAshby) {
            console.log('Detected Ashby application form...');
            await fillAshby(page, applicant, pdfBuffer, tempPdfPath);
            await page.waitForTimeout(1500);

            if (effectiveAutoSubmit) {
                console.log('Submitting Ashby application...');
                isSubmittingActive = true;
                const submitLocator = page.locator('button[type="submit"], button:has-text("Submit Application"), button:has-text("Submit application"), button:has-text("Submit"), button:has-text("Apply Now")').first();
                const outcome = await handleSubmitWithCaptchaWait(page, page, submitLocator, 'Ashby', isHeaded, apiSubmissionConfirmed);
                success = outcome.success;
                submitted = outcome.submitted;
                message = outcome.message;
                screenshotBuffer = outcome.screenshotBuffer;
            } else {
                screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
                success = true;
                submitted = false;
                message = isManualAssisted ? 'Ashby form autofilled. Window open on desktop for CAPTCHA review.' : 'Ashby form autofilled and screenshot recorded. Auto-submit is disabled.';
            }
        }
        else if (isLinkedIn) {
            console.log('Detected LinkedIn application URL...');
            await page.waitForTimeout(2500);

            const isLoginWall = await page.locator('.join-form, .sign-in-form, [data-tracking-control-name*="sign-in-modal"], #base-contextual-sign-in-modal').count() > 0 || page.url().includes('/login');

            if (isLoginWall) {
                console.log('LinkedIn sign-in wall detected.');
                screenshotBuffer = await page.screenshot({ fullPage: false }).catch(() => null);
                success = false;
                submitted = false;
                message = 'LinkedIn authentication required. Please click "Sign in to LinkedIn" in the dashboard header to connect your account.';
            } else {
                const easyApplyBtn = page.locator('button.jobs-apply-button:has-text("Easy Apply"), button:has-text("Easy Apply")').first();
                const hasEasyApply = await easyApplyBtn.count() > 0;

                if (hasEasyApply) {
                    console.log('Found LinkedIn Easy Apply button. Clicking...');
                    await easyApplyBtn.click();
                    await page.waitForTimeout(2000);

                    // Autofill phone number
                    await fillInput(page, 'input[id*="phoneNumber"], input[name*="phoneNumber"]', applicant.phone);

                    // Attach resume PDF
                    const fileInput = page.locator('input[type="file"]').first();
                    if (await fileInput.count() > 0) {
                        if (tempPdfPath && fs.existsSync(tempPdfPath)) {
                            await fileInput.setInputFiles(tempPdfPath).catch(() => {});
                        } else if (pdfBuffer) {
                            await fileInput.setInputFiles({
                                name: `${applicant.firstName}_${applicant.lastName}_Resume.pdf`,
                                mimeType: 'application/pdf',
                                buffer: pdfBuffer
                            }).catch(() => {});
                        }
                    }

                    // Progress through multi-step dialog
                    let reachedEnd = false;
                    if (effectiveAutoSubmit) {
                        for (let s = 0; s < 5; s++) {
                            const submitBtn = page.locator('button[aria-label="Submit application"], button:has-text("Submit application")').first();
                            if (await submitBtn.count() > 0 && await submitBtn.isVisible().catch(() => false)) {
                                await submitBtn.click({ timeout: 4000 }).catch(() => {});
                                await page.waitForTimeout(2500);
                                reachedEnd = true;
                                break;
                            }

                            const reviewBtn = page.locator('button[aria-label="Review your application"], button:has-text("Review")').first();
                            if (await reviewBtn.count() > 0 && await reviewBtn.isVisible().catch(() => false)) {
                                await reviewBtn.click({ timeout: 4000 }).catch(() => {});
                                await page.waitForTimeout(1500);
                                continue;
                            }

                            const nextBtn = page.locator('button[aria-label="Continue to next step"], button:has-text("Next")').first();
                            if (await nextBtn.count() > 0 && await nextBtn.isVisible().catch(() => false)) {
                                const radios = await page.$$('input[type="radio"][value*="Yes"], input[type="radio"][value*="1"]');
                                for (const r of radios) { await r.check().catch(() => {}); }
                                await nextBtn.click({ timeout: 4000 }).catch(() => {});
                                await page.waitForTimeout(1500);
                                continue;
                            }
                            break;
                        }
                    }

                    screenshotBuffer = await page.screenshot({ fullPage: false }).catch(() => null);

                    const pageText = (await page.innerText('body').catch(() => '')).toLowerCase();
                    const isApplicationSent = pageText.includes('application sent') || pageText.includes('your application was sent');

                    if (effectiveAutoSubmit && isApplicationSent) {
                        success = true;
                        submitted = true;
                        message = 'LinkedIn Easy Apply confirmed & submitted successfully!';
                    } else if (effectiveAutoSubmit && !reachedEnd) {
                        success = false;
                        submitted = false;
                        message = 'LinkedIn Easy Apply stopped due to unanswered questions or verification step.';
                    } else {
                        success = true;
                        submitted = false;
                        message = 'LinkedIn Easy Apply opened & pre-filled. Ready for final user review.';
                    }
                } else {
                    const applyBtn = page.locator('button.jobs-apply-button, a.jobs-apply-button, button:has-text("Apply")').first();
                    if (await applyBtn.count() > 0) {
                        const href = await applyBtn.getAttribute('href').catch(() => null);
                        screenshotBuffer = await page.screenshot({ fullPage: false }).catch(() => null);
                        success = true;
                        submitted = false;
                        message = href ? `LinkedIn directs to external career site (${href}). Pre-fill prepared.` : 'LinkedIn listing directs to external application portal.';
                    } else {
                        screenshotBuffer = await page.screenshot({ fullPage: false }).catch(() => null);
                        success = true;
                        submitted = false;
                        message = 'LinkedIn job details loaded. Click Apply Link on card to complete submission.';
                    }
                }
            }
        }
        else {
            console.log('Executing universal application form autofill & submission...');
            await fillGeneric(page, applicant, pdfBuffer, tempPdfPath);
            await page.waitForTimeout(1500);

            if (effectiveAutoSubmit) {
                console.log('Attempting generic submit click...');
                const submitLocator = page.locator('button[type="submit"], input[type="submit"], button:has-text("Submit Application"), button:has-text("Submit application"), button:has-text("Submit"), button:has-text("Apply Now"), button:has-text("Send Application")').first();
                const outcome = await handleSubmitWithCaptchaWait(page, page, submitLocator, 'Generic', isHeaded, apiSubmissionConfirmed);
                success = outcome.success;
                submitted = outcome.submitted;
                message = outcome.message;
                screenshotBuffer = outcome.screenshotBuffer;
            } else {
                screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);
                success = true;
                submitted = false;
                message = isManualAssisted ? 'Generic form autofilled. Window open on desktop for CAPTCHA review.' : 'Form autofilled by best-effort. Auto-submit is disabled.';
            }
        }

        // ==========================================
        // MANUAL-ASSISTED WORKFLOW
        // Keep browser alive & visible on macOS desktop for user to solve CAPTCHA & submit
        // ==========================================
        if (isManualAssisted) {
            try {
                const captchaOrSubmit = page.locator('iframe[title*="challenge" i], iframe[src*="recaptcha" i], iframe[src*="challenges.cloudflare.com" i], iframe[src*="hcaptcha" i], .cf-turnstile, #cf-turnstile, div[class*="turnstile" i], button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")').first();
                if (await captchaOrSubmit.count().catch(() => 0) > 0) {
                    await captchaOrSubmit.scrollIntoViewIfNeeded().catch(() => {});
                }
            } catch (e) {}

            await page.bringToFront().catch(() => {});
            screenshotBuffer = await page.screenshot({ fullPage: false }).catch(() => null);

            message = 'Form autofilled & resume attached! Chrome window is open on your desktop — please solve the CAPTCHA and submit.';

            // Monitor background submission if jobId provided
            if (options.jobId) {
                const monitoredJobId = options.jobId;
                const checkUrlConfirmation = async () => {
                    try {
                        const cur = page.url().toLowerCase();
                        const isConfirmed = cur.includes('/thanks') ||
                            cur.includes('/thank-you') ||
                            cur.includes('/confirmation') ||
                            cur.includes('/applied') ||
                            cur.includes('/application-submitted') ||
                            cur.includes('/job-application-confirmation') ||
                            cur.includes('#thanks') ||
                            cur.includes('success=true');

                        if (isConfirmed) {
                            console.log(`[Manual-Assisted] Application confirmed via page navigation for job ${monitoredJobId}!`);
                            const { runQuery, getQuery } = require('./db');
                            const now = new Date().toISOString();
                            await runQuery("UPDATE jobs SET status = 'APPLIED', applied_at = ?, application_status = 'Submitted by candidate after CAPTCHA' WHERE job_id = ?", [now, monitoredJobId]);
                            const app = await getQuery('SELECT id FROM applications WHERE job_id = ?', [monitoredJobId]);
                            if (app) {
                                await runQuery("UPDATE applications SET status = 'SUBMITTED', applied_at = ?, updated_at = ? WHERE id = ?", [now, now, app.id]);
                            }
                        }
                    } catch (e) {}
                };
                page.on('framenavigated', checkUrlConfirmation);
            }

            // Deferred resource cleanup when candidate closes the window
            context.on('close', () => {
                console.log(`[Manual-Assisted] Chrome window closed for job ${options.jobId || ''}`);
                if (tempPdfPath && fs.existsSync(tempPdfPath)) {
                    try { fs.unlinkSync(tempPdfPath); } catch (e) {}
                }
                if (profileDir && fs.existsSync(profileDir)) {
                    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
                }
            });

            return {
                success: true,
                submitted: false,
                manualAssisted: true,
                message,
                screenshotBuffer
            };
        }

        if (context) await context.close().catch(() => {});

        // Clean up temp file
        if (tempPdfPath && fs.existsSync(tempPdfPath)) {
            try { fs.unlinkSync(tempPdfPath); } catch (e) {}
        }
        if (profileDir && fs.existsSync(profileDir)) {
            try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
        }

        return { success, submitted, message, screenshotBuffer };

    } catch (err) {
        const isAbort = (sessionRecord && sessionRecord.aborted) ||
                        err.message.includes('Application stopped by user') ||
                        err.message.includes('Target page, context or browser has been closed') ||
                        err.message.includes('Target closed') ||
                        err.message.includes('Browser has been closed') ||
                        err.message.includes('browser has been closed');

        if (isAbort) {
            console.log(`[Auto-Apply] Session for job ${jobId} was stopped by user.`);
            if (context && !isManualAssisted) await context.close().catch(() => {});
            if (tempPdfPath && fs.existsSync(tempPdfPath)) {
                try { fs.unlinkSync(tempPdfPath); } catch (e) {}
            }
            if (profileDir && fs.existsSync(profileDir)) {
                try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
            }
            return {
                success: false,
                submitted: false,
                status: 'STOPPED',
                requires_manual: true,
                reason: 'Auto-apply stopped by user',
                message: 'Auto-apply stopped by user.',
                screenshotBuffer: null
            };
        }

        console.error('Error during auto-application:', err);
        if (context && !isManualAssisted) await context.close().catch(() => {});
        if (tempPdfPath && fs.existsSync(tempPdfPath) && !isManualAssisted) {
            try { fs.unlinkSync(tempPdfPath); } catch (e) {}
        }
        if (profileDir && fs.existsSync(profileDir) && !isManualAssisted) {
            try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
        }
        return { success: false, submitted: false, message: `Application failed: ${err.message}`, screenshotBuffer: null };
    } finally {
        if (sessionRecord) {
            activeApplySessions.delete(jobId);
        }
    }
}

/**
 * Robust input filler that handles standard inputs, React synthetic event setters, and event bubbling.
 */
async function fillInput(container, selector, value) {
    try {
        if (!value) return;
        const locator = container.locator(selector).first();
        if (await locator.count() > 0) {
            await locator.scrollIntoViewIfNeeded().catch(() => {});
            await locator.click().catch(() => {});
            await locator.fill(value);
            await locator.evaluate((node, val) => {
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(node, val);
                } else {
                    node.value = val;
                }
                node.dispatchEvent(new Event('input', { bubbles: true }));
                node.dispatchEvent(new Event('change', { bubbles: true }));
                node.dispatchEvent(new Event('blur', { bubbles: true }));
            }, value).catch(() => {});
        }
    } catch (e) {
        console.warn(`Could not fill selector ${selector}:`, e.message);
    }
}

/**
 * Fills location input and handles autocomplete/places dropdown selection.
 */
async function fillLocationInput(container, locationValue) {
    if (!locationValue) return;
    const locSelectors = [
        '#candidate-location',
        'input#location',
        'input[name="job_application[location]"]',
        'input[name*="location" i]',
        'input[id*="location" i]',
        'input[placeholder*="location" i]',
        'input[placeholder*="city" i]'
    ];
    for (const sel of locSelectors) {
        try {
            const locator = container.locator(sel).first();
            if (await locator.count() > 0) {
                await locator.scrollIntoViewIfNeeded().catch(() => {});
                await locator.click().catch(() => {});
                await locator.fill('');
                await locator.type(locationValue, { delay: 35 });
                await container.waitForTimeout(800);

                // Check if Google Places or custom autocomplete suggestion list appeared
                const suggestion = container.locator('.pac-item, [role="option"], .autocomplete-suggestion, .tt-suggestion, div[class*="suggestion"], div[class*="autocomplete-item"]').first();
                if (await suggestion.count() > 0 && await suggestion.isVisible().catch(() => false)) {
                    await suggestion.click().catch(() => {});
                } else {
                    const pageObj = container.page ? container.page() : container;
                    if (pageObj && pageObj.keyboard) {
                        await pageObj.keyboard.press('ArrowDown').catch(() => {});
                        await pageObj.keyboard.press('Enter').catch(() => {});
                    }
                }
                break;
            }
        } catch (e) {}
    }
}

/**
 * Comprehensive dropdown, combobox, and required checkbox handler.
 */
async function answerDropdownsAndSelects(container, applicant) {
    try {
        // 1. Native <select> elements
        const selects = await container.$$('select');
        for (const select of selects) {
            try {
                const id = await select.getAttribute('id');
                const name = (await select.getAttribute('name') || '').toLowerCase();
                let labelText = '';
                if (id) {
                    const labelEl = await container.$(`label[for="${id}"]`);
                    if (labelEl) labelText = (await labelEl.innerText()).toLowerCase();
                }
                if (!labelText) {
                    const parent = await select.evaluateHandle(el => el.closest('.field, .application-question, div, tr'));
                    if (parent) labelText = (await parent.innerText().catch(() => '')).toLowerCase();
                }

                const options = await select.$$eval('option', opts => opts.map(o => ({ value: o.value, text: o.text.trim() })));
                const validOptions = options.filter(o => o.value && o.text && !o.text.toLowerCase().includes('select') && !o.text.toLowerCase().includes('choose'));

                if (validOptions.length === 0) continue;

                const fullQuestion = `${labelText} ${name}`;

                // Work Authorization
                if (fullQuestion.includes('authorized') || fullQuestion.includes('legal right to work') || fullQuestion.includes('legally eligible')) {
                    const yesOpt = validOptions.find(o => o.text.toLowerCase() === 'yes' || o.text.toLowerCase().startsWith('yes'));
                    if (yesOpt) await select.selectOption(yesOpt.value);
                }
                // Visa Sponsorship
                else if (fullQuestion.includes('sponsorship') || fullQuestion.includes('visa')) {
                    const targetText = (applicant.requiresSponsorship === 'Yes') ? 'yes' : 'no';
                    const targetOpt = validOptions.find(o => o.text.toLowerCase() === targetText || o.text.toLowerCase().startsWith(targetText));
                    if (targetOpt) await select.selectOption(targetOpt.value);
                }
                // Willing to Relocate
                else if (fullQuestion.includes('relocate') || fullQuestion.includes('willing to relocate')) {
                    const yesOpt = validOptions.find(o => o.text.toLowerCase() === 'yes' || o.text.toLowerCase().startsWith('yes'));
                    if (yesOpt) await select.selectOption(yesOpt.value);
                }
                // Previously Employed
                else if (fullQuestion.includes('previously employed') || fullQuestion.includes('worked at') || fullQuestion.includes('former employee')) {
                    const noOpt = validOptions.find(o => o.text.toLowerCase() === 'no' || o.text.toLowerCase().startsWith('no'));
                    if (noOpt) await select.selectOption(noOpt.value);
                }
                // Conflict of interest / family members / outside business
                else if (fullQuestion.includes('family member') || fullQuestion.includes('personal relationship') || fullQuestion.includes('outside business')) {
                    const noOpt = validOptions.find(o => o.text.toLowerCase() === 'no' || o.text.toLowerCase().startsWith('no'));
                    if (noOpt) await select.selectOption(noOpt.value);
                }
                // Language fluency
                else if (fullQuestion.includes('language') || fullQuestion.includes('speak')) {
                    const yesOpt = validOptions.find(o => o.text.toLowerCase() === 'yes' || o.text.toLowerCase().startsWith('yes') || o.text.toLowerCase().includes('fluent') || o.text.toLowerCase().includes('professional'));
                    if (yesOpt) await select.selectOption(yesOpt.value);
                }
                // How did you hear
                else if (fullQuestion.includes('hear') || fullQuestion.includes('source') || fullQuestion.includes('learn about')) {
                    const bestOpt = validOptions.find(o => o.text.toLowerCase().includes('linkedin') || o.text.toLowerCase().includes('website') || o.text.toLowerCase().includes('job board') || o.text.toLowerCase().includes('internet')) || validOptions[0];
                    if (bestOpt) await select.selectOption(bestOpt.value);
                }
                // Pronouns
                else if (fullQuestion.includes('pronoun')) {
                    const opt = validOptions.find(o => o.text.toLowerCase().includes('he/him') || o.text.toLowerCase().includes('he / him') || o.text.toLowerCase().includes('prefer not') || o.text.toLowerCase().includes('decline')) || validOptions[0];
                    if (opt) await select.selectOption(opt.value);
                }
                // Demographics (Gender, Race, Veteran, Disability)
                else if (fullQuestion.includes('gender') || fullQuestion.includes('race') || fullQuestion.includes('ethnicity') || fullQuestion.includes('veteran') || fullQuestion.includes('disability')) {
                    const opt = validOptions.find(o => o.text.toLowerCase().includes('decline') || o.text.toLowerCase().includes('prefer not') || o.text.toLowerCase().includes('do not wish') || o.text.toLowerCase().includes('not a veteran') || o.text.toLowerCase().includes('no, i don')) || validOptions[0];
                    if (opt) await select.selectOption(opt.value);
                }
                // Default fallback for required select
                else {
                    const isRequired = (await select.getAttribute('required') !== null) || fullQuestion.includes('*') || fullQuestion.includes('required');
                    if (isRequired) {
                        const opt = validOptions.find(o => o.text.toLowerCase().includes('decline') || o.text.toLowerCase().includes('prefer not') || o.text.toLowerCase().includes('n/a') || o.text.toLowerCase() === 'no') || validOptions[0];
                        if (opt) await select.selectOption(opt.value);
                    }
                }
            } catch (selErr) {}
        }

        // 2. Modern Greenhouse / React-Select containers (.select__container)
        const selectContainers = await container.$$('.select__container');
        for (const sc of selectContainers) {
            try {
                const labelText = (await sc.$eval('label', l => l.innerText).catch(() => '')).toLowerCase();
                const ctrl = await sc.$('.select__control');
                if (!ctrl) continue;
                await ctrl.click().catch(() => {});
                await container.waitForTimeout(250);

                const options = await container.$$eval('.select__menu [role="option"], .select__menu div[class*="option"]', opts => opts.map(o => o.innerText.trim())).catch(() => []);
                let chosen = null;

                if (labelText.includes('country') || labelText.includes('phone code') || labelText.includes('reside')) {
                    chosen = options.find(o => o.toLowerCase().startsWith('india') || o.includes('+91'));
                } else if (labelText.includes('earliest') || labelText.includes('join') || labelText.includes('start date')) {
                    chosen = options.find(o => o.toLowerCase().includes('on or before') || o.toLowerCase().includes('immediate') || o.toLowerCase().includes('jan') || o.toLowerCase().includes('winter') || o.toLowerCase().includes('30 days'));
                } else if (labelText.includes('work from') || labelText.includes('bangalore') || labelText.includes('office') || labelText.includes('neural network') || labelText.includes('from scratch') || labelText.includes('authorized') || labelText.includes('eligible') || labelText.includes('relocate') || labelText.includes('whatsapp') || labelText.includes('opt-in')) {
                    chosen = options.find(o => o.toLowerCase() === 'yes' || o.toLowerCase().startsWith('yes'));
                } else if (labelText.includes('sponsorship') || labelText.includes('visa')) {
                    const targetText = (applicant.requiresSponsorship === 'Yes') ? 'yes' : 'no';
                    chosen = options.find(o => o.toLowerCase() === targetText || o.toLowerCase().startsWith(targetText));
                } else if (labelText.includes('month')) {
                    chosen = options.find(o => o.toLowerCase().includes('may') || o.toLowerCase().includes('june')) || options[0];
                } else if (labelText.includes('school') || labelText.includes('university')) {
                    chosen = options.find(o => o.toLowerCase().includes('pandit') || o.toLowerCase().includes('deendayal') || o.toLowerCase().includes('other')) || options[0];
                } else if (labelText.includes('degree')) {
                    chosen = options.find(o => o.toLowerCase().includes('bachelor') || o.toLowerCase().includes('b.tech') || o.toLowerCase().includes('undergraduate')) || options[0];
                } else if (labelText.includes('discipline')) {
                    chosen = options.find(o => o.toLowerCase().includes('computer engineering') || o.toLowerCase().includes('computer science') || o.toLowerCase().includes('engineering')) || options[0];
                } else if (labelText.includes('education')) {
                    chosen = options.find(o => o.toLowerCase().includes('bachelor') || o.toLowerCase().includes('b.tech') || o.toLowerCase().includes('cs'));
                } else if (labelText.includes('hands-on experience') || labelText.includes('experience')) {
                    chosen = options.find(o => o.toLowerCase().includes('1-2 years') || o.toLowerCase().includes('6-12 months') || o.toLowerCase().includes('1 year'));
                } else if (labelText.includes('gender') || labelText.includes('race') || labelText.includes('ethnicity') || labelText.includes('veteran') || labelText.includes('disability')) {
                    chosen = options.find(o => o.toLowerCase().includes('decline') || o.toLowerCase().includes('prefer not') || o.toLowerCase().includes('do not wish') || o.toLowerCase().includes('not a veteran') || o.toLowerCase().includes('no, i don')) || options[0];
                }

                if (!chosen && options.length > 0) {
                    chosen = options.find(o => !o.toLowerCase().includes('select') && !o.toLowerCase().includes('choose')) || options[0];
                }

                if (chosen) {
                    const optLocator = container.locator(`.select__menu [role="option"]:has-text("${chosen}"), .select__menu div[class*="option"]:has-text("${chosen}")`).first();
                    await optLocator.click({ timeout: 3000 }).catch(async () => {
                        const pageObj = container.page ? container.page() : container;
                        if (pageObj && pageObj.keyboard) await pageObj.keyboard.press('Escape').catch(() => {});
                    });
                } else {
                    const pageObj = container.page ? container.page() : container;
                    if (pageObj && pageObj.keyboard) await pageObj.keyboard.press('Escape').catch(() => {});
                }
                await container.waitForTimeout(150);
            } catch (scErr) {}
        }

        // 3. Custom dropdowns / buttons ([role="combobox"], custom Greenhouse/Ashby selects not inside .select__container)
        const customSelects = await container.$$('[role="combobox"]:not(.select__input), [aria-haspopup="listbox"]:not(.select__control)');
        for (const cs of customSelects) {
            try {
                const isExpanded = await cs.getAttribute('aria-expanded');
                if (isExpanded === 'false' || !isExpanded) {
                    await cs.click({ timeout: 2000 }).catch(() => {});
                    await container.waitForTimeout(300);
                    const listboxOpts = await container.$$('[role="option"], .select__option');
                    if (listboxOpts.length > 0) {
                        await listboxOpts[0].click({ timeout: 2000 }).catch(() => {});
                    } else {
                        await cs.click({ timeout: 2000 }).catch(() => {});
                    }
                }
            } catch (e) {}
        }

        // 4. Checkboxes (Privacy policy, consent, terms, required checkboxes)
        const checkboxes = await container.$$('input[type="checkbox"]');
        for (const cb of checkboxes) {
            try {
                const isChecked = await cb.isChecked().catch(() => false);
                if (isChecked) continue;

                const isRequired = (await cb.getAttribute('required') !== null);
                const parent = await cb.evaluateHandle(el => el.closest('label, .field, div'));
                const labelText = parent ? (await parent.innerText().catch(() => '')).toLowerCase() : '';

                const isPrivacyOrConsent =
                    labelText.includes('privacy') ||
                    labelText.includes('policy') ||
                    labelText.includes('consent') ||
                    labelText.includes('agree') ||
                    labelText.includes('acknowledge') ||
                    labelText.includes('terms') ||
                    labelText.includes('authorize');

                if (isRequired || isPrivacyOrConsent) {
                    await cb.check({ force: true }).catch(() => cb.click({ force: true }).catch(() => {}));
                }
            } catch (e) {}
        }

        // 5. Required Fieldset Checkboxes (e.g. public repos / contributions)
        const fieldsetCheckboxes = await container.$$('fieldset[aria-required="true"], fieldset.checkbox');
        for (const fs of fieldsetCheckboxes) {
            try {
                const anyChecked = await fs.$('input[type="checkbox"]:checked');
                if (!anyChecked) {
                    const legendText = (await fs.$eval('legend', l => l.innerText).catch(() => '')).toLowerCase();
                    const cbs = await fs.$$('input[type="checkbox"]');
                    let checkedAny = false;
                    for (const cb of cbs) {
                        const cbId = await cb.getAttribute('id');
                        const cbLabel = cbId ? (await fs.$eval(`[for="${cbId.replace(/"/g, '\\"')}"]`, l => l.innerText).catch(() => '')).toLowerCase() : '';
                        if (legendText.includes('point to publicly') || legendText.includes('publicly') || legendText.includes('github') || legendText.includes('open-source')) {
                            if (cbLabel.includes('open-source') || cbLabel.includes('github') || cbLabel.includes('public')) {
                                await cb.check({ force: true }).catch(() => cb.click({ force: true }).catch(() => {}));
                                checkedAny = true;
                            }
                        } else if (cbLabel.includes('january') || cbLabel.includes('6 months') || cbLabel.includes('jan - jun') || cbLabel.includes('winter')) {
                            await cb.check({ force: true }).catch(() => cb.click({ force: true }).catch(() => {}));
                            checkedAny = true;
                        }
                    }
                    if (!checkedAny && cbs.length > 0) {
                        await cbs[0].check({ force: true }).catch(() => cbs[0].click({ force: true }).catch(() => {}));
                    }
                }
            } catch (fsErr) {}
        }
    } catch (err) {
        console.warn('answerDropdownsAndSelects note:', err.message);
    }
}

/**
 * Automatically inspects unfilled inputs, textareas, and radio buttons
 * and answers them dynamically via candidate profile & LLM.
 */
async function autoAnswerCustomQuestions(container, applicant) {
    try {
        console.log('[AI Form Filler] Inspecting custom questions on page...');

        // 1. Unfilled Text Inputs and Textareas (exclude react-select dropdown inputs)
        const inputs = await container.$$('input[type="text"]:not(.select__input), input[type="number"], input:not([type]):not(.select__input), textarea');
        for (const input of inputs) {
            try {
                const isVisible = await input.isVisible().catch(() => false);
                if (!isVisible) continue;

                const className = (await input.getAttribute('class') || '').toLowerCase();
                const role = (await input.getAttribute('role') || '').toLowerCase();
                if (className.includes('select__') || role === 'combobox') continue;

                const curVal = await input.inputValue().catch(() => '');
                if (curVal && curVal.trim().length > 0) continue;

                const id = await input.getAttribute('id');
                const name = (await input.getAttribute('name') || '').toLowerCase();
                const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
                let labelText = '';

                if (id) {
                    const labelEl = await container.$(`label[for="${id}"]`);
                    if (labelEl) labelText = (await labelEl.innerText()).trim();
                }
                if (!labelText) {
                    const leverPrev = await input.evaluate(el => {
                        const af = el.closest('.application-field');
                        const prev = af ? af.previousElementSibling : el.previousElementSibling;
                        return prev && prev.classList && prev.classList.contains('application-label') ? prev.innerText : null;
                    }).catch(() => null);
                    if (leverPrev) labelText = leverPrev.trim();
                }
                if (!labelText) {
                    const parent = await input.evaluateHandle(el => el.closest('label, div.field, div.application-question, div[class*="field" i], tr, p'));
                    if (parent) {
                        const pLabel = await parent.$('label, .application-label, legend, span[class*="label" i]');
                        if (pLabel) labelText = (await pLabel.innerText()).trim();
                        else labelText = (await parent.innerText().catch(() => '')).trim();
                    }
                }
                if (!labelText && placeholder) {
                    labelText = placeholder;
                }

                if (!labelText || labelText.length < 2) continue;

                // Skip core fields already handled by specialized platform fillers
                const lLower = labelText.toLowerCase();
                if (lLower.includes('first name') || lLower.includes('last name') || lLower.includes('legal name') || lLower.includes('full name') || lLower.includes('email') || lLower.includes('phone') || lLower.includes('location') || lLower.includes('resume') || lLower.includes('cv') || lLower.includes('linkedin') || lLower.includes('github') || lLower.includes('portfolio') || lLower.includes('employer') || lLower.includes('university') || lLower.includes('school') || lLower.includes('pronoun')) {
                    continue;
                }

                const answer = await answerFormQuestion(labelText, `${name} ${placeholder}`);
                if (answer && answer.trim().length > 0 && answer !== 'MANUAL_REQUIRED') {
                    console.log(`[AI Form Filler] Filled "${labelText.slice(0, 45)}..." -> "${answer.slice(0, 35)}"`);
                    await input.fill(answer).catch(() => {});
                    await container.waitForTimeout(100);
                }
            } catch (err) {}
        }

        // 2. Radio Button Groups (Yes/No questions)
        const radioGroups = await container.$$('fieldset:has(input[type="radio"]), div.field:has(input[type="radio"]), div[class*="radio" i], div.application-question:has(input[type="radio"]), .ashby-application-form-input-radio-group, div:has(> [class*="radio-group-option"])');
        for (const group of radioGroups) {
            try {
                const anyChecked = await group.$('input[type="radio"]:checked');
                if (anyChecked) continue;

                const legendEl = await group.$('legend, label, span[class*="label" i], div[class*="title" i], div[class*="label" i]');
                let questionText = legendEl ? (await legendEl.innerText()).trim() : '';
                if (!questionText) {
                    const parent = await group.evaluateHandle(el => el.closest('div'));
                    if (parent) questionText = (await parent.innerText().catch(() => '')).trim();
                }
                if (!questionText || questionText.length < 3) continue;

                const answer = await answerFormQuestion(questionText);
                const isYes = answer.toLowerCase().includes('yes') || answer.toLowerCase().startsWith('y');

                const targetRadio = await group.$(`input[type="radio"][value*="${isYes ? 'Yes' : 'No'}" i], label:has-text("${isYes ? 'Yes' : 'No'}"), [class*="radio-group-option"]:has-text("${isYes ? 'Yes' : 'No'}")`);
                if (targetRadio) {
                    await targetRadio.check().catch(async () => {
                        await targetRadio.click({ force: true }).catch(async () => {
                            await targetRadio.evaluate(el => {
                                const input = el.tagName === 'INPUT' ? el : el.querySelector('input[type="radio"]');
                                if (input) {
                                    input.checked = true;
                                    input.dispatchEvent(new Event('change', { bubbles: true }));
                                    input.dispatchEvent(new Event('click', { bubbles: true }));
                                } else {
                                    el.click();
                                }
                            }).catch(() => {});
                        });
                    });
                    console.log(`[AI Form Filler] Checked radio (${isYes ? 'Yes' : 'No'}) for: "${questionText.slice(0, 45)}..."`);
                }
            } catch (err) {}
        }
    } catch (e) {
        console.warn('[AI Form Filler] Scan notice:', e.message);
    }
}

async function fillGreenhouse(page, applicant, pdfBuffer, tempPdfPath) {
    // 1. Basic details (Supports both modern Greenhouse React IDs and classic name attributes)
    await fillInput(page, '#first_name, input[name="job_application[first_name]"], input[name="first_name"], input[autocomplete="given-name"], input[id*="first_name" i]', applicant.firstName);
    await fillInput(page, '#last_name, input[name="job_application[last_name]"], input[name="last_name"], input[autocomplete="family-name"], input[id*="last_name" i]', applicant.lastName);
    await fillInput(page, '#email, input[name="job_application[email]"], input[name="email"], input[type="email"]', applicant.email);
    await fillInput(page, '#phone, input[name="job_application[phone]"], input[name="phone"], input[type="tel"]', applicant.phone);

    // Location with autocomplete
    await fillLocationInput(page, applicant.location);

    // Direct Resume PDF Upload
    const fileSelector = 'input#resume[type="file"], input[type="file"][name*="resume" i], input[data-qa*="resume" i], input[type="file"]';
    const fileLocator = page.locator(fileSelector).first();
    if (await fileLocator.count() > 0) {
        console.log('Uploading resume PDF to Greenhouse...');
        if (tempPdfPath && fs.existsSync(tempPdfPath)) {
            await fileLocator.setInputFiles(tempPdfPath).catch(err => console.warn('File upload note:', err.message));
        } else if (pdfBuffer) {
            await fileLocator.setInputFiles({
                name: `${applicant.firstName}_${applicant.lastName}_Resume.pdf`,
                mimeType: 'application/pdf',
                buffer: pdfBuffer
            }).catch(err => console.warn('File upload note:', err.message));
        }
        await page.waitForTimeout(1000);
    }

    // Dynamic question labels
    const labels = await page.$$('label');
    for (const label of labels) {
        try {
            const text = (await label.innerText()).toLowerCase();
            const forAttr = await label.getAttribute('for');
            if (!forAttr) continue;
            const safeSelector = `[id="${forAttr.replace(/"/g, '\\"')}"]`;
            const targetEl = await page.$(safeSelector);
            if (!targetEl) continue;
            const targetType = (await targetEl.getAttribute('type') || '').toLowerCase();
            if (targetType === 'checkbox' || targetType === 'radio') continue;

            if (text.includes('linkedin')) {
                await fillInput(page, safeSelector, applicant.linkedin);
            } else if (text.includes('website') || text.includes('portfolio')) {
                await fillInput(page, safeSelector, applicant.portfolio);
            } else if (text.includes('github') && !text.includes('repo')) {
                await fillInput(page, safeSelector, applicant.github);
            } else if (text.includes('preferred first name') || text.includes('preferred name')) {
                await fillInput(page, safeSelector, applicant.firstName);
            } else if (text.includes('current or previous employer') || text.includes('most recent employer') || text.includes('current company') || text.includes('previous employer')) {
                await fillInput(page, safeSelector, applicant.currentCompany || 'Space Applications Centre (ISRO)');
            } else if (text.includes('current or previous job title') || text.includes('most recent job title') || text.includes('previous job title')) {
                await fillInput(page, safeSelector, 'Software Engineering Intern');
            } else if (text.includes('gpa') || text.includes('grade point')) {
                await fillInput(page, safeSelector, '3.42 / 4.00');
            } else if (text.includes('offer deadline') || text.includes('recruiting-process deadline')) {
                await fillInput(page, safeSelector, 'No active offer deadlines at this time.');
            } else if (text.includes('not see your university') || text.includes('school name here')) {
                await fillInput(page, safeSelector, 'Pandit Deendayal Energy University');
            } else if (text.includes('start date year') || text.includes('start year')) {
                await fillInput(page, safeSelector, '2023');
            } else if (text.includes('end date year') || text.includes('graduation year') || text.includes('end year')) {
                await fillInput(page, safeSelector, '2027');
            } else if (text.includes('why do you want to join') || text.includes('why figma') || text.includes('why this role') || text.includes('why stripe')) {
                const whyEssay = `I am excited by the company's mission and engineering challenges. Bringing my background building full-stack platforms (Monerva, Kronos) and my SWE internship at SAC/ISRO developing high-performance telemetry and Agentic architectures, I am eager to apply my skills to your team's goals.`;
                await fillInput(page, safeSelector, whyEssay);
            } else if (text.includes('where do you intend to work') || text.includes('intended work location')) {
                await fillInput(page, safeSelector, applicant.location);
            }
        } catch (e) {}
    }

    // Helper to select option in modern Greenhouse React-Select
    async function selectGreenhouseReact(selector, searchText, optionFilterRegex) {
        try {
            const el = page.locator(selector).first();
            if (await el.count() > 0 && await el.isVisible()) {
                await el.click().catch(() => {});
                if (searchText) {
                    await el.pressSequentially(searchText, { delay: 40 }).catch(() => {});
                }
                await page.waitForSelector('.select__menu [role="option"]', { timeout: 3000 }).catch(() => {});
                const opts = page.locator('.select__menu [role="option"], .select__menu div[class*="option"]');
                const optCount = await opts.count().catch(() => 0);
                if (optCount > 0) {
                    let targetOpt = null;
                    if (optionFilterRegex) {
                        for (let i = 0; i < optCount; i++) {
                            const optText = (await opts.nth(i).innerText().catch(() => '')).trim();
                            if (optionFilterRegex.test(optText)) {
                                targetOpt = opts.nth(i);
                                break;
                            }
                        }
                    }
                    if (!targetOpt) targetOpt = opts.first();
                    await targetOpt.click({ timeout: 3000 }).catch(() => {});
                    await page.waitForTimeout(400);
                } else if (searchText) {
                    await el.press('Enter').catch(() => {});
                    await page.waitForTimeout(300);
                }
            }
        } catch (e) {}
    }

    // Modern Greenhouse Country Field
    await selectGreenhouseReact('#country', 'India', /^India \+91$/i);

    // Modern Greenhouse Education Fields
    await selectGreenhouseReact('#school--0', 'Pandit', /Pandit|Deendayal|Other/i);
    await selectGreenhouseReact('#degree--0', 'Bachelor', /Bachelor|B\.Tech/i);
    await selectGreenhouseReact('#discipline--0', 'Computer', /Computer Science|Computer Engineering/i);
    await selectGreenhouseReact('#end-month--0', '', /May|June/i);
    await fillInput(page, '#start-year--0', '2023');
    await fillInput(page, '#end-year--0', '2027');

    // Modern Greenhouse Custom Verification Selects
    await selectGreenhouseReact('#question_67942591', 'Yes', /^Yes/i);
    await selectGreenhouseReact('#question_67942592', 'No', /^No/i);
    await selectGreenhouseReact('#question_67942587', 'Yes', /^Yes/i);
    await selectGreenhouseReact('#question_69459535', 'India', /^India/i);

    // Internship Cohort Checkbox (e.g. Stripe January to June (6 months))
    const janToJunCb = page.locator('input[id*="731172288"], input[type="checkbox"]:has(+ label:has-text("January to June")), label:has-text("January to June (6 months)")').first();
    if (await janToJunCb.count() > 0) {
        await janToJunCb.check({ force: true }).catch(() => janToJunCb.click({ force: true }).catch(() => {}));
    }

    // Work authorization & dropdowns
    await answerDropdownsAndSelects(page, applicant);
    await autoAnswerCustomQuestions(page, applicant);
}

async function fillLever(page, applicant, pdfBuffer, tempPdfPath) {
    // Dismiss cookie banner if present
    const dismissBtn = page.locator('button:has-text("Dismiss"), a:has-text("Dismiss"), .cookie-notice button').first();
    if (await dismissBtn.count().catch(() => 0) > 0) {
        await dismissBtn.click().catch(() => {});
    }

    // Basic Details
    await fillInput(page, 'input[name="name"], input[autocomplete="name"]', `${applicant.firstName} ${applicant.lastName}`);
    await fillInput(page, 'input[name="email"], input[type="email"]', applicant.email);
    await fillInput(page, 'input[name="phone"], input[type="tel"]', applicant.phone);
    await fillInput(page, 'input[name="org"]', applicant.currentCompany || '');

    // Links
    await fillInput(page, 'input[name="urls[LinkedIn]"], input[placeholder*="linkedin" i]', applicant.linkedin);
    await fillInput(page, 'input[name="urls[GitHub]"], input[placeholder*="github" i]', applicant.github);
    await fillInput(page, 'input[name="urls[Portfolio]"], input[placeholder*="portfolio" i]', applicant.portfolio || applicant.github);

    // Resume PDF upload
    const fileSelector = 'input[type="file"][name="resume"], input[type="file"]';
    const fileLocator = page.locator(fileSelector).first();
    if (await fileLocator.count() > 0) {
        console.log('Uploading resume to Lever...');
        if (tempPdfPath && fs.existsSync(tempPdfPath)) {
            await fileLocator.setInputFiles(tempPdfPath).catch(err => console.warn('Lever file upload note:', err.message));
        } else if (pdfBuffer) {
            await fileLocator.setInputFiles({
                name: `${applicant.firstName}_${applicant.lastName}_Resume.pdf`,
                mimeType: 'application/pdf',
                buffer: pdfBuffer
            }).catch(err => console.warn('Lever file upload note:', err.message));
        }
        await page.waitForTimeout(1000);
    }

    // Work auth checkboxes & dropdowns
    await answerLeverCheckboxes(page, applicant);
    await answerDropdownsAndSelects(page, applicant);
    await autoAnswerCustomQuestions(page, applicant);
}

async function fillAshby(page, applicant, pdfBuffer, tempPdfPath) {
    console.log('[Ashby Form Filler] Preparing Ashby application form...');

    // 1. If currently on job overview page (not ending with /application), navigate directly or click Apply
    const curUrl = page.url();
    if (!curUrl.includes('/application')) {
        const directAppUrl = curUrl.replace(/\/+$/, '') + '/application';
        try {
            console.log(`[Ashby Form Filler] Navigating to application URL: ${directAppUrl}`);
            await page.goto(directAppUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
        } catch (e) {
            const applyBtn = page.locator('button:has-text("Apply for this job"), a:has-text("Apply for this job"), button:has-text("Apply Now")').first();
            if (await applyBtn.count().catch(() => 0) > 0) {
                await applyBtn.click().catch(() => {});
                await page.waitForTimeout(2500);
            }
        }
    } else {
        await page.waitForTimeout(1500);
    }

    // Ensure Ashby React form inputs are hydrated
    await page.waitForSelector('input[type="text"], input[type="email"], input[type="file"], textarea', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // Helper: find input by label text
    async function fillByLabel(labelTextMatches, value) {
        if (!value) return false;
        const matches = Array.isArray(labelTextMatches) ? labelTextMatches : [labelTextMatches];
        try {
            const labels = await page.$$('label');
            for (const l of labels) {
                const text = (await l.innerText().catch(() => '')).trim().toLowerCase();
                if (matches.some(m => text.includes(m.toLowerCase()))) {
                    const forId = await l.getAttribute('for');
                    if (forId) {
                        const el = await page.$(`[id="${forId}"]`);
                        if (el) {
                            await el.scrollIntoViewIfNeeded().catch(() => {});
                            await el.fill(value).catch(() => {});
                            return true;
                        }
                    }
                    const container = await l.evaluateHandle(el => el.closest('div'));
                    const input = await container.$('input[type="text"], input[type="email"], input[type="tel"], textarea');
                    if (input) {
                        await input.scrollIntoViewIfNeeded().catch(() => {});
                        await input.fill(value).catch(() => {});
                        return true;
                    }
                }
            }
        } catch (e) {}
        return false;
    }

    // 2. Candidate Full Name
    const fullName = `${applicant.firstName} ${applicant.lastName}`.trim();
    const nameFilled = await fillByLabel(['Legal First and Last Name', 'Legal Name', 'Full Name'], fullName);
    if (!nameFilled) {
        await fillInput(page, '#_systemfield_name, input[name="_systemfield_name"], input[name="name"], input#name, input[autocomplete="name"]', fullName);
    }

    // Preferred Names
    await fillByLabel('Preferred First Name', applicant.firstName);
    await fillByLabel('Preferred Last Name', applicant.lastName);

    // 3. Email
    const emailFilled = await fillByLabel('Email', applicant.email);
    if (!emailFilled) {
        await fillInput(page, '#_systemfield_email, input[name="_systemfield_email"], input[name="email"], input#email, input[type="email"]', applicant.email);
    }

    // 4. Phone
    const phoneFilled = await fillByLabel(['Phone Number', 'Phone', 'Mobile'], applicant.phone);
    if (!phoneFilled) {
        await fillInput(page, 'input[type="tel"], #_systemfield_phone, input[name="phoneNumber"], input#phoneNumber', applicant.phone);
    }

    // 5. Location
    const locInput = page.locator('label:has-text("Location") ~ div input, div:has-text("Location") input[placeholder*="typing" i], input[placeholder*="Start typing" i]').first();
    if (await locInput.count() > 0) {
        const targetLoc = applicant.location || 'Bengaluru, Karnataka, India';
        await locInput.click().catch(() => {});
        await locInput.fill(targetLoc).catch(() => {});
        await page.waitForTimeout(800);
        await locInput.press('ArrowDown').catch(() => {});
        await page.waitForTimeout(200);
        await locInput.press('Enter').catch(() => {});
        const locOption = page.locator('[role="listbox"] [role="option"], .ashby-location-option, div[class*="option" i]').first();
        if (await locOption.count() > 0 && await locOption.isVisible().catch(() => false)) {
            await locOption.click().catch(() => {});
        }
    }

    // 6. Current Employer & University & Pronouns
    await fillByLabel(['Current or Most Recent Employer', 'Current Employer', 'Recent Employer'], applicant.currentCompany || 'Space Applications Centre (ISRO)');
    await fillByLabel(['University or School Attended', 'University', 'School', 'Degree'], applicant.university || 'Pandit Deendayal Energy University');
    await fillByLabel('Pronouns', applicant.pronouns || 'He/Him');

    // 7. Work Eligibility (Ashby custom button toggle)
    const isAuth = applicant.workAuthorization === 'Yes' || !applicant.workAuthorization || applicant.workAuthorization === true;
    const authBtn = page.locator(`.ashby-application-form-input-yesno button[data-option="${isAuth ? 'yes' : 'no'}"], button:has-text("${isAuth ? 'Yes' : 'No'}")`).first();
    if (await authBtn.count() > 0) {
        await authBtn.click().catch(() => {});
    }

    // 8. Visa Sponsorship
    const reqSponsorship = applicant.requiresSponsorship === 'Yes' || applicant.requiresSponsorship === true;
    const sponsorSelector = reqSponsorship
        ? 'label:has-text("Yes, I will require")'
        : 'label:has-text("No, I do not require sponsorship")';
    const sponsorLabel = page.locator(sponsorSelector).first();
    if (await sponsorLabel.count() > 0) {
        await sponsorLabel.click().catch(() => {});
    }

    // 9. Privacy Policy / Consent
    const consentLabel = page.locator('label:has-text("I consent"), input[type="checkbox"][name*="consent" i]').first();
    if (await consentLabel.count() > 0) {
        await consentLabel.click().catch(() => {});
    }

    // 10. Hybrid / In-office Policy & Ashby radio groups
    const hybridYesLabel = page.locator('label:has-text("Yes, I’m able to work from the office 3 days a week"), label:has-text("Yes, I’m able to work"), label:has-text("3 days a week")').first();
    if (await hybridYesLabel.count() > 0) {
        await hybridYesLabel.click().catch(() => {});
    }

    const ashbyRadioGroups = await page.$$('.ashby-application-form-input-radio-group, div:has(> .ashby-application-form-input-radio-group-option)');
    for (const rg of ashbyRadioGroups) {
        try {
            const checked = await rg.$('input[type="radio"]:checked');
            if (checked) continue;
            const parent = await rg.evaluateHandle(el => el.closest('div'));
            const text = parent ? (await parent.innerText().catch(() => '')).toLowerCase() : '';
            if (text.includes('bangalore') || text.includes('on-site') || text.includes('onsite') || text.includes('possible') || text.includes('authorized') || text.includes('relocate')) {
                const yesLabel = await rg.$('label:has-text("Yes"), .ashby-application-form-input-radio-group-option:has-text("Yes")');
                if (yesLabel) await yesLabel.click().catch(() => {});
            } else {
                const firstOption = await rg.$('label, .ashby-application-form-input-radio-group-option');
                if (firstOption) await firstOption.click().catch(() => {});
            }
        } catch (e) {}
    }

    // 11. Social & Portfolio links
    await fillByLabel('LinkedIn', applicant.linkedin);
    await fillByLabel('GitHub', applicant.github);
    await fillByLabel(['Portfolio', 'Website'], applicant.portfolio || applicant.github);

    // Fallbacks for socials
    await fillInput(page, 'input[name*="linkedin" i], input[placeholder*="linkedin" i]', applicant.linkedin);
    await fillInput(page, 'input[name*="github" i], input[placeholder*="github" i]', applicant.github);
    await fillInput(page, 'input[name*="website" i], input[placeholder*="portfolio" i]', applicant.portfolio || applicant.github);

    // 12. Direct Resume PDF Upload (target #_systemfield_resume explicitly)
    let fileLocator = page.locator('input#_systemfield_resume, input[type="file"][id*="resume" i]').first();
    if (await fileLocator.count() === 0) {
        fileLocator = page.locator('input[type="file"]').last();
    }
    if (await fileLocator.count() > 0) {
        console.log('Uploading resume to Ashby file input...');
        if (tempPdfPath && fs.existsSync(tempPdfPath)) {
            await fileLocator.setInputFiles(tempPdfPath).catch(err => console.warn('Ashby file upload note:', err.message));
        } else if (pdfBuffer) {
            await fileLocator.setInputFiles({
                name: `${applicant.firstName}_${applicant.lastName}_Resume.pdf`,
                mimeType: 'application/pdf',
                buffer: pdfBuffer
            }).catch(err => console.warn('Ashby file upload note:', err.message));
        }
        await page.waitForTimeout(1000);
    }

    // Answer any remaining custom questions
    await answerDropdownsAndSelects(page, applicant);
    await autoAnswerCustomQuestions(page, applicant);
}

async function fillGeneric(page, applicant, pdfBuffer, tempPdfPath) {
    let textFields = await page.$$('input[type="text"], input[type="email"], input[type="tel"]');
    if (textFields.length === 0) {
        const applyBtn = page.locator('button:has-text("Apply for this job"), a:has-text("Apply for this job"), button:has-text("Apply Now"), a:has-text("Apply Now"), button:has-text("Apply"), a:has-text("Apply"), a[href*="apply"]').first();
        if (await applyBtn.count().catch(() => 0) > 0 && await applyBtn.isVisible().catch(() => false)) {
            console.log('[Generic] Clicking Apply button to reveal application portal/form...');
            await applyBtn.click().catch(() => {});
            await page.waitForTimeout(2000);
            textFields = await page.$$('input[type="text"], input[type="email"], input[type="tel"]');
        }
    }
    for (const field of textFields) {
        const nameAttr = (await field.getAttribute('name') || '').toLowerCase();
        const placeholderAttr = (await field.getAttribute('placeholder') || '').toLowerCase();
        const idAttr = (await field.getAttribute('id') || '').toLowerCase();

        const matchStr = `${nameAttr} ${placeholderAttr} ${idAttr}`;

        if (matchStr.includes('first') && matchStr.includes('name')) {
            await field.fill(applicant.firstName);
        } else if (matchStr.includes('last') && matchStr.includes('name')) {
            await field.fill(applicant.lastName);
        } else if (matchStr.includes('name') && !matchStr.includes('first') && !matchStr.includes('last')) {
            await field.fill(`${applicant.firstName} ${applicant.lastName}`);
        } else if (matchStr.includes('email')) {
            await field.fill(applicant.email);
        } else if (matchStr.includes('phone') || matchStr.includes('tel') || matchStr.includes('mobile')) {
            await field.fill(applicant.phone);
        } else if (matchStr.includes('linkedin')) {
            await field.fill(applicant.linkedin);
        } else if (matchStr.includes('github')) {
            await field.fill(applicant.github);
        } else if (matchStr.includes('portfolio') || matchStr.includes('website')) {
            await field.fill(applicant.portfolio || '');
        }
    }

    const fileSelector = 'input[type="file"]';
    const fileLocator = page.locator(fileSelector).first();
    if (await fileLocator.count() > 0) {
        if (tempPdfPath && fs.existsSync(tempPdfPath)) {
            await fileLocator.setInputFiles(tempPdfPath).catch(() => {});
        } else if (pdfBuffer) {
            await fileLocator.setInputFiles({
                name: `${applicant.firstName}_${applicant.lastName}_Resume.pdf`,
                mimeType: 'application/pdf',
                buffer: pdfBuffer
            }).catch(() => {});
        }
    }

    await answerDropdownsAndSelects(page, applicant);
    await autoAnswerCustomQuestions(page, applicant);
}

async function answerLeverCheckboxes(page, applicant) {
    try {
        const radioGroups = await page.$$('.application-question');
        for (const group of radioGroups) {
            const text = (await group.innerText()).toLowerCase();
            if (text.includes('authorized to work') || text.includes('legal right to work')) {
                const yesButton = await group.$('input[value*="yes"], input[value="1"]');
                if (yesButton) await yesButton.click();
            }
            if (text.includes('sponsorship') || text.includes('require visa')) {
                const targetVal = applicant.requiresSponsorship === 'Yes' ? 'yes' : 'no';
                const button = await group.$(`input[value*="${targetVal}"]`);
                if (button) await button.click();
            }
        }
    } catch (err) {
        console.warn('Could not answer Lever custom checkboxes:', err.message);
    }
}

module.exports = {
    autoApply,
    verifySubmissionStrict,
    stopAllApplySessions,
    stopApplySession,
    activeApplySessions
};
