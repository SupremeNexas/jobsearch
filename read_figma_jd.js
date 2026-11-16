const { initDb, getQuery } = require('./actor/src/db');
async function run() {
    await initDb();
    const job = await getQuery("SELECT description FROM jobs WHERE job_id = '6e306ef4ae2f2a35'");
    console.log(job.description);
}
run();
