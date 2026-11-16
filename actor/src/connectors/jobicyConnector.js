/**
 * Jobicy Connector
 * Searches and ingests remote software-engineering opportunities from Jobicy.
 */

const https = require('https');
const { recordConnectorStatus } = require('./connectorHealth');

function fetchHttps(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'application/json'
            },
            timeout: 10000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(body);
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error(`Invalid JSON response from Jobicy: ${body.slice(0, 100)}`));
                    }
                } else {
                    reject(new Error(`Jobicy HTTP ${res.statusCode}: ${body.slice(0, 100)}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Jobicy request timeout'));
        });
    });
}

async function searchJobs(options = {}) {
    const { keywords = ['software', 'engineer'], count = 50 } = options;
    console.log(`[Jobicy Connector] Fetching remote engineering opportunities...`);

    try {
        const url = `https://jobicy.com/api/v2/remote-jobs?count=${count}&industry=engineering`;
        const data = await fetchHttps(url);

        const rawList = (data && data.jobs) ? data.jobs : [];
        const results = [];

        for (const item of rawList) {
            results.push({
                external_id: String(item.id || ''),
                source: 'Jobicy',
                source_url: item.url || '',
                company: item.companyName || 'Unknown Company',
                company_url: item.companyWebsite || '',
                role: item.jobTitle || 'Software Engineer',
                department: item.jobIndustry || 'Engineering',
                location: item.jobGeo || 'Remote',
                country: item.jobGeo || 'Remote',
                remote_type: 'remote',
                employment_type: Array.isArray(item.jobType) ? item.jobType.join(', ').toLowerCase() : (item.jobType ? String(item.jobType).toLowerCase() : 'full_time'),
                experience_level: item.jobLevel || 'entry_mid',
                salary_min: item.annualSalaryMin ? Number(item.annualSalaryMin) : 0,
                salary_max: item.annualSalaryMax ? Number(item.annualSalaryMax) : 0,
                salary_currency: item.salaryCurrency || 'USD',
                skills: (item.jobTags || []).join(', '),
                required_skills: (item.jobTags || []).join(', '),
                description: item.jobDescription || item.jobExcerpt || '',
                posted_at: item.pubDate || new Date().toISOString(),
                application_url: item.url || '',
                company_description: item.companyName || '',
                source_verified: 1,
                verification_url: item.url || '',
                raw: item
            });
        }

        recordConnectorStatus('jobicy', { status: 'WORKING', jobsCount: results.length });
        console.log(`[Jobicy Connector] Successfully retrieved ${results.length} remote jobs.`);
        return results;
    } catch (err) {
        console.error(`[Jobicy Connector] Error:`, err.message);
        recordConnectorStatus('jobicy', { status: 'FAILED', error: err.message });
        return [];
    }
}

module.exports = {
    id: 'jobicy',
    name: 'Jobicy',
    searchJobs
};
