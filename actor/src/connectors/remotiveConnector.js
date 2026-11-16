/**
 * Remotive Connector
 * Searches and ingests remote software-engineering opportunities from Remotive.
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
                        reject(new Error(`Invalid JSON response from Remotive: ${body.slice(0, 100)}`));
                    }
                } else {
                    reject(new Error(`Remotive HTTP ${res.statusCode}: ${body.slice(0, 100)}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Remotive request timeout'));
        });
    });
}

async function searchJobs(options = {}) {
    const { keywords = ['software', 'engineer'], limit = 50 } = options;
    console.log(`[Remotive Connector] Fetching remote engineering opportunities...`);

    try {
        const url = `https://remotive.com/api/remote-jobs?category=software-dev&limit=${limit}`;
        const data = await fetchHttps(url);

        const rawList = (data && data.jobs) ? data.jobs : [];
        const results = [];

        for (const item of rawList) {
            results.push({
                external_id: String(item.id || ''),
                source: 'Remotive',
                source_url: item.url || '',
                company: item.company_name || 'Unknown Company',
                company_url: item.company_logo || '',
                role: item.title || 'Software Engineer',
                department: item.category || 'Software Development',
                location: item.candidate_required_location || 'Remote (Worldwide)',
                country: item.candidate_required_location || 'Worldwide',
                remote_type: 'remote',
                employment_type: item.job_type ? item.job_type.toLowerCase() : 'full_time',
                experience_level: 'entry_mid',
                salary_min: 0,
                salary_max: 0,
                salary_currency: 'USD',
                salary: item.salary || '',
                skills: (item.tags || []).join(', '),
                required_skills: (item.tags || []).join(', '),
                description: item.description || '',
                posted_at: item.publication_date || new Date().toISOString(),
                application_url: item.url || '',
                company_description: item.company_name || '',
                source_verified: 1,
                verification_url: item.url || '',
                raw: item
            });
        }

        recordConnectorStatus('remotive', { status: 'WORKING', jobsCount: results.length });
        console.log(`[Remotive Connector] Successfully retrieved ${results.length} remote jobs.`);
        return results;
    } catch (err) {
        console.error(`[Remotive Connector] Error:`, err.message);
        recordConnectorStatus('remotive', { status: 'FAILED', error: err.message });
        return [];
    }
}

module.exports = {
    id: 'remotive',
    name: 'Remotive',
    searchJobs
};
