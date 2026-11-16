const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const profilePath = path.join(__dirname, 'profile.json');
const { getQuery } = require('./db');

async function getMasterResume() {
    try {
        const activeSetting = await getQuery("SELECT value FROM settings WHERE key = 'ACTIVE_BASE_RESUME'");
        const activeResume = (activeSetting && activeSetting.value) || 'resume_12_8_26.md';
        const resumePath = path.join(__dirname, '../../resumes', activeResume);
        if (!fs.existsSync(resumePath)) {
            // Fallback to default
            const defaultPath = path.join(__dirname, '../../resumes/resume_12_8_26.md');
            if (!fs.existsSync(defaultPath)) {
                throw new Error(`Master resume not found at: ${resumePath} or fallback ${defaultPath}`);
            }
            return fs.readFileSync(defaultPath, 'utf8');
        }
        return fs.readFileSync(resumePath, 'utf8');
    } catch (err) {
        // Fallback in case DB is not yet initialized or query fails
        const defaultPath = path.join(__dirname, '../../resumes/resume_12_8_26.md');
        if (fs.existsSync(defaultPath)) {
            return fs.readFileSync(defaultPath, 'utf8');
        }
        throw err;
    }
}

function getStructuredProfile() {
    if (!fs.existsSync(profilePath)) {
        return {};
    }
    return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
}

/**
 * Universal caller to OmniRoute OpenAI-compatible endpoint.
 */
async function callOmniRoute(messages, systemPrompt = '') {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (openrouterKey) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            const model = process.env.AIHAWK_MODEL || 'gemini-3.8-flash';
            const requestMessages = [];
            if (systemPrompt) requestMessages.push({ role: 'system', content: systemPrompt });
            requestMessages.push(...messages);

            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openrouterKey}`,
                    'HTTP-Referer': 'https://github.com/SupremeNexas/jobsearch',
                    'X-Title': 'JobSearch Agent'
                },
                body: JSON.stringify({
                    model: model,
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
            }
        } catch (err) {
            console.warn('[AI OpenRouter] Fallback to OmniRoute:', err.message);
        }
    }

    const url = process.env.OMNIROUTE_URL || 'http://localhost:20128/v1';
    const apiKey = process.env.OMNIROUTE_API_KEY || 'sk-2cdc8d524108d19a-0abc42-d8f4f651';

    const requestMessages = [];
    if (systemPrompt) {
        requestMessages.push({ role: 'system', content: systemPrompt });
    }
    requestMessages.push(...messages);

    console.log(`[OmniRoute] Dispatching chat completion request to gateway: ${url}...`);

    const targetModel = process.env.OMNIROUTE_MODEL || 'gemini-3.8-flash';
    const fallbackModel = 'google/gemini-2.5-flash';
    const timeoutMs = parseInt(process.env.OMNIROUTE_TIMEOUT_MS, 10) || 25000;

    async function attemptRequest(modelToUse) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${url}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model: modelToUse,
                    messages: requestMessages,
                    temperature: 0.1
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(`OmniRoute gateway request failed with status ${response.status}: ${errorText}`);
            }

            const resultData = await response.json();
            if (!resultData.choices || resultData.choices.length === 0) {
                throw new Error('Malformed completions response payload from OmniRoute.');
            }

            const content = resultData.choices[0].message.content;
            return content ? content.trim() : '';
        } catch (err) {
            clearTimeout(timeoutId);
            throw err;
        }
    }

    try {
        return await attemptRequest(targetModel);
    } catch (primaryErr) {
        if (targetModel !== fallbackModel) {
            console.warn(`[OmniRoute] Primary model "${targetModel}" failed (${primaryErr.message}). Retrying with fallback model "${fallbackModel}"...`);
            try {
                return await attemptRequest(fallbackModel);
            } catch (fallbackErr) {
                throw new Error(`OmniRoute failed for both ${targetModel} and ${fallbackModel}: ${fallbackErr.message}`);
            }
        }
        throw primaryErr;
    }
}

/**
 * Scans and scores a job description against the candidate.
 * Returns { score, explanation, is_match }
 */
async function scoreJob(jobTitle, company, jdText, settingsObj = {}) {
    const resume = await getMasterResume();
    const systemPrompt = "You are an expert AI Job Recruiter. Your task is to evaluate and score the suitability of a job listing for the candidate. Return ONLY raw JSON matching instructions.";

    const userPrompt = `
