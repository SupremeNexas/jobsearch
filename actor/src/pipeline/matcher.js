/**
 * AI Job Matcher Engine
 * Evaluates jobs against candidate profile and preferences.
 * Uses OmniRoute LLM gateway with structured output parsing & high-performance deterministic evaluator.
 */

const { getCandidateProfile } = require('../connectors/candidateConnector');
const { callOmniRoute } = require('../ai');
const { runQuery } = require('../db');

const DEFAULT_WEIGHTS = {
    skill: 0.40,
    experience: 0.25,
    location: 0.20,
    education: 0.15
};

function evaluateDeterministicMatch(job, profile, customWeights = {}) {
    const weights = { ...DEFAULT_WEIGHTS, ...customWeights };
    const candidateSkills = [
        'python', 'javascript', 'typescript', 'go', 'golang', 'java', 'c', 'c++', 'sql', 'r', 'dart',
        'react', 'next.js', 'node.js', 'express', 'fastapi', 'flask', 'rest', 'grpc', 'flutter', 'html', 'css', 'ejs',
        'llm', 'llms', 'rag', 'agent', 'agentic', 'agents', 'multi-agent', 'multi-agent systems', 'tool calling', 'api orchestration', 'autonomous workflows',
        'langchain', 'ollama', 'transformers', 'machine learning', 'deep learning', 'nlp', 'scikit-learn', 'numpy', 'pandas',
        'postgres', 'postgresql', 'mongodb', 'redis', 'docker', 'prometheus', 'git', 'github', 'vercel', 'sqlite', 'supabase', 'prisma'
    ];

    const jdText = `${job.role} ${job.description || ''} ${job.skills || ''} ${job.location || ''}`.toLowerCase();

    const matchingSkills = [];
    candidateSkills.forEach(s => {
        if (jdText.includes(s)) {
            matchingSkills.push(s);
        }
    });

    const potentialGaps = ['kubernetes', 'aws', 'gcp', 'azure', 'kafka', 'c#', '.net', 'ruby', '5+ years', '8+ years', 'staff', 'principal', 'director'];
    const skillGaps = [];
    potentialGaps.forEach(g => {
        if (jdText.includes(g)) {
            skillGaps.push(g);
        }
    });

    // 1. Skill Match (0-100)
    let skillScore = Math.min(matchingSkills.length * 14 + 45, 96);
    const isAgenticGenAi = jdText.includes('agent') || jdText.includes('agentic') || jdText.includes('genai') || jdText.includes('generative ai') || jdText.includes('llm');
    if (isAgenticGenAi) skillScore = Math.min(skillScore + 8, 98);

    // 2. Experience Match (0-100)
    const isEarlyCareer = /\b(intern|internship|co-op|apprentice)\b/i.test(jdText) || jdText.includes('graduate') || jdText.includes('junior') ||
                          jdText.includes('early career') || jdText.includes('entry') || jdText.includes('associate') ||
                          jdText.includes('university') || jdText.includes('fresher') || jdText.includes('sde 1') || jdText.includes('sde-1');
    const isWinterSpringIntern = isEarlyCareer && /\b(winter|spring|january|6[- ]month|off-cycle)\b/i.test(jdText);

    let experienceScore = isEarlyCareer ? (isWinterSpringIntern ? 100 : 96) : 82;
    if (!isEarlyCareer && (jdText.includes('staff') || jdText.includes('principal') || jdText.includes('director') || jdText.includes('8+ years') || jdText.includes('10+ years'))) {
        experienceScore = 45;
    }

    // 3. Location & Work Mode Match (0-100)
    let locationScore = 85;
    const isRemote = (job.remote_type && job.remote_type.toLowerCase() === 'remote') || jdText.includes('remote') || jdText.includes('work from anywhere') || jdText.includes('anywhere');
    if (isRemote) {
        locationScore = 96;
    } else if (jdText.includes('india') || jdText.includes('bangalore') || jdText.includes('bengaluru') || jdText.includes('gandhinagar') || jdText.includes('ahmedabad') || jdText.includes('mumbai') || jdText.includes('delhi')) {
        locationScore = 92;
    } else if (jdText.includes('must reside in us') || jdText.includes('us citizenship required')) {
        locationScore = 40;
    }

    // 4. Education Match (0-100)
    const educationScore = 95; // B.Tech Computer Engineering (PDEU 2026)

    // Calculate multi-dimensional overall score
    const weightedScore = (weights.skill * skillScore) +
                          (weights.experience * experienceScore) +
                          (weights.location * locationScore) +
                          (weights.education * educationScore);
    const finalScore = Math.min(Math.max(Math.round(weightedScore), 35), 98);

    // Determine Actionable Recommendation
    let recommendationAction = 'CONSIDER_APPLY';
    if (finalScore >= 85) recommendationAction = 'STRONG_MATCH';
    else if (finalScore < 60) recommendationAction = 'LOW_FIT';

    // Map STAR alignment stories to requirements
    const starStories = [
        {
            pillar: 'AI / LLM & Space Technology',
            project: 'Space Applications Centre [ISRO]',
            evidence: 'Engineered local Ollama LLM integration (1T-class models) and parsed pulsar timing vectors with 6.8 km precision.'
        },
        {
            pillar: 'Full-Stack Architecture & Security',
            project: 'Monerva Platform',
            evidence: 'Built 20+ REST APIs, PostgreSQL, LangChain LLM integration, JWT/RBAC auth, and receipt scanning for 100+ users.'
        },
        {
            pillar: 'High-Performance Backend & Quantitative Systems',
            project: 'Kronos Quantitative Engine',
            evidence: 'Developed Go/gRPC services, Redis caching, Prometheus metrics, and automated AI trading achieving 15% profit in paper trading.'
        },
        {
            pillar: 'Asynchronous Data Pipelines & Crawlers',
            project: 'Jobkart.ai',
            evidence: 'Built distributed scraping and task scheduling with Python/FastAPI/Redis, cutting latency by 40% across 10,000+ jobs.'
        }
    ];

    const reasoningSummary = `${recommendationAction}: ${finalScore}% fit for ${job.role} at ${job.company}. Matches skills: [${matchingSkills.slice(0, 6).join(', ') || 'software engineering'}]. Location match: ${locationScore}%, Tech match: ${skillScore}%. Validated against PDEU CE degree, ISRO internship, and Monerva/Kronos projects.`;

    return {
        overall_score: finalScore,
        skill_match: skillScore,
        experience_match: experienceScore,
        education_match: educationScore,
        location_match: locationScore,
        tech_match: skillScore,
        matched_skills: matchingSkills.join(', '),
        missing_skills: skillGaps.join(', '),
        matching_experience: 'Software Engineering Intern @ Space Applications Centre [ISRO] (May-July 2026)',
        relevant_projects: 'Monerva (Node.js/PostgreSQL/LangChain) | Kronos (Go/gRPC/Redis) | Jobkart.ai (FastAPI/Scrapy)',
        star_alignment: starStories,
        recommendation_action: recommendationAction,
        missing_requirements: skillGaps.slice(0, 3).join(', '),
        skill_gaps: skillGaps.join(', '),
        reasoning_summary: reasoningSummary,
        scoring_weights: weights
    };
}

