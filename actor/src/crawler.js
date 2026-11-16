const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const url = require('url');
const { normalizeTitle, normalizeCompany } = require('./services/canonicalize');

/**
 * Crawls and searches for job listings on Lever / Greenhouse and public boards.
 * Now enhanced with Bright Data API for broader job platform coverage.
 * @param {Array<string>} keywords E.g. ['Software Engineer', 'Frontend Developer']
 * @param {string} location E.g. 'Remote', 'United States'
 * @param {Array<string>} targetCompanies E.g. ['stripe', 'openai', 'figma', 'vercel'] (optional)
 * @returns {Promise<Array<object>>} List of jobs
 */
async function crawlJobs(keywords, location, targetCompanies = []) {
    const jobs = [];
    console.log(`Starting crawl for keywords: ${keywords.join(', ')} in ${location}...`);

    // If target companies list is provided, scan their Greenhouse/Lever boards directly
    // This is 100% reliable and doesn't get blocked
    if (targetCompanies && targetCompanies.length > 0) {
        for (const company of targetCompanies) {
            try {
                // Try Greenhouse first
                const greenhouseUrl = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`;
                console.log(`Checking Greenhouse board for ${company}...`);
                const ghRes = await fetchJson(greenhouseUrl);
                if (ghRes && ghRes.jobs) {
                    for (const job of ghRes.jobs) {
                        if (matchesKeywords(job.title, keywords)) {
                            const loc = (job.location && job.location.name) || '';
                            jobs.push({
                                url: job.absolute_url,
                                title: job.title,
                                company: company,
                                location: loc,
                                description: stripHtml(job.content || ''),
                                platform: 'greenhouse',
                                date: new Date(job.updated_at || Date.now()),
                                source_job_id: job.internal_job_id || null,
                                requisition_id: job.requisition_id || null,
                                greenhouse_id: job.id || null,
                                canonical_key: `${normalizeCompany(company)}||${normalizeTitle(job.title)}`,
                                normalized_title: normalizeTitle(job.title),
                                normalized_company: normalizeCompany(company)
                            });
                        }
                    }
                }
            } catch (err) {
                console.log(`No Greenhouse board found for ${company}... trying Lever`);
            }

            try {
                // Try Lever
                const leverUrl = `https://api.lever.co/v0/postings/${company}?mode=json`;
                console.log(`Checking Lever board for ${company}...`);
                const leverRes = await fetchJson(leverUrl);
                if (leverRes && Array.isArray(leverRes)) {
                    for (const job of leverRes) {
                        if (matchesKeywords(job.categories.commitment + ' ' + job.title, keywords)) {
                            jobs.push({
                                url: job.applyUrl,
                                title: job.title,
                                company: company,
                                description: stripHtml(job.description + ' ' + (job.lists ? job.lists.map(l => l.content).join(' ') : '')),
                                platform: 'lever',
                                date: new Date(job.createdAt || Date.now()),
                                source_job_id: job.id || null,
                                requisition_id: job.requisition_id || null,
                                canonical_key: `${normalizeCompany(company)}||${normalizeTitle(job.title)}`,
                                normalized_title: normalizeTitle(job.title),
                                normalized_company: normalizeCompany(company)
                            });
                        }
                    }
                }
            } catch (err) {
                console.log(`No Lever board found for ${company}`);
            }

            try {
                // Try Ashby
                const ashbyUrl = `https://api.ashbyhq.com/posting-api/job-board/${company}`;
                const ashbyRes = await fetchJson(ashbyUrl);
                if (ashbyRes && ashbyRes.jobs && Array.isArray(ashbyRes.jobs)) {
                    for (const job of ashbyRes.jobs) {
                        if (matchesKeywords(job.title, keywords)) {
                            const loc = job.location || (job.isRemote ? 'Remote' : '');
                            jobs.push({
                                url: job.jobUrl,
                                title: job.title,
                                company: company,
                                location: loc,
                                description: stripHtml(job.descriptionPlain || job.title),
                                platform: 'ashby',
                                date: new Date(job.publishedAt || Date.now()),
                                source_job_id: job.id || null,
                                requisition_id: null,
                                canonical_key: `${normalizeCompany(company)}||${normalizeTitle(job.title)}`,
                                normalized_title: normalizeTitle(job.title),
                                normalized_company: normalizeCompany(company)
                            });
                        }
                    }
                }
            } catch (err) {
                // Ignore Ashby if not applicable
            }
        }
    }

    // Try Bright Data for broader job platform coverage
    try {
        const brightDataJobs = await crawlJobsByBrightData(keywords, location, targetCompanies);
        jobs.push(...brightDataJobs);
    } catch (e) {
        console.error('Error fetching from Bright Data:', e.message);
    }

    // 3. Fetch from RemoteOK API
    try {
        const remoteokJobs = await fetchRemoteOkJobs(keywords);
        jobs.push(...remoteokJobs);
    } catch (e) {
        console.error('Error fetching from RemoteOK:', e.message);
    }

    // 4. Fetch from Remotive API
    try {
        const remotiveJobs = await fetchRemotiveJobs(keywords);
        jobs.push(...remotiveJobs);
    } catch (e) {
        console.error('Error fetching from Remotive:', e.message);
    }

    // 5. Fetch job feeds from targeted RSS/XML boards
    try {
        console.log(`Fetching public RSS listings for keywords...`);
        const feeds = [
            { url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss', platform: 'weworkremotely' },
            { url: 'https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss', platform: 'weworkremotely' },
            { url: 'https://hnrss.org/jobs', platform: 'hnrss' },
            { url: 'https://jsremotely.com/feed.xml', platform: 'jsremotely' }
        ];

        if (location.toLowerCase().includes('remote')) {
            feeds.push({ url: 'https://weworkremotely.com/remote-jobs.rss', platform: 'weworkremotely' });
        }

        // Fetch RSS feeds concurrently
        const feedPromises = feeds.map(feed => fetchRssFeed(feed.url, keywords, feed.platform));
        const rssResultsList = await Promise.all(feedPromises);

        for (const rssResults of rssResultsList) {
            jobs.push(...rssResults);
        }
    } catch (e) {
        console.error('Error fetching RSS/XML listings:', e.message);
    }

    // 6. Fetch dedicated live tech internship trackers (Sarthzk India Tracker & SpeedyApply 2027 SWE)
    try {
        const trackerJobs = await fetchInternshipTrackers(keywords, location);
        jobs.push(...trackerJobs);
    } catch (e) {
        console.error('Error fetching internship trackers:', e.message);
    }

    console.log(`Found ${jobs.length} total jobs matching criteria.`);
    return jobs;
}

/**
 * Fetch remote jobs from the Remotive API.
 */
async function fetchRemotiveJobs(keywords) {
    const results = [];
    try {
        console.log(`[Remotive] Querying Remotive Software Development API...`);
        const response = await axios.get('https://remotive.com/api/remote-jobs?category=software-development&limit=100', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const data = response.data;
        if (data && Array.isArray(data.jobs)) {
            for (const job of data.jobs) {
                if (matchesKeywords(job.title, keywords)) {
                    results.push({
                        url: job.url,
                        title: job.title,
                        company: job.company_name || 'Unknown',
                        location: job.candidate_required_location || 'Remote',
                        description: stripHtml(job.description || ''),
                        platform: 'remotive',
                        date: new Date(job.publication_date || Date.now())
                    });
                }
            }
        }
        console.log(`[Remotive] Extracted ${results.length} matching jobs.`);
    } catch (err) {
        console.error('[Remotive Error] Failed to fetch:', err.message);
    }
    return results;
}

/**
 * Fetch remote jobs from the RemoteOK API.
 */
async function fetchRemoteOkJobs(keywords) {
    const results = [];
    try {
        console.log(`[RemoteOK] Querying RemoteOK API...`);
        const response = await axios.get('https://remoteok.com/api', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const data = response.data;
        if (Array.isArray(data) && data.length > 1) {
            // First item is legal info/disclaimer, slice it
            const jobsList = data.slice(1);
            for (const job of jobsList) {
                if (job && matchesKeywords(job.position, keywords)) {
                    results.push({
                        url: job.url,
                        title: job.position,
                        company: job.company || 'Unknown',
                        location: job.location || 'Remote',
                        description: stripHtml(job.description || job.desc || ''),
                        platform: 'remoteok',
                        date: job.epoch ? new Date(parseInt(job.epoch, 10) * 1000) : new Date()
                    });
                }
            }
        }
        console.log(`[RemoteOK] Extracted ${results.length} matching jobs.`);
    } catch (err) {
        console.error('[RemoteOK Error] Failed to fetch:', err.message);
    }
    return results;
}

/**
 * Fetch open tech & SWE internships from verified GitHub repositories.
 * Aggregates India & Global Remote trackers (Sarthzk India Tracker & SpeedyApply).
 */
async function fetchInternshipTrackers(keywords, location = '') {
    const results = [];
    console.log('[InternTrackers] Querying live GitHub tech internship trackers...');

    // 1. Sarthzk India Tech Internship Tracker (Automated daily check from 160+ official career pages)
    try {
        const data = await fetchJson('https://raw.githubusercontent.com/Sarthzk/internship-tracker/main/data/listings.json');
        if (Array.isArray(data)) {
            const open = data.filter(item => item.status === 'open');
            for (const item of open) {
                const title = item.title || '';
                const loc = item.locations ? item.locations.join(', ') : (item.is_remote ? 'Remote - India' : 'India');
                const url = item.url || '';
                const company = item.company || 'Unknown';

                if (matchesKeywords(title, keywords) || /\b(intern|internship)\b/i.test(title)) {
                    results.push({
                        url: url,
                        title: title,
                        company: company,
                        location: loc,
                        description: `Role: ${title} at ${company}. Category: ${item.category || 'SWE/Tech'}. Target term: Winter/Summer/Off-cycle. Location: ${loc}. Direct official posting.`,
                        platform: item.source || 'internship-tracker',
                        date: new Date(item.date_posted || item.last_seen || Date.now()),
                        source_job_id: item.external_id || null,
                        canonical_key: `${normalizeCompany(company)}||${normalizeTitle(title)}`,
                        normalized_title: normalizeTitle(title),
                        normalized_company: normalizeCompany(company)
                    });
                }
            }
            console.log(`[InternTrackers] Extracted ${results.length} open internship listings from Sarthzk tracker.`);
        }
    } catch (err) {
        console.warn('[InternTrackers] Could not fetch Sarthzk listings:', err.message);
    }

    // 2. SpeedyApply International & Remote SWE Internships (2027 cycle)
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch('https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/INTERN_INTL.md', { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
            const md = await res.text();
            const lines = md.split('\n');
            let addedCount = 0;
            for (const line of lines) {
                if (!line.startsWith('|')) continue;
                const cells = line.split('|').map(c => c.trim()).filter(Boolean);
                if (cells.length >= 4 && !cells[0].includes('Company') && !cells[0].includes('---')) {
                    const compMatch = cells[0].match(/<strong>(.*?)<\/strong>/);
                    const company = compMatch ? compMatch[1] : cells[0].replace(/<[^>]+>/g, '').trim();
                    const title = cells[1].replace(/<[^>]+>/g, '').trim();
                    const loc = cells[2].replace(/<[^>]+>/g, '').trim();
                    const linkMatch = cells[3].match(/href="([^"]+)"/);
                    const jobUrl = linkMatch ? linkMatch[1] : '';

                    const locLower = loc.toLowerCase();
                    const titleLower = title.toLowerCase();
                    const isTargetLocation = locLower.includes('india') || locLower.includes('remote') || locLower.includes('bengaluru') ||
                                           locLower.includes('bangalore') || locLower.includes('pune') || locLower.includes('hyderabad') ||
                                           locLower.includes('gurgaon') || locLower.includes('delhi') || locLower.includes('noida') ||
                                           locLower.includes('global') || locLower.includes('anywhere');

                    if (jobUrl && isTargetLocation && (matchesKeywords(title, keywords) || /\b(intern|internship|co-op)\b/i.test(titleLower))) {
                        results.push({
                            url: jobUrl,
                            title: title,
                            company: company,
                            location: loc,
                            description: `Role: ${title} at ${company}. Location: ${loc}. College internship opportunity for SWE / AI / ML.`,
                            platform: 'speedyapply-intl',
                            date: new Date(),
                            canonical_key: `${normalizeCompany(company)}||${normalizeTitle(title)}`,
                            normalized_title: normalizeTitle(title),
                            normalized_company: normalizeCompany(company)
                        });
                        addedCount++;
                    }
                }
            }
            console.log(`[InternTrackers] Extracted ${addedCount} internship listings from SpeedyApply tracker.`);
        }
    } catch (err) {
        console.warn('[InternTrackers] Could not fetch SpeedyApply listings:', err.message);
    }

    return results;
}

/**
 * Crawl jobs using Bright Data API for platforms like LinkedIn, Indeed, Naukri, etc.
 * @param {Array<string>} keywords
 * @param {string} location
 * @param {Array<string>} targetCompanies
 * @returns {Promise<Array<object>>}
 */
async function crawlJobsByBrightData(keywords, location, targetCompanies = []) {
    const brightDataJobs = [];

    if (!process.env.BRIGHTDATA_API_KEY) {
        console.log('Bright Data API key not configured, skipping Bright Data crawl');
        return brightDataJobs;
    }

    // Build search URLs for various job platforms
    const searchUrls = buildSearchUrls(keywords, location, targetCompanies);

    if (searchUrls.length === 0) {
        return brightDataJobs;
    }

    try {
        // Using Bright Data Web Scraper API
        const projectId = process.env.BRIGHTDATA_PROJECT || 'job_search_automation';
        const apiKey = process.env.BRIGHTDATA_API_KEY;

        const response = await axios.post(
            `https://api.brightdata.com/datasets/v3/trigger`,
            {
                dataset_id: 'gd_lk5ns7kz21pck8jpis',
                parameters: searchUrls.map(url => ({ url })),
                include_errors: true,
                type: 'discover_new',
                discover_by: 'url'
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log(`Bright Data crawl triggered: ${response.data.snapshot_id || 'snapshot created'}`);

        // Poll for results
        const snapshotId = response.data.snapshot_id;
        if (snapshotId) {
            const results = await pollBrightDataResults(snapshotId, apiKey);
            return processBrightDataResults(results, keywords);
        }
    } catch (error) {
        console.error(`Bright Data crawl error: ${error.message}`);
    }

    return brightDataJobs;
}

function buildSearchUrls(keywords, location, targetCompanies) {
    const urls = [];
    const keyword = keywords[0] || 'Software Engineer';
    const encodedKeyword = encodeURIComponent(keyword);
    const encodedLocation = encodeURIComponent(location);

    // LinkedIn Jobs
    urls.push(`https://www.linkedin.com/jobs/search/?keywords=${encodedKeyword}&location=${encodedLocation}&f_TPR=r86400`);

    // Indeed
    urls.push(`https://www.indeed.com/jobs?q=${encodedKeyword}&l=${encodedLocation}&fromage=1`);

    // Naukri (India)
    if (location.toLowerCase().includes('india') || location.toLowerCase().includes('remote')) {
        urls.push(`https://www.naukri.com/${encodedKeyword}-jobs-in-${encodedLocation}`);
    }

    // Glassdoor
    urls.push(`https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodedKeyword}&locT=C&locId=1&locKeyword=${encodedLocation}`);

    // Wellfound (AngelList)
    urls.push(`https://wellfound.com/jobs?keywords=${encodedKeyword}&location=${encodedLocation}`);

    // Company-specific boards if targetCompanies provided
    if (targetCompanies && targetCompanies.length > 0) {
        for (const company of targetCompanies) {
            urls.push(`https://www.linkedin.com/jobs/search/?keywords=${encodedKeyword}&location=${encodedLocation}&f_C=${company}`);
        }
    }

    return urls;
}

async function pollBrightDataResults(snapshotId, apiKey) {
    const maxAttempts = 30;
    const delay = 5000; // 5 seconds

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const response = await axios.get(
                `https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}`,
                { headers: { 'Authorization': `Bearer ${apiKey}` } }
            );

            if (response.data.status === 'ready') {
                console.log('Bright Data snapshot ready');
                return response.data.data || [];
            } else if (response.data.status === 'failed') {
                throw new Error('Bright Data snapshot failed');
            }
            // Still processing, wait and retry
            console.log(`Bright Data snapshot processing... (attempt ${attempt + 1}/${maxAttempts})`);
            await new Promise(resolve => setTimeout(resolve, delay));
        } catch (error) {
            console.error(`Error polling Bright Data: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw new Error('Bright Data snapshot timeout');
}

function processBrightDataResults(rawResults, keywords) {
    const jobs = [];

    for (const result of rawResults) {
        try {
            // Bright Data returns structured job data
            const title = result.title || result.job_title || '';
            const description = result.description || result.job_description || '';
            const company = result.company_name || result.company || 'Unknown';
            const jobUrl = result.url || result.job_url || result.apply_url || '';
            const location = result.location || result.job_location || '';
            const platform = result.platform || 'brightdata';

            if (title && jobUrl && matchesKeywords(title, keywords)) {
                jobs.push({
                    url: jobUrl,
                    title: title,
                    company: company,
                    location: location,
                    description: stripHtml(description),
                    platform: platform,
                    date: new Date()
                });
            }
        } catch (e) {
            console.warn('Error processing Bright Data result:', e.message);
        }
    }

    console.log(`Processed ${jobs.length} jobs from Bright Data results`);
    return jobs;
}

function matchesKeywords(text, keywords) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return keywords.some(k => {
        const lk = k.toLowerCase().trim();
        if (lk.includes('intern')) {
            const hasIntern = /\b(intern|internship|interns|co-op|coop)\b/i.test(lowerText);
            const isInternalOrInternational = /\b(internal|international)\b/i.test(lowerText) && !/\b(software|engineering|developer|backend|frontend|sde|ai|data|product)\s+intern/i.test(lowerText);
            return hasIntern && !isInternalOrInternational;
        }
        return lowerText.includes(lk);
    });
}

async function fetchJson(urlStr, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(urlStr, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function fetchRssFeed(rssUrl, keywords, platform) {
    const results = [];
    try {
        console.log(`[RSS: ${platform}] Fetching feed: ${rssUrl}...`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(rssUrl, { signal: controller.signal });
        clearTimeout(timer);
        const text = await response.text();

        // Simple XML regex parsing for title, link, description
        const items = text.match(/<item>[\s\S]*?<\/item>/g) || [];
        for (const item of items) {
            const titleMatch = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || item.match(/<title>([\s\S]*?)<\/title>/);
            const linkMatch = item.match(/<link>([\s\S]*?)<\/link>/);
            const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || item.match(/<description>([\s\S]*?)<\/description>/);
            const pubDateMatch = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);

            if (titleMatch && linkMatch) {
                const title = titleMatch[1].trim();
                const urlStr = linkMatch[1].trim();
                let description = descMatch ? stripHtml(descMatch[1]) : '';
                let pubDate = pubDateMatch ? new Date(pubDateMatch[1]) : new Date();

                // Parse company name from title "Slack: Software Engineer" or "Software Engineer at Slack"
                let company = 'Unknown';
                if (title.includes(' at ')) {
                    company = title.split(' at ').pop();
                } else if (title.includes(':')) {
                    company = title.split(':').shift();
                }

                if (matchesKeywords(title, keywords)) {
                    results.push({
                        url: urlStr,
                        title: title,
                        company: company.trim(),
                        location: 'Remote',
                        description: description,
                        platform: platform,
                        date: pubDate
                    });
                }
            }
        }
    } catch (err) {
        console.error(`[RSS Warning: ${platform}] Error parsing RSS feed:`, err.message);
    }
    return results;
}

function stripHtml(html) {
    return html.replace(/<[^>]*>?/gm, ' ')
               .replace(/\s+/g, ' ')
               .replace(/&nbsp;/g, ' ')
               .replace(/&/g, '&')
               .trim();
}

module.exports = { crawlJobs };