Evaluate and score the candidate against this job opening.

Candidate Resume:
---
${resume}
---

Job Title: ${jobTitle}
Company: ${company}
Job Description:
---
${jdText}
---

Candidate Preferences:
- Preferred Roles: ${settingsObj.PREFERRED_ROLES || 'Software Engineer, Developer'}
- Excluded Roles (strictly reject or low score): ${settingsObj.EXCLUDED_ROLES || 'Senior, Staff, Principal, Manager, Director'}
- Preferred Locations: ${settingsObj.PREFERRED_LOCATIONS || 'Remote, India, Gandhinagar'}
- Excluded Locations: ${settingsObj.EXCLUDED_LOCATIONS || 'Europe, UK'}

CRITICAL GUIDELINES:
1. Candidate is a B.Tech Computer Engineering student at PDEU actively seeking Winter / 6-Month Internships (January to June time period) as well as entry-level Software Engineer roles.
2. Give TOP PRIORITY (score 90-98) to Winter Intern, 6-Month Intern, Software Engineer Intern, Backend Intern, Machine Learning / AI Intern, and SDE Intern roles in India or Remote.
3. Do not rank jobs requiring 3+ years of professional post-grad experience highly (max score of 50).
4. Rank roles matching Go, Node.js, Express, Python, FastAPI, React, AI/ML highly.
5. Be realistic. Check for work authorization constraints (candidate is based in India, requires visa sponsorship for US/Europe roles unless remote).

Generate a JSON object containing:
- "score": Integer between 0 and 100 representing suitability.
- "classification": One of ["Excellent" (90-100), "Strong" (75-89), "Possible" (60-74), "Reject" (Below 60)].
- "explanation": Short, 2-3 sentence summary of why this score was given, referencing matching/missing skills and requirements.
- "missing_requirements": Array of strings list of missing key requirements candidate does not possess.

Return ONLY raw JSON. No conversational text around it, no markdown wrappers.
`;

    try {
        const text = await callOmniRoute([{ role: 'user', content: userPrompt }], systemPrompt);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        throw new Error('No JSON payload extracted from OmniRoute content');
    } catch(err) {
        console.error('Error during AI scoring via OmniRoute, using fallback:', err.message);
        return generateMockScore(jobTitle, jdText);
    }
}

function getVisibleText(itemContent) {
    let text = itemContent;
    // Remove \raisebox{...}{...}
    text = text.replace(/\\raisebox\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, '$1');
    text = text.replace(/\\raisebox\s*\{[^{}]*\}\s*\{\\[a-zA-Z]+\{[^{}]*\}\}/g, '');

    // Remove \faIcon{...}
    text = text.replace(/\\faIcon\s*\{[^{}]*\}/g, '');

    // Remove \href{url}{text} -> text
    text = text.replace(/\\href\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, '$1');

    // Unwrap standard formatting commands: \textbf, \textit, \underline, \emph
    let prev;
    do {
        prev = text;
        text = text.replace(/\\(?:textbf|textit|underline|emph)\s*\{([^{}]*)\}/g, '$1');
    } while (text !== prev);

    // Clean up escaped characters (e.g. \%, \&, \$, \_, etc. -> %, &, $, _, etc.)
    text = text.replace(/\\([#&%$_{}~^])/g, '$1');

    // Double backslashes (\\) -> space
    text = text.replace(/\\\\/g, ' ');

    // Trim extra spaces
    return text.replace(/\s+/g, ' ').trim();
}

function getBullets(latex) {
    const bullets = [];
    const bodyStart = latex.indexOf('\\begin{document}');
    let idx = bodyStart !== -1 ? bodyStart : 0;
    const command = '\\resumeItem{';

    while (true) {
        const startIdx = latex.indexOf(command, idx);
        if (startIdx === -1) break;

        const contentStart = startIdx + command.length;
        let braceCount = 1;
        let p = contentStart;
        while (braceCount > 0 && p < latex.length) {
            if (latex[p] === '{' && latex[p - 1] !== '\\') {
                braceCount++;
            } else if (latex[p] === '}' && latex[p - 1] !== '\\') {
                braceCount--;
            }
            p++;
        }

        const itemContent = latex.substring(contentStart, p - 1);
        const visibleText = getVisibleText(itemContent);

        bullets.push({
            start: startIdx,
            end: p,
            raw: itemContent,
            visible: visibleText,
            length: visibleText.length
        });

        idx = p;
    }
    return bullets;
}

function replaceBullets(latex, bullets, rewrites) {
    let newLatex = '';
    let lastIdx = 0;
    for (let i = 0; i < bullets.length; i++) {
        const b = bullets[i];
        newLatex += latex.substring(lastIdx, b.start);
        if (rewrites[i] !== undefined && rewrites[i] !== null) {
            newLatex += `\\resumeItem{${rewrites[i]}}`;
        } else {
            newLatex += `\\resumeItem{${b.raw}}`;
        }
        lastIdx = b.end;
    }
    newLatex += latex.substring(lastIdx);
    return newLatex;
}

async function refineLaTeXBullets(jobTitle, company, jdText, latex) {
    let currentLatex = latex;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        const bullets = getBullets(currentLatex);
        const outOfBounds = [];

        for (let i = 0; i < bullets.length; i++) {
            const b = bullets[i];
            if (b.length < 85 || b.length > 98) {
                outOfBounds.push({ index: i, bullet: b });
            }
        }

        if (outOfBounds.length === 0) {
            console.log(`[Tailoring Debug] All ${bullets.length} bullets are within the 85-98 character count range.`);
            break;
        }

        console.log(`[Tailoring Debug] Found ${outOfBounds.length} out-of-bounds bullets. Refining... (Attempt ${attempts + 1}/${maxAttempts})`);

        const bulletsToRewrite = outOfBounds.map(ob => {
            const isCert = ob.bullet.raw.toLowerCase().includes('certification') ||
                           ob.bullet.raw.includes('OmniRoute:') ||
                           ob.bullet.raw.includes('CSSI:');
            const isExtracurricular = ob.bullet.raw.includes('outreach') ||
                                     ob.bullet.raw.includes('student engagement');
            let type = 'experience-or-project';
            if (isCert) type = 'certification-achievement';
            else if (isExtracurricular) type = 'extracurricular';

            return {
                index: ob.index,
                type: type,
                currentRaw: ob.bullet.raw,
                currentVisibleText: ob.bullet.visible,
                currentVisibleLength: ob.bullet.length
            };
        });

        const systemPrompt = "You are a precise resume professional. Your task is to adjust LaTeX resume bullets to fit an exact visible character count constraint. Return ONLY raw JSON.";

        const userPrompt = `