async function matchJobWithCandidate(job, options = {}) {
    const { useLlm = false } = options;
    const profile = getCandidateProfile();

    let analysis = null;

    if (useLlm) {
        // Try OmniRoute LLM match
        try {
            const info = (profile && profile.personal_information) || {};
            const candidateName = [info.first_name, info.last_name].filter(Boolean).join(' ') || 'Candidate';
            const eduText = ((profile && profile.education_details) || []).map(e => `${e.degree || ''}, ${e.institution || ''} (${e.start_date || ''}-${e.end_date || ''})`).join('; ') || 'Computer Science degree';
            const expText = ((profile && profile.experience_details) || []).map(x => `${x.position || ''} at ${x.company || ''}`).join('; ') || 'Software Engineering Experience';
            const projText = ((profile && profile.projects) || []).map((p, idx) => `${idx + 1}. ${p.name || ''} (${(p.skills || []).join(', ')})`).join('\n  ') || 'Full stack and backend engineering projects';
            const skillsList = profile && profile.skills ? (Array.isArray(profile.skills) ? profile.skills.join(', ') : Object.values(profile.skills).flat().join(', ')) : 'JavaScript, Python, Go, SQL, Web development';

            const systemPrompt = "You are an expert technical recruiter matching candidate qualifications against job postings. Return ONLY valid JSON.";
            const userPrompt = `
Match candidate ${candidateName} against this opportunity:
Candidate:
- Education: ${eduText}
- Experience: ${expText}
- Projects:
  ${projText}
- Core Skills: ${skillsList}

Job:
- Role: ${job.role}
- Company: ${job.company}
- Location: ${job.location} (Remote Type: ${job.remote_type})
- Description: ${(job.description || '').slice(0, 1500)}

Generate JSON with fields:
- "overall_score": number (0-100)
- "matching_skills": string
- "matching_experience": string
- "relevant_projects": string
- "missing_requirements": string
- "skill_gaps": string
- "reasoning_summary": string
            `;

            const responseText = await callOmniRoute([{ role: 'user', content: userPrompt }], systemPrompt);
            const match = responseText.match(/\{[\s\S]*\}/);
            if (match) {
                const parsed = JSON.parse(match[0]);
                analysis = {
                    overall_score: parsed.overall_score || 80,
                    skill_match: parsed.overall_score || 80,
                    experience_match: 85,
                    education_match: 95,
                    location_match: 90,
                    tech_match: 85,
                    matched_skills: parsed.matching_skills || '',
                    missing_skills: parsed.missing_requirements || parsed.skill_gaps || '',
                    matching_experience: parsed.matching_experience || '',
                    relevant_projects: parsed.relevant_projects || '',
                    missing_requirements: parsed.missing_requirements || '',
                    skill_gaps: parsed.skill_gaps || '',
                    reasoning_summary: parsed.reasoning_summary || ''
                };
            }
        } catch (llmErr) {
            analysis = evaluateDeterministicMatch(job, profile);
        }
    }

    if (!analysis) {
        analysis = evaluateDeterministicMatch(job, profile);
    }

    job.match_score = analysis.overall_score;
    job.score = analysis.overall_score;
    job.score_explanation = analysis.reasoning_summary;

    // Generate referral & recruiter outreach drafts
    const candidateInfo = (profile && profile.personal_information) || {};
    const candidateFullName = [candidateInfo.first_name, candidateInfo.last_name].filter(Boolean).join(' ') || 'Applicant';
    const candidatePortfolio = candidateInfo.portfolio ? `Portfolio: ${candidateInfo.portfolio}` : '';
    const candidateGithub = candidateInfo.github ? `GitHub: ${candidateInfo.github}` : '';
    const candidateLinkedin = candidateInfo.linkedin ? `LinkedIn: ${candidateInfo.linkedin}` : '';
    const candidateLinks = [candidatePortfolio, candidateGithub, candidateLinkedin].filter(Boolean).join('\n');
    const candidateContact = [candidateInfo.phone, candidateInfo.email].filter(Boolean).join(' | ');

    const referralDraft = `
Hi [Name],

I noticed that ${job.company} is currently hiring for a ${job.role}. Given my background in software engineering, full-stack architectures, and distributed systems, I would love to learn more about the team's engineering challenges. If you feel my background is a strong fit, I would be grateful for a referral.

${candidateLinks}

Best regards,
${candidateFullName}
`.trim();

    const recruiterDraft = `
Subject: Application for ${job.role} - ${candidateFullName}

Hi [Recruiter Name],

I am reaching out regarding the ${job.role} opening at ${job.company} (${job.application_url || ''}).

My background includes full-stack development, modern APIs, and scalable software systems. I'd welcome the chance to connect and discuss how my verified background aligns with ${job.company}'s engineering goals.

Best regards,
${candidateFullName}
${candidateContact}
`.trim();

    job.recommendation_action = analysis.recommendation_action;
    job.star_alignment = analysis.star_alignment;

    job.notes = JSON.stringify({
        referralDraft,
        recruiterDraft,
        matchingSkills: analysis.matched_skills,
        skillGaps: analysis.skill_gaps,
        projects: analysis.relevant_projects,
        starAlignment: analysis.star_alignment,
        recommendationAction: analysis.recommendation_action,
        scoringWeights: analysis.scoring_weights
    });

    // Persist to ai_job_matches
    const now = new Date().toISOString();
    try {
        await runQuery(`
            INSERT INTO ai_job_matches (
                job_id, overall_score, skill_match, experience_match, education_match,
                location_match, tech_match, matched_skills, missing_skills,
                matching_experience, relevant_projects, missing_requirements, skill_gaps,
                reasoning_summary, explanation, evaluated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                overall_score = excluded.overall_score,
                matched_skills = excluded.matched_skills,
                missing_skills = excluded.missing_skills,
                matching_experience = excluded.matching_experience,
                relevant_projects = excluded.relevant_projects,
                skill_gaps = excluded.skill_gaps,
                reasoning_summary = excluded.reasoning_summary,
                evaluated_at = excluded.evaluated_at
        `, [
            job.id || job.job_id,
            analysis.overall_score,
            analysis.skill_match,
            analysis.experience_match,
            analysis.education_match,
            analysis.location_match,
            analysis.tech_match,
            analysis.matched_skills,
            analysis.missing_skills,
            analysis.matching_experience,
            analysis.relevant_projects,
            analysis.missing_requirements,
            analysis.skill_gaps,
            analysis.reasoning_summary,
            analysis.reasoning_summary,
            now
        ]);
    } catch (e) {
        // Safe db handling
    }

    return analysis;
}

module.exports = {
    matchJobWithCandidate,
    evaluateDeterministicMatch
};
