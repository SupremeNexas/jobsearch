const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { initDb, getQuery } = require('./actor/src/db');
const { tailorJobApplication } = require('./actor/src/autofiller');
const { extractJdSkills, classifySkillGaps, calculateAtsScore } = require('./actor/src/ats');

async function run() {
    await initDb();

    console.log("=== Tailoring Job Application (Generating Version 2) ===");
    try {
        const result = await tailorJobApplication('6e306ef4ae2f2a35');
        console.log("Tailoring Result:", result);
    } catch (err) {
        console.error("Compilation error:", err);
        return;
    }

    const figmaJobId = '6e306ef4ae2f2a35';
    const job = await getQuery("SELECT * FROM jobs WHERE job_id = ?", [figmaJobId]);
    const jdSkills = extractJdSkills(job.description);
    console.log(`Extracted JD Skills (${jdSkills.length}):`, jdSkills);

    // Get the latest tailored resume version details
    const versionDetails = await getQuery(`
        SELECT * FROM resume_versions
        WHERE job_id = ?
        ORDER BY version DESC LIMIT 1
    `, [figmaJobId]);

    if (!versionDetails) {
        console.error("No resume versions found in DB for job!");
        return;
    }

    console.log(`\n=== New Tailored Resume Details (Version ${versionDetails.version}) ===`);
    console.log(`PDF Path: ${versionDetails.pdf_path}`);

    // Read the PDF using python/pypdf script to check the ATS score
    const absolutePdfPath = path.join(__dirname, 'actor', versionDetails.pdf_path);
    console.log(`Reading text from PDF: ${absolutePdfPath}`);
    if (fs.existsSync(absolutePdfPath)) {
        try {
            const pdfText = execSync(`python3 extract_pdf_text.py "${absolutePdfPath}"`, { encoding: 'utf8' });

            // Log skills matches of the PDF
            const pdfClassification = classifySkillGaps(jdSkills, pdfText);
            const pdfScore = calculateAtsScore(pdfClassification);
            console.log("\n=== Tailored PDF V2 Resume Score ===");
            console.log(`ATS Score: ${pdfScore}`);
            console.log(`Existing (${pdfClassification.existing.length}):`, pdfClassification.existing);
            console.log(`Supported (${pdfClassification.supportedByResume.length}):`, pdfClassification.supportedByResume);
            console.log(`Gaps (${pdfClassification.gap.length}):`, pdfClassification.gap);

            // Also check the raw Markdown/LaTeX stored in DB
            const rawText = versionDetails.tailored_markdown;
            const rawClassification = classifySkillGaps(jdSkills, rawText);
            const rawScore = calculateAtsScore(rawClassification);
            console.log("\n=== Tailored Raw Text/LaTeX Resume Score ===");
            console.log(`ATS Score: ${rawScore}`);
            console.log(`Existing (${rawClassification.existing.length}):`, rawClassification.existing);
            console.log(`Supported (${rawClassification.supportedByResume.length}):`, rawClassification.supportedByResume);
            console.log(`Gaps (${rawClassification.gap.length}):`, rawClassification.gap);

        } catch (err) {
            console.error("Error evaluating new resume:", err);
        }
    } else {
        console.error(`PDF file does not exist at: ${absolutePdfPath}`);
    }
}

run().catch(console.error);