Job Context: ${jobTitle} at ${company}
Job Description Excerpt:
${jdText.substring(0, 1000)}

Constraint:
Every bullet must have a visible character length between 85 and 98 (inclusive).
We define visible character length as the length of the string after stripping LaTeX markup (e.g. \\textbf{...}, \\href{...}{...}, escaped characters like \\% or \\$, etc.).

Here are the bullets that need adjustment:
${JSON.stringify(bulletsToRewrite, null, 2)}

DIRECTIONS:
1. For 'experience-or-project' bullets: Ensure the rewritten bullet follows the Google XYZ formula: "Accomplished [X] as measured by [Y], by doing [Z]". It must start with an action verb, have a metric, and a technical implementation.
2. For 'certification-achievement' or 'extracurricular' bullets: Keep them as factual descriptions of the achievement/activity without forcing the Google XYZ formula if it doesn't make sense, but make sure the text length is strictly 85 to 98 characters.
3. Every rewritten bullet MUST have a visible character length (excluding all LaTeX formatting tags/escape characters) strictly between 85 and 98 characters. Verify this character count yourself for each rewrite you produce.
4. Keep the exact factual metrics, names, and tools. Do not fabricate anything. Keep the LaTeX formatting commands (e.g. \\textbf{...}, \\href{...}{...}) correct. Every opened brace must be closed.
5. Return ONLY a valid JSON object mapping the string representation of the index to the rewritten raw LaTeX string. Do NOT wrap in markdown code blocks (\`\`\`json).

Example Return Format:
{
  "0": "Accomplished \\textbf{X} as measured by \\textbf{Y}\\% by doing \\textbf{Z}.",
  "1": "Earned \\textbf{15+} professional certifications in agentic AI platforms, demonstrating advanced mastery."
}
`;

        try {
            const rawResponse = await callOmniRoute([{ role: 'user', content: userPrompt }], systemPrompt);
            let cleanedResponse = rawResponse.trim();
            if (cleanedResponse.startsWith('```')) {
                cleanedResponse = cleanedResponse.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
            }

            const rewrites = JSON.parse(cleanedResponse);
            console.log(`[Tailoring Debug] Received rewrites for indexes: ${Object.keys(rewrites).join(', ')}`);

            currentLatex = replaceBullets(currentLatex, bullets, rewrites);
            attempts++;
        } catch (err) {
            console.error(`[Tailoring Debug] Failed to refine bullets via AI:`, err.message);
            break;
        }
    }

    return currentLatex;
}

