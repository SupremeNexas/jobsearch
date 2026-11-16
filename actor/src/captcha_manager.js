const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

/**
 * CaptchaManager
 * Manages live CAPTCHA challenges during browser automation.
 * Holds the browser session alive, streams screencast frames to the localhost dashboard,
 * accepts user mouse & keyboard inputs from the localhost popup modal,
 * and auto-detects resolution to complete submissions seamlessly.
 */
class CaptchaManager extends EventEmitter {
    constructor() {
        super();
        this.activeSessions = new Map();
        this.testSession = null;
        this.defaultTimeoutMs = 5 * 60 * 1000; // 5 minutes default
    }

    /**
     * Checks if an interactive challenge or bot verification is present on the page.
     * @param {import('playwright').Page} page
     * @param {import('playwright').Frame} [targetFrame]
     * @returns {Promise<boolean>}
     */
    async isCaptchaChallenge(page, targetFrame = null) {
        if (!page) return false;
        const frame = targetFrame || page;
        try {
            const captchaLocators = frame.locator([
                'iframe[title*="challenge" i]',
                'iframe[src*="recaptcha" i]',
                'iframe[src*="challenges.cloudflare.com" i]',
                'iframe[src*="hcaptcha" i]',
                '[data-sitekey]',
                '.g-recaptcha',
                '.cf-turnstile',
                '#cf-turnstile',
                'div[class*="turnstile" i]',
                'div:has-text("Verify you are human")',
                'div:has-text("Select all images with")',
                '#challenge-stage',
                'div[class*="captcha" i]:not(.hidden)',
                'iframe[title*="recaptcha" i]'
            ].join(', '));

            const count = await captchaLocators.count().catch(() => 0);
            if (count > 0) {
                const first = captchaLocators.first();
                const visible = await first.isVisible().catch(() => false);
                if (visible) return true;

                // If explicit sitekey container or challenge iframe is present in DOM, flag as challenge
                const explicitCount = await frame.locator('.g-recaptcha, .cf-turnstile, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="challenges"], iframe[src*="hcaptcha"]').count().catch(() => 0);
                if (explicitCount > 0) return true;
            }

            // Also check for email verification code inputs
            const codeInput = page.locator('#security-input-0, input#security_code, input[id*="security-input" i], input[placeholder*="security code" i], input[placeholder*="verification code" i]').first();
            if (await codeInput.count().catch(() => 0) > 0 && await codeInput.isVisible().catch(() => false)) {
                return true;
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Checks whether the CAPTCHA has been solved on the page.
     * @param {import('playwright').Page} page
     * @param {import('playwright').Frame} [targetFrame]
     * @returns {Promise<{ solved: boolean, tokenFound: boolean, navigated: boolean }>}
     */
    async isSolved(page, targetFrame = null) {
        if (!page) return { solved: false, tokenFound: false, navigated: false };
        try {
            // 1. Navigation / Confirmation check
            const curUrl = page.url().toLowerCase();
            const isConfirmedUrl = curUrl.includes('/thanks') ||
                                   curUrl.includes('/thank-you') ||
                                   curUrl.includes('/confirmation') ||
                                   curUrl.includes('/applied') ||
                                   curUrl.includes('/application-submitted') ||
                                   curUrl.includes('success=true');
            if (isConfirmedUrl) {
                return { solved: true, tokenFound: true, navigated: true };
            }

            // 2. Token values check in DOM (Cloudflare Turnstile, Google reCAPTCHA, hCaptcha)
            const tokenFound = await page.evaluate(() => {
                const cf = document.querySelector('[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
                if (cf && cf.value && cf.value.length > 5) return true;

                const gr = document.querySelector('[name="g-recaptcha-response"], textarea[name="g-recaptcha-response"]');
                if (gr && gr.value && gr.value.length > 5) return true;

                const hc = document.querySelector('[name="h-captcha-response"], textarea[name="h-captcha-response"]');
                if (hc && hc.value && hc.value.length > 5) return true;

                return false;
            }).catch(() => false);

            if (tokenFound) {
                return { solved: true, tokenFound: true, navigated: false };
            }

            // 3. Challenge locator disappearance check
            const challengeLocators = page.locator([
                'iframe[title*="challenge" i]',
                'iframe[src*="challenges.cloudflare.com" i]',
                'iframe[src*="recaptcha" i]',
                'iframe[src*="hcaptcha" i]',
                'div:has-text("Verify you are human")'
            ].join(', '));
            const count = await challengeLocators.count().catch(() => 0);
            if (count === 0) {
                return { solved: true, tokenFound: false, navigated: false };
            }

            const visible = await challengeLocators.first().isVisible().catch(() => false);
            if (!visible) {
                return { solved: true, tokenFound: false, navigated: false };
            }

            return { solved: false, tokenFound: false, navigated: false };
        } catch (e) {
            return { solved: false, tokenFound: false, navigated: false };
        }
    }

    /**
     * Registers a new active CAPTCHA challenge session.
     * Starts screencasting, emits an event for the localhost popup modal,
     * and returns a Promise that settles when solved, submitted, skipped, or timed out.
     */
    async registerChallenge(options) {
        const {
            page,
            targetFrame = null,
            submitLocator = null,
            atsType = 'ATS',
            job = {},
            jobId = job.job_id || 'active_job',
            isHeaded = false,
            apiSubmissionConfirmed = false,
            timeoutMs = this.defaultTimeoutMs
        } = options;

        const sessionId = 'captcha_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        const startTime = Date.now();
        const expiresAt = startTime + timeoutMs;
        const viewport = (page.viewportSize && page.viewportSize()) || { width: 1280, height: 850 };

        console.log(`\n🧩 [CaptchaManager] Registering challenge session: ${sessionId} for job ${jobId} (${atsType})`);

        const session = {
            id: sessionId,
            jobId,
            job: {
                role: job.role || 'Job Application',
                company: job.company || atsType,
                url: job.url || job.application_url || ''
            },
            atsType,
            page,
            targetFrame: targetFrame || page,
            submitLocator,
            isHeaded,
            apiSubmissionConfirmed,
            viewport,
            startTime,
            expiresAt,
            status: 'ACTIVE',
            latestFrame: null,
            lastFrameTime: Date.now(),
            cdpSession: null,
            watchdogTimer: null,
            timeoutTimer: null,
            resolve: null,
            reject: null
        };

        // Register session immediately so synchronous callers can query getActiveSession()
        this.activeSessions.set(sessionId, session);

        // Capture initial frame immediately
        try {
            session.latestFrame = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 80 }).catch(() => null);
        } catch (e) {}

        // Scroll to CAPTCHA element so it's centered in the viewport
        await this.scrollToCaptcha(page).catch(() => {});

        // Connect CDP screencast on page
        try {
            const cdp = await page.context().newCDPSession(page);
            session.cdpSession = cdp;

            cdp.on('Page.screencastFrame', async ({ data, sessionId: cdpSessionId }) => {
                if (session.status !== 'ACTIVE') return;
                try {
                    session.latestFrame = Buffer.from(data, 'base64');
                    session.lastFrameTime = Date.now();
                    await cdp.send('Page.screencastFrameAck', { sessionId: cdpSessionId }).catch(() => {});
                    this.emit('frame', {
                        sessionId,
                        timestamp: session.lastFrameTime
                    });
                } catch (err) {}
            });

            await cdp.send('Page.startScreencast', {
                format: 'jpeg',
                quality: 80,
                everyNthFrame: 1
            });
            console.log(`[CaptchaManager] CDP Screencast stream initiated for session ${sessionId}`);
        } catch (cdpErr) {
            console.warn(`[CaptchaManager] CDP Screencast notice: ${cdpErr.message}. Falling back to periodic screenshots.`);
        }

        // Emit challenge detected event for localhost dashboard
        this.emit('captcha_detected', this.formatSessionData(session));

        return new Promise((resolve) => {
            session.resolve = resolve;

            // Timeout timer
            session.timeoutTimer = setTimeout(async () => {
                if (session.status === 'ACTIVE') {
                    console.log(`⏳ [CaptchaManager] Session ${sessionId} expired after ${Math.round(timeoutMs / 1000)}s.`);
                    session.status = 'EXPIRED';
                    await this.cleanupSession(sessionId);
                    resolve({
                        success: false,
                        submitted: false,
                        requires_manual: true,
                        captcha_required: true,
                        status: 'CAPTCHA_REQUIRED',
                        message: `CAPTCHA challenge timed out on localhost popup after ${Math.round(timeoutMs / 1000)}s.`
                    });
                }
            }, timeoutMs);

            // Watchdog loop: checks for resolution every 1.5 seconds
            session.watchdogTimer = setInterval(async () => {
                if (session.status !== 'ACTIVE') return;

                // Take fallback screenshot if CDP isn't delivering frames
                if (!session.cdpSession || (Date.now() - session.lastFrameTime > 2000)) {
                    try {
                        const fallbackBuffer = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 75 }).catch(() => null);
                        if (fallbackBuffer) {
                            session.latestFrame = fallbackBuffer;
                            session.lastFrameTime = Date.now();
                            this.emit('frame', { sessionId, timestamp: session.lastFrameTime });
                        }
                    } catch (e) {}
                }

                // Check if solved
                const check = await this.isSolved(page, session.targetFrame);
                if (check.solved) {
                    console.log(`\n🎉 [CaptchaManager] CAPTCHA resolution detected on session ${sessionId} (token: ${check.tokenFound}, navigated: ${check.navigated})!`);
                    session.status = 'SOLVED';
                    this.emit('captcha_solved', this.formatSessionData(session));

                    // Wait 1.5 seconds for state to settle, then submit if form is still open
                    if (!check.navigated && session.submitLocator) {
                        console.log(`[CaptchaManager] Auto-triggering form submission on ${atsType}...`);
                        await page.waitForTimeout(1500);
                        const submitResult = await this.executeSubmit(session);
                        await this.cleanupSession(sessionId);
                        resolve(submitResult);
                    } else {
                        // Already submitted or navigated
                        await this.cleanupSession(sessionId);
                        resolve({
                            success: true,
                            submitted: true,
                            requires_manual: false,
                            status: 'APPLIED',
                            message: `${atsType} application confirmed & successfully submitted after CAPTCHA resolution!`
                        });
                    }
                }
            }, 1200);
        });
    }

