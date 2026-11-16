const { initDb, allQuery, runQuery } = require('./db');
const { runDiscoveryCycle } = require('./scanner');

async function testDiscovery() {
    console.log("=== STARTING DISCOVERY INTEGRATION TEST ===");

    // 1. Initialize SQLite Database
    await initDb();

    // 2. Clear old sheet/doc records from database to ensure fresh test runs
    console.log("[Test] Preparing db...");
    await runQuery("DELETE FROM jobs WHERE source IN ('sheet1', 'sheet2', 'doc1')");

    // 3. Execution of full discovery/scoring cycle
    console.log("[Test] Running discovery cycle (parsing + score + SQLite)...");
    const result = await runDiscoveryCycle();
    console.log("[Test] Cycle execution result:", JSON.stringify(result, null, 2));

    // 4. Verifying insertion and attributes inside SQLite database
    console.log("[Test] Querying jobs from DB to verify persistence...");
    const jobs = await allQuery("SELECT job_id, company, role, source, score, status FROM jobs WHERE source IN ('sheet1', 'sheet2', 'doc1')");

    console.log(`[Test] Total parsed jobs verified in DB: ${jobs.length}`);
    if (jobs.length > 0) {
        console.log("[Test] First 5 entries:");
        console.log(JSON.stringify(jobs.slice(0, 5), null, 2));
    } else {
        throw new Error("No jobs from sheets/docs saved into the SQLite jobs table!");
    }

    console.log("=== DISCOVERY INTEGRATION TEST DONE ===");
}

testDiscovery().catch(err => {
    console.error("Discovery test failed:", err);
    process.exit(1);
});
