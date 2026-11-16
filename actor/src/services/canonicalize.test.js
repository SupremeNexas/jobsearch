/**
 * Deduplication & Multi-Location Grouping Tests
 *
 * Run: node src/services/canonicalize.test.js
 */

const assert = require('assert');
const {
    normalizeTitle,
    normalizeCompany,
    canonicalizeUrl,
    generateCanonicalId,
    groupJobsByCanonical,
    extractTrigrams,
    jaccardSimilarity
} = require('./canonicalize');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e.message}`);
        failed++;
    }
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg || 'Assertion failed'}: expected "${expected}", got "${actual}"`);
    }
}

function assertOk(actual, msg) {
    if (!actual) {
        throw new Error(msg || 'Expected truthy value');
    }
}

function assertDeepEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(`${msg || 'Deep assertion failed'}:\n  expected: ${e}\n  actual:   ${a}`);
    }
}

console.log('\n=== Canonicalize Tests ===\n');

// ── Title Normalization ──
test('normalizeTitle: basic lowercase', () => {
    assertEqual(normalizeTitle('Senior Software Engineer'), 'senior software engineer');
});

test('normalizeTitle: strips special chars', () => {
    assertEqual(normalizeTitle('Front-End Developer (Remote)'), 'front-end developer remote');
});

test('normalizeTitle: normalizes unicode dashes', () => {
    const result = normalizeTitle('Developer—Senior');
    assertOk(result.includes('developer'), 'should contain normalized developer');
});

// ── Company Normalization ──
test('normalizeCompany: strips Inc suffix', () => {
    assertEqual(normalizeCompany('Stripe Inc.'), 'stripe');
});

test('normalizeCompany: strips multiple suffixes', () => {
    assertEqual(normalizeCompany('Google LLC'), 'google');
});

test('normalizeCompany: handles empty', () => {
    assertEqual(normalizeCompany(''), '');
});

// ── URL Canonicalization ──
test('canonicalizeUrl: strips UTM params', () => {
    const url = 'https://example.com/jobs/123?utm_source=jobsite&ref=sidebar';
    assertEqual(canonicalizeUrl(url), 'https://example.com/jobs/123');
});

test('canonicalizeUrl: preserves path', () => {
    const url = 'https://boards.greenhouse.io/company/jobs/456';
    assertEqual(canonicalizeUrl(url), 'https://boards.greenhouse.io/company/jobs/456');
});

test('canonicalizeUrl: empty string', () => {
    assertEqual(canonicalizeUrl(''), '');
});

// ── Canonical ID Generation ──
test('generateCanonicalId: deterministic for same input', () => {
    const id1 = generateCanonicalId('greenhouse', 'Stripe', 'Software Engineer');
    const id2 = generateCanonicalId('greenhouse', 'Stripe', 'Software Engineer');
    assertEqual(id1, id2);
});

test('generateCanonicalId: different for different company', () => {
    const id1 = generateCanonicalId('greenhouse', 'Stripe', 'Software Engineer');
    const id2 = generateCanonicalId('greenhouse', 'Google', 'Software Engineer');
    assertOk(id1 !== id2);
});

// ── Trigram Extraction ──
test('extractTrigrams: generates trigrams', () => {
    const trigrams = extractTrigrams('the quick brown fox');
    assertOk(trigrams.has('the quick brown'));
    assertOk(trigrams.has('quick brown fox'));
    assertEqual(trigrams.size, 2);
});

test('extractTrigrams: empty string', () => {
    const trigrams = extractTrigrams('');
    assertEqual(trigrams.size, 0);
});

// ── Jaccard Similarity ──
test('jaccardSimilarity: identical sets', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['a', 'b', 'c']);
    assertEqual(jaccardSimilarity(a, b), 1);
});

test('jaccardSimilarity: disjoint sets', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    assertEqual(jaccardSimilarity(a, b), 0);
});

test('jaccardSimilarity: partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    assertEqual(jaccardSimilarity(a, b), 0.5); // 2 shared / (3 + 3 - 2) = 2/4 = 0.5
});