    /**
     * Dispatches user interactions (clicks, keyboard, scroll) from the localhost popup to the live page.
     */
    async dispatchInput(sessionId, inputData) {
        let session = this.activeSessions.get(sessionId);
        if (!session && this.testSession && this.testSession.id === sessionId) {
            session = this.testSession;
        }
        if (!session || !session.page) {
            throw new Error(`Session ${sessionId} not found or inactive`);
        }

        const { page, viewport } = session;
        const type = inputData.type || 'click';

        // Scale coordinates to page viewport
        const displayWidth = inputData.displayWidth || viewport.width;
        const displayHeight = inputData.displayHeight || viewport.height;
        const scaleX = viewport.width / displayWidth;
        const scaleY = viewport.height / displayHeight;
        const targetX = Math.round((inputData.x || 0) * scaleX);
        const targetY = Math.round((inputData.y || 0) * scaleY);

        switch (type) {
            case 'click': {
                console.log(`[CaptchaManager] Dispatched click to (${targetX}, ${targetY}) [scaled from ${inputData.x}, ${inputData.y}]`);
                await page.mouse.click(targetX, targetY).catch(e => console.log('Mouse click notice:', e.message));
                break;
            }
            case 'mousemove': {
                await page.mouse.move(targetX, targetY).catch(() => {});
                break;
            }
            case 'type': {
                if (inputData.text) {
                    console.log(`[CaptchaManager] Dispatched typing: "${inputData.text.slice(0, 10)}..."`);
                    await page.keyboard.type(inputData.text, { delay: 40 }).catch(() => {});
                }
                break;
            }
            case 'key': {
                if (inputData.key) {
                    await page.keyboard.press(inputData.key).catch(() => {});
                }
                break;
            }
            case 'scroll': {
                const deltaY = inputData.deltaY || 200;
                await page.mouse.wheel(0, deltaY).catch(() => {});
                break;
            }
            case 'focus_captcha': {
                await this.scrollToCaptcha(page);
                break;
            }
            case 'focus_submit': {
                await this.scrollToSubmit(page, session.submitLocator);
                break;
            }
            default:
                break;
        }

        // Trigger immediate frame capture
        setTimeout(async () => {
            try {
                const freshBuffer = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 80 }).catch(() => null);
                if (freshBuffer) {
                    session.latestFrame = freshBuffer;
                    session.lastFrameTime = Date.now();
                    this.emit('frame', { sessionId, timestamp: session.lastFrameTime });
                }
            } catch (e) {}
        }, 150);

        return { success: true, targetX, targetY };
    }

    /**
     * Scrolls the browser viewport to center on the CAPTCHA challenge element.
     */
    async scrollToCaptcha(page) {
        if (!page) return;
        try {
            const loc = page.locator([
                'iframe[title*="challenge" i]',
                'iframe[src*="recaptcha" i]',
                'iframe[src*="challenges.cloudflare.com" i]',
                'iframe[src*="hcaptcha" i]',
                '.cf-turnstile',
                '#cf-turnstile',
                'div[class*="turnstile" i]',
                'div:has-text("Verify you are human")',
                '#security-input-0',
                'input#security_code'
            ].join(', ')).first();

            if (await loc.count().catch(() => 0) > 0) {
                await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(300);
            }
        } catch (e) {}
    }

    /**
     * Scrolls the browser viewport to center on the submit button.
     */
    async scrollToSubmit(page, submitLocator = null) {
        if (!page) return;
        try {
            const loc = submitLocator || page.locator('button[type="submit"]:has-text("Submit"), button:has-text("Submit application"), button:has-text("Submit Application"), #submit_app, input[type="submit"], button:has-text("Submit")').first();
            if (await loc.count().catch(() => 0) > 0) {
                await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
                await page.waitForTimeout(300);
            }
        } catch (e) {}
    }

    /**
     * Executes the form submission and verifies the result.
     */
    async executeSubmit(session) {
        const { page, targetFrame, submitLocator, atsType, apiSubmissionConfirmed } = session;
        console.log(`[CaptchaManager] Executing submission click for session ${session.id}...`);

        try {
            if (submitLocator && await submitLocator.count().catch(() => 0) > 0) {
                await submitLocator.click({ timeout: 6000 }).catch(e => console.log(`${atsType} submit note:`, e.message));
                await page.waitForTimeout(3500);
                await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
            }

            // Verify with strict ATS check
            const { verifySubmissionStrict } = require('./apply');
            const verification = await verifySubmissionStrict(page, targetFrame, atsType, apiSubmissionConfirmed);
            const screenshotBuffer = await page.screenshot({ fullPage: true }).catch(() => null);

            session.status = verification.submitted ? 'SUBMITTED' : 'SOLVED';
            this.emit('captcha_submitted', {
                sessionId: session.id,
                success: verification.success,
                submitted: verification.submitted,
                message: verification.message
            });

            return {
                success: verification.success,
                submitted: verification.submitted,
                status: verification.status,
                captcha_required: verification.captcha_required,
                message: verification.message,
                screenshotBuffer
            };
        } catch (e) {
            console.error(`[CaptchaManager] Submit execution error:`, e.message);
            return {
                success: false,
                submitted: false,
                status: 'MANUAL_REQUIRED',
                message: `Submission error: ${e.message}`
            };
        }
    }

    /**
     * Manually triggers submission from the localhost popup.
     */
    async submitSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) throw new Error(`Active session ${sessionId} not found`);

        const result = await this.executeSubmit(session);
        if (session.resolve) {
            session.resolve(result);
        }
        await this.cleanupSession(sessionId);
        return result;
    }

    /**
     * User skips the CAPTCHA from localhost popup.
     */
    async skipSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return { success: false, message: 'Session not found' };

        console.log(`[CaptchaManager] User skipped CAPTCHA session ${sessionId}`);
        session.status = 'SKIPPED';
        const result = {
            success: false,
            submitted: false,
            requires_manual: true,
            captcha_required: true,
            status: 'CAPTCHA_REQUIRED',
            message: 'Candidate skipped CAPTCHA challenge in localhost popup.'
        };

        if (session.resolve) {
            session.resolve(result);
        }
        await this.cleanupSession(sessionId);
        this.emit('captcha_cleared', { sessionId, reason: 'skipped' });
        return { success: true };
    }

    /**
     * Brings the browser to front on macOS desktop if headed.
     */
    async bringToFront(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session || !session.page) return false;
        try {
            await session.page.bringToFront();
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Cleans up timers, CDP screencast, and memory for a session.
     */
    async cleanupSession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return;

        if (session.watchdogTimer) {
            clearInterval(session.watchdogTimer);
            session.watchdogTimer = null;
        }
        if (session.timeoutTimer) {
            clearTimeout(session.timeoutTimer);
            session.timeoutTimer = null;
        }
        if (session.cdpSession) {
            try {
                await session.cdpSession.send('Page.stopScreencast').catch(() => {});
                await session.cdpSession.detach().catch(() => {});
            } catch (e) {}
            session.cdpSession = null;
        }

        this.activeSessions.delete(sessionId);
        this.emit('captcha_cleared', { sessionId, status: session.status });
    }

    /**
     * Gets the current active session data for localhost API.
     */
    getActiveSession(sessionId = null) {
        if (sessionId) {
            const s = this.activeSessions.get(sessionId);
            return s ? this.formatSessionData(s) : null;
        }

        if (this.activeSessions.size > 0) {
            const first = Array.from(this.activeSessions.values())[0];
            return this.formatSessionData(first);
        }

        if (this.testSession) {
            return this.formatSessionData(this.testSession);
        }

        return null;
    }

    /**
     * Returns the latest screencast frame JPEG buffer.
     */
    getLatestFrame(sessionId = null) {
        let session = null;
        if (sessionId) {
            session = this.activeSessions.get(sessionId);
        }
        if (!session && this.activeSessions.size > 0) {
            session = Array.from(this.activeSessions.values())[0];
        }
        if (!session && this.testSession) {
            session = this.testSession;
        }
        return (session && session.latestFrame) ? session.latestFrame : null;
    }

    /**
     * Formats session details for JSON responses.
     */
    formatSessionData(session) {
        if (!session) return null;
        const now = Date.now();
        const timeRemaining = Math.max(0, Math.round((session.expiresAt - now) / 1000));
        return {
            id: session.id,
            jobId: session.jobId,
            atsType: session.atsType,
            company: session.job ? session.job.company : session.atsType,
            role: session.job ? session.job.role : 'Job Application',
            url: session.job ? session.job.url : '',
            status: session.status,
            startTime: session.startTime,
            expiresAt: session.expiresAt,
            timeRemaining,
            viewport: session.viewport,
            hasFrame: !!session.latestFrame
        };
    }

    /**
     * Creates a simulated test session for instant localhost verification.
     */
    createTestSession() {
        if (this.testSession) return this.formatSessionData(this.testSession);

        const id = 'test_captcha_' + Date.now();
        const startTime = Date.now();
        const expiresAt = startTime + 300000;

        // Generate an SVG frame representing a Cloudflare Turnstile challenge box
        const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="850" viewBox="0 0 1280 850">
            <rect width="1280" height="850" fill="#f8fafc"/>
            <rect x="0" y="0" width="1280" height="70" fill="#0f172a"/>
            <text x="40" y="44" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="20" font-weight="bold">Acme Corp Careers — Senior Full Stack Engineer</text>
            
            <!-- Application Form Mockup -->
            <rect x="240" y="110" width="800" height="660" rx="16" fill="#ffffff" stroke="#e2e8f0" stroke-width="2"/>
            <text x="280" y="160" fill="#1e293b" font-family="-apple-system, sans-serif" font-size="22" font-weight="bold">Submit Your Application</text>
            
            <!-- Prefilled Fields -->
            <text x="280" y="210" fill="#64748b" font-family="-apple-system, sans-serif" font-size="13">First Name</text>
            <rect x="280" y="220" width="340" height="42" rx="8" fill="#f1f5f9" stroke="#cbd5e1"/>
            <text x="295" y="247" fill="#0f172a" font-family="-apple-system, sans-serif" font-size="14">Alex</text>
            
            <text x="640" y="210" fill="#64748b" font-family="-apple-system, sans-serif" font-size="13">Last Name</text>
            <rect x="640" y="220" width="360" height="42" rx="8" fill="#f1f5f9" stroke="#cbd5e1"/>
            <text x="655" y="247" fill="#0f172a" font-family="-apple-system, sans-serif" font-size="14">Morgan</text>
            
            <text x="280" y="295" fill="#64748b" font-family="-apple-system, sans-serif" font-size="13">Email Address</text>
            <rect x="280" y="305" width="720" height="42" rx="8" fill="#f1f5f9" stroke="#cbd5e1"/>
            <text x="295" y="332" fill="#0f172a" font-family="-apple-system, sans-serif" font-size="14">alex.morgan@example.com</text>
            
            <text x="280" y="380" fill="#64748b" font-family="-apple-system, sans-serif" font-size="13">Resume / CV</text>
            <rect x="280" y="390" width="720" height="48" rx="8" fill="#ecfdf5" stroke="#10b981" stroke-width="1.5"/>
            <text x="320" y="420" fill="#065f46" font-family="-apple-system, sans-serif" font-size="14" font-weight="600">✓ Tailored_Resume.pdf attached (Full Stack / GenAI)</text>

            <!-- Turnstile / CAPTCHA Widget Box -->
            <rect x="280" y="470" width="420" height="84" rx="10" fill="#ffffff" stroke="#f59e0b" stroke-width="2.5" filter="drop-shadow(0 4px 6px rgba(245, 158, 11, 0.2))"/>
            <rect x="304" y="496" width="32" height="32" rx="6" fill="#ffffff" stroke="#f59e0b" stroke-width="2.5"/>
            <text x="350" y="518" fill="#1e293b" font-family="-apple-system, sans-serif" font-size="16" font-weight="600">Verify you are human</text>
            <text x="350" y="534" fill="#64748b" font-family="-apple-system, sans-serif" font-size="11">Cloudflare Turnstile • Click box to solve</text>
            <rect x="630" y="496" width="50" height="32" rx="6" fill="#f8fafc"/>
            <text x="638" y="518" fill="#f59e0b" font-family="-apple-system, sans-serif" font-size="18" font-weight="bold">⚡</text>

            <!-- Submit Button -->
            <rect x="280" y="585" width="720" height="52" rx="12" fill="#2563eb"/>
            <text x="580" y="618" fill="#ffffff" font-family="-apple-system, sans-serif" font-size="16" font-weight="bold">Submit Application</text>
            
            <!-- Instructions badge -->
            <rect x="280" y="660" width="720" height="70" rx="10" fill="#eff6ff" stroke="#bfdbfe"/>
            <text x="300" y="690" fill="#1e40af" font-family="-apple-system, sans-serif" font-size="13" font-weight="bold">Interactive Localhost Test Session Active</text>
            <text x="300" y="712" fill="#3b82f6" font-family="-apple-system, sans-serif" font-size="12">Clicking anywhere inside the checkbox or buttons dispatches live clicks!</text>
        </svg>
        `;

        this.testSession = {
            id,
            jobId: 'demo_test_job_101',
            job: {
                role: 'Senior Full Stack Engineer (GenAI)',
                company: 'Acme AI Labs',
                url: 'https://boards.greenhouse.io/acme/jobs/101'
            },
            atsType: 'Greenhouse',
            page: null,
            targetFrame: null,
            submitLocator: null,
            viewport: { width: 1280, height: 850 },
            startTime,
            expiresAt,
            status: 'ACTIVE',
            latestFrame: Buffer.from(svg),
            lastFrameTime: Date.now()
        };

        this.emit('captcha_detected', this.formatSessionData(this.testSession));
        return this.formatSessionData(this.testSession);
    }

    /**
     * Clears simulated test session.
     */
    clearTestSession() {
        this.testSession = null;
        this.emit('captcha_cleared', { sessionId: 'test', reason: 'cleared' });
    }
}

// Global Singleton Instance
const captchaManager = new CaptchaManager();
module.exports = captchaManager;
