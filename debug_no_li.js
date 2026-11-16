const { initDb, getQuery } = require('./actor/src/db');
const he = {
    decode: (str) => {
        if (!str) return '';
        return str
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&nbsp;/g, ' ');
    }
};
async function debug() {
    await initDb();
    const job = await getQuery("SELECT description FROM jobs WHERE description IS NOT NULL AND company = 'stripe' AND description NOT LIKE '%&lt;li%' LIMIT 1");
    if (job) {
        console.log('--- Decoded Stripe description without <li> ---');
        console.log(he.decode(job.description).substring(0, 2000));
    } else {
        console.log('No job found');
    }
}
debug().catch(console.error);
