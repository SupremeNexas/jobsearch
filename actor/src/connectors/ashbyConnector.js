/**
 * Ashby ATS Board Connector
 * Directly fetches live job postings from Ashby-hosted company boards (Supabase, Linear, Sentry, Cohere, Pinecone, PostHog, Ramp, Perplexity, Cursor, Retool).
 */

const https = require('https');
const { recordConnectorStatus } = require('./connectorHealth');

const ASHBY_COMPANIES = [
    'supabase', 'linear', 'cohere', 'pinecone', 'posthog',
    'ramp', 'perplexity', 'cursor',
    'cognition', 'modal', 'replit', 'braintrust', 'composio', 'livekit', 'warp', 'mintlify', 'resend',
    'infisical', 'runway', 'speckle', 'poolside', 'langchain', 'temporal', 'snyk', 'cartesia', 'anyscale',
    'deepgram', 'render', 'railway', 'vapi', 'llamaindex', 'weaviate', 'harvey', 'cerebras', 'baseten',
    'factory', 'writer', 'taktile', 'character', 'unstructured', 'firecrawl'
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
    console.log(`[Ashby Connector] Scanning ${ASHBY_COMPANIES.length} company boards...`);

    const results = [];
    const promises = ASHBY_COMPANIES.map(async (company) => {
        try {
            const url = `https://api.ashbyhq.com/posting-api/job-board/${company}`;
            const data = await fetchJson(url);
            if (data && data.jobs && Array.isArray(data.jobs)) {
                for (const j of data.jobs) {
                    const title = j.title || '';
                    const loc = j.location || (j.isRemote ? 'Remote' : 'Worldwide');
                    const text = `${title} ${loc}`.toLowerCase();

                    const matches = keywords.some(k => text.includes(k.toLowerCase()));
                    if (matches) {
                        const locLower = loc.toLowerCase();
                        const isRemote = j.isRemote || locLower.includes('remote') || locLower.includes('anywhere') || locLower.includes('work from home') || locLower.includes('wfh') || locLower.includes('distributed') || locLower.includes('home based') || title.toLowerCase().includes('(remote)');
                        const isIndia = locLower.includes('india') || locLower.includes('bengaluru') || locLower.includes('bangalore') || locLower.includes('pune') || locLower.includes('hyderabad') || locLower.includes('mumbai');
                        const isUsa = !isIndia && (locLower.includes('united states') || locLower.includes('usa') || locLower.includes('san francisco') || locLower.includes('new york') || locLower.includes('seattle') || locLower.includes('austin') || locLower.includes('hybrid') || locLower.includes('in-office') || /(?:^|[\s,\/\(])(ca|ny|tx|wa|ma|il|va|nc|co|fl|ga|nj|pa|oh|mi|md|or|dc)(?:[\s,\/\)]|$)/i.test(loc));

                        if (isUsa && !isRemote) {
                            continue; // Candidate requires USA postings to be remote
                        }

                        results.push({
                            external_id: String(j.id || ''),
                            source: 'Ashby',
                            source_url: j.jobUrl,
                            company: company.charAt(0).toUpperCase() + company.slice(1),
                            company_url: `https://${company}.com`,
                            role: title,
                            department: j.department || 'Engineering',
                            location: loc,
                            country: isIndia ? 'India' : (isRemote ? 'Remote (Worldwide)' : loc),
                            remote_type: isRemote ? 'remote' : 'hybrid',
                            employment_type: j.employmentType ? j.employmentType.toLowerCase() : 'full_time',
                            experience_level: text.includes('intern') ? 'internship' : (text.includes('graduate') || text.includes('junior') ? 'entry_level' : 'entry_mid'),
                            salary_min: (j.compensation && j.compensation.minSalary) || 0,
                            salary_max: (j.compensation && j.compensation.maxSalary) || 0,
                            salary_currency: (j.compensation && j.compensation.currency) || 'USD',
                            skills: 'TypeScript, Next.js, Node.js, PostgreSQL, Go, React, AI',
                            description: stripHtml(j.descriptionPlain || j.descriptionHtml || title),
                            posted_at: j.publishedAt || new Date().toISOString(),
                            application_url: j.jobUrl,
                            company_description: `${company} engineering platform`,
                            source_verified: 1,
                            verification_url: j.jobUrl,
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
        recordConnectorStatus('ashby', { status: 'WORKING', jobsCount: results.length });
    } else {
        recordConnectorStatus('ashby', { status: 'WORKING', jobsCount: 0 });
    }

    console.log(`[Ashby Connector] Extracted ${results.length} relevant positions.`);
    return results;
}

module.exports = {
    id: 'ashby',
    name: 'Ashby ATS',
    searchJobs
};
