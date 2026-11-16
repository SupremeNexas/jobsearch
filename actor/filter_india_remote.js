const fs = require('fs');
const path = require('path');

// Load found jobs
const inputPath = path.join(__dirname, 'found_jobs.json');
const jobs = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

console.log(`Loaded ${jobs.length} jobs from found_jobs.json\n`);

// Filter: keep jobs whose location is in India or Remote
function isIndiaOrRemote(job) {
    const loc = job.location ? job.location.toLowerCase() : '';
    const title = job.title ? job.title.toLowerCase() : '';
    const desc = job.description ? job.description.toLowerCase() : '';
    const companyLoc = job.company ? job.company.toLowerCase() : '';

    // Known Indian cities
    const indiaCities = ['india', 'bangalore', 'bengaluru', 'mumbai', 'delhi', 'noida',
        'gurgaon', 'hyderabad', 'chennai', 'pune', 'kolkata', 'indore', 'ahmedabad',
        'mohali', 'chennai', 'trivandrum', 'kochi', 'pune'];

    // Check location field
    if (loc) {
        if (loc.includes('remote') || loc.includes('wfh') || loc.includes('work from home')) {
            return true;
        }
        for (const city of indiaCities) {
            if (loc.includes(city)) return true;
        }
    }

    // Check title for remote/international markers
    if (title.includes('(remote)')) return true;
    if (title.includes('remote')) return true;
    if (title.includes('wfh')) return true;
    if (title.includes('international')) return true;

    // Check description for remote/international
    if (desc.includes('remote') || desc.includes('work from home')) return true;
    if (desc.includes('indian citizen') || desc.includes('india based')) return true;

    return false;
}

const filtered = jobs.filter(isIndiaOrRemote);

console.log(`\n==============================`);
console.log(`IN INDIA OR REMOTE JOBS: ${filtered.length}`);
console.log(`==============================\n`);

filtered.forEach((job, idx) => {
    console.log(`[${idx + 1}] ${job.title} @ ${job.company}`);
    console.log(`    Location: ${job.location || 'N/A'}`);
    console.log(`    URL: ${job.url}`);
    console.log(`    Platform: ${job.platform}`);
    console.log('-'.repeat(70));
});

const outPath = path.join(__dirname, 'india_remote_jobs.json');
fs.writeFileSync(outPath, JSON.stringify(filtered, null, 2));
console.log(`\nSaved to: ${outPath}`);