/**
 * Tailor resume to fit a target job description.
 * Returns tailored Markdown or LaTeX text.
 */
async function tailorResumeText(jobTitle, company, jdText) {
    const resume = await getMasterResume();
    const isLatex = resume.includes('\\documentclass') || resume.includes('\\begin{document}');

    let gapGuideline = '';
    try {
        const { extractJdSkills, classifySkillGaps } = require('./ats');
        const jdSkills = extractJdSkills(jdText);
        const classification = classifySkillGaps(jdSkills, resume);
        const gaps = classification.gap;
        if (gaps && gaps.length > 0) {
            gapGuideline = `8. ATS GAP ALIGNMENT: The skill-gap checker identified the following keywords from the job description that are missing from your resume's skills section/descriptions: ${gaps.join(', ')}. Without fabricating any credentials or experience details, please ensure that you explicitly mention or weave these exact keywords/technologies (e.g. adding them into the "Skills" list or contextually in experience/projects if true, such as adding UI under frontend/technical technologies or CS in relation to computer engineering degree or core CS concepts) to bridge the gap and achieve a score of 100 on the final compiled PDF. Keep all character limits and other guidelines intact.`;
        }
    } catch (e) {
        console.warn("Failed to dynamically compute skill gaps inside tailorResumeText:", e.message);
    }

    let systemPrompt = "You are an expert Resume Writer and ATS Optimizer. Your mission is to adapt candidate's Markdown resume to align with target role without fabricating anything. Return ONLY modified Markdown.";
    let userPrompt = `
Target Job: ${jobTitle} at ${company}
Job Description:
---
${jdText}
---

Candidate Master Resume:
---
${resume}
---

STRICT ATS TAILORING DIRECTIONS:
1. TRUTH-PRESERVING: Absolutely do NOT fabricate or embellish any accomplishments, projects, internships, metrics, dates, schools, degrees, or tools. You can only reword or restructure items.
2. ALIGN KEYWORDS & BOLDING: Reorder, emphasize, and bolden important key metrics and technology aspects using double asterisks (e.g., **PulsarNav.ai** or **20+**).
3. GOOGLE XYZ BULLET FORMULA: Every single experience and project bullet point MUST strictly follow the Google XYZ formula: "Accomplished [X] as measured by [Y], by doing [Z]". Each bullet description must begin with a strong action verb, state a measurable metric/result, and explain the technical implementation method.
4. DETAILED ONE-LINE CONSTRAINT & SPACE UTILIZATION: Each tailored bullet point MUST occupy exactly 1 line on the page (no wrapping to a second line) and utilize the horizontal width of the line fully to avoid wasting space. To do this, every single bullet point MUST have a length of between 85 and 98 characters (including spaces and formatting double asterisks). If a bullet point description is under 85 characters, you MUST expand it by adding relevant technical details or context. If it exceeds 98 characters, you MUST shorten it to avoid wrapping.
5. KEEP basic contact details, name, and schools untouched.
6. NO STYLING CHANGES: Do NOT change any markdown layout, headers, dividers/separators, list symbols, or any styling elements. Keep the layout, sections, spacing, and styling exactly the same as the original. You may change:
   a) the descriptions/bullet points of the experiences/projects to match the job description.
   b) the technical skills item lists under the Technical Skills section (e.g. Languages, Frontend, Backend, AI/ML, Databases, Tools) to incorporate relevant matching skills/technologies from the job description.
7. ONE-PAGE CONSTRAINT & FULL PAGE COVERAGE: The resume must fit on EXACTLY one page, just like the master resume does, utilizing the entirety of the page down to the footer (not less, not more). Do NOT delete or omit any bullet points or accomplishments from the master resume (keep all 9 bullet points for the ISRO internship, all 4 for Expense Tracker, all 3 for Kronos, all 3 for Job Search Portal, and all 3 for Certifications & Achievements). Keeping all 19 bullets with strict character length limits ensures the resume fills the entire page exactly down to the footer without leaving empty spaces.
${gapGuideline ? gapGuideline + '\n' : ''}
Return ONLY the tailored markdown content. Do not write any explanations or preambles.
`;

    if (isLatex) {
        systemPrompt = "You are an expert Resume Writer and ATS Optimizer. Your mission is to adapt the candidate's LaTeX resume to align with target role without fabricating anything. Return ONLY the modified LaTeX code.";
        userPrompt = `
Target Job: ${jobTitle} at ${company}
Job Description:
---
${jdText}
---

Candidate Master LaTeX Resume:
---
${resume}
---

STRICT ATS TAILORING DIRECTIONS:
1. TRUTH-PRESERVING: Absolutely do NOT fabricate or embellish any accomplishments, projects, internships, metrics, dates, schools, degrees, or tools. You can only reword or restructure items.
2. ALIGN KEYWORDS & BOLDING: Reorder, emphasize, and bolden important key metrics and technology aspects using \\textbf (e.g., \\textbf{PulsarNav.ai} or \\textbf{20+}). Keep other LaTeX formatting commands (like \\textit, \\underline) intact.
3. GOOGLE XYZ BULLET FORMULA: Every single experience and project bullet point MUST strictly follow the Google XYZ formula: "Accomplished [X] as measured by [Y], by doing [Z]". Each bullet description inside \\resumeItem{...} must begin with a strong action verb, state a measurable metric/result, and explain the technical implementation method.
4. DETAILED ONE-LINE CONSTRAINT & SPACE UTILIZATION: Each tailored bullet point description inside \\resumeItem{...} MUST occupy exactly 1 line in the compiled PDF (no wrapping to a second line) and utilize the horizontal width of the line fully to avoid wasting space. To do this, every single bullet point MUST have a visible character length (excluding LaTeX tags/commands like \\textbf{...}, \\href{...}{...}, etc.) of between 85 and 98 characters. If the visible length of a bullet is under 85 characters, you MUST expand it with relevant technical details or metrics. If it exceeds 98 characters, you MUST shorten it. The total raw LaTeX string length including LaTeX commands should therefore naturally be between 95 and 120 characters.
5. KEEP basic contact details, name, and schools untouched.
6. NO STYLING/LATEX/MARKUP CHANGES: Do NOT change any LaTeX packages, custom commands (\\resumeItem, \\resumeSubheading, etc.), margins, line spacing, font sizes, layouts, headers, dividers/separators, or any styling elements. Keep the layout, sections, spacing, and styling exactly the same as original LaTeX document. You may change:
   a) the descriptions/bullet points of experiences/projects to match the job description.
   b) the lists under the Technical Skills section (e.g. Languages, Frontend, Backend, AI/ML, Databases, Tools) to incorporate relevant matching skills/technologies from the job description.
   Never delete or modify structural layout commands. Every open brace '{' must be closed properly.
7. ONE-PAGE CONSTRAINT & FULL PAGE COVERAGE: The resume must fit on EXACTLY one page, just like the master resume does, utilizing the entirety of the page down to the footer (not less, not more). Do NOT delete or omit any bullet points or accomplishments from the master resume (keep all 9 bullet points for the ISRO internship, all 4 for Expense Tracker, all 3 for Kronos, all 3 for Job Search Portal, and all 3 for Certifications & Achievements). Keeping all 19 bullets with strict character length limits ensures the resume fills the entire page exactly down to the footer without leaving empty spaces.
8. Return ONLY the complete, valid, compilable LaTeX document. Do NOT wrap it in markdown code fence blocks (\`\`\`latex ... \`\`\`). Return ONLY the raw LaTeX starting with % or \\documentclass and ending with \\end{document}.
${gapGuideline ? gapGuideline + '\n' : ''}
`;
    }

    try {
        let text = await callOmniRoute([{ role: 'user', content: userPrompt }], systemPrompt);
        if (text.startsWith('```')) {
            text = text.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
        }
        let tailoredText = text.trim();

        // --- ATS OPTIMIZATION REFINEMENT LOOP ---
        try {
            const { extractJdSkills, classifySkillGaps, calculateAtsScore, prepareResumeSkillsAndProse } = require('./ats');
            const jdSkills = extractJdSkills(jdText);

            let preprocessed = prepareResumeSkillsAndProse(tailoredText);
            let classification = classifySkillGaps(jdSkills, preprocessed);
            let atsScore = calculateAtsScore(classification);
            console.log(`[ATS Loop] Initial tailored resume ATS Score: ${atsScore}%`);

            let attempts = 0;
            const maxAttempts = 2; // Up to 2 refinement attempts

            while (atsScore < 95 && attempts < maxAttempts && classification.gap.length > 0) {
                attempts++;
                console.log(`[ATS Loop] Current ATS Score is ${atsScore}%. Target: >=95%. Gap terms: ${classification.gap.join(', ')}. Refining (Attempt ${attempts}/${maxAttempts})...`);

                const refinementPrompt = `
You tailored this resume previously, but it achieved an ATS score of only ${atsScore}% against the job description.
The following keyword skills from the job description are STILL missing from either the Technical Skills lists or the experience/project descriptions:
${classification.gap.join(', ')}

Please refine your previous tailored draft by explicitly weaving these exact missing keywords/technologies (matching the terms exactly, e.g. case-sensitively or as they appear in the list) into:
1. The appropriate bulleted rows inside the "Technical Skills" section (e.g., Languages, Frontend, Backend, AI/ML, Databases, Tools). This is highly preferred and easiest!
2. Or contextually in the experience/project descriptions if they are related to the candidate's achievements, making sure that each updated experience/project bullet point strictly keeps its length between 85 and 98 characters and uses the Google XYZ formula.

Do NOT violate any of the other constraints (truth-preserving, one-page layout, keep structural LaTeX/Markdown intact).

Current Draft:
---
${tailoredText}
---

Return ONLY the complete, updated LaTeX (or Markdown) source code without any explanations or markdown code blocks wrapper.
`;

                const refinedTextRaw = await callOmniRoute([{ role: 'user', content: refinementPrompt }], systemPrompt);
                let refinedText = (refinedTextRaw || '').trim();
                if (refinedText && refinedText.startsWith('```')) {
                    refinedText = refinedText.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
                }

                const newPreprocessed = prepareResumeSkillsAndProse(refinedText);
                const newClassification = classifySkillGaps(jdSkills, newPreprocessed);
                const newAtsScore = calculateAtsScore(newClassification);
                console.log(`[ATS Loop] Refinement attempt ${attempts} outcome: ATS Score: ${newAtsScore}% (Previous: ${atsScore}%)`);

                if (newAtsScore > atsScore) {
                    tailoredText = refinedText;
                    atsScore = newAtsScore;
                    classification = newClassification;
                } else {
                    console.log(`[ATS Loop] Score did not improve. Keeping previous draft.`);
                }
            }
            console.log(`[ATS Loop] Final optimized resume ATS Score achieved: ${atsScore}%`);
        } catch (atsErr) {
            console.error('[ATS Loop] Error during ATS loop optimization:', atsErr.message);
        }
        // ----------------------------------------

        if (isLatex) {
            tailoredText = await refineLaTeXBullets(jobTitle, company, jdText, tailoredText);
        }
        return tailoredText;
    } catch(err) {
        console.error('Error during AI tailoring via OmniRoute, using fallback:', err.message);
        return resume;
    }
}

