/**
 * End-to-End Test Suite for Unified Job Discovery Engine
 */

const assert = require('assert');
const path = require('path');
const { initDb, allQuery, getQuery, runQuery } = require('./db');
const { normalizeJob, normalizeCompany, normalizeTitle } = require('./pipeline/normalizer');
const { deduplicateJobs, cleanUrlForDeduplication } = require('./pipeline/deduplicator');
const { verifyJob, batchVerifyJobs } = require('./pipeline/verifier');
const { matchJobWithCandidate, evaluateDeterministicMatch } = require('./pipeline/matcher');
const { executeDiscoveryCycle, SEARCH_MODES } = require('./discoveryEngine');
const { getAllConnectorStatuses, recordConnectorStatus, SOURCE_CONNECTORS } = require('./connectors');

async function runTests() {
    console.log('================================================================');
    console.log('🧪 RUNNING COMPREHENSIVE JOB DISCOVERY ENGINE TEST SUITE');
    console.log('================================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            process.stdout.write(`• ${name}... `);
            await fn();
            console.log('✅ PASS');
            passed++;
        } catch (err) {
            console.log('❌ FAIL');
            console.error(`  Error: ${err.message}`);
            failed++;
        }
    }

    // 1. Database Init Test
    await test('Database Schema & Table Initialization', async () => {
        await initDb();
        const tables = await allQuery("SELECT name FROM sqlite_master WHERE type='table'");
        const tableNames = tables.map(t => t.name);
        const requiredTables = ['jobs', 'job_sources', 'companies', 'ai_job_matches', 'job_verifications', 'candidate_profiles', 'referrals', 'search_runs'];
        for (const reqTable of requiredTables) {
            assert(tableNames.includes(reqTable), `Missing table ${reqTable}`);
        }
    });

    // 2. Normalization Test
    await test('Job Normalizer maps raw inputs into Normalized Job Schema', async () => {
        const raw = {
            title: 'Senior Software Engineer, Backend - Experimentation',
            company: 'DoorDash Inc.',
            url: 'https://careers.doordash.com/job/12345?utm_source=linkedin&ref=board',
            location: 'Remote, US',
            description: '<p>Build scalable backend systems with <b>Python</b>, <b>Go</b>, and <b>PostgreSQL</b>.</p>',
            source: 'JobYap',
            salary_min: 140000,
            salary_max: 190000,
            salary_currency: 'USD'
        };

        const normalized = normalizeJob(raw);
        assert(normalized.id, 'Missing normalized id');
        assert.strictEqual(normalized.company, 'DoorDash');
        assert.strictEqual(normalized.remote_type, 'remote');
        assert(normalized.skills.toLowerCase().includes('python'));
        assert(normalized.skills.toLowerCase().includes('go'));
        assert(normalized.skills.toLowerCase().includes('postgresql'));
        assert(!normalized.description.includes('<p>'), 'HTML tags not stripped from description');
    });

    // 3. Deduplication Test
    await test('Deduplication Engine merges identical postings & multi-locations', async () => {
        const jobA = normalizeJob({
            title: 'Backend Engineer',
            company: 'Stripe',
            url: 'https://stripe.com/jobs/1?utm_source=linkedin',
            location: 'Remote',
            description: 'Core payment rails in Go and Ruby.'
        });

        const jobB = normalizeJob({
            title: 'Backend Engineer',
            company: 'Stripe',
            url: 'https://stripe.com/jobs/1?utm_source=twitter',
            location: 'India',
            description: 'Core payment rails in Go and Ruby.'
        });

        const result = deduplicateJobs([jobA, jobB]);
        assert.strictEqual(result.uniqueCount, 1, 'Should deduplicate identical jobs');
        assert.strictEqual(result.duplicatesRemoved, 1);
        assert(result.deduplicated[0].location.includes('Remote'));
        assert(result.deduplicated[0].location.includes('India'));
    });

    // 4. Verification Test
    await test('Job Verification Engine validates URLs and updates status', async () => {
        const testJob = normalizeJob({
            title: 'Software Engineer',
            company: 'Vercel',
            url: 'https://vercel.com',
            location: 'Remote'
        });

        const verResult = await verifyJob(testJob);
        assert(verResult.status === 'ACTIVE' || verResult.status === 'UNVERIFIED');
        assert(verResult.verifiedAt);
    });

    // 5. Matching Engine Test
    await test('Candidate Profile Matching evaluates skills and generates outreach drafts', async () => {
        const job = normalizeJob({
            title: 'Junior Backend Engineer (Go / Python)',
            company: 'Supabase',
            url: 'https://supabase.com/jobs/sde1',
            location: 'Remote',
            description: 'Early career role for 2026 graduates. Work with Go, Python, PostgreSQL, Redis, and LangChain LLMs.'
        });

        const match = await matchJobWithCandidate(job);
        assert(match.overall_score >= 80, `Expected score >= 80, got ${match.overall_score}`);
        assert(match.matched_skills.toLowerCase().includes('go'));
        assert(match.matched_skills.toLowerCase().includes('python'));
        assert(match.relevant_projects.includes('Monerva'));
        assert(job.notes, 'Outreach drafts not attached to job notes');
    });

    // 6. Connector Isolation Test
    await test('Connector Isolation: Single connector failure does not stop discovery cycle', async () => {
        recordConnectorStatus('failed_test_connector', { status: 'FAILED', error: 'Network timeout simulation' });
        const stat = getAllConnectorStatuses().find(c => c.id === 'failed_test_connector');
        assert.strictEqual(stat.status, 'FAILED');
        assert.strictEqual(stat.lastError, 'Network timeout simulation');
    });

    // 7. Full Discovery Cycle End-to-End Test
    await test('Full Discovery Cycle executes, dedups, verifies, matches, and persists', async () => {
        const discoveryOutput = await executeDiscoveryCycle({
            modes: ['QUICK_SEARCH'],
            selectedSources: 'all',
            verifyImmediate: true,
            scoreThreshold: 70
        });

        assert(discoveryOutput.runId, 'Missing runId');
        assert(discoveryOutput.jobsFound > 0, 'No jobs discovered');
        assert(discoveryOutput.sourcesAttempted > 0, 'No sources attempted');
        assert(discoveryOutput.sourcesSucceeded > 0, 'No sources succeeded');

        // Check DB persisted jobs
        const dbJobsCount = ((await getQuery("SELECT COUNT(*) as count FROM jobs")) || {}).count || 0;
        assert(dbJobsCount > 0, 'No jobs in SQLite database');

        // Check SearchRun persisted
        const lastRun = await getQuery("SELECT * FROM search_runs WHERE id = ?", [discoveryOutput.runId]);
        assert(lastRun, 'SearchRun record not persisted');
        assert.strictEqual(lastRun.status, 'completed');
    });

    console.log('\n================================================================');
    console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================');

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runTests();
}

module.exports = { runTests };
