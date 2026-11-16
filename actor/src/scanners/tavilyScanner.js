const { runQuery } = require('../db');

// Helper functions (assume they exist elsewhere)
function extractCompany(title) {
    // Simple heuristic to extract company name from title
    const match = title.match(/^(.*?)\s*:\s*[^(]*$/);
    return match ? match[1].trim() : title;
}

function sanitizeDescription(text) {
    // Basic sanitization: remove excessive whitespace and limit length
    return text?.replace(/\s+/g, ' ')?.substring(0, 1000).trim();
}

/**
 * Perform a Tavily search for jobs matching the given keywords and location.
 * Returns a list of job objects compatible with our internal schema.
 *
 * @param {Array<string>} keywords - Array of job title keywords
 * @param {string} location - Preferred job location (optional)
 * @returns {Promise<Array<Object>>} - List of job objects
 */
async function searchJobs(keywords, location) {
    if (!keywords || keywords.length === 0) {
        throw new Error('Keywords array cannot be empty');
    }

    // Build the query string - combining keywords with OR and adding location
    const query = keywords.join(' OR ') + ' jobs ' + (location ? location : '');

    try {
        // Attempt to use the Tavily ecosystem for broader coverage
        const response = await fetch(process.env.TAVILY_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                query: query,
                search_depth: 'advanced',
                max_results: 20,
                // Add location filter if provided
                ...(location && { extra_filter: location })
            })
        });

        if (!response.ok) {
            console.error(`Tavily API request failed with status ${response.status}`);
            throw new Error(`API request failed: ${response.status}`);
        }

        const data = await response.json();

        // Transform results into our standardized job format
        const jobs = [];
        for (const result of data.results) {
            const job = {
                url: result.url || '',
                title: result.title || 'Unknown Title',
                company: extractCompany(result.title) || 'Unknown Company',
                description: sanitizeDescription(result.content) || '',
                score: result.relevance_score || 0,
                source: 'tavily',
                source_tool: 'tavily',
                location: location || 'Remote'
            };

            jobs.push(job);
        }

        // Deduplicate jobs by URL
        const seenUrls = new Set();
        const uniqueJobs = jobs.filter(job => {
            if (seenUrls.has(job.url)) return false;
            seenUrls.add(job.url);
            return true;
        });

        return uniqueJobs;

    } catch (error) {
        console.error('Error during Tavily search:', error.message);
        throw error;
    }
}

module.exports = { searchJobs };