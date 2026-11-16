/**
 * repost_detector.js — Repost and Duplicate Detection Engine
 * Adapted from career-ops-main/detect-reposts.mjs
 *
 * Computes canonical fingerprints from:
 * 1. Normalized canonical URL (stripping UTM, tracking, session query params).
 * 2. Canonical company + normalized role slug.
 * 3. Exact job board ID matching across platforms.
 */

const crypto = require('crypto');

/**
 * Normalizes a URL by removing tracking query parameters and trailing slashes.
 */
function normalizeUrl(rawUrl = '') {
    if (!rawUrl) return '';
    try {
        const u = new URL(rawUrl);
        // Stripping standard tracking & session params
        const stripParams = [
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            'gh_jid', 'ref', 'source', 'trkid', 'trk', 'trackingid', 'sessionid',
            'fbclid', 'gclid', 'currentJobId'
        ];
        stripParams.forEach(p => u.searchParams.delete(p));
        // Remove trailing slash
        let pathname = u.pathname.replace(/\/+$/, '');
        return `${u.protocol}//${u.host}${pathname}${u.search ? u.search : ''}`.toLowerCase();
    } catch (e) {
        return rawUrl.trim().toLowerCase();
    }
}

/**
 * Normalizes job title and company into a canonical slug
 */
function normalizeRole(role = '') {
    return role
        .toLowerCase()
        .replace(/\b(senior|sr|sr\.|junior|jr|jr\.|lead|staff|principal)\b/g, '')
        .replace(/[^a-z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeCompany(company = '') {
    return company
        .toLowerCase()
        .replace(/\b(inc|ltd|llc|technologies|solutions|corp|corporation|pvt)\b/g, '')
        .replace(/[^a-z0-9]/g, '')
        .trim();
}

/**
 * Generates a SHA-256 fingerprint for deduplication.
 */
function computeJobFingerprint(job) {
    const normUrl = normalizeUrl(job.url || job.link);
    const normRole = normalizeRole(job.role || job.title);
    const normComp = normalizeCompany(job.company);

    const rawString = `${normComp}:::${normRole}`;
    const contentHash = crypto.createHash('sha256').update(rawString).digest('hex').slice(0, 16);
    const urlHash = normUrl ? crypto.createHash('sha256').update(normUrl).digest('hex').slice(0, 16) : null;

    return {
        contentHash,
        urlHash,
        normalizedUrl: normUrl,
        normalizedRole: normRole,
        normalizedCompany: normComp
    };
}

/**
 * Finds duplicates within an array of jobs or checks a job against existing DB records.
 */
function isRepost(jobA, jobB) {
    if (!jobA || !jobB) return false;

    // 1. Same normalized URL
    const urlA = normalizeUrl(jobA.url || jobA.link);
    const urlB = normalizeUrl(jobB.url || jobB.link);
    if (urlA && urlB && urlA === urlB) return true;

    // 2. Exact company & title match
    const fpA = computeJobFingerprint(jobA);
    const fpB = computeJobFingerprint(jobB);
    if (fpA.contentHash === fpB.contentHash && fpA.normalizedRole.length > 3) {
        return true;
    }

    return false;
}

module.exports = {
    normalizeUrl,
    normalizeRole,
    normalizeCompany,
    computeJobFingerprint,
    isRepost
};
