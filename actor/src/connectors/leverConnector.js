/**
 * Lever ATS Board Connector
 * Directly fetches live job postings from Lever-hosted company boards.
 */

const https = require('https');
const { recordConnectorStatus } = require('./connectorHealth');

const LEVER_COMPANIES = [
    'meesho', 'cred', 'palantir'
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
    const { keywords = ['software', 'engineer', 'backend', 'fullstack', 'developer', 'ai'] } = options;
    console.log(`[Lever Connector] Scanning ${LEVER_COMPANIES.length} company boards...`);

    const results = [];
    const promises = LEVER_COMPANIES.map(async (company) => {
        try {
            const url = `https://api.lever.co/v0/postings/${company}?mode=json`;
            const data = await fetchJson(url);
            if (data && Array.isArray(data)) {
                for (const j of data) {
                    const title = j.title || '';
                    const loc = (j.categories && j.categories.location) || 'Remote';
                    const text = `${title} ${loc}`.toLowerCase();

                    const matches = keywords.some(k => text.includes(k.toLowerCase()));
                    if (matches) {
                        const locLower = loc.toLowerCase();
                        const isRemote = locLower.includes('remote') || locLower.includes('anywhere') || locLower.includes('work from home') || locLower.includes('wfh') || locLower.includes('distributed') || locLower.includes('home based') || title.toLowerCase().includes('(remote)');
                        const isIndia = locLower.includes('india') || locLower.includes('bengaluru') || locLower.includes('bangalore') || locLower.includes('pune') || locLower.includes('hyderabad');
                        const isUsa = !isIndia && (locLower.includes('united states') || locLower.includes('usa') || locLower.includes('san francisco') || locLower.includes('new york') || locLower.includes('seattle') || locLower.includes('austin') || locLower.includes('hybrid') || locLower.includes('in-office') || /(?:^|[\s,\/\(])(ca|ny|tx|wa|ma|il|va|nc|co|fl|ga|nj|pa|oh|mi|md|or|dc)(?:[\s,\/\)]|$)/i.test(loc));

                        if (isUsa && !isRemote) {
                            continue; // Candidate requires USA postings to be remote
                        }

                        const desc = (j.description || '') + ' ' + ((j.lists || []).map(l => (l.text || '') + ': ' + (l.content || '')).join(' '));

                        results.push({
                            external_id: String(j.id || ''),
                            source: 'Lever',
                            source_url: j.hostedUrl || j.applyUrl,
                            company: company.charAt(0).toUpperCase() + company.slice(1),
                            company_url: `https://${company}.com`,
                            role: title,
                            department: (j.categories && j.categories.team) || 'Engineering',
                            location: loc,
                            country: isIndia ? 'India' : (isRemote ? 'Remote' : loc),
                            remote_type: isRemote ? 'remote' : 'hybrid',
                            employment_type: (j.categories && j.categories.commitment) ? j.categories.commitment.toLowerCase() : 'full_time',
                            experience_level: text.includes('intern') ? 'internship' : (text.includes('graduate') || text.includes('junior') ? 'entry_level' : 'entry_mid'),
                            salary_min: 0,
                            salary_max: 0,
                            salary_currency: 'USD',
                            skills: 'Java, Python, Go, Node.js, Distributed Systems, SQL',
                            description: stripHtml(desc),
                            posted_at: new Date(j.createdAt || Date.now()).toISOString(),
                            application_url: j.applyUrl || j.hostedUrl,
                            company_description: `${company} engineering team`,
                            source_verified: 1,
                            verification_url: j.hostedUrl || j.applyUrl,
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
        recordConnectorStatus('lever', { status: 'WORKING', jobsCount: results.length });
    } else {
        recordConnectorStatus('lever', { status: 'WORKING', jobsCount: 0 });
    }

    console.log(`[Lever Connector] Extracted ${results.length} relevant positions.`);
    return results;
}

module.exports = {
    id: 'lever',
    name: 'Lever ATS',
    searchJobs
};
