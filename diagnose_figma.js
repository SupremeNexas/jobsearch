const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { initDb, getQuery } = require('./actor/src/db');
const { extractJdSkills, classifySkillGaps, calculateAtsScore } = require('./actor/src/ats');

async function run() {
    await initDb();

    const figmaJobId = '6e306ef4ae2f2a35';
    const job = await getQuery("SELECT * FROM jobs WHERE job_id = ?", [figmaJobId]);
    if (!job) {
        console.error("Figma job not found in DB!");
        return;
    }

    console.log("=== Job Information ===");
    console.log(`Role: ${job.role} at ${job.company}`);
    console.log(`URL: ${job.url}`);
    console.log("=======================\n");

    const jdSkills = extractJdSkills(job.description);
    console.log(`Extracted JD Skills (${jdSkills.length}):`, jdSkills);
    console.log("-----------------------------------------\n");

    // 1. Base Markdown Resume
    const markdownPath = path.join(__dirname, 'resumes/resume_12_8_26.md');
    let mdText = '';
    if (fs.existsSync(markdownPath)) {
        mdText = fs.readFileSync(markdownPath, 'utf8');
    }
    const mdClassification = classifySkillGaps(jdSkills, mdText);
    const mdScore = calculateAtsScore(mdClassification);
    console.log("=== Base Markdown Resume (resume_12_8_26.md) ===");
    console.log(`ATS Score: ${mdScore}`);
    console.log(`Existing (${mdClassification.existing.length}):`, mdClassification.existing);
    console.log(`Supported (${mdClassification.supportedByResume.length}):`, mdClassification.supportedByResume);
    console.log(`Gaps (${mdClassification.gap.length}):`, mdClassification.gap);
    console.log("-----------------------------------------\n");

    // 2. Base LaTeX Resume
    const latexPath = path.join(__dirname, 'resumes/resume_12_8_26.tex');
    let latexText = '';
    if (fs.existsSync(latexPath)) {
        latexText = fs.readFileSync(latexPath, 'utf8');
    }
    const latexClassification = classifySkillGaps(jdSkills, latexText);
    const latexScore = calculateAtsScore(latexClassification);
    console.log("=== Base LaTeX Resume (resume_12_8_26.tex) ===");
    console.log(`ATS Score: ${latexScore}`);
    console.log(`Existing (${latexClassification.existing.length}):`, latexClassification.existing);
    console.log(`Supported (${latexClassification.supportedByResume.length}):`, latexClassification.supportedByResume);
    console.log(`Gaps (${latexClassification.gap.length}):`, latexClassification.gap);
    console.log("-----------------------------------------\n");

    // 3. Base PDF Resume (using python parser helper)
    const basePdfPath = '/Users/supryo/Desktop/personal/resume/resume_12_8_26.pdf';
    let basePdfText = '';
    if (fs.existsSync(basePdfPath)) {
        try {
            basePdfText = execSync(`python3 extract_pdf_text.py "${basePdfPath}"`, { encoding: 'utf8' });
        } catch (err) {
            console.error("Error reading base PDF text via python:", err);
        }
    }
    const basePdfClassification = classifySkillGaps(jdSkills, basePdfText);
    const basePdfScore = calculateAtsScore(basePdfClassification);
    console.log("=== Base PDF Resume (resume_12_8_26.pdf) ===");
    console.log(`ATS Score: ${basePdfScore}`);
    console.log(`Existing (${basePdfClassification.existing.length}):`, basePdfClassification.existing);
    console.log(`Supported (${basePdfClassification.supportedByResume.length}):`, basePdfClassification.supportedByResume);
    console.log(`Gaps (${basePdfClassification.gap.length}):`, basePdfClassification.gap);
    console.log("-----------------------------------------\n");

    // 4. Tailored PDF Resume Version 1
    const tailoredPdfPath = path.join(__dirname, 'actor/tailored_resumes/tailored_6e306ef4ae2f2a35_v1.pdf');
    let tailoredPdfText = '';
    if (fs.existsSync(tailoredPdfPath)) {
        try {
            tailoredPdfText = execSync(`python3 extract_pdf_text.py "${tailoredPdfPath}"`, { encoding: 'utf8' });
        } catch (err) {
            console.error("Error reading tailored PDF text via python:", err);
        }
    } else {
        console.log(`Warning: Tailored PDF v1 not found at ${tailoredPdfPath}`);
    }
    const tailoredPdfClassification = classifySkillGaps(jdSkills, tailoredPdfText);
    const tailoredPdfScore = calculateAtsScore(tailoredPdfClassification);
    console.log("=== Tailored PDF Resume V1 (tailored_6e306ef4ae2f2a35_v1.pdf) ===");
    console.log(`ATS Score: ${tailoredPdfScore}`);
    console.log(`Existing (${tailoredPdfClassification.existing.length}):`, tailoredPdfClassification.existing);
    console.log(`Supported (${tailoredPdfClassification.supportedByResume.length}):`, tailoredPdfClassification.supportedByResume);
    console.log(`Gaps (${tailoredPdfClassification.gap.length}):`, tailoredPdfClassification.gap);
    console.log("-----------------------------------------\n");
}

run().catch(console.error);
