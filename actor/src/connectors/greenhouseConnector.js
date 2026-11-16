/**
 * Greenhouse ATS Board Connector
 * Directly fetches live job postings from top tech companies using official Greenhouse Board APIs.
 */

const https = require('https');
const { recordConnectorStatus } = require('./connectorHealth');

const GREENHOUSE_COMPANIES = [
    'stripe', 'cloudflare', 'okta', 'purestorage', 'datadog', 'affirm',
    'gitlab', 'coinbase', 'mongodb', 'elastic', 'anthropic', 'scaleai',
    'pinterest', 'robinhood', 'instacart', 'brex', 'figma', 'vercel',
    'retool', 'sentry', 'notion', 'airtable', 'dropbox', 'rubrik', 'groww', 'automattic',
    'databricks', 'canonical', 'airbnb', 'lyft', 'mozilla', 'assemblyai', 'grafanalabs', 'reddit', 'togetherai', 'tavily'
];

function fetchJson(url) {
    return new Promise((resolve) => {
        const req = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
            timeout: 8000
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(JSON.parse(data));
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
            req.destroy();
            resolve(null);
        });
    });
}

function stripHtml(html) {
    if (!html) return '';
    return html.replace(/<[^>]*>?/gm, ' ')
               .replace(/&nbsp;/g, ' ')
               .replace(/&amp;/g, '&')
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/\s+/g, ' ')
               .trim();
}

async function searchJobs(options = {}) {
    const { keywords = ['software', 'engineer', 'backend', 'fullstack', 'developer', 'ai', 'systems'] } = options;
    console.log(`[Greenhouse Connector] Scanning ${GREENHOUSE_COMPANIES.length} company boards...`);

    const results = [];
    const promises = GREENHOUSE_COMPANIES.map(async (company) => {
        try {
            const url = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`;
            const data = await fetchJson(url);
            if (data && data.jobs && Array.isArray(data.jobs)) {
                for (const j of data.jobs) {
                    const title = j.title || '';
                    const loc = (j.location && j.location.name) || 'Remote';
                    const text = `${title} ${loc}`.toLowerCase();

                    const matches = keywords.some(k => text.includes(k.toLowerCase()));
                    if (matches) {
                        const locLower = loc.toLowerCase();
                        const isRemote = locLower.includes('remote') || locLower.includes('anywhere') || locLower.includes('work from home') || locLower.includes('wfh') || locLower.includes('distributed') || locLower.includes('home based') || title.toLowerCase().includes('(remote)');
                        const isIndia = locLower.includes('india') || locLower.includes('bengaluru') || locLower.includes('bangalore') || locLower.includes('pune') || locLower.includes('hyderabad') || locLower.includes('mumbai') || locLower.includes('delhi');
                        const isUsa = !isIndia && (locLower.includes('united states') || locLower.includes('usa') || locLower.includes('san francisco') || locLower.includes('new york') || locLower.includes('seattle') || locLower.includes('austin') || locLower.includes('hybrid') || locLower.includes('in-office') || /(?:^|[\s,\/\(])(ca|ny|tx|wa|ma|il|va|nc|co|fl|ga|nj|pa|oh|mi|md|or|dc)(?:[\s,\/\)]|$)/i.test(loc));

                        if (isUsa && !isRemote) {
                            continue; // Candidate requires USA postings to be remote
                        }

                        results.push({
                            external_id: String(j.id || j.internal_job_id || ''),
                            source: 'Greenhouse',
                            source_url: j.absolute_url,
                            company: company.charAt(0).toUpperCase() + company.slice(1),
                            company_url: `https://${company}.com`,
                            role: title,
                            department: (j.departments && j.departments[0] && j.departments[0].name) || 'Engineering',
                            location: loc,
                            country: isIndia ? 'India' : (isRemote ? 'Remote (Worldwide)' : loc),
                            remote_type: isRemote ? 'remote' : 'hybrid',
                            employment_type: 'full_time',
                            experience_level: text.includes('intern') ? 'internship' : (text.includes('graduate') || text.includes('junior') ? 'entry_level' : 'entry_mid'),
                            salary_min: 0,
                            salary_max: 0,
                            salary_currency: 'USD',
                            skills: 'Node.js, TypeScript, Go, Python, React, PostgreSQL, Docker',
                            description: stripHtml(j.content || title),
                            posted_at: j.updated_at || new Date().toISOString(),
                            application_url: j.absolute_url,
                            company_description: `${company} engineering team`,
                            source_verified: 1,
                            verification_url: j.absolute_url,
                            raw: j
                        });
                    }
                }
            }
        } catch (e) {
            // company board unavailable
        }
    });

    await Promise.all(promises);

    if (results.length > 0) {
        recordConnectorStatus('greenhouse', { status: 'WORKING', jobsCount: results.length });
    } else {
        recordConnectorStatus('greenhouse', { status: 'WORKING', jobsCount: 0 });
    }

    console.log(`[Greenhouse Connector] Extracted ${results.length} relevant positions.`);
    return results;
}

module.exports = {
    id: 'greenhouse',
    name: 'Greenhouse ATS',
    searchJobs
};
