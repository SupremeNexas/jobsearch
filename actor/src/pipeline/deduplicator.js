/**
 * Deduplication Engine
 * Identifies and merges identical opportunities across sources, URLs, and multi-location variants.
 */

const { normalizeCompany, normalizeTitle } = require('./normalizer');

function cleanUrlForDeduplication(rawUrl) {
    if (!rawUrl) return '';
    try {
        const parsed = new URL(rawUrl);
        // Remove tracking parameters
        const searchParams = new URLSearchParams(parsed.search);
        const trackingKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source', 'gh_src', 'lever-source'];
        trackingKeys.forEach(k => searchParams.delete(k));

        parsed.search = searchParams.toString();
        // Remove trailing slashes
        return (parsed.origin + parsed.pathname.replace(/\/+$/, '') + (parsed.search ? '?' + parsed.search : '')).toLowerCase();
    } catch (e) {
        return rawUrl.trim().toLowerCase();
    }
}

function computeCanonicalKey(job) {
    const comp = normalizeCompany(job.company).toLowerCase().replace(/[^a-z0-9]/g, '');
    const title = normalizeTitle(job.role || job.title).toLowerCase().replace(/[^a-z0-9]/g, '');
    return `${comp}||${title}`;
}

/**
 * Deduplicates a list of normalized jobs.
 * Preserves all source URLs and location variations.
 */
function deduplicateJobs(jobsList) {
    const uniqueMap = new Map();
    const seenUrls = new Map();
    let duplicatesCount = 0;

    for (const job of jobsList) {
        const cleanUrl = cleanUrlForDeduplication(job.application_url);
        const canonicalKey = computeCanonicalKey(job);

        let existing = null;

        // 1. Check exact clean URL match
        if (cleanUrl && seenUrls.has(cleanUrl)) {
            existing = seenUrls.get(cleanUrl);
        }
        // 2. Check canonical key match
        else if (canonicalKey && uniqueMap.has(canonicalKey)) {
            existing = uniqueMap.get(canonicalKey);
        }

        if (existing) {
            duplicatesCount++;
            // Merge location
            if (job.location && !existing.location.toLowerCase().includes(job.location.toLowerCase())) {
                existing.location = `${existing.location}, ${job.location}`;
                existing.location_count = (existing.location_count || 1) + 1;
            }
            // Retain richer description if existing is brief
            if (job.description && job.description.length > (existing.description || '').length) {
                existing.description = job.description;
            }
            // Keep source notes
            if (!existing.all_sources) {
                existing.all_sources = [existing.source];
            }
            if (!existing.all_sources.includes(job.source)) {
                existing.all_sources.push(job.source);
            }
            // Retain latest seen timestamp
            existing.last_seen_at = new Date().toISOString();
        } else {
            job.canonical_id = job.id;
            job.is_canonical = 1;
            job.location_count = 1;
            job.all_sources = [job.source];
            uniqueMap.set(canonicalKey, job);
            if (cleanUrl) {
                seenUrls.set(cleanUrl, job);
            }
        }
    }

    const deduplicated = Array.from(uniqueMap.values());
    console.log(`[Deduplicator] Ingested ${jobsList.length} jobs -> ${deduplicated.length} unique opportunities (${duplicatesCount} duplicates merged).`);

    return {
        deduplicated,
        totalFound: jobsList.length,
        uniqueCount: deduplicated.length,
        duplicatesRemoved: duplicatesCount
    };
}

module.exports = {
    deduplicateJobs,
    cleanUrlForDeduplication,
    computeCanonicalKey
};
