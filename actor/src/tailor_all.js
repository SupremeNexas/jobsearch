const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { initDb, allQuery, getQuery } = require('./db');
const { tailorJobApplication } = require('./autofiller');
const { getMasterResume } = require('./ai');
const { extractJdSkills, classifySkillGaps, calculateAtsScore, prepareResumeSkillsAndProse } = require('./ats');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const minScoreThreshold = parseInt(process.env.MIN_SCORE_THRESHOLD || '75', 10);

async function getJobAtsScore(job, cvText, preprocessedCvMaster) {
    const versionDetails = await getQuery(`
        SELECT tailored_markdown FROM resume_versions
        WHERE job_id = ?
        ORDER BY version DESC, id DESC LIMIT 1
    `, [job.job_id]);

    const usedCvText = (versionDetails && versionDetails.tailored_markdown) || cvText;
    const preprocessedCv = (usedCvText === cvText) ? preprocessedCvMaster : prepareResumeSkillsAndProse(usedCvText);
    const jdSkills = extractJdSkills(job.description || '');
    const classification = classifySkillGaps(jdSkills, preprocessedCv);
    return calculateAtsScore(classification);
}

async function run() {
    console.log('====================================================');
    console.log('STARTING RESUME ATS OPTIMIZATION RUN FOR ALL JOBS...');
    console.log('====================================================');

    await initDb();

    // Fetch active base resume
    const cvText = await getMasterResume();
    const preprocessedCvMaster = prepareResumeSkillsAndProse(cvText);

    // Fetch jobs in EVALUATED, RESUME_TAILORED or MANUAL_REQUIRED status
    const jobs = await allQuery(`
        SELECT job_id, company, role, status, description, score
        FROM jobs
        WHERE status IN ('EVALUATED', 'RESUME_TAILORED', 'MANUAL_REQUIRED')
        ORDER BY score DESC
    `);

    console.log(`Found ${jobs.length} total potential jobs to check.`);

    const targets = [];
    for (const job of jobs) {
        // Skip jobs that do not meet suitability score threshold (unless already tailored/manual, where we might want to fix them anyway)
        if (job.status === 'EVALUATED' && job.score < minScoreThreshold) {
            continue;
        }

        const atsScore = await getJobAtsScore(job, cvText, preprocessedCvMaster);

        // Target:
        // - status 'EVALUATED' or 'MANUAL_REQUIRED' (not yet tailored / needs manual help)
        // - status 'RESUME_TAILORED' but ATS score below 95% (needs ATS improvement)
        if (job.status !== 'RESUME_TAILORED' || atsScore < 95) {
            targets.push({
                ...job,
                currentAtsScore: atsScore
            });
        }
    }

    console.log(`Identified ${targets.length} jobs requiring tailoring/improvement (ATS Score < 95% or not tailored).`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < targets.length; i++) {
        const job = targets[i];
        console.log(`\n[${i + 1}/${targets.length}] Processing: "${job.role}" at ${job.company}`);
        console.log(`    Status: ${job.status} | Current ATS Score: ${job.currentAtsScore}%`);

        try {
            const result = await tailorJobApplication(job.job_id);
            if (result && result.success) {
                // Fetch new score
                const newScore = await getJobAtsScore(job, cvText, preprocessedCvMaster);
                console.log(`    -> SUCCESS. New ATS Score: ${newScore}% (improved from ${job.currentAtsScore}%)`);
                successCount++;
            } else {
                console.warn(`    -> Tailoring returned unsuccessful flag for job ${job.job_id}`);
                failCount++;
            }
        } catch (err) {
            console.error(`    -> ERROR tailoring job ${job.job_id}:`, err.message);
            failCount++;
        }
    }

    console.log('\n====================================================');
    console.log('ATS OPTIMIZATION RUN COMPLETED!');
    console.log(`Total processed: ${targets.length}`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failCount}`);
    console.log('====================================================');
}

if (require.main === module) {
    run().catch(err => {
        console.error('Crash in batch tailor controller:', err);
    });
}