/**
 * Write a personalized, short cover letter for the job.
 * Returns cover letter string.
 */
async function generateCoverLetter(jobTitle, company, jdText) {
    const resume = await getMasterResume();
    const systemPrompt = "You are a professional hiring writer. Draft a concise 200-word cover letter matching candidate context truth-preservingly.";

    const userPrompt = `
Generate a short, impact-oriented cover letter for the applicant.

Candidate Resume Details:
---
${resume}
---

Job Target: ${jobTitle} at ${company}
Job Description:
---
${jdText}
---

CRITICAL DETAILS:
- Make it professional, confident, and short (max 200-250 words, 3 short paragraphs).
- Incorporate matching details from the candidate's actual background and projects from the resume.
- Make the tone natural and authentic. Avoid generic AI filler words.
- Do NOT fabricate any facts.

Return ONLY the final cover letter text.
`;

    try {
        return await callOmniRoute([{ role: 'user', content: userPrompt }], systemPrompt);
    } catch(err) {
        console.error('Error generating cover letter via OmniRoute, using fallback:', err.message);
        return `Dear Hiring Team,\n\nI am writing to express my strong interest in the ${jobTitle} position at ${company}. Having strong experience in software engineering and modern backend architectures, I look forward to contributing to your software team.\n\nBest regards,\nCandidate`;
    }
}

