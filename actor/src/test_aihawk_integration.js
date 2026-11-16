const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { initDb, runQuery, getQuery, allQuery } = require('./db');
const {
    getAihawkConfig,
    getMaskedConfig,
    maskSecret,
    client,
    matcherService,
    jobService,
    applicationService,
    browserManager,
    mcpBridge,
    logger
} = require('./services/aihawk');

async function runTests() {
    console.log('==================================================');
    console.log('Starting AIHawk Comprehensive Integration Test Suite');
    console.log('==================================================\n');

    try {
        // Test 1: Database Initialization
        console.log('[Test 1] Testing Database & AIHawk Schema Initializations...');
        await initDb();
        const tables = await allQuery("SELECT name FROM sqlite_master WHERE type='table'");
        const tableNames = tables.map(t => t.name);

        assert(tableNames.includes('jobs'), 'jobs table should exist');
        assert(tableNames.includes('job_search_profiles'), 'job_search_profiles table should exist');
        assert(tableNames.includes('ai_job_matches'), 'ai_job_matches table should exist');
        assert(tableNames.includes('applications'), 'applications table should exist');
        assert(tableNames.includes('application_logs'), 'application_logs table should exist');
        assert(tableNames.includes('aihawk_sessions'), 'aihawk_sessions table should exist');
        console.log('  -> PASS: All AIHawk tables initialized correctly.');

        // Test 2: Config Management & Secret Masking
        console.log('\n[Test 2] Testing Configuration Management & Secret Masking...');
        const maskedLong = maskSecret('sk-or-v1-abcdef1234567890');
        assert.strictEqual(maskedLong, 'sk-o...7890', 'Should mask long secrets correctly');
        const maskedShort = maskSecret('12345');
        assert.strictEqual(maskedShort, '********', 'Should mask short secrets with asterisks');
        const emptyMask = maskSecret('');
        assert.strictEqual(emptyMask, '', 'Should handle empty secrets gracefully');

        const config = await getAihawkConfig();
        assert(config.model, 'Config should have a default model');
        assert(config.profileDir, 'Config should specify a profile directory');
        const maskedConfig = getMaskedConfig(config);
        assert(maskedConfig.openrouterKey !== config.openrouterKey || !config.openrouterKey, 'Masked config must not expose raw key');
        console.log('  -> PASS: Configuration retrieval and secret masking verified.');

        // Test 3: Search Profiles CRUD
        console.log('\n[Test 3] Testing Job Search Profiles CRUD...');
        const testProfile = {
            name: 'Integration Test Profile',
            keywords: 'Backend Engineer, Go, Node.js',
            skills: 'Go, Node.js, SQLite',
            location: 'Remote, India',
            remote_type: 'remote',
            experience_level: 'entry_mid',
            employment_type: 'full_time',
            salary_min: 0,
            salary_max: 0,
            company_filters: 'figma,stripe,openai',
            excluded_companies: 'consulting',
            industry: 'Technology',
            date_posted: 'all',
            max_jobs: 15,
            sources: 'greenhouse,lever,remoteok'
        };

        const createdProfile = await jobService.createSearchProfile(testProfile);
        assert(createdProfile.id, 'Created profile should have an id');
        assert.strictEqual(createdProfile.name, 'Integration Test Profile');

        const profiles = await jobService.getSearchProfiles();
        assert(profiles.some(p => p.id === createdProfile.id), 'Created profile should be in listing');

        await jobService.deleteSearchProfile(createdProfile.id);
        const profilesAfter = await jobService.getSearchProfiles();
        assert(!profilesAfter.some(p => p.id === createdProfile.id), 'Profile should be deleted');
        console.log('  -> PASS: Job search profiles created, retrieved, and deleted successfully.');

        // Test 4: Job Seeding & Multi-Dimensional Match Evaluation
        console.log('\n[Test 4] Testing 5-Dimensional AI Job Matching...');
        const http = require('http');
        const mockHtml = fs.readFileSync(path.join(__dirname, '../public/mock_greenhouse.html'), 'utf8');
        const mockServer = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(mockHtml);
        });
        await new Promise(r => mockServer.listen(3921, '127.0.0.1', r));

        const testJobId = 'test_aihawk_job_101';
        const now = new Date().toISOString();
        await runQuery(`
            INSERT OR REPLACE INTO jobs (
                job_id, company, role, location, source, url, description,
                score, status, discovered_at, is_saved, is_ignored
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            testJobId,
            'Acme Cloud Corp',
            'Fullstack Software Engineer',
            'Remote - Global',
            'greenhouse',
            'http://127.0.0.1:3921/mock_greenhouse.html',
            'We are seeking a Fullstack Software Engineer with Node.js, Express, React, TypeScript, and SQLite experience to build cloud systems.',
            0,
            'DISCOVERED',
            now,
            0,
            0
        ]);

        const matchResult = await matcherService.evaluateJob(testJobId);
        assert(matchResult, 'Match result should be produced');
        assert(typeof matchResult.overall_score === 'number', 'Overall score should be a number');
        assert(matchResult.overall_score >= 0 && matchResult.overall_score <= 100, 'Overall score should be between 0 and 100');
        assert(typeof matchResult.skill_match === 'number', 'Skill match should be evaluated');
        assert(typeof matchResult.tech_match === 'number', 'Tech match should be evaluated');
        assert(Array.isArray(matchResult.matched_skills), 'Matched skills should be an array');
        assert(matchResult.explanation, 'Explanation should be provided');

        // Check database persistence of match
        const dbMatch = await matcherService.getJobMatch(testJobId);
        assert(dbMatch, 'Match must be persisted to ai_job_matches table');
        assert.strictEqual(dbMatch.job_id, testJobId);
        console.log(`  -> PASS: Job matched with overall score ${matchResult.overall_score}% across 5 dimensions.`);

        // Test 5: Job Save and Ignore Flags
        console.log('\n[Test 5] Testing Job Save & Ignore State Toggles...');
        await runQuery('UPDATE jobs SET is_saved = 1 WHERE job_id = ?', [testJobId]);
        let job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [testJobId]);
        assert.strictEqual(job.is_saved, 1, 'Job should be saved');

        await runQuery('UPDATE jobs SET is_saved = 0, is_ignored = 1 WHERE job_id = ?', [testJobId]);
        job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [testJobId]);
        assert.strictEqual(job.is_ignored, 1, 'Job should be ignored');
        console.log('  -> PASS: Job bookmarking and ignore status functioning properly.');

        // Test 6: Application Staging & User Approval Enforcement
        console.log('\n[Test 6] Testing Application Preparation & User Approval Gate...');
        const prep = await applicationService.prepareApplication(testJobId);
        assert(prep.applicationId, 'Preparation should generate an application record');
        assert.strictEqual(prep.status, 'READY_TO_APPLY', 'Application must be staged in READY_TO_APPLY state');
        assert(prep.preparedPayload.email, 'Prepared payload must populate candidate information');

        // Attempt execution without approval flag -> Staged in READY_TO_APPLY without submission
        const unapprovedExec = await applicationService.executeApplication(testJobId, { approved: false });
        assert.strictEqual(unapprovedExec.status, 'READY_TO_APPLY', 'Unapproved application must remain staged without submission');
        console.log('  -> PASS: User approval gate strictly blocks unapproved automated submissions.');

        // Test 7: Approved Execution Workflow
        console.log('\n[Test 7] Testing Approved Application Execution Lifecycle...');
        const execResult = await applicationService.executeApplication(testJobId, {
            approved: true,
            customFields: { notes: 'Automated integration test approval' }
        });
        assert(execResult.success, 'Execution should report success');
        assert(['APPLIED', 'REQUIRES_USER_ACTION'].includes(execResult.status), 'Application status should update to APPLIED or REQUIRES_USER_ACTION');

        const appRecord = await getQuery('SELECT * FROM applications WHERE job_id = ?', [testJobId]);
        assert(appRecord, 'Application record should be present');
        assert(['APPLIED', 'REQUIRES_USER_ACTION'].includes(appRecord.status));
        console.log(`  -> PASS: Approved application executed (Status: ${execResult.status}) and recorded to pipeline history.`);

        // Test 8: MCP Bridge & Tool Definitions
        console.log('\n[Test 8] Testing AIHawk MCP Server Bridge...');
        const mcpConfig = await mcpBridge.getMcpServerConfig();
        assert.strictEqual(mcpConfig.name, 'aihawk-stealth');
        assert(mcpConfig.command, 'MCP config should have a command');

        const tools = mcpBridge.getToolDefinitions();
        const toolNames = tools.map(t => t.name);
        assert(toolNames.includes('browser_open'), 'MCP should expose browser_open');
        assert(toolNames.includes('job_search'), 'MCP should expose job_search');
        assert(toolNames.includes('job_match'), 'MCP should expose job_match');
        assert(toolNames.includes('job_apply_prepare'), 'MCP should expose job_apply_prepare');
        assert(toolNames.includes('job_apply_execute'), 'MCP should expose job_apply_execute');
        console.log(`  -> PASS: MCP bridge defines ${tools.length} stealth agent tools.`);

        // Clean up test records and browser sessions
        await browserManager.closeAllSessions();
        await runQuery('DELETE FROM applications WHERE job_id = ?', [testJobId]);
        await runQuery('DELETE FROM ai_job_matches WHERE job_id = ?', [testJobId]);
        await runQuery('DELETE FROM jobs WHERE job_id = ?', [testJobId]);
        if (mockServer) mockServer.close();

        console.log('\n==================================================');
        console.log('ALL AIHAWK INTEGRATION TESTS PASSED SUCCESSFULLY!');
        console.log('==================================================\n');
        process.exit(0);
    } catch (err) {
        console.error('\n[TEST FAILURE]', err);
        process.exit(1);
    }
}

runTests();
