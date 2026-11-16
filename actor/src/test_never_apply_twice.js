/**
 * test_never_apply_twice.js
 * Comprehensive automated verification test suite ensuring that the system
 * NEVER applies to the same job listing twice.
 */

const assert = require('assert');
const http = require('http');
const {
    normalizeJobUrl,
    normalizeCompanyName,
    normalizeRoleTitle,
    computeJobKey,
    acquireApplyLock,
    releaseApplyLock,
    checkAlreadyApplied,
    checkPageAlreadyApplied,
    recordJobApplied
} = require('./pipeline/application_guard');
const { applyToJob } = require('./autofiller');
const { runQuery, getQuery } = require('./db');

let totalTests = 0;
let passedTests = 0;

async function test(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
    }
}

async function runNeverApplyTwiceTestSuite() {
    console.log('========================================================');
    console.log('🧪 Starting "Never Apply Twice" Duplicate Prevention Tests');
    console.log('========================================================\n');

    // Seed test jobs in database
    const testJob1Id = 'test_dup_job_001';
    const testJob2Id = 'test_dup_job_002';
    const testJob3Id = 'test_dup_job_003';
    const now = new Date().toISOString();

    // Clean up previous test runs if any
    await runQuery('DELETE FROM jobs WHERE job_id IN (?, ?, ?)', [testJob1Id, testJob2Id, testJob3Id]);
    await runQuery('DELETE FROM applications WHERE job_id IN (?, ?, ?)', [testJob1Id, testJob2Id, testJob3Id]);

    // Insert testJob1 as already APPLIED
    await runQuery(`
        INSERT INTO jobs (
            job_id, company, role, location, source, url, application_url,
            status, applied_at, score, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'APPLIED', ?, 95, ?)
    `, [
        testJob1Id,
        'Anthropic PBC',
        'Senior AI Systems Engineer',
        'Remote',
        'greenhouse',
        'https://boards.greenhouse.io/anthropic/jobs/4001?gh_jid=4001',
        'https://boards.greenhouse.io/anthropic/jobs/4001?gh_jid=4001',
        now,
        now
    ]);

    // Insert testJob2 as ACTIVE (unapplied)
    await runQuery(`
        INSERT INTO jobs (
            job_id, company, role, location, source, url, application_url,
            status, score, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 90, ?)
    `, [
        testJob2Id,
        'BrandNewCo Inc',
        'Full Stack Engineer',
        'Remote',
        'ashby',
        'https://jobs.ashbyhq.com/brandnewco/9001',
        'https://jobs.ashbyhq.com/brandnewco/9001',
        now
    ]);

    console.log('Suite 1: URL Normalization & Canonical Fingerprinting');

    await test('normalizeJobUrl should strip tracking params and fragments', () => {
        const raw = 'https://boards.greenhouse.io/anthropic/jobs/4001?utm_source=linkedin&ref=boards&gh_src=share#apply';
        const expected = 'https://boards.greenhouse.io/anthropic/jobs/4001';
        assert.strictEqual(normalizeJobUrl(raw), expected);
    });

    await test('normalizeJobUrl should deduplicate query parameters', () => {
        const raw = 'https://jobs.elastic.co/jobs?gh_jid=8256011&gh_jid=8256011';
        const expected = 'https://jobs.elastic.co/jobs?gh_jid=8256011';
        assert.strictEqual(normalizeJobUrl(raw), expected);
    });

    await test('normalizeCompanyName should strip legal suffixes & punctuation', () => {
        assert.strictEqual(normalizeCompanyName('Anthropic, PBC'), 'anthropic');
        assert.strictEqual(normalizeCompanyName('Google LLC'), 'google');
        assert.strictEqual(normalizeCompanyName('Figma (Local Test Sandbox)'), 'figma');
        assert.strictEqual(normalizeCompanyName('Rubrik Inc.'), 'rubrik');
    });

    await test('normalizeRoleTitle should strip parentheticals and extra whitespace', () => {
        assert.strictEqual(normalizeRoleTitle('Senior AI Systems Engineer (Remote)'), 'senior ai systems engineer');
        assert.strictEqual(normalizeRoleTitle('Staff Software Engineer [India / Remote]'), 'staff software engineer');
    });

    console.log('\nSuite 2: Database Pre-Flight Guard');

    await test('checkAlreadyApplied should catch exact job_id that has status APPLIED', async () => {
        const res = await checkAlreadyApplied(testJob1Id);
        assert.strictEqual(res.alreadyApplied, true);
        assert.strictEqual(res.matchType, 'DIRECT_ID');
    });

    await test('checkAlreadyApplied should catch novel job listing with the same URL (even with tracking params)', async () => {
        const res = await checkAlreadyApplied({
            company: 'Different Co Name',
            role: 'Different Title',
            url: 'https://boards.greenhouse.io/anthropic/jobs/4001?utm_source=twitter&ref=feed#app'
        });
        assert.strictEqual(res.alreadyApplied, true);
        assert.strictEqual(res.matchType, 'NORMALIZED_URL');
    });

    await test('checkAlreadyApplied should catch duplicate opportunity by canonical company + role', async () => {
        const res = await checkAlreadyApplied({
            company: 'Anthropic, Inc.',
            role: 'Senior AI Systems Engineer (Worldwide Remote)',
            url: 'https://different-job-board.com/anthropic-posting'
        });
        assert.strictEqual(res.alreadyApplied, true);
        assert.strictEqual(res.matchType, 'CANONICAL_ROLE');
    });

    await test('checkAlreadyApplied should return false for genuinely unapplied jobs', async () => {
        const res = await checkAlreadyApplied(testJob2Id);
        assert.strictEqual(res.alreadyApplied, false);
    });

    console.log('\nSuite 3: Concurrency & In-Flight Lock Protection');

    await test('acquireApplyLock should block concurrent submissions for the same job or URL', () => {
        const lock1 = acquireApplyLock('lock_job_1', 'https://jobs.example.com/test', 'Acme', 'Engineer');
        assert.strictEqual(lock1, true, 'First lock must succeed');

        const lock2 = acquireApplyLock('lock_job_1', 'https://jobs.example.com/test', 'Acme', 'Engineer');
        assert.strictEqual(lock2, false, 'Duplicate lock on same job_id must be rejected');

        const lock3 = acquireApplyLock('lock_job_2', 'https://jobs.example.com/test', 'OtherCo', 'OtherRole');
        assert.strictEqual(lock3, false, 'Duplicate lock on same normalized URL must be rejected');

        releaseApplyLock('lock_job_1', 'https://jobs.example.com/test', 'Acme', 'Engineer');

        const lock4 = acquireApplyLock('lock_job_1', 'https://jobs.example.com/test', 'Acme', 'Engineer');
        assert.strictEqual(lock4, true, 'Lock must be re-acquirable after release');
        releaseApplyLock('lock_job_1', 'https://jobs.example.com/test', 'Acme', 'Engineer');
    });

    console.log('\nSuite 4: Orchestrator Integration (applyToJob)');

    await test('applyToJob must IMMEDIATELY skip browser launch and return already_applied: true', async () => {
        const result = await applyToJob(testJob1Id, { autoSubmit: true });
        assert.strictEqual(result.already_applied, true);
        assert.strictEqual(result.status, 'APPLIED');
        assert.strictEqual(result.submitted, false);
        assert(result.message.includes('Skipped duplicate'), 'Message must indicate skipped duplicate');
    });

    console.log('\nSuite 5: In-Browser ATS Portal Page Detection');

    await test('checkPageAlreadyApplied should detect on-page phrases', async () => {
        const mockPage = {
            innerText: async (sel) => {
                if (sel === 'body') {
                    return 'Welcome to Stripe Careers. Note: You have already applied to this job on October 12, 2026.';
                }
                return '';
            },
            locator: () => ({
                count: async () => 0,
                first: () => ({ isVisible: async () => false })
            })
        };

        const check = await checkPageAlreadyApplied(mockPage);
        assert.strictEqual(check.alreadyAppliedOnPage, true);
        assert.strictEqual(check.detectedText, 'you have already applied');
    });

    await test('checkPageAlreadyApplied should detect LinkedIn / ATS Applied badge', async () => {
        const mockPage = {
            innerText: async () => 'Software Engineer at Linear. Remote.',
            locator: (sel) => ({
                count: async () => sel.includes('button:has-text("Applied")') ? 1 : 0,
                first: () => ({
                    isVisible: async () => true,
                    innerText: async () => 'Applied'
                })
            })
        };

        const check = await checkPageAlreadyApplied(mockPage);
        assert.strictEqual(check.alreadyAppliedOnPage, true);
        assert.strictEqual(check.detectedText, 'Applied');
    });

    // Clean up test rows
    await runQuery('DELETE FROM jobs WHERE job_id IN (?, ?, ?)', [testJob1Id, testJob2Id, testJob3Id]);
    await runQuery('DELETE FROM applications WHERE job_id IN (?, ?, ?)', [testJob1Id, testJob2Id, testJob3Id]);

    console.log('\n========================================================');
    console.log(`TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
    console.log('========================================================');

    if (passedTests !== totalTests) {
        process.exit(1);
    }
}

runNeverApplyTwiceTestSuite().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