/**
 * Deterministic profile answers for standard ATS questions.
 */
function getDeterministicAnswer(questionText = '', fieldDescription = '', profile = {}) {
    const q = (questionText + ' ' + fieldDescription).toLowerCase().trim();
    const info = profile.personal_information || {};
    const edu = (profile.education_details && profile.education_details[0]) || {};
    const exp = (profile.experience_details && profile.experience_details[0]) || {};
    const prefs = profile.work_preferences || {};

    // 1. Socials & URLs
    if (q.includes('linkedin')) return info.linkedin || '';
    if (q.includes('github')) return info.github || '';
    if (q.includes('portfolio') || q.includes('website') || q.includes('personal site') || q.includes('blog')) {
        return info.portfolio || '';
    }

    // 2. Contact details
    if (q.includes('phone') || q.includes('mobile') || q.includes('contact number')) return info.phone || '';
    if (q.includes('email')) return info.email || '';
    if (q.includes('first name') || q.includes('given name')) return info.first_name || 'Applicant';
    if (q.includes('last name') || q.includes('family name') || q.includes('surname')) return info.last_name || '';
    if (q.includes('full name')) return [info.first_name, info.last_name].filter(Boolean).join(' ') || 'Applicant';
    if (q.includes('city')) return info.location?.city || '';
    if (q.includes('state')) return info.location?.state || '';
    if (q.includes('country')) return info.location?.country || '';
    if (q.includes('address') || q.includes('current location') || q.includes('where are you based') || q.includes('reside')) {
        return [info.location?.city, info.location?.state, info.location?.country].filter(Boolean).join(', ') || 'Remote';
    }

    // 3. Work Authorization & Sponsorship
    if (q.includes('authorized') || q.includes('legal right to work') || q.includes('legally eligible') || q.includes('work authorization') || q.includes('work permit')) {
        if (q.includes('india')) return 'Yes';
        if (q.includes('united states') || q.includes('u.s.') || q.includes('us citizen') || q.includes('europe') || q.includes('uk')) return 'No';
        return prefs.work_authorization || 'Yes';
    }
    if (q.includes('sponsorship') || q.includes('visa')) {
        if (q.includes('india')) return 'No';
        return prefs.requires_sponsorship || 'No';
    }
    if (q.includes('18 years') || q.includes('legal age') || q.includes('over 18')) return 'Yes';

    // 4. Compensation / Notice period
    if (q.includes('current ctc') || q.includes('current salary') || q.includes('present ctc')) {
        return '0 (Student / Intern)';
    }
    if (q.includes('salary') || q.includes('compensation') || q.includes('ctc') || q.includes('desired pay') || q.includes('rate')) {
        if (q.includes('number') || q.includes('numeric') || q.includes('$') || q.includes('inr')) return '0';
        return prefs.salary_expectation || 'Competitive / Open to negotiation';
    }
    if (q.includes('notice') || q.includes('start date') || q.includes('available') || q.includes('when can you start') || q.includes('joining period')) {
        return prefs.availability || 'Immediate (0 days)';
    }
    if (q.includes('relocate') || q.includes('willing to relocate')) return 'Yes';

    // 5. Experience / Education
    if (q.includes('current company') || q.includes('current employer') || q.includes('most recent employer') || q.includes('previous employer')) {
        return exp.company || 'Space Applications Centre [ISRO]';
    }
    if (q.includes('current title') || q.includes('current role') || q.includes('job title')) {
        return exp.position || 'Software Engineering Intern';
    }
    if (q.includes('school') || q.includes('university') || q.includes('college') || q.includes('institution')) {
        return edu.institution || 'Pandit Deendayal Energy University';
    }
    if (q.includes('degree') || q.includes('qualification')) {
        return `${edu.degree || 'Bachelor of Technology'} in ${edu.field_of_study || 'Computer Engineering'}`;
    }
    if (q.includes('gpa') || q.includes('grade')) return edu.gpa || '3.42/4.00';
    if (q.includes('graduation') || q.includes('year of passing') || q.includes('passout') || q.includes('graduating')) return '2026';
    if (q.includes('major') || q.includes('field of study')) return edu.field_of_study || 'Computer Engineering';

    // 6. Years of experience
    if (q.includes('years of experience') || q.includes('years experience') || q.includes('how many years')) {
        return '2';
    }

    // 7. How did you hear
    if (q.includes('how did you hear') || q.includes('hear about') || q.includes('referral') || q.includes('source')) {
        return 'Company Career Page / LinkedIn';
    }

    // 8. EEO / Demographics
    if (q.includes('gender')) return 'Male';
    if (q.includes('pronoun')) return 'He/Him';
    if (q.includes('veteran')) return 'No, I am not a protected veteran';
    if (q.includes('disability')) return 'No, I do not have a disability';
    if (q.includes('race') || q.includes('ethnicity')) return 'Asian';

    // 9. Essays / Open-ended
    if (q.includes('why do you want') || q.includes('why this role') || q.includes('why us') || q.includes('cover letter') || q.includes('about yourself') || q.includes('summary')) {
        return `I am enthusiastic about this role and the team's mission. With my background building full-stack platforms (Monerva, Kronos, Jobkart.ai) and my SWE internship at Space Applications Centre (ISRO) developing telemetry pipelines and Agentic AI architectures, I bring disciplined engineering skills and immediate velocity to your team.`;
    }

    return '';
}

