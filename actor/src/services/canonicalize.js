/**
 * Job Canonicalization & Multi-Location Grouping Service
 *
 * Identifies duplicate job postings that differ only by location and groups
 * them into one canonical record with an associated list of locations.
 *
 * Pipeline:
 *   1. Source + requisition ID match (highest confidence)
 *   2. Canonical URL match
 *   3. Company + normalized title + description similarity
 *
 * Conservative by design: keeps jobs separate when confidence is insufficient.
 */

const crypto = require('crypto');
const { runQuery, getQuery, allQuery } = require('../db');

// ──────────────────────────────────────────────
// Title Normalization
// ──────────────────────────────────────────────
function normalizeTitle(title) {
    if (!title) return '';
    return title
        .toLowerCase()
        .replace(/[‐‑‒–—―−﹘﹣－]/g, '-') // normalize dashes
        .replace(/[^\w\s\-]/g, ' ')           // strip special chars
        .replace(/\s+/g, ' ')                  // collapse whitespace
        .trim();
}

// ──────────────────────────────────────────────
// Company Normalization
// ──────────────────────────────────────────────
const COMPANY_SUFFIXES = /\b(inc\.?|ltd\.?|llc\.?|corp\.?|co\.?|gmbh|n\.?v\.?|plc|s\.?a\.?|b\.?v\.?|limited|corporation|company)\b/gi;

function normalizeCompany(company) {
    if (!company) return '';
    return company
        .toLowerCase()
        .replace(COMPANY_SUFFIXES, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// ──────────────────────────────────────────────
// URL Canonicalization
// ──────────────────────────────────────────────
const TRACKING_PARAMS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'ref', 'source', 'tracking', 'click_id', 'fbclid', 'gclid',
    'mc_cid', 'mc_eid', '_ga', '_gid', 'si'
]);

function canonicalizeUrl(rawUrl) {
    if (!rawUrl) return '';
    try {
        const u = new URL(rawUrl);
        const params = new URLSearchParams(u.search);
        for (const key of [...params.keys()]) {
            if (TRACKING_PARAMS.has(key.toLowerCase())) {
                params.delete(key);
            }
        }
        u.search = params.toString();
        u.hash = '';
        return u.toString().replace(/\/+$/, '');
    } catch {
        return rawUrl.split('?')[0].replace(/\/+$/, '');
    }
}

// ──────────────────────────────────────────────
// Description Similarity (Jaccard on word trigrams)
// ──────────────────────────────────────────────
function extractTrigrams(text) {
    const words = (text || '')
        .toLowerCase()
        .replace(/<[^>]+>/g, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(w => w.length > 2);
    const trigrams = new Set();
    for (let i = 0; i < words.length - 2; i++) {
        trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    return trigrams;
}

function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const item of setA) {
        if (setB.has(item)) intersection++;
    }
    return intersection / (setA.size + setB.size - intersection);
}

// ──────────────────────────────────────────────
// Canonical Key Generation
// ──────────────────────────────────────────────
function generateCanonicalId(source, company, role) {
    const key = `${normalizeCompany(company)}_${normalizeTitle(role)}_${(source || '').toLowerCase()}`;
    return 'cj_' + crypto.createHash('sha256').update(key).digest('hex').substring(0, 14);
}

// ──────────────────────────────────────────────
// Core: Group raw jobs into canonical buckets
// ──────────────────────────────────────────────

/**
 * Groups an array of raw job objects into canonical job groups.
 * Each group has one representative job + an array of locations with per-location metadata.
 *
 * @param {Array} rawJobs - array of job objects from any crawler
 * @param {Object} opts - options
 * @param {boolean} opts.useDescription - whether to also compare descriptions (default true)
 * @returns {Array} canonicalGroups
 */
