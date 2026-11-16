const { runQuery } = require('../db');

/**
 * Crawl a company's careers page using Firecrawl to extract job listings.
 * Returns a list of job objects compatible with our internal schema.
 *
 * @param {string} url - URL of the careers page to crawl
 * @param {Array<string>} keywords - Keywords to filter job titles (optional)
 * @returns {Promise<Array<Object>>} - List of job objects
 */
async function crawlAndExtractJobs(url, keywords = []) {
    if (!url) {
        throw new Error('URL parameter is required');
    }

    try {
        const response = await fetch(process.env.FIRECRAWL_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: url,
                format: 'json',
                primaryOptimize: 'extraction',
                includeTags: ['careers', 'jobs', 'positions']
            })
        });

        if (!response.ok) {
            console.error(`Firecrawl API request failed with status ${response.status}`);
            throw new Error(`API request failed: ${response.status}`);
        }

        const data = await response.json();

        // Process Firecrawl's structured output
        const jobs = [];

        // Extract jobs from Firecrawl's response
        const jobList = data.found_jobs || data.jobs || [];
        if (!jobList.length) return [];

        for (const job of jobList) {
            // Match keywords in title or description
            const title = (job.title || '').toLowerCase();
            if (keywords.length > 0 && keywords.every(k => !title.includes(k.toLowerCase())))
                continue;

            const jobObj = {
                url: job.url || job.applyUrl || '',
                title: job.title || (job.position_title ? job.position_title : job._source.title || 'Unknown'),
                company: extractCompanyName(url) || job.company || 'Unknown Company',
                description: sanitizeDescription(job.content || job.description || ''),
                source: 'firecrawl',
                source_tool: 'firecrawl',
                location: job.location || 'Remote',
                posted_date: job.posted_date || job.date_posted || null
            };

            jobs.push(jobObj);
        }

        return jobs;
    } catch (error) {
        console.error('Error during Firecrawl extraction:', error.message);
        throw error;
    }
}

// Helper to extract company from URL
function extractCompanyName(url) {
    try {
        const hostname = new URL(url).hostname;
        const match = hostname.match(/^www\.([^.]+)/);
        return match ? match[1] : hostname;
    } catch {
        return 'Unknown Company';
    }
}

function sanitizeDescription(text) {
    return text?.replace(/<[^>]*>/g, ' ')?.replace(/\s+/g, ' ')?.substring(0, 1000).trim();
}

module.exports = { crawlAndExtractJobs };