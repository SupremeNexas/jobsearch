/**
 * Targeted scorer for remaining sheet/doc jobs that weren't processed
 * during the initial discovery cycle (which timed out).
 *
 * Importers: Called directly via `node src/score_remaining.js`
 * Affected API: SQLite jobs table, OmniRoute AI scoring gateway
 * Data Schema: jobs table (job_id, company, role, location, source, url, description, score, score_explanation, status, discovered_at)
 * User instruction: "lets see, run it" — complete the ingestion of all sheet/doc jobs
 */
const crypto = require('crypto');
const path = require('path');
const { initDb, runQuery, allQuery } = require('./db');
const { scoreJob } = require('./ai');
const { parseSheet1Jobs, parseSheet2Jobs, parseDocJobs } = require('./parse_docs');

function generateJobId(jobUrl) {
    return crypto.createHash('sha256').update(jobUrl).digest('hex').substring(0, 16);
}

async function scoreRemainingDocJobs() {
    console.log('=== SCORING REMAINING SHEET/DOC JOBS ===');
    await initDb();

    // Fetch settings for scoring
    const rawSettings = await allQuery('SELECT * FROM settings');
    const settings = {};
    rawSettings.forEach(s => settings[s.key] = s.value);
    const minScore = parseInt(settings.MIN_SCORE_THRESHOLD || '75', 10);

    // Parse all jobs from files
    const rootDir = path.join(__dirname, '../..');
    const sheet1Jobs = parseSheet1Jobs(path.join(rootDir, 'sheet1.csv'));
    const sheet2Jobs = parseSheet2Jobs(path.join(rootDir, 'sheet2.csv'));
    const docJobs = parseDocJobs(path.join(rootDir, 'doc1.html'));

    const allDocJobs = [...sheet1Jobs, ...sheet2Jobs, ...docJobs];
    console.log(`Total parsed: ${sheet1Jobs.length} sheet1, ${sheet2Jobs.length} sheet2, ${docJobs.length} doc1 = ${allDocJobs.length}`);

    let inserted = 0, skipped = 0, evaluated = 0, rejected = 0;

    for (const rawJob of allDocJobs) {
        const jobId = generateJobId(rawJob.url);

        // Skip if already in DB
        const existing = await allQuery('SELECT job_id FROM jobs WHERE job_id = ? OR url = ?', [jobId, rawJob.url]);
        if (existing && existing.length > 0) {
            skipped++;
            continue;
        }

        // Score via AI
        console.log(`[Scoring] ${rawJob.title} at ${rawJob.company}...`);
        const evaluation = await scoreJob(rawJob.title, rawJob.company, rawJob.description || '', settings);

        let finalStatus = 'EVALUATED';
        if (evaluation.score < minScore) {
            finalStatus = 'REJECTED';
            rejected++;
        } else {
            evaluated++;
        }

        await runQuery(`
            INSERT INTO jobs (
                job_id, company, role, location, source, url, description,
                score, score_explanation, status, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            jobId,
            rawJob.company,
            rawJob.title,
            rawJob.location || 'Remote',
            rawJob.platform || 'rss',
            rawJob.url,
            rawJob.description || '',
            evaluation.score,
            JSON.stringify({
                classification: evaluation.classification,
                explanation: evaluation.explanation,
                missing_requirements: evaluation.missing_requirements || []
            }),
            finalStatus,
            new Date().toISOString()
        ]);

        inserted++;
        console.log(`  -> Score: ${evaluation.score} | Status: ${finalStatus}`);
    }

    console.log(`\n=== DONE ===`);
    console.log(`Skipped (already in DB): ${skipped}`);
    console.log(`Newly scored & inserted: ${inserted}`);
    console.log(`  Evaluated (qualified): ${evaluated}`);
    console.log(`  Rejected: ${rejected}`);
}

scoreRemainingDocJobs().catch(err => {
    console.error('Score remaining failed:', err);
    process.exit(1);
});