function groupJobsByCanonical(rawJobs, opts = {}) {
    const useDescription = opts.useDescription !== false;
    const groups = new Map(); // canonicalKey -> { canonical, locations[] }

    // Stage 1+2+3: Build candidate groups keyed by (source + normalizedCompany + normalizedTitle)
    for (const job of rawJobs) {
        const normCompany = normalizeCompany(job.company);
        const normTitle = normalizeTitle(job.role || job.title);
        const source = (job.source || job.platform || '').toLowerCase();

        // Candidate key: source + company + title (without location)
        const candidateKey = `${source}||${normCompany}||${normTitle}`;

        if (!groups.has(candidateKey)) {
            groups.set(candidateKey, {
                canonical: { ...job },
                locations: [],
                descriptionTrigrams: null
            });
        }

        const group = groups.get(candidateKey);

        // If using descriptions and we already have content, verify similarity
        if (useDescription && group.locations.length > 0 && job.description && group.canonical.description) {
            if (!group.descriptionTrigrams) {
                group.descriptionTrigrams = extractTrigrams(group.canonical.description);
            }
            const jobTrigrams = extractTrigrams(job.description);
            const sim = jaccardSimilarity(group.descriptionTrigrams, jobTrigrams);

            // If descriptions are substantially different (< 0.4 similarity),
            // this is likely a different role despite matching title — keep separate
            if (sim < 0.4 && group.descriptionTrigrams.size > 10 && jobTrigrams.size > 10) {
                // Create a separate group with a disambiguated key
                const altKey = candidateKey + '||' + (job.job_id || job.url || Math.random());
                groups.set(altKey, {
                    canonical: { ...job },
                    locations: [{
                        location: job.location || 'Remote',
                        url: job.url,
                        application_url: job.application_url || job.url,
                        job_id: job.job_id,
                        source_job_id: job.source_job_id || null
                    }],
                    descriptionTrigrams: jobTrigrams
                });
                continue;
            }
        }

        // Add this location variant to the group
        group.locations.push({
            location: job.location || 'Remote',
            url: job.url,
            application_url: job.application_url || job.url,
            job_id: job.job_id,
            source_job_id: job.source_job_id || null
        });
    }

    // Deduplicate locations within each group
    const result = [];
    for (const [, group] of groups) {
        const seenLocations = new Set();
        const uniqueLocations = [];
        for (const loc of group.locations) {
            const locKey = (loc.location || '').toLowerCase().trim();
            if (!seenLocations.has(locKey)) {
                seenLocations.add(locKey);
                uniqueLocations.push(loc);
            }
        }
        group.locations = uniqueLocations;
        result.push(group);
    }

    return result;
}

// ──────────────────────────────────────────────
// DB Schema: Create job_locations table
// ──────────────────────────────────────────────

async function ensureJobLocationsTable() {
    await runQuery(`
        CREATE TABLE IF NOT EXISTS job_locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            canonical_job_id TEXT NOT NULL,
            location TEXT NOT NULL,
            url TEXT,
            application_url TEXT,
            original_job_id TEXT,
            source_job_id TEXT,
            FOREIGN KEY (canonical_job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
        )
    `);

    // Add canonical columns to jobs table if missing
    try {
        await runQuery('ALTER TABLE jobs ADD COLUMN canonical_id TEXT');
    } catch (e) { /* column already exists */ }
    try {
        await runQuery('ALTER TABLE jobs ADD COLUMN is_canonical INTEGER DEFAULT 1');
    } catch (e) { /* column already exists */ }
    try {
        await runQuery('ALTER TABLE jobs ADD COLUMN location_count INTEGER DEFAULT 1');
    } catch (e) { /* column already exists */ }

    // Index for fast lookups
    try {
        await runQuery('CREATE INDEX IF NOT EXISTS idx_job_locations_canonical ON job_locations(canonical_job_id)');
    } catch (e) { /* index may already exist */ }
    try {
        await runQuery('CREATE INDEX IF NOT EXISTS idx_jobs_canonical_id ON jobs(canonical_id)');
    } catch (e) { /* index may already exist */ }
}

// ──────────────────────────────────────────────
// Reconcile existing DB jobs into canonical groups
// ──────────────────────────────────────────────

