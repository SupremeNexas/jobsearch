const { initDb, allQuery } = require('./actor/src/db');
const { getMasterResume } = require('./actor/src/ai');
const { extractJdSkills, classifySkillGaps, calculateAtsScore } = require('./actor/src/ats');

async function run() {
    await initDb();
    const cvText = await getMasterResume();
    console.log("=== Active Master Resume ===");
    console.log(cvText.substring(0, 500));
    console.log("============================\n");

    const jobs = await allQuery("SELECT job_id, company, role, description FROM jobs WHERE description IS NOT NULL LIMIT 5");
    for (const job of jobs) {
        console.log(`Job: "${job.role}" at ${job.company}`);
        const jdSkills = extractJdSkills(job.description);
        console.log("  Extracted Skills:", jdSkills);
        const classification = classifySkillGaps(jdSkills, cvText);
        console.log("  Classification:", {
            existingCount: classification.existing.length,
            supportedCount: classification.supportedByResume.length,
            gapCount: classification.gap.length,
            existing: classification.existing,
            supported: classification.supportedByResume,
            gap: classification.gap
        });
        const score = calculateAtsScore(classification);
        console.log("  ATS Score:", score);
        console.log("-----------------------------------------");
    }
}

run().catch(console.error);
