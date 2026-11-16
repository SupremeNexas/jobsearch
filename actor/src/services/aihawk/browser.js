const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { getAihawkConfig } = require('./config');
const { logger } = require('./logs');

class AihawkBrowserManager {
    constructor() {
        this.sessions = new Map(); // sessionName -> { browser, context, page, createdAt, lastActive }
    }

    async getProfileDir(sessionName = 'main') {
        const config = await getAihawkConfig();
        const baseDir = config.profileDir || path.join(__dirname, '../../../../data/aihawk_profiles');
        const sessionDir = path.join(baseDir, sessionName);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        return sessionDir;
    }

    async openSession(sessionName = 'main', customOptions = {}) {
        if (this.sessions.has(sessionName)) {
            const existing = this.sessions.get(sessionName);
            if (!existing.page.isClosed()) {
                existing.lastActive = new Date();
                return existing;
            } else {
                await this.closeSession(sessionName);
            }
        }

        const config = await getAihawkConfig();
        const profileDir = await this.getProfileDir(sessionName);
        const isHeaded = customOptions.headed !== undefined ? customOptions.headed : config.headed;
        const proxyServer = customOptions.proxy || config.proxy;

        logger.setStatus('initializing_browser', `Launching stealth browser session (${sessionName})`);
        logger.log('browser_launch', `Opening persistent browser session '${sessionName}' in ${profileDir}`, {
            headed: isHeaded,
            proxy: proxyServer ? 'CONFIGURED' : 'DIRECT',
            seed: config.seed
        });

        const launchArgs = [
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--hide-scrollbars',
            '--mute-audio'
        ];

        const launchOptions = {
            headless: !isHeaded,
            args: launchArgs,
            viewport: { width: 1280, height: 800 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            ignoreHTTPSErrors: true
        };

        if (fs.existsSync('/Applications/Google Chrome.app')) {
            launchOptions.channel = 'chrome';
        }

        if (proxyServer) {
            launchOptions.proxy = { server: proxyServer };
        }

        let context;
        let page;

        try {
            // Launch persistent context to preserve cookies and login sessions across restarts
            context = await chromium.launchPersistentContext(profileDir, launchOptions);
            const pages = context.pages();
            page = pages.length > 0 ? pages[0] : await context.newPage();

            // Apply stealth evasions
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
                window.navigator.chrome = {
                    runtime: {}
                };
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5]
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en']
                });
            });

            const sessionObj = {
                name: sessionName,
                context,
                page,
                profileDir,
                createdAt: new Date(),
                lastActive: new Date()
            };

            this.sessions.set(sessionName, sessionObj);
            logger.setStatus('loading_profile', `Session '${sessionName}' ready with persistent profile.`);
            return sessionObj;
        } catch (err) {
            logger.log('browser_error', `Failed to open persistent browser context: ${err.message}`);
            const fallbackLaunchOptions = {
                headless: !isHeaded,
                args: launchArgs
            };
            if (fs.existsSync('/Applications/Google Chrome.app')) {
                fallbackLaunchOptions.channel = 'chrome';
            }
            const browser = await chromium.launch(fallbackLaunchOptions);
            context = await browser.newContext({
                viewport: { width: 1280, height: 800 },
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            });
            page = await context.newPage();
            const sessionObj = {
                name: sessionName,
                browser,
                context,
                page,
                profileDir,
                createdAt: new Date(),
                lastActive: new Date()
            };
            this.sessions.set(sessionName, sessionObj);
            return sessionObj;
        }
    }

    async closeSession(sessionName = 'main') {
        if (!this.sessions.has(sessionName)) return;
        const session = this.sessions.get(sessionName);
        try {
            if (session.context) await session.context.close().catch(() => {});
            if (session.browser) await session.browser.close().catch(() => {});
        } catch (e) {
            // ignore
        }
        this.sessions.delete(sessionName);
        logger.log('browser_close', `Closed browser session '${sessionName}'`);
    }

    async closeAllSessions() {
        for (const name of Array.from(this.sessions.keys())) {
            await this.closeSession(name);
        }
    }

    async navigate(sessionName, url, timeout = 30000) {
        const session = await this.openSession(sessionName);
        logger.log('browser_navigate', `Navigating to ${url}`);
        await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        session.lastActive = new Date();
        return session.page;
    }

    async humanType(page, selector, text, delayRange = [20, 50]) {
        await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
        await page.focus(selector);
        await page.fill(selector, ''); // clear first
        for (const char of text) {
            await page.type(selector, char, {
                delay: Math.floor(Math.random() * (delayRange[1] - delayRange[0])) + delayRange[0]
            });
        }
    }

    async captureScreenshot(sessionName, targetPath) {
        const session = this.sessions.get(sessionName);
        if (!session || !session.page) {
            throw new Error(`Active session '${sessionName}' not found`);
        }
        const buffer = await session.page.screenshot({ fullPage: true });
        if (targetPath) {
            fs.writeFileSync(targetPath, buffer);
        }
        return buffer;
    }

    listSessions() {
        return Array.from(this.sessions.entries()).map(([name, s]) => ({
            name,
            profileDir: s.profileDir,
            createdAt: s.createdAt,
            lastActive: s.lastActive,
            isClosed: s.page ? s.page.isClosed() : true
        }));
    }
}

const browserManager = new AihawkBrowserManager();
module.exports = {
    AihawkBrowserManager,
    browserManager
};
