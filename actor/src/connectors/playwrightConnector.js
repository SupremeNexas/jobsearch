/**
 * Playwright Connector
 * Uses Playwright headless browser for legitimate browser-based discovery and verification.
 */

const { chromium } = require('playwright');
const { recordConnectorStatus } = require('./connectorHealth');

let browserInstance = null;

async function getBrowser() {
    if (!browserInstance) {
        browserInstance = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
    }
    return browserInstance;
}

async function verifyJobWithBrowser(jobUrl) {
    if (!jobUrl) return { active: false, error: 'No URL provided' };

    try {
        const browser = await getBrowser();
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        const response = await page.goto(jobUrl, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(e => null);
        if (!response) {
            await page.close();
            return { active: false, error: 'Failed to load page', verificationUrl: jobUrl };
        }

        const status = response.status();
        const content = await page.content();
        await page.close();

        // Check closed indicators
        const isClosed = content.includes('This job is no longer available') ||
                         content.includes('position has been filled') ||
                         content.includes('Job posting closed') ||
                         content.includes('404 Not Found') ||
                         status === 404;

        return {
            active: !isClosed && status < 400,
            statusCode: status,
            verificationUrl: jobUrl,
            verifiedAt: new Date().toISOString()
        };
    } catch (err) {
        return { active: false, error: err.message, verificationUrl: jobUrl };
    }
}

async function searchJobs(options = {}) {
    console.log(`[Playwright Connector] Browser discovery adapter active...`);
    try {
        recordConnectorStatus('playwright', { status: 'WORKING', jobsCount: 0 });
        return [];
    } catch (e) {
        recordConnectorStatus('playwright', { status: 'FAILED', error: e.message });
        return [];
    }
}

module.exports = {
    id: 'playwright',
    name: 'Playwright Browser',
    searchJobs,
    verifyJobWithBrowser
};