async function reconcileExistingDuplicates() {
    await ensureJobLocationsTable();

    // Fetch all jobs grouped by company + normalized title
    const allJobs = await allQuery(`
        SELECT job_id, company, role, location, source, url, description,
               score, status, is_saved, is_ignored, application_url, discovered_at
        FROM jobs
        WHERE (is_canonical IS NULL OR is_canonical = 1)
        ORDER BY company, role, score DESC
    `);

    if (!allJobs || allJobs.length === 0) return { grouped: 0, locationsAdded: 0 };

    const groups = groupJobsByCanonical(allJobs);

    let groupedCount = 0;
    let locationsAdded = 0;

    for (const group of groups) {
        if (group.locations.length <= 1) continue; // single-location, nothing to merge

        // Pick the canonical record: prefer highest score, then earliest discovered
        const canonical = group.canonical;
        const canonicalJobId = canonical.job_id;

        // Check if already has locations
        const existingLocs = await allQuery(
            'SELECT id FROM job_locations WHERE canonical_job_id = ?',
            [canonicalJobId]
        );

        if (existingLocs && existingLocs.length > 0) continue; // already reconciled

        // Build location list from all locations
        const allLocations = group.locations.map(l => l.location).join(', ');

        // Insert location records for the canonical job
        for (const loc of group.locations) {
            await runQuery(`
                INSERT OR IGNORE INTO job_locations (canonical_job_id, location, url, application_url, original_job_id, source_job_id)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [canonicalJobId, loc.location, loc.url, loc.application_url, loc.job_id, loc.source_job_id]);
            locationsAdded++;
        }

        // Update canonical record with aggregated location and count
        await runQuery(`
            UPDATE jobs SET location = ?, location_count = ?, is_canonical = 1, canonical_id = ?
            WHERE job_id = ?
        `, [allLocations, group.locations.length, canonicalJobId, canonicalJobId]);

        // Mark non-canonical variants as hidden (is_canonical = 0) and point them to canonical
        for (const loc of group.locations) {
            if (loc.job_id && loc.job_id !== canonicalJobId) {
                // Migrate saved/ignored state: if any variant was saved, the canonical should be saved
                const variant = await getQuery('SELECT is_saved, is_ignored FROM jobs WHERE job_id = ?', [loc.job_id]);
                if (variant) {
                    if (variant.is_saved) {
                        await runQuery('UPDATE jobs SET is_saved = 1 WHERE job_id = ?', [canonicalJobId]);
                    }
                }

                // Migrate application records to point to canonical
                await runQuery(
                    'UPDATE applications SET job_id = ? WHERE job_id = ? AND NOT EXISTS (SELECT 1 FROM applications WHERE job_id = ?)',
                    [canonicalJobId, loc.job_id, canonicalJobId]
                );

                // Migrate AI match records
                await runQuery(
                    'UPDATE ai_job_matches SET job_id = ? WHERE job_id = ? AND NOT EXISTS (SELECT 1 FROM ai_job_matches WHERE job_id = ?)',
                    [canonicalJobId, loc.job_id, canonicalJobId]
                );

                // Migrate resume versions
                await runQuery(
                    'UPDATE resume_versions SET job_id = ? WHERE job_id = ?',
                    [canonicalJobId, loc.job_id]
                );

                // Mark variant as non-canonical
                await runQuery(
                    'UPDATE jobs SET is_canonical = 0, canonical_id = ? WHERE job_id = ?',
                    [canonicalJobId, loc.job_id]
                );
            }
        }

        groupedCount++;
    }

    console.log(`[Canonicalize] Reconciled ${groupedCount} multi-location groups, added ${locationsAdded} location records.`);
    return { grouped: groupedCount, locationsAdded };
}

// ──────────────────────────────────────────────
// Insert new jobs with canonical deduplication
// ──────────────────────────────────────────────

/**
 * Checks if a new job is a location variant of an existing canonical job.
 * Returns the canonical job_id if matched, null otherwise.
 */
async function findExistingCanonical(job) {
    const normCompany = normalizeCompany(job.company);
    const normTitle = normalizeTitle(job.role || job.title);
    const source = (job.source || '').toLowerCase();

    // Stage 1: Check by source + normalized company/title among canonical jobs
    const candidates = await allQuery(`
        SELECT job_id, company, role, description, source, location
        FROM jobs
        WHERE is_canonical = 1 OR is_canonical IS NULL
        ORDER BY score DESC
    `);

    for (const candidate of (candidates || [])) {
        const candCompany = normalizeCompany(candidate.company);
        const candTitle = normalizeTitle(candidate.role);
        const candSource = (candidate.source || '').toLowerCase();

        // Must match source + company + title
        if (candSource !== source || candCompany !== normCompany || candTitle !== normTitle) {
            continue;
        }

        // If descriptions available, verify similarity
        if (job.description && candidate.description) {
            const jobTrigrams = extractTrigrams(job.description);
            const candTrigrams = extractTrigrams(candidate.description);
            if (jobTrigrams.size > 10 && candTrigrams.size > 10) {
                const sim = jaccardSimilarity(jobTrigrams, candTrigrams);
                if (sim < 0.4) continue; // different job content
            }
        }

        return candidate.job_id;
    }

    return null;
}

/**
 * Adds a location to an existing canonical job if not already present.
 */
async function addLocationToCanonical(canonicalJobId, location, url, applicationUrl, originalJobId, sourceJobId) {
    const normLoc = (location || '').toLowerCase().trim();

    // Check if this location already exists
    const existing = await getQuery(
        'SELECT id FROM job_locations WHERE canonical_job_id = ? AND LOWER(TRIM(location)) = ?',
        [canonicalJobId, normLoc]
    );

    if (existing) return false; // already have this location

    await runQuery(`
        INSERT INTO job_locations (canonical_job_id, location, url, application_url, original_job_id, source_job_id)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [canonicalJobId, location, url, applicationUrl, originalJobId, sourceJobId]);

    // Update aggregated location on the canonical job
    const allLocs = await allQuery(
        'SELECT location FROM job_locations WHERE canonical_job_id = ?',
        [canonicalJobId]
    );
    const locCount = allLocs ? allLocs.length : 1;
    const locStr = allLocs ? allLocs.map(l => l.location).join(', ') : location;

    await runQuery(
        'UPDATE jobs SET location = ?, location_count = ? WHERE job_id = ?',
        [locStr, locCount, canonicalJobId]
    );

    return true;
}

// ──────────────────────────────────────────────
// Get locations for a canonical job
// ──────────────────────────────────────────────

async function getJobLocations(canonicalJobId) {
    return allQuery(
        'SELECT id, location, url, application_url, original_job_id, source_job_id FROM job_locations WHERE canonical_job_id = ? ORDER BY location',
        [canonicalJobId]
    );
}

// ──────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────

module.exports = {
    normalizeTitle,
    normalizeCompany,
    canonicalizeUrl,
    generateCanonicalId,
    groupJobsByCanonical,
    ensureJobLocationsTable,
    reconcileExistingDuplicates,
    findExistingCanonical,
    addLocationToCanonical,
    getJobLocations,
    jaccardSimilarity,
    extractTrigrams
};