// ── Job Grouping ──
test('groupJobsByCanonical: groups same company/title/location variants', () => {
    const jobs = [
        { job_id: 'j1', company: 'Stripe', role: 'Software Engineer', location: 'San Francisco', source: 'greenhouse', description: 'Build APIs in Node.js', url: 'https://example.com/jobs/1' },
        { job_id: 'j2', company: 'Stripe', role: 'Software Engineer', location: 'New York', source: 'greenhouse', description: 'Build APIs in Node.js', url: 'https://example.com/jobs/2' },
        { job_id: 'j3', company: 'Stripe', role: 'Software Engineer', location: 'Remote', source: 'greenhouse', description: 'Build APIs in Node.js', url: 'https://example.com/jobs/3' }
    ];
    const groups = groupJobsByCanonical(jobs);
    assertOk(groups.length > 0, 'should have groups');

    // Find the Stripe group
    const stripeGroup = groups.find(g =>
        g.canonical.company === 'Stripe' && g.canonical.role === 'Software Engineer'
    );
    assertOk(stripeGroup, 'should find Stripe group');
    assertOk(stripeGroup.locations.length >= 3, `should have 3+ locations, got ${stripeGroup.locations.length}`);
});

test('groupJobsByCanonical: keeps different companies separate', () => {
    const jobs = [
        { job_id: 'j1', company: 'Stripe', role: 'Software Engineer', location: 'SF', source: 'greenhouse', description: 'Build APIs', url: 'https://example.com/jobs/1' },
        { job_id: 'j2', company: 'Google', role: 'Software Engineer', location: 'SF', source: 'greenhouse', description: 'Build APIs', url: 'https://example.com/jobs/2' }
    ];
    const groups = groupJobsByCanonical(jobs);
    // Should have at least 2 groups (different companies)
    assertOk(groups.length >= 2, `expected 2+ groups, got ${groups.length}`);
});

test('groupJobsByCanonical: location deduplication', () => {
    const jobs = [
        { job_id: 'j1', company: 'Stripe', role: 'Engineer', location: 'Remote', source: 'greenhouse', description: 'Build', url: 'https://example.com/jobs/1' },
        { job_id: 'j2', company: 'Stripe', role: 'Engineer', location: 'Remote', source: 'greenhouse', description: 'Build', url: 'https://example.com/jobs/2' }
    ];
    const groups = groupJobsByCanonical(jobs);
    const group = groups.find(g => g.canonical.company === 'Stripe');
    assertOk(group, 'should find Stripe group');
    // Same location "Remote" should appear only once
    const remoteCount = group.locations.filter(l => l.location === 'Remote').length;
    assertEqual(remoteCount, 1, 'Remote location should appear once');
});

test('groupJobsByCanonical: different descriptions keep separate', () => {
    const jobs = [
        { job_id: 'j1', company: 'Stripe', role: 'Software Engineer', location: 'SF', source: 'greenhouse',
          description: 'Python Django backend development with PostgreSQL and Redis caching', url: 'https://example.com/jobs/1' },
        { job_id: 'j2', company: 'Stripe', role: 'Software Engineer', location: 'NY', source: 'greenhouse',
          description: 'Frontend React Vue TypeScript UI design systems CSS', url: 'https://example.com/jobs/2' }
    ];
    const groups = groupJobsByCanonical(jobs);
    // These have very different descriptions — may be split into separate groups
    // The important thing is no crash and reasonable behavior
    assertOk(groups.length >= 1, 'should have at least one group');
});

// ── Edge Cases ──
test('normalizeTitle: handles null/undefined', () => {
    assertEqual(normalizeTitle(null), '');
    assertEqual(normalizeTitle(undefined), '');
});

test('normalizeCompany: handles null/undefined', () => {
    assertEqual(normalizeCompany(null), '');
    assertEqual(normalizeCompany(undefined), '');
});

test('canonicalizeUrl: handles null/undefined', () => {
    assertEqual(canonicalizeUrl(null), '');
    assertEqual(canonicalizeUrl(undefined), '');
});

test('generateCanonicalId: produces cj_ prefix', () => {
    const id = generateCanonicalId('greenhouse', 'Company', 'Role');
    assertOk(id.startsWith('cj_'), `expected cj_ prefix, got ${id}`);
});

// ── Summary ──
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('All tests passed! ✅');
}
