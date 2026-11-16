const fs = require('fs');
const path = require('path');
const { initDb, allQuery, getQuery, runQuery } = require('./actor/src/db');
const { tailorResumeText, generateCoverLetter } = require('./actor/src/ai');
const { renderResumeToPdf } = require('./actor/src/tailor');

// Simple text diff generator (matching the one in autofiller.js)
function generateBasicDiff(original, tailored) {
    const originalLines = original.split('\n');
    const tailoredLines = tailored.split('\n');

    let diff = 'Resume Tailoring Changes:\n';
    let changed = false;

    // Track differences in headers/skills
    originalLines.forEach(ol => {
        if (ol.trim() !== '' && !tailoredLines.some(tl => tl.trim() === ol.trim())) {
            diff += `- Removed/reworded: ${ol.substring(0, 100)}\n`;
            changed = true;
        }
    });

    tailoredLines.forEach(tl => {
        if (tl.trim() !== '' && !originalLines.some(ol => ol.trim() === tl.trim())) {
            diff += `+ Added/emphasized: ${tl.substring(0, 100)}\n`;
            changed = true;
        }
    });

    if (!changed) {
        return 'No major line differences. Terminology optimization only.';
    }
    return diff;
}

async function retailorAll() {
    console.log('====================================================');
    console.log('INITIATING RESUME RE-TAILORING PIPELINE...');
    console.log('====================================================');

    await initDb();

    // Fetch all jobs with active resume versions
    const jobs = await allQuery('SELECT * FROM jobs WHERE resume_version > 0');
    console.log(`Found ${jobs.length} jobs to re-tailor.`);

    // Fetch active base resume key from settings
    const activeResumeSetting = await getQuery("SELECT value FROM settings WHERE key = 'ACTIVE_BASE_RESUME'");
    const activeResumeKey = (activeResumeSetting && activeResumeSetting.value) || 'resume_12_8_26.md';
    let baseResumePath = path.join(__dirname, 'resumes', activeResumeKey);
    if (!fs.existsSync(baseResumePath)) {
        baseResumePath = path.join(__dirname, 'resumes/resume_12_8_26.md');
    }
    console.log(`Using base resume: ${baseResumePath}`);
    const baseResumeContent = fs.readFileSync(baseResumePath, 'utf8');

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const jobId = job.job_id;
        const currentVersion = job.resume_version;

        console.log(`\n[${i + 1}/${jobs.length}] Re-tailoring job: "${job.role}" at ${job.company} (ID: ${jobId}, Version: ${currentVersion})...`);

        try {
            // 1. Retrieve the existing version record specifically to reuse the cover letter and get the correct PDF path
            const extVersion = await getQuery(
                'SELECT * FROM resume_versions WHERE job_id = ? AND version = ?',
                [jobId, currentVersion]
            );

            if (!extVersion) {
                console.warn(`[Warning] No version entry found in DB for job ${jobId} v${currentVersion}. Skipping.`);
                continue;
            }

            const jdText = `${job.role} at ${job.company}\n\n${job.description}`;

            // 2. Call Sonnet via OmniRoute with the new prompt instructions
            console.log(`[AI] Tailoring resume text...`);
            const tailoredMarkdown = await tailorResumeText(job.role, job.company, jdText);

            // Reuse cover letter if it exists, otherwise generate one
            let coverLetter = extVersion.cover_letter;
            if (!coverLetter) {
                console.log(`[AI] Cover letter missing. Generating a new one...`);
                coverLetter = await generateCoverLetter(job.role, job.company, jdText);
            } else {
                console.log(`[AI] Reusing existing cover letter.`);
            }

            // 3. Compile/Render new PDF
            console.log(`[Compiler] Rendering tailored resume to PDF bytes...`);
            const pdfBuffer = await renderResumeToPdf(tailoredMarkdown);

            // 4. Overwrite existing PDF file on disk
            // Resolve path properly (pdf_path in DB is stored as /tailored_resumes/filename.pdf)
            const absolutePdfPath = path.join(__dirname, 'actor', extVersion.pdf_path);
            console.log(`[Storage] Overwriting PDF file at: ${absolutePdfPath}`);
            fs.writeFileSync(absolutePdfPath, pdfBuffer);

            // 5. Calculate new basic text diff
            const diff = generateBasicDiff(baseResumeContent, tailoredMarkdown);

            // 6. Update database record inline
            await runQuery(
                `UPDATE resume_versions
                 SET tailored_markdown = ?, cover_letter = ?, diff_from_master = ?, created_at = ?
                 WHERE job_id = ? AND version = ?`,
                [tailoredMarkdown, coverLetter, diff, new Date().toISOString(), jobId, currentVersion]
            );

            console.log(`[Success] Overwrote version and file for job ${jobId} v${currentVersion}.`);
        } catch (error) {
            console.error(`[Error] Failed to re-tailor job ${jobId}:`, error.message);
        }
    }

    console.log('\n====================================================');
    console.log('RESUME RE-TAILORING PIPELINE COMPLETED SUCCESSFULLY!');
    console.log('====================================================');
}

retailorAll().catch(err => {
    console.error('Pipeline crashed:', err);
    process.exit(1);
});
