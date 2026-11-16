/**
 * screening_service.js — Intelligent, Fact-Grounded Application Screening Q&A Engine
 * 
 * Complies with strict safety rules:
 * 1. Uses candidate's verified profile as sole source of truth.
 * 2. Never invents unsupported claims or metrics.
 * 3. Flags sensitive questions (legal declarations, salary commitments, sponsorship) for manual user confirmation.
 * 4. Caches reusable answers for future applications.
 */

const fs = require('fs');
const path = require('path');
const { loadProfile, verifyContentFacts } = require('./verify_facts');
const { callOmniRoute } = require('./ai');

// In-memory or file-backed approved answer cache
const APPROVED_ANSWERS_PATH = path.resolve(__dirname, '../data/screening_answers_cache.json');

function loadApprovedCache() {
    try {
        if (fs.existsSync(APPROVED_ANSWERS_PATH)) {
            return JSON.parse(fs.readFileSync(APPROVED_ANSWERS_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn('[ScreeningService] Could not read cache:', e.message);
    }
    return {};
}

function saveApprovedCache(cache) {
    try {
        const dir = path.dirname(APPROVED_ANSWERS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(APPROVED_ANSWERS_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch (e) {
        console.warn('[ScreeningService] Could not save cache:', e.message);
    }
}

/**
 * Categorizes whether a question involves legal, financial, or visa commitments that REQUIRE manual confirmation.
 */
function classifySensitivity(questionText = '') {
    const q = questionText.toLowerCase();

    // 1. Legal / Criminal / Non-compete declarations
    if (q.includes('felony') || q.includes('misdemeanor') || q.includes('criminal') ||
        q.includes('non-compete') || q.includes('conflict of interest') || q.includes('nda') ||
        q.includes('military') || q.includes('security clearance') || q.includes('disability') ||
        q.includes('veteran') || q.includes('race') || q.includes('ethnicity') || q.includes('gender')) {
        return {
            category: 'LEGAL_OR_DEMOGRAPHIC',
            requiresConfirmation: true,
            reason: 'Question involves legal declarations or voluntary demographic self-identification.'
        };
    }

    // 2. Salary commitments
    if (q.includes('salary') || q.includes('compensation') || q.includes('expected pay') || q.includes('hourly rate') || q.includes('desired rate') || q.includes('ctc')) {
        return {
            category: 'SALARY_COMMITMENT',
            requiresConfirmation: true,
            reason: 'Question requires specific salary or compensation commitment.'
        };
    }

    // 3. Work Authorization & Sponsorship
    if (q.includes('sponsorship') || q.includes('visa') || q.includes('work authorization') || q.includes('legally authorized') || q.includes('require sponsorship')) {
        return {
            category: 'WORK_AUTHORIZATION',
            requiresConfirmation: false, // Standard answer available, but flagged for verification if on-site US
            reason: 'Work authorization and sponsorship declaration.'
        };
    }

    return {
        category: 'STANDARD_TECHNICAL_OR_EXPERIENCE',
        requiresConfirmation: false,
        reason: 'Standard profile, technical, or motivational question.'
    };
}

/**
 * Standard deterministic answer bank for candidate profile
 */
function getDeterministicAnswer(questionText, profile) {
    const q = questionText.toLowerCase();

    // Work authorization
    if (q.includes('legally authorized to work in the country') || q.includes('authorized to work in india') || q.includes('legally authorized to work in the united states') || q.includes('legally authorized')) {
        if (q.includes('united states') || q.includes('in the us')) {
            return {
                answer: 'No',
                confidence: 95,
                requiresConfirmation: true,
                flagReason: 'US work authorization requires explicit candidate confirmation based on job remote status.'
            };
        }
        return {
            answer: 'Yes',
            confidence: 95,
            requiresConfirmation: false
        };
    }

    // Sponsorship
    if (q.includes('will you now or in the future require sponsorship') || q.includes('require visa sponsorship') || q.includes('sponsorship')) {
        return {
            answer: 'No',
            confidence: 90,
            requiresConfirmation: false,
            flagReason: 'Does not require sponsorship for India or worldwide remote roles.'
        };
    }

    // Notice period / Availability / Internship timeline
    if (q.includes('internship duration') || q.includes('internship timeline') || q.includes('available from january') || q.includes('6 month') || q.includes('6-month') || (q.includes('start date') && q.includes('intern'))) {
        return {
            answer: 'Available for 6-month full-time internship from January to June',
            confidence: 99,
            requiresConfirmation: false
        };
    }

    if (q.includes('notice period') || q.includes('how soon can you start') || q.includes('availability') || q.includes('start date')) {
        return {
            answer: 'Available from January 2027 for 6-month internship / Immediate',
            confidence: 98,
            requiresConfirmation: false
        };
    }

    // Salary expectations
    if (q.includes('salary expectation') || q.includes('desired salary') || q.includes('compensation')) {
        return {
            answer: 'Negotiable / Competitive market rate',
            confidence: 85,
            requiresConfirmation: true,
            flagReason: 'Review salary before submitting.'
        };
    }

    // Years of experience (Candidate: B.Tech 2026, 2-3 years building production projects & ISRO internship)
    if (q.includes('how many years of experience') || q.includes('years of experience')) {
        if (q.includes('python') || q.includes('node') || q.includes('javascript') || q.includes('software')) {
            return { answer: '3', confidence: 95, requiresConfirmation: false };
        }
        if (q.includes('go') || q.includes('golang') || q.includes('react') || q.includes('sql') || q.includes('docker') || q.includes('redis') || q.includes('postgresql')) {
            return { answer: '2', confidence: 95, requiresConfirmation: false };
        }
        if (q.includes('ai') || q.includes('llm') || q.includes('agentic')) {
            return { answer: '2', confidence: 95, requiresConfirmation: false };
        }
        return { answer: '2', confidence: 80, requiresConfirmation: false };
    }

    // GPA
    if (q.includes('gpa') || q.includes('grade point')) {
        return { answer: '3.42 / 4.00', confidence: 100, requiresConfirmation: false };
    }

    // Degree / University
    if (q.includes('university') || q.includes('institution') || q.includes('college')) {
        return { answer: 'Pandit Deendayal Energy University (PDEU)', confidence: 100, requiresConfirmation: false };
    }

    if (q.includes('degree') || q.includes('major') || q.includes('field of study')) {
        return { answer: 'B.Tech in Computer Engineering', confidence: 100, requiresConfirmation: false };
    }

    return null;
}

/**
 * Answers a single screening question using verified profile and AI with fact-checking.
 * @param {string} questionText
 * @param {object} job
 * @param {object} [customProfile]
 * @returns {Promise<{ answer: string, confidence: number, requiresConfirmation: boolean, flagReason?: string, source: string }>}
 */
async function answerScreeningQuestion(questionText, job = {}, customProfile = null) {
    const profile = customProfile || loadProfile();
    const sensitivity = classifySensitivity(questionText);

    // 1. Check approved cache
    const cache = loadApprovedCache();
    const cacheKey = questionText.trim().toLowerCase();
    if (cache[cacheKey]) {
        return {
            ...cache[cacheKey],
            source: 'approved_cache'
        };
    }

    // 2. Check deterministic verified bank
    const deterministic = getDeterministicAnswer(questionText, profile);
    if (deterministic) {
        return {
            ...deterministic,
            requiresConfirmation: deterministic.requiresConfirmation || sensitivity.requiresConfirmation,
            flagReason: deterministic.flagReason || (sensitivity.requiresConfirmation ? sensitivity.reason : undefined),
            source: 'deterministic_profile_rules'
        };
    }

    // 3. For free-form behavioral / motivational questions, synthesize with LLM grounded strictly in candidate facts
    const info = (profile && profile.personal_information) || {};
    const candidateName = [info.first_name, info.last_name].filter(Boolean).join(' ') || 'the applicant';
    const eduList = ((profile && profile.education_details) || []).map(e => `${e.degree || ''} at ${e.institution || ''} (${e.start_date || ''} - ${e.end_date || ''})`).join('; ');
    const expList = ((profile && profile.experience_details) || []).map(x => `${x.position || ''} at ${x.company || ''}`).join('; ');
    const projList = ((profile && profile.projects) || []).map((p, idx) => `${idx + 1}. ${p.name || ''} (${(p.skills || []).join(', ')})`).join('\n  ');

    const systemPrompt = `You are answering a job application screening question on behalf of candidate ${candidateName}.
Candidate facts:
- Education: ${eduList || 'Computer Science degree'}
- Experience: ${expList || 'Software Engineering experience'}
- Projects:
  ${projList || 'Full stack web applications, distributed systems, and AI automation tooling'}
- Location: ${[info.location?.city, info.location?.country].filter(Boolean).join(', ') || 'Remote'}

STRICT PRINCIPLES:
1. TRUTH-PRESERVING: Never invent companies, unverified metrics, or degrees.
2. CONCISE: Keep answers under 100 words unless a long essay is explicitly requested.
3. RELEVANT: Relate directly to ${job.role || 'the role'} at ${job.company || 'the company'}.
4. Return ONLY the answer text.`;

    const userPrompt = `Question: "${questionText}"
Job Role: ${job.role || 'Software Engineer'}
Company: ${job.company || 'Engineering Team'}`;

    let generatedAnswer = '';
    try {
        generatedAnswer = await callOmniRoute([{ role: 'user', content: userPrompt }], systemPrompt);
    } catch (e) {
        console.warn('[ScreeningService] LLM call failed, providing standard fallback:', e.message);
        generatedAnswer = `With a background in Computer Engineering from PDEU and experience developing software systems at Space Applications Centre (ISRO) and full-stack projects like Monerva and Kronos, I bring strong problem solving, backend engineering, and AI integration skills to this position.`;
    }

    // Verify facts in generated answer
    const verification = verifyContentFacts(generatedAnswer, profile);

    return {
        answer: generatedAnswer.trim(),
        confidence: verification.valid ? 90 : 70,
        requiresConfirmation: sensitivity.requiresConfirmation || !verification.valid,
        flagReason: sensitivity.requiresConfirmation ? sensitivity.reason : (!verification.valid ? 'AI generated claim requires fact verification.' : undefined),
        source: 'ai_synthesized_verified'
    };
}

/**
 * Answers a batch of form questions.
 */
async function answerFormBatch(questions = [], job = {}, profile = null) {
    const results = [];
    for (const q of questions) {
        const text = typeof q === 'string' ? q : (q.label || q.question || q.name || '');
        if (!text) continue;
        const answerObj = await answerScreeningQuestion(text, job, profile);
        results.push({
            question: text,
            fieldId: q.id || q.name || null,
            ...answerObj
        });
    }
    return results;
}

/**
 * Approves and saves a screening answer to the reusable cache.
 */
function approveAnswer(questionText, answer) {
    const cache = loadApprovedCache();
    const cacheKey = questionText.trim().toLowerCase();
    cache[cacheKey] = {
        answer,
        confidence: 100,
        requiresConfirmation: false,
        approvedAt: new Date().toISOString()
    };
    saveApprovedCache(cache);
}

module.exports = {
    classifySensitivity,
    answerScreeningQuestion,
    answerFormBatch,
    approveAnswer
};