/**
 * Answer form questions using candidate profile information and AI.
 */
async function answerFormQuestion(questionText, fieldDescription = '') {
    const profile = getStructuredProfile();
    const deterministic = getDeterministicAnswer(questionText, fieldDescription, profile);

    // If deterministic matched high-confidence factual answer, return immediately
    if (deterministic && deterministic !== '') {
        return deterministic;
    }

    // Otherwise, attempt LLM completion
    try {
        const resume = await getMasterResume();
        const systemPrompt = "Help auto-answer a job application question based ONLY on the candidate's factual details. Return ONLY the answer.";
        const userPrompt = `
Candidate Factual Details (Structured):
---
${JSON.stringify(profile, null, 2)}
---

Candidate Resume Markdown:
---
${resume}
---

Question: "${questionText}"
Field Context: "${fieldDescription}"

DIRECTIONS:
1. Keep the answer extremely concise, professional, and clear.
2. Return ONLY the direct answer text. No conversational wrapping.
`;
        const aiResponse = await callOmniRoute([{ role: 'user', content: userPrompt }], systemPrompt);
        if (aiResponse && aiResponse.trim().length > 0 && aiResponse !== 'MANUAL_REQUIRED') {
            return aiResponse.trim();
        }
    } catch(err) {
        console.warn('AI question answering fallback:', err.message);
    }

    return deterministic || 'Yes';
}

