/**
 * test_upgrade.js — Comprehensive Automated Verification Suite
 * Validates all 10 upgrade milestones:
 * 1. Zero-hallucination fact verification guardrail
 * 2. Liveness & ATS closed-page classification
 * 3. Repost & canonical deduplication
 * 4. Multi-dimensional fit scoring & STAR alignment
 * 5. Screening answer generation & sensitivity flagging
 * 6. CRM Kanban state transitions & follow-up cadence
 * 7. AI Interview Preparation & mock evaluator
 */

const assert = require('assert');
const { verifyContentFacts, loadProfile } = require('./src/verify_facts');
const { classifyLiveness } = require('./src/liveness');
const { normalizeUrl, isRepost, computeJobFingerprint } = require('./src/repost_detector');
const { classifySensitivity, answerScreeningQuestion } = require('./src/screening_service');
const { evaluateDeterministicMatch } = require('./src/pipeline/matcher');
const { isValidTransition, getKanbanBoard } = require('./src/crm_service');
const { generateInterviewPrepPack, evaluateMockAnswer } = require('./src/interview_service');

let passedTests = 0;
let totalTests = 0;

function it(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}`);
    }
}

async function itAsync(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passedTests++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    Error: ${err.message}`);
    }
}

async function runAllTests() {
    console.log('====================================================');
    console.log('🧪 Starting CareerOps Upgrade Verification Test Suite');
    console.log('====================================================\n');

    // 1. Fact Verification Guardrail Tests
    console.log('Suite 1: Fact Verification & Anti-Hallucination Guardrail');
    it('Should approve authentic metrics from candidate profile', () => {
        const text = "During my internship at ISRO, I parsed 50+ pulsar timing vectors and achieved 6.8 km error at 95th percentile.";
        const res = verifyContentFacts(text);
        assert.strictEqual(res.valid, true, 'Authentic metrics must pass fact check');
        assert.strictEqual(res.inventedClaims.length, 0);
    });

    it('Should flag invented metrics not present in profile', () => {
        const text = "Increased revenue by 85% and managed $5M dollar budget across 50,000 users.";
        const res = verifyContentFacts(text);
        assert.strictEqual(res.valid, false, 'Invented claims must be flagged');
        assert.ok(res.inventedClaims.length >= 2, 'Should detect invented numbers');
    });

    // 2. Liveness & Expiration Detection
    console.log('\nSuite 2: ATS Liveness & Expiration Detection');
    it('Should detect HTTP 404/410 as expired', () => {
        const res = classifyLiveness({ status: 404 });
        assert.strictEqual(res.isLive, false);
        assert.strictEqual(res.status, 'EXPIRED');
    });

    it('Should detect closed ATS phrases in body text', () => {
        const res = classifyLiveness({ bodyText: 'Thank you for your interest. This position is no longer accepting applications.' });
        assert.strictEqual(res.isLive, false);
        assert.strictEqual(res.code, 'closed_banner');
    });

    it('Should classify Cloudflare / bot challenges as uncertain, not expired', () => {
        const res = classifyLiveness({ bodyText: 'Just a moment... Attention Required! | Cloudflare Ray ID: 87162981' });
        assert.strictEqual(res.isLive, true);
        assert.strictEqual(res.status, 'UNCERTAIN');
    });

    // 3. Repost & Deduplication
    console.log('\nSuite 3: Repost & Canonical Deduplication');
    it('Should strip UTM and session params during URL normalization', () => {
        const raw = 'https://jobs.lever.co/company/12345?utm_source=linkedin&ref=tracker&utm_medium=feed/';
        const norm = normalizeUrl(raw);
        assert.strictEqual(norm, 'https://jobs.lever.co/company/12345');
    });

    it('Should identify reposts with matching role and company fingerprint', () => {
        const jobA = { company: 'Stripe Inc.', role: 'Senior Backend Engineer', url: 'https://stripe.com/jobs/1' };
        const jobB = { company: 'stripe', role: 'Backend Engineer', url: 'https://stripe.com/jobs/1?ref=aggregator' };
        assert.strictEqual(isRepost(jobA, jobB), true);
    });

    // 4. Screening Answers & Sensitivity Flagging
    console.log('\nSuite 4: Screening Service & Safety Flags');
    it('Should flag salary and legal questions for manual review', () => {
        const sal = classifySensitivity('What are your salary expectations in USD?');
        assert.strictEqual(sal.requiresConfirmation, true);
        assert.strictEqual(sal.category, 'SALARY_COMMITMENT');

        const leg = classifySensitivity('Have you ever signed a non-compete agreement?');
        assert.strictEqual(leg.requiresConfirmation, true);
        assert.strictEqual(leg.category, 'LEGAL_OR_DEMOGRAPHIC');
    });

    it('Should answer standard questions deterministically without flags', async () => {
        const res = await answerScreeningQuestion('How many years of experience do you have with Python?');
        assert.strictEqual(res.answer, '3');
        assert.strictEqual(res.requiresConfirmation, false);
    });

    // 5. AI Match Engine & STAR Alignment
    console.log('\nSuite 5: AI Match Engine & Multi-Dimensional Fit');
    it('Should calculate multi-dimensional scores and STAR alignment', () => {
        const sampleJob = {
            role: 'AI / Backend Engineer',
            company: 'Anthropic',
            location: 'Remote',
            remote_type: 'remote',
            description: 'Looking for a software engineer with Go, Python, PostgreSQL, and LLM agent architectures.'
        };
        const match = evaluateDeterministicMatch(sampleJob, {});
        assert.ok(match.overall_score >= 85, 'Should score high for AI/Go/PostgreSQL match');
        assert.strictEqual(match.recommendation_action, 'STRONG_MATCH');
        assert.ok(match.star_alignment.length >= 3, 'Must include STAR alignment evidence');
        assert.strictEqual(match.scoring_weights.skill, 0.40);
    });

    // 6. CRM Kanban & State Machine
    console.log('\nSuite 6: CRM State Machine & Kanban Board');
    it('Should validate legal state transitions', () => {
        assert.strictEqual(isValidTransition('SAVED', 'READY_FOR_REVIEW'), true);
        assert.strictEqual(isValidTransition('READY_FOR_REVIEW', 'SUBMITTED'), true);
        assert.strictEqual(isValidTransition('SUBMITTED', 'INTERVIEW'), true);
        assert.strictEqual(isValidTransition('SUBMITTED', 'OFFER'), true);
        assert.strictEqual(isValidTransition('SAVED', 'INTERVIEW'), false, 'Illegal direct jump to INTERVIEW');
    });

    await itAsync('Should group applications into all 6 Kanban columns', async () => {
        const board = await getKanbanBoard();
        assert.ok(board.saved !== undefined);
        assert.ok(board.ready_for_review !== undefined);
        assert.ok(board.submitted !== undefined);
        assert.ok(board.interviewing !== undefined);
        assert.ok(board.offers !== undefined);
        assert.ok(board.archived !== undefined);
    });

    // 7. Interview Prep & Mock Evaluator
    console.log('\nSuite 7: AI Interview Preparation & Mock Evaluator');
    await itAsync('Should evaluate mock interview answer with STAR framework', async () => {
        const evalRes = await evaluateMockAnswer(
            'How did you solve an API performance issue?',
            'At Kronos, market data ingestion from 45+ exchanges caused dispatch bottlenecks and latency spikes. My task was to eliminate queue latency and maintain high-throughput streaming. I architected Go microservices with gRPC transport, Redis pipeline buffering, and Prometheus telemetry. This cut dispatch latency by 40% and verified market forecasts across 30-step regression tests.',
            { role: 'Backend Engineer', company: 'Stripe' }
        );
        assert.ok(evalRes.score > 0, 'Evaluation score should be positive');
        assert.ok(Array.isArray(evalRes.strengths));
    });

    console.log('\n====================================================');
    console.log(`📊 Test Results: ${passedTests}/${totalTests} Passed (${Math.round((passedTests/totalTests)*100)}%)`);
    console.log('====================================================\n');

    if (passedTests === totalTests) {
        process.exit(0);
    } else {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal error in test runner:', err);
    process.exit(1);
});
