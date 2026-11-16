const { initDb, allQuery } = require('./actor/src/db');

async function main() {
    await initDb();
    const rows = await allQuery('SELECT job_id, resume_version, company, role FROM jobs WHERE resume_version > 0');
    console.log(`Found ${rows.length} jobs with tailored resumes:`);
    for (const r of rows) {
        console.log(`Job ID: ${r.job_id}, Company: ${r.company}, Role: ${r.role}, Latest Version: ${r.resume_version}`);
    }
}

main().catch(console.error);