function generateMockScore(jobTitle, jdText) {
    const title = jobTitle.toLowerCase();
    const text = jdText.toLowerCase();

    let score = 55;
    const missing = [];
    const reasons = [];

    const isIntern = /\b(intern|internship|co-op|apprentice)\b/i.test(jobTitle) || /\b(intern|internship)\b/i.test(jdText);
    const isWinterSpring = /\b(winter|spring|january|6[- ]month|off-cycle)\b/i.test(jobTitle) || /\b(winter|spring|january|6[- ]month|jan to jun|january to june)\b/i.test(jdText);

    if (title.includes('software') || title.includes('backend') || title.includes('developer') || title.includes('engineer') || title.includes('sde') || title.includes('ai') || title.includes('ml')) {
        score += 20;
        reasons.push('Matches core Software / AI Engineer disciplines');
    }
    if (text.includes('node') || text.includes('javascript') || text.includes('go') || text.includes('python') || text.includes('react') || text.includes('fastapi') || text.includes('sql')) {
        score += 15;
        reasons.push('Requires master languages / stack (Go/Node/Python/React)');
    } else {
        missing.push('Target backend languages');
    }

    if (isIntern) {
        score += 12;
        reasons.push('Target internship opportunity');
        if (isWinterSpring) {
            score += 10;
            reasons.push('Directly matches Winter / 6-Month (Jan-Jun) requirement');
        }
    }

    if (!isIntern && (text.includes('senior') || text.includes('lead') || title.includes('senior') || text.includes('5+ years') || text.includes('8+ years'))) {
        score -= 20;
        reasons.push('Requires senior level or extensive commercial experience');
        missing.push('Commercial tenure');
    }

    score = Math.max(10, Math.min(98, score));

    return {
        score,
        classification: score >= 90 ? 'Excellent' : (score >= 75 ? 'Strong' : (score >= 60 ? 'Possible' : 'Reject')),
        explanation: `Evaluated job "${jobTitle}". Reasons: ${reasons.join(', ')}.`,
        missing_requirements: missing
    };
}

module.exports = {
    scoreJob,
    tailorResumeText,
    generateCoverLetter,
    answerFormQuestion,
    getMasterResume,
    getStructuredProfile,
    callOmniRoute
};
