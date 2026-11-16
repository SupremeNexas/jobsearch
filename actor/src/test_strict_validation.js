/**
 * test_strict_validation.js
 * Comprehensive automated verification test suite for ATS submission verification.
 * 
 * Verifies:
 * 1. Unit testing of `verifySubmissionStrict` decision matrix.
 * 2. E2E Playwright test with a failing form (validation errors / unsubmitted).
 *    MUST return `submitted: false`, `requires_manual: true`, and never declare success.
 * 3. E2E Playwright test with a genuinely successful form.
 *    MUST return `submitted: true`, `requires_manual: false`.
 */

const assert = require('assert');
const http = require('http');
const { autoApply, verifySubmissionStrict } = require('./apply');

let passedTests = 0;
let totalTests = 0;

function it(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}`);
    }
}

async function itAsync(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}`);
    }
}

async function runTestSuite() {
    console.log('====================================================');
    console.log('🧪 Starting ATS Strict Submission Verification Tests');
    console.log('====================================================\n');

    // ==========================================
    // SUITE 1: verifySubmissionStrict Decision Logic
    // ==========================================
    console.log('Suite 1: verifySubmissionStrict Unit Logic');

    await itAsync('Should REJECT submission when submit button is still visible on form', async () => {
        const mockPage = {
            url: () => 'https://boards.greenhouse.io/company/jobs/12345',
            innerText: async () => 'Apply for this job First Name Last Name Email',
            locator: (sel) => {
                if (sel.includes('button[type="submit"]')) {
                    return {
                        count: async () => 1,
                        first: () => ({ isVisible: async () => true })
                    };
                }
                return {
                    count: async () => 0,
                    first: () => ({ isVisible: async () => false })
                };
            }
        };

        const result = await verifySubmissionStrict(mockPage, mockPage, 'Greenhouse');
        assert.strictEqual(result.submitted, false, 'Must not be submitted when button is still visible');
        assert.strictEqual(result.requires_manual, true, 'Must require manual review');
    });

    await itAsync('Should REJECT submission when validation errors are present', async () => {
        const mockPage = {
            url: () => 'https://boards.greenhouse.io/company/jobs/12345',
            innerText: async () => 'Apply for this job First Name is required. Please enter your location',
            locator: (sel) => {
                if (sel.includes('.field-error')) {
                    return {
                        count: async () => 1,
                        nth: () => ({
                            isVisible: async () => true,
                            innerText: async () => 'First Name is required.'
                        })
                    };
                }
                if (sel.includes('button[type="submit"]')) {
                    return {
                        count: async () => 1,
                        first: () => ({ isVisible: async () => true })
                    };
                }
                return {
                    count: async () => 0,
                    first: () => ({ isVisible: async () => false })
                };
            }
        };

        const result = await verifySubmissionStrict(mockPage, mockPage, 'Greenhouse');
        assert.strictEqual(result.submitted, false, 'Must be false when validation errors exist');
        assert.strictEqual(result.requires_manual, true);
        assert.ok(result.message.includes('Form rejected by Greenhouse validation') || result.errors.length > 0);
    });

    await itAsync('Should REJECT submission when CAPTCHA is detected', async () => {
        const mockPage = {
            url: () => 'https://boards.greenhouse.io/company/jobs/12345',
            innerText: async () => 'Verify you are human',
            locator: (sel) => {
                if (sel.includes('iframe[title*="challenge"]') || sel.includes('recaptcha')) {
                    return {
                        count: async () => 1,
                        first: () => ({ isVisible: async () => true })
                    };
                }
                return {
                    count: async () => 0,
                    first: () => ({ isVisible: async () => false })
                };
            }
        };

        const result = await verifySubmissionStrict(mockPage, mockPage, 'Greenhouse');
        assert.strictEqual(result.submitted, false);
        assert.strictEqual(result.requires_manual, true);
        assert.ok(result.message.includes('CAPTCHA'));
    });

    await itAsync('Should APPROVE submission ONLY when URL or text confirms AND submit button is gone', async () => {
        const mockPage = {
            url: () => 'https://boards.greenhouse.io/company/jobs/12345/thanks',
            innerText: async () => 'Thank you for applying to Company! Your application has been received.',
            locator: (sel) => ({
                count: async () => 0,
                first: () => ({ isVisible: async () => false }),
                nth: () => ({ isVisible: async () => false, innerText: async () => '' })
            })
        };

        const result = await verifySubmissionStrict(mockPage, mockPage, 'Greenhouse');
        assert.strictEqual(result.submitted, true, 'Must confirm submission when thanks page is reached');
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.requires_manual, false);
    });

    // ==========================================
    // SUITE 2: End-to-End Browser Playwright Tests
    // ==========================================
    console.log('\nSuite 2: E2E Playwright Browser Tests against Real Mock Server');

    // Spin up local HTTP server with failing and successful forms
    const testServer = http.createServer((req, res) => {
        if (req.url === '/failing_form.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <!DOCTYPE html>
                <html>
                <body>
                    <h2>Company - Software Engineer</h2>
                    <form id="application_form" onsubmit="event.preventDefault(); document.getElementById('err').style.display='block';">
                        <label for="first_name">First Name</label>
                        <input id="first_name" name="first_name" value="Alex" />
                        <label for="location">Location *</label>
                        <input id="candidate-location" name="location" value="" />
                        <div id="err" class="field-error" style="display:none; color:red;">Please enter your location</div>
                        <button type="submit" id="submit_app">Submit Application</button>
                    </form>
                </body>
                </html>
            `);
        } else if (req.url === '/successful_form.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                <!DOCTYPE html>
                <html>
                <body>
                    <h2>Company - Software Engineer</h2>
                    <form id="application_form" onsubmit="event.preventDefault(); document.getElementById('application_form').style.display='none'; document.getElementById('thanks').style.display='block';">
                        <label for="first_name">First Name</label>
                        <input id="first_name" name="first_name" value="Alex" />
                        <button type="submit" id="submit_app">Submit Application</button>
                    </form>
                    <div id="thanks" style="display:none;">
                        <h3>Thank you for applying</h3>
                        <p>Your application submitted successfully!</p>
                    </div>
                </body>
                </html>
            `);
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise(resolve => testServer.listen(3099, '127.0.0.1', resolve));

    const applicant = {
        firstName: 'Alex',
        lastName: 'Morgan',
        email: 'alex.morgan@example.com',
        phone: '+1-555-0199',
        linkedin: 'https://linkedin.com/in/alexmorgan',
        github: 'https://github.com/alexmorgan',
        portfolio: 'https://alexmorgan.dev',
        location: 'San Francisco, CA',
        workAuthorization: 'Yes',
        requiresSponsorship: 'No'
    };
    const dummyPdf = Buffer.from('%PDF-1.4 Mock PDF content');

    try {
        await itAsync('E2E: Failing form with validation errors MUST NOT be marked submitted', async () => {
            const result = await autoApply('http://127.0.0.1:3099/failing_form.html', applicant, dummyPdf, true);
            assert.strictEqual(result.submitted, false, 'Result submitted must be false for failing form');
            assert.strictEqual(result.success, false, 'Result success must be false for failing form');
            assert.ok(result.message.includes('validation') || result.message.includes('did not confirm') || result.message.includes('Submit button still active'), 'Message must indicate error');
            console.log(`    [Failing Form Result Message]: "${result.message}"`);
        });

        await itAsync('E2E: Successful form MUST be marked submitted', async () => {
            const result = await autoApply('http://127.0.0.1:3099/successful_form.html', applicant, dummyPdf, true);
            assert.strictEqual(result.submitted, true, 'Result submitted must be true for successful form');
            assert.strictEqual(result.success, true, 'Result success must be true for successful form');
            assert.ok(result.message.includes('confirmed & successfully submitted'), 'Message must indicate confirmation');
            console.log(`    [Successful Form Result Message]: "${result.message}"`);
        });
    } finally {
        testServer.close();
    }

    console.log('\n====================================================');
    console.log(`TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
    console.log('====================================================');

    if (passedTests !== totalTests) {
        process.exit(1);
    }
}

runTestSuite().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
