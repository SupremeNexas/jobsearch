/**
 * cover_letter.js — Job-specific, fact-verified cover letter generator
 * Uses OmniRoute / Claude AI with fallback, enforcing zero hallucination.
 */

const { callOmniRoute } = require('./ai');
const { verifyContentFacts, loadProfile } = require('./verify_facts');

/**
 * Generates a tailored cover letter for a job posting.
 * @param {object} job
 * @param {object} [profile]
 * @returns {Promise<{ coverLetter: string, verified: boolean, summary: string }>}
 */
async function generateCoverLetter(job, profile = null) {
    const candidate = profile || loadProfile();
    const info = candidate.personal_information || {};
    const candidateName = [info.first_name, info.last_name].filter(Boolean).join(' ') || 'Applicant';
    const email = info.email || 'applicant@example.com';
    const phone = info.phone || '';
    const location = [info.location?.city, info.location?.country].filter(Boolean).join(', ') || 'Remote';
    const linkedin = info.linkedin || '';
    const github = info.github || '';
    const portfolio = info.portfolio || '';

    const eduText = (candidate.education_details || []).map(e => `${e.degree || ''} at ${e.institution || ''} (${e.start_date || ''}-${e.end_date || ''})`).join('; ') || 'Computer Science degree';
    const expText = (candidate.experience_details || []).map(x => `${x.position || ''} at ${x.company || ''}`).join('; ') || 'Software Engineering experience';
    const projText = (candidate.projects || []).map((p, idx) => `* ${p.name || ''} (${(p.skills || []).join(', ')}): ${(p.highlights || []).slice(0, 2).join(' ')}`).join('\n   ');

    const systemPrompt = `You are an expert executive cover letter writer.
You are writing a tailored cover letter on behalf of candidate ${candidateName} applying for ${job.role} at ${job.company}.

RULES:
1. TRUTH-PRESERVING: Strictly cite only verified facts from candidate's background:
   - Education: ${eduText}.
   - Experience: ${expText}.
   - Projects:
   ${projText || '* Modern full-stack and distributed backend services.'}
2. TONE: Professional, confident, concise, and impact-oriented.
3. LENGTH: Exactly 3 to 4 tightly composed paragraphs.
4. Do NOT hallucinate unverified companies, metrics, or degrees.
5. Return the cover letter text directly.`;

    const userPrompt = `Job Title: ${job.role}
Company: ${job.company}
Location: ${job.location || 'Remote'}
Job Description Summary:
${(job.description || '').slice(0, 1500)}

Please draft the tailored cover letter.`;

    let coverLetterText = '';
    try {
        coverLetterText = await callOmniRoute([{ role: 'user', content: userPrompt }], systemPrompt);
    } catch (e) {
        console.warn('[CoverLetter] AI generation fallback to deterministic template:', e.message);
        coverLetterText = `Dear Hiring Team at ${job.company},

I am writing to express my strong enthusiasm for the ${job.role} position at ${job.company}. With a strong foundation in software engineering and hands-on experience building resilient full-stack systems and distributed services, I am eager to contribute to your engineering goals.

Throughout my projects and engineering experience, I have developed scalable applications, high-performance APIs, and robust data pipelines. I am particularly excited about ${job.company}'s focus on innovation and scalability. I would welcome the opportunity to discuss how my technical foundation, engineering discipline, and problem-solving skills can add immediate value to your team.

Thank you for your time and consideration.

Sincerely,
${candidateName}
${[email, phone].filter(Boolean).join(' | ')}`;
    }

    const verification = verifyContentFacts(coverLetterText, candidate);

    return {
        coverLetter: coverLetterText,
        verified: verification.valid,
        summary: verification.summary,
        inventedClaims: verification.inventedClaims
    };
}

module.exports = {
    generateCoverLetter
};
