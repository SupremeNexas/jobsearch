const { crawlJobs } = require('./crawler');

/**
 * Comprehensive job scanner — scans a wide list of tech companies
 * on Greenhouse + Lever for roles matching the candidate's profile.
 */
async function main() {
    const keywords = [
        'Software Engineer',
        'Backend Engineer',
        'Full Stack',
        'Platform Engineer',
        'Python',
        'Developer',
        'Infrastructure Engineer',
        'DevOps',
        'Site Reliability',
        'Machine Learning Engineer',
        'Data Engineer',
        'Systems Engineer',
    ];

    const location = 'Remote';

    const targetCompanies = [
        'figma', 'stripe', 'openai', 'datadog', 'hashicorp',
        'grafana', 'sentry', 'vercel', 'retool', 'dbt-labs',
        'gusto', 'ramp', 'brex', 'notion', 'linear',
        'loom', 'webflow', 'airtable', 'sourcegraph', 'temporal',
        'cockroachlabs', 'planetscale', 'supabase', 'neon', 'turso',
        'airbyte', 'mux', 'clerk', 'resend', 'railway',
        'render', 'fly', 'netlify', 'prisma', 'zed-industries',
        'replit', 'huggingface', 'anthropic', 'cohere', 'mistral',
        'perplexityai', 'anyscale', 'modal', 'langchain', 'weaviate',
        'qdrant', 'pinecone', 'chromadb', 'deepmind', 'stability',
        'midjourney', 'cursor', 'codeium',
        'posthog', 'cal-com', 'gitpod', 'snyk', 'elastic',
        'miro', 'clickup', 'deel', 'rippling',
        'remote', 'oysterhr',
    ];

    console.log(`Scanning ${targetCompanies.length} companies for ${keywords.length} keyword sets...`);

    const allJobs = [];
    const BATCH_SIZE = 5;
    for (let i = 0; i < targetCompanies.length; i += BATCH_SIZE) {
        const batch = targetCompanies.slice(i, i + BATCH_SIZE);
        const batchJobs = await crawlJobs(keywords, location, batch);
        allJobs.push(...batchJobs);
    }

    const seen = new Set();
    const uniqueJobs = allJobs.filter(job => {
        if (seen.has(job.url)) return false;
        seen.add(job.url);
        return true;
    });

    const relevantJobs = uniqueJobs.filter(job => {
        const title = job.title.toLowerCase();
        return !title.includes('manager') &&
               !title.includes('director') &&
               !title.includes('staff') &&
               !title.includes('principal') &&
               !title.includes('lead') &&
               !title.includes('senior') &&
               !title.includes('vp ') &&
               !title.includes('vice president') &&
               !title.includes('head of');
    });

    console.log(`\n========================================`);
    console.log(`TOTAL LISTINGS FOUND: ${uniqueJobs.length}`);
    console.log(`RELEVANT FOR YOUR PROFILE: ${relevantJobs.length}`);
    console.log(`========================================\n`);

    relevantJobs.forEach((job, idx) => {
        console.log(`[${idx + 1}] ${job.title} at ${job.company}`);
        console.log(`    URL:      ${job.url}`);
        console.log(`    Platform: ${job.platform}`);
        console.log('-'.repeat(70));
    });

    const fs = require('fs');
    const path = require('path');
    const outputPath = path.join(__dirname, '../found_jobs.json');
    fs.writeFileSync(outputPath, JSON.stringify(relevantJobs, null, 2));
    console.log(`\nFull results saved to: ${outputPath}`);
}

main().catch(err => {
    console.error('Scan failed:', err);
    process.exit(1);
});
