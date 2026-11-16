const http = require('http');
const assert = require('assert');
const { chromium } = require('playwright');
const captchaManager = require('./captcha_manager');

async function run() {
    console.log('====================================================');
    console.log('🧪 Starting CAPTCHA Localhost Popup Solver Tests');
    console.log('====================================================\n');

    // ----------------------------------------------------
    // Test 1: CAPTCHA Challenge Detection Logic
    // ----------------------------------------------------
    console.log('[Test 1] Testing challenge element detection in Playwright DOM...');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });

    // A. Page without CAPTCHA
    await page.setContent('<div class="form"><h1>Job Application</h1><button id="btn">Submit</button></div>');
    let hasCap = await captchaManager.isCaptchaChallenge(page);
    assert.strictEqual(hasCap, false, 'Page without CAPTCHA should return false');
    console.log('  ✓ Correctly returns false for standard form');

    // B. Page with Cloudflare Turnstile
    await page.setContent('<div class="form"><div class="cf-turnstile" data-sitekey="xyz">Verify you are human</div></div>');
    hasCap = await captchaManager.isCaptchaChallenge(page);
    assert.strictEqual(hasCap, true, 'Page with Cloudflare Turnstile should return true');
    console.log('  ✓ Correctly detects Cloudflare Turnstile challenge');

    // C. Page with Google reCAPTCHA
    await page.setContent('<div class="form"><div class="g-recaptcha" data-sitekey="xyz"></div></div>');
    hasCap = await captchaManager.isCaptchaChallenge(page);
    assert.strictEqual(hasCap, true, 'Page with g-recaptcha should return true');
    console.log('  ✓ Correctly detects Google reCAPTCHA challenge');

    // D. Page with Email Security Code input
    await page.setContent('<div class="form"><input id="security-input-0" placeholder="security code" /></div>');
    hasCap = await captchaManager.isCaptchaChallenge(page);
    assert.strictEqual(hasCap, true, 'Page with security code should return true');
    console.log('  ✓ Correctly detects Email Verification / Security code challenge');

    // ----------------------------------------------------
    // Test 2: Test Session Simulation & Frame Delivery
    // ----------------------------------------------------
    console.log('\n[Test 2] Testing simulated test session for localhost popup...');
    const testSession = captchaManager.createTestSession();
    assert.ok(testSession, 'Test session should be created');
    assert.strictEqual(testSession.status, 'ACTIVE');
    assert.strictEqual(testSession.company, 'Acme AI Labs');
    console.log('  ✓ Test session generated successfully with session ID:', testSession.id);

    const active = captchaManager.getActiveSession();
    assert.strictEqual(active.id, testSession.id);
    console.log('  ✓ getActiveSession returns the test session');

    const frame = captchaManager.getLatestFrame(testSession.id);
    assert.ok(frame && frame.length > 0, 'Latest frame buffer should not be empty');
    assert.ok(frame.toString('utf8').includes('Cloudflare Turnstile'), 'Frame should contain Turnstile mockup');
    console.log('  ✓ getLatestFrame returns valid interactive image buffer (' + frame.length + ' bytes)');

    captchaManager.clearTestSession();
    assert.strictEqual(captchaManager.getActiveSession(), null);
    console.log('  ✓ clearTestSession cleanly removes simulated session');

    // ----------------------------------------------------
    // Test 3: Live Playwright Screencasting & Interactive Click Dispatch
    // ----------------------------------------------------
    console.log('\n[Test 3] Testing live interactive click dispatch into Playwright...');
    let boxClicked = false;
    await page.setContent(`
        <div style="width:1280px;height:850px;background:#fff;padding:40px;">
            <h2>Acme Careers</h2>
            <div id="captcha-box" style="width:300px;height:80px;background:#fef3c7;border:2px solid #f59e0b;cursor:pointer;padding:20px;">
                Verify you are human
            </div>
            <button id="submit-btn" style="margin-top:20px;padding:10px 20px;">Submit Application</button>
        </div>
        <script>
            document.getElementById('captcha-box').addEventListener('click', () => {
                window.boxClicked = true;
                document.getElementById('captcha-box').style.background = '#d1fae5';
                document.getElementById('captcha-box').innerHTML = '✓ Human Verified';
            });
        </script>
    `);

    // Register live challenge with short timeout
    const challengePromise = captchaManager.registerChallenge({
        page,
        targetFrame: page,
        submitLocator: page.locator('#submit-btn'),
        atsType: 'Greenhouse',
        job: { role: 'Full Stack Engineer', company: 'Acme Test' },
        jobId: 'test_job_interactive',
        timeoutMs: 8000
    });

    const liveActiveSession = captchaManager.getActiveSession();
    assert.ok(liveActiveSession, 'Live session must be active');
    console.log('  ✓ Live challenge registered with session ID:', liveActiveSession.id);

    // Give CDP screencast 500ms to initialize
    await new Promise(r => setTimeout(r, 600));

    // Verify latest frame was captured
    const liveFrame = captchaManager.getLatestFrame(liveActiveSession.id);
    assert.ok(liveFrame && liveFrame.length > 0, 'Live screencast frame captured');
    console.log('  ✓ Live frame successfully captured via CDP screencast (' + liveFrame.length + ' bytes)');

    // Get exact center of #captcha-box
    const box = await page.locator('#captcha-box').boundingBox();
    const clickX = Math.round(box.x + box.width / 2);
    const clickY = Math.round(box.y + box.height / 2);

    // Dispatch click from localhost popup coordinates onto #captcha-box
    await captchaManager.dispatchInput(liveActiveSession.id, {
        type: 'click',
        x: clickX,
        y: clickY,
        displayWidth: 1280,
        displayHeight: 850
    });

    await new Promise(r => setTimeout(r, 500));
    const wasClicked = await page.evaluate(() => window.boxClicked);
    assert.strictEqual(wasClicked, true, 'Click dispatched from localhost popup must hit target element in live page');
    console.log('  ✓ Live click dispatched to page successfully triggered element event!');

    // Clean up session by skipping
    await captchaManager.skipSession(liveActiveSession.id);
    const outcome = await challengePromise;
    assert.strictEqual(outcome.captcha_required, true);
    assert.strictEqual(outcome.status, 'CAPTCHA_REQUIRED');
    console.log('  ✓ Cleanly resolved with CAPTCHA_REQUIRED on user skip');

    await browser.close();

    // ----------------------------------------------------
    // Test 4: End-to-End HTTP API Endpoints on Localhost
    // ----------------------------------------------------
    console.log('\n[Test 4] Testing Localhost Server API routes (/api/captcha/*)...');
    const { server } = require('./server');
    const TEST_PORT = 3456;

    await new Promise((resolve) => server.listen(TEST_PORT, '127.0.0.1', resolve));
    console.log(`  ✓ Localhost test server listening on port ${TEST_PORT}`);

    const makeRequest = (path, method = 'GET', body = null) => {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: TEST_PORT,
                path,
                method,
                headers: body ? { 'Content-Type': 'application/json' } : {}
            }, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    let json = null;
                    try { json = JSON.parse(buffer.toString('utf8')); } catch (e) {}
                    resolve({ statusCode: res.statusCode, headers: res.headers, buffer, json });
                });
            });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    };

    try {
        // A. GET /api/captcha/status (Initially idle)
        const initialStatus = await makeRequest('/api/captcha/status');
        assert.strictEqual(initialStatus.statusCode, 200);
        assert.strictEqual(initialStatus.json.hasActiveCaptcha, false);
        console.log('  ✓ GET /api/captcha/status correctly reports idle initially');

        // B. POST /api/captcha/test (Triggers test session)
        const triggerTest = await makeRequest('/api/captcha/test', 'POST');
        assert.strictEqual(triggerTest.statusCode, 200);
        assert.strictEqual(triggerTest.json.success, true);
        assert.ok(triggerTest.json.session, 'Should return test session data');
        console.log('  ✓ POST /api/captcha/test successfully triggered session:', triggerTest.json.session.id);

        // C. GET /api/captcha/status (Now active)
        const activeStatus = await makeRequest('/api/captcha/status');
        assert.strictEqual(activeStatus.statusCode, 200);
        assert.strictEqual(activeStatus.json.hasActiveCaptcha, true);
        assert.strictEqual(activeStatus.json.session.company, 'Acme AI Labs');
        console.log('  ✓ GET /api/captcha/status reports active CAPTCHA session with company:', activeStatus.json.session.company);

        // D. GET /api/captcha/frame
        const frameRes = await makeRequest('/api/captcha/frame');
        assert.strictEqual(frameRes.statusCode, 200);
        assert.ok(frameRes.buffer.length > 500, 'Frame image should be returned');
        console.log('  ✓ GET /api/captcha/frame successfully returns interactive frame buffer (' + frameRes.buffer.length + ' bytes)');

        // E. POST /api/captcha/skip
        const skipRes = await makeRequest('/api/captcha/skip', 'POST', { sessionId: triggerTest.json.session.id });
        assert.strictEqual(skipRes.statusCode, 200);
        assert.strictEqual(skipRes.json.success, true);
        console.log('  ✓ POST /api/captcha/skip successfully resolved and cleared session');

    } finally {
        await new Promise((resolve) => server.close(resolve));
        console.log('  ✓ Localhost test server closed cleanly');
    }

    console.log('\n====================================================');
    console.log('🎉 ALL CAPTCHA LOCALHOST POPUP SOLVER TESTS PASSED!');
    console.log('====================================================\n');
}

run().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
