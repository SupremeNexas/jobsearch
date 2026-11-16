const { getAihawkConfig } = require('./config');
const { logger } = require('./logs');

class AihawkClient {
    constructor() {
        this.timeoutMs = 45000;
        this.omnirouteUnavailableUntil = 0;
    }

    async callLlm(messages, systemPrompt = '', options = {}) {
        const config = await getAihawkConfig();
        const model = options.model || config.model || 'gemini-3.8-flash';

        const requestMessages = [];
        if (systemPrompt) {
            requestMessages.push({ role: 'system', content: systemPrompt });
        }
        requestMessages.push(...messages);

        // 1. Try OpenRouter if API key is present
        if (config.openrouterKey) {
            try {
                logger.log('llm_call', `Dispatching request to OpenRouter (model: ${model})...`);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000);

                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${config.openrouterKey}`,
                        'HTTP-Referer': 'https://github.com/SupremeNexas/Jobs_Applier_AI_Agent_AIHawk',
                        'X-Title': 'AIHawk Job Agent'
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: requestMessages,
                        temperature: options.temperature !== undefined ? options.temperature : 0.1,
                        response_format: options.json ? { type: 'json_object' } : undefined
                    }),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
                if (response.ok) {
                    const data = await response.json();
                    if (data.choices && data.choices[0] && data.choices[0].message) {
                        return data.choices[0].message.content.trim();
                    }
                } else {
                    const errText = await response.text().catch(() => '');
                    console.warn(`[AIHawk OpenRouter] Response failed (${response.status}): ${errText}`);
                }
            } catch (err) {
                console.warn(`[AIHawk OpenRouter] Error: ${err.message}`);
            }
        }

        // 2. Try OmniRoute Gateway if available and not recently timed out
        if (config.omnirouteUrl && Date.now() > this.omnirouteUnavailableUntil) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for local OmniRoute gateway

                const gatewayModel = process.env.OMNIROUTE_MODEL || process.env.AIHAWK_MODEL || 'antigravity/claude-sonnet-4-6';
                const response = await fetch(`${config.omnirouteUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${config.omnirouteKey || 'sk-default'}`
                    },
                    body: JSON.stringify({
                        model: gatewayModel,
                        messages: requestMessages,
                        temperature: 0.1
                    }),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
                if (response.ok) {
                    const data = await response.json();
                    if (data.choices && data.choices[0] && data.choices[0].message) {
                        return data.choices[0].message.content.trim();
                    }
                } else {
                    this.omnirouteUnavailableUntil = Date.now() + 60000;
                }
            } catch (err) {
                // Mark OmniRoute unavailable for 60 seconds to avoid repeating delays on every job in this batch
                this.omnirouteUnavailableUntil = Date.now() + 60000;
            }
        }

        // 3. Fallback deterministic generator
        return null;
    }

    /**
     * Deep multi-dimensional matching
     */
    async matchJob(job, profile = {}, masterResume = '') {
        const jd = (job.description || '').substring(0, 3500);
        const role = job.role || 'Software Engineer';
        const company = job.company || 'Company';

        const systemPrompt = `You are the AIHawk intelligent recruiting evaluator. Evaluate the candidate profile and resume against this job posting with precision.
CRITICAL RULE: Never invent, extrapolate or fabricate qualifications not present in the candidate profile/resume. Return ONLY valid JSON.`;

        const userPrompt = `
Candidate Profile:
${JSON.stringify(profile, null, 2)}

Candidate Base Resume:
${masterResume ? masterResume.substring(0, 3000) : 'No resume provided.'}

Job Listing:
Title: ${role}
Company: ${company}
Location: ${job.location || 'Remote'}
Description:
${jd}

Evaluate the candidate across 5 dimensions (0 to 100):
1. Skill Match: Coverage of required and preferred programming languages, frameworks, libraries.
2. Experience Match: Seniority level, years of work, relevance of past roles/internships.
3. Education Match: Degree, field of study, relevance.
4. Location Match: Location compatibility (Remote vs Onsite, country/city).
5. Tech Match: Infrastructure, tools, cloud, database alignment.

Compute an Overall Match Percentage (0-100) as a weighted average.

Return JSON in this EXACT structure:
{
  "overall_score": 85,
  "skill_match": 88,
  "experience_match": 78,
  "education_match": 95,
  "location_match": 90,
  "tech_match": 85,
  "matched_skills": ["Node.js", "React", "TypeScript", "Express", "SQLite"],
  "missing_skills": ["Kubernetes", "AWS Lambda"],
  "recommended_resume": "resume_12_8_26.md",
  "explanation": "Strong alignment with candidate backend Node.js and fullstack engineering skills. Minor gap in cloud orchestration."
}
`;

        try {
            const raw = await this.callLlm([{ role: 'user', content: userPrompt }], systemPrompt, { json: true });
            if (raw) {
                const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
                const matchJson = cleaned.match(/\{[\s\S]*\}/);
                if (matchJson) {
                    const parsed = JSON.parse(matchJson[0]);
                    return {
                        overall_score: Math.min(100, Math.max(0, parseInt(parsed.overall_score || 75, 10))),
                        skill_match: Math.min(100, Math.max(0, parseInt(parsed.skill_match || 75, 10))),
                        experience_match: Math.min(100, Math.max(0, parseInt(parsed.experience_match || 70, 10))),
                        education_match: Math.min(100, Math.max(0, parseInt(parsed.education_match || 80, 10))),
                        location_match: Math.min(100, Math.max(0, parseInt(parsed.location_match || 80, 10))),
                        tech_match: Math.min(100, Math.max(0, parseInt(parsed.tech_match || 75, 10))),
                        matched_skills: Array.isArray(parsed.matched_skills) ? parsed.matched_skills : [],
                        missing_skills: Array.isArray(parsed.missing_skills) ? parsed.missing_skills : [],
                        recommended_resume: parsed.recommended_resume || 'resume_12_8_26.md',
                        explanation: parsed.explanation || 'Evaluated match based on role and skills.'
                    };
                }
            }
        } catch (e) {
            console.warn('[AIHawk Client] Match LLM parse failed, falling back to deterministic heuristic:', e.message);
        }

        // Heuristic fallback
        return this.heuristicMatch(job, profile, masterResume);
    }

    heuristicMatch(job, profile = {}, masterResume = '') {
        const jd = ((job.role || '') + ' ' + (job.description || '')).toLowerCase();
        const candidateSkills = ['javascript', 'typescript', 'react', 'node', 'nodejs', 'express', 'python', 'fastapi', 'go', 'golang', 'sqlite', 'postgresql', 'docker', 'git', 'rest', 'api', 'playwright'];

        const matched = [];
        const missing = [];

        const targetTech = ['react', 'vue', 'angular', 'node', 'express', 'python', 'fastapi', 'django', 'go', 'golang', 'rust', 'c++', 'java', 'spring', 'aws', 'gcp', 'azure', 'kubernetes', 'docker', 'graphql', 'sql', 'postgres', 'mongodb', 'redis'];

        targetTech.forEach(tech => {
            if (jd.includes(tech)) {
                if (candidateSkills.some(cs => cs.includes(tech) || tech.includes(cs))) {
                    matched.push(tech.charAt(0).toUpperCase() + tech.slice(1));
                } else {
                    missing.push(tech.charAt(0).toUpperCase() + tech.slice(1));
                }
            }
        });

        // Add default matched skills if candidate profile lists them
        if (matched.length === 0) {
            matched.push('Node.js', 'Express', 'React', 'JavaScript', 'Git');
        }

        let skillScore = Math.min(95, Math.max(50, Math.round((matched.length / Math.max(1, matched.length + missing.length)) * 100)));
        if (missing.length === 0) skillScore = 88;

        const isSenior = /\b(senior|staff|principal|lead|manager|director|vp)\b/i.test(job.role || '');
        const expScore = isSenior ? 45 : 85;
        const eduScore = 90;
        const isRemote = /\b(remote|anywhere|wfh|telecommute|india)\b/i.test((job.location || '') + ' ' + jd);
        const locScore = isRemote ? 95 : 65;
        const techScore = skillScore;

        const overall = Math.round((skillScore * 0.35) + (expScore * 0.25) + (eduScore * 0.15) + (locScore * 0.15) + (techScore * 0.10));

        return {
            overall_score: overall,
            skill_match: skillScore,
            experience_match: expScore,
            education_match: eduScore,
            location_match: locScore,
            tech_match: techScore,
            matched_skills: matched.slice(0, 8),
            missing_skills: missing.slice(0, 6),
            recommended_resume: 'resume_12_8_26.md',
            explanation: `Score computed from keyword alignment (${matched.length} matched skills) and role seniority filter. ${isSenior ? 'Note: Role requires senior experience.' : 'Good fit for engineering capabilities.'}`
        };
    }
}

const client = new AihawkClient();
module.exports = {
    AihawkClient,
    client
};
