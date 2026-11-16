const http = require('http');
const fs = require('fs');
const path = require('path');
const { initDb, runQuery, getQuery } = require('./db');
const { tailorJobApplication, applyToJob } = require('./autofiller');
const { server } = require('./server');

const testJobId = 'mocktestjob111';

async function runEndToEndTest() {
    console.log('====================================================');
    console.log('STARTING SAFELY ISOLATED PIPELINE INTEGRATION TEST...');
    console.log('====================================================');

    // 1. Initialize SQLite Database
    await initDb();

    // 2. Clear previous test records
    await runQuery('DELETE FROM jobs WHERE job_id = ?', [testJobId]);
    await runQuery('DELETE FROM resume_versions WHERE job_id = ?', [testJobId]);

    // 3. Insert mock settings
    await runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES ('MIN_SCORE_THRESHOLD', '75')");
    await runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES ('AUTO_APPLY_ENABLED', 'true')");
    await runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES ('AUTO_APPLY_MODE', 'AUTO_APPLY')");

    // 4. Seed Mock Job referencing local mockup form url
    await runQuery(`
        INSERT INTO jobs (
            job_id, company, role, location, source, url, description,
            score, score_explanation, status, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        testJobId,
        'Figma (Local Test Sandbox)',
        'Software Engineer',
        'Remote, India',
        'greenhouse',
        'http://localhost:3002/mock_greenhouse.html',
        'Looking for a developer skilled in React, Node.js, and concurrent Go systems.',
        88,
        JSON.stringify({
            classification: 'Strong',
            explanation: 'Perfect match for Node.js Express tracker and ISRO intern telemetry engines.',
            missing_requirements: []
        }),
        'EVALUATED',
        new Date().toISOString()
    ]);

    console.log('[Test] Mock job seeded in SQLite database.');

    // 5. Start HTTP server programmatically on port 3002
    await new Promise((resolve) => {
        server.listen(3002, '0.0.0.0', () => {
            console.log('[Test] HTTP test server online at http://localhost:3002');
            resolve();
        });
    });

    try {
        // 6. Tailor Resume (Drafts new tailored Markdown and HTML -> PDF file)
        console.log('[Test] Phase 1 - Executing resume tailoring AI optimization...');
        const tailoringResult = await tailorJobApplication(testJobId);
        console.log('[Test] Tailoring Success:', tailoringResult.success, 'Version:', tailoringResult.version);

        // Verify generated PDF exists
        const versionDetails = await getQuery('SELECT pdf_path FROM resume_versions WHERE job_id = ? LIMIT 1', [testJobId]);
        const pdfFilepath = path.join(__dirname, '..', versionDetails.pdf_path);
        const pdfExists = fs.existsSync(pdfFilepath);
        console.log('[Test] Verification - PDF File Written:', pdfExists, 'at:', pdfFilepath);

        if (!pdfExists) {
            throw new Error('PDF resume file not found!');
        }

        // 7. Auto-Apply Playwright Form Automation against local server
        console.log('[Test] Phase 2 - Executing Playwright Form Submitter against local mock form...');
        const applyResult = await applyToJob(testJobId);
        console.log('[Test] Apply Success:', applyResult.success, 'New Status:', applyResult.status);

        // 8. Verify status and screenshot presence
        const updatedJob = await getQuery('SELECT status, screenshot_path FROM jobs WHERE job_id = ?', [testJobId]);
        console.log('[Test] Verification - Final DB Status:', updatedJob.status);
        console.log('[Test] Verification - DB Screenshot Path:', updatedJob.screenshot_path);

        const screenshotExists = fs.existsSync(path.join(__dirname, '../public', updatedJob.screenshot_path));
        console.log('[Test] Verification - PNG Screenshot File Saved:', screenshotExists);

        if (updatedJob.status !== 'APPLIED' || !screenshotExists) {
            throw new Error('Integration test failed verification gates!');
        }

        console.log('\n====================================================');
        console.log('✅ PIPELINE INTEGRATION TEST ENTIRELY SUCCESSFUL!');
        console.log('====================================================');

    } catch (e) {
        console.error('\n====================================================');
        console.error('❌ PIPELINE INTEGRATION TEST FAILED:', e.message);
        console.error('====================================================');
        process.exitCode = 1;
    } finally {
        // Clean up test server
        server.close(() => {
            console.log('[Test] Express test server closed.');
            process.exit(process.exitCode || 0);
        });
    }
}

if (require.main === module) {
    runEndToEndTest().catch(err => {
        console.error('Test script crashed:', err);
        process.exit(1);
    });
}
