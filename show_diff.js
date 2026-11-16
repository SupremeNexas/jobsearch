const { initDb, getQuery } = require('./actor/src/db');
async function run() {
    await initDb();
    const versionDetails = await getQuery("SELECT tailored_markdown, diff_from_master FROM resume_versions WHERE job_id = '6e306ef4ae2f2a35' AND version = 2");
    if (versionDetails) {
        console.log("=== DIFF FROM MASTER ===");
        console.log(versionDetails.diff_from_master);
        console.log("========================\n");
    } else {
        console.log("No version 2 found!");
    }
}
run();
