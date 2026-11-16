const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const PROFILE_DIR = path.resolve(__dirname, '../data/browser_profile');
const STATE_FILE = path.join(PROFILE_DIR, 'storage_state.json');

async function isLinkedInAuthenticated() {
    if (!fs.existsSync(STATE_FILE)) {
        return false;
    }
    try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const cookies = state.cookies || [];
        return cookies.some(c => c.name === 'li_at' && c.value && c.value.length > 10);
    } catch (e) {
        return false;
    }
}

async function loginLinkedIn() {
    console.log('========================================================');
    console.log('🔐 Launching Google Chrome for LinkedIn Authentication...');
    console.log(`📂 Profile Directory: ${PROFILE_DIR}`);
    console.log('========================================================\n');
    console.log('👉 A browser window is opening on your desktop.');
    console.log('👉 Please log in to your LinkedIn account (Email/Password or Google).');
    console.log('👉 Waiting for successful authentication...\n');

    if (!fs.existsSync(PROFILE_DIR)) {
        fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }

    const launchOptions = {
        channel: 'chrome',
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ],
        viewport: { width: 1280, height: 900 }
    };

    let context;
    try {
        context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
    } catch (e) {
        console.error('Error launching persistent Chrome:', e.message);
        throw e;
    }

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // Navigate to LinkedIn login
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

    // Poll every 2 seconds for active login
    let authenticated = false;
    let attempts = 0;
    const maxAttempts = 150; // ~5 minutes

    while (!authenticated && attempts < maxAttempts) {
        attempts++;
        await new Promise(r => setTimeout(r, 2000));

        try {
            const currentUrl = page.url();
            const cookies = await context.cookies();
            const hasLiAt = cookies.some(c => c.name === 'li_at' && c.value && c.value.length > 10);

            if (hasLiAt || currentUrl.includes('/feed') || currentUrl.includes('/in/') || (currentUrl.includes('/jobs/') && !currentUrl.includes('/login'))) {
                console.log('\n🎉 SUCCESS! LinkedIn session detected (li_at session token found).');
                authenticated = true;

                // Save storage state for headless agents
                await context.storageState({ path: STATE_FILE });
                console.log(`💾 Saved persistent session to ${STATE_FILE}`);

                try {
                    const userElem = await page.locator('.feed-identity-module, .global-nav__me, .identity-headline').first();
                    const text = await userElem.innerText().catch(() => '');
                    if (text) {
                        console.log(`👤 Connected as: ${text.split('\n')[0]}`);
                    }
                } catch (e) {}

                console.log('✅ LinkedIn Authentication complete! You can close the browser window or continue.');
                break;
            }
        } catch (pollErr) {
            // Page might be navigating
        }
    }

    if (!authenticated) {
        console.log('\n⚠️ Login timed out after 5 minutes.');
    }

    // Keep open for 3 seconds, then cleanly close
    await new Promise(r => setTimeout(r, 3000));
    await context.close().catch(() => {});
    return authenticated;
}

if (require.main === module) {
    loginLinkedIn()
        .then(success => {
            process.exit(success ? 0 : 1);
        })
        .catch(err => {
            console.error('Fatal LinkedIn login error:', err);
            process.exit(1);
        });
}

module.exports = { loginLinkedIn, isLinkedInAuthenticated, PROFILE_DIR, STATE_FILE };
