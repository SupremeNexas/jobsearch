const fs = require('fs');
const path = require('path');
const { initDb, allQuery, getQuery, runQuery } = require('./actor/src/db');
const { callOmniRoute } = require('./actor/src/ai');
const { renderResumeToPdf } = require('./actor/src/tailor');

function generateBasicDiff(original, tailored) {
    const originalLines = original.split('\n');
    const tailoredLines = tailored.split('\n');
    let diff = 'Resume Tailoring Changes:\n';
    let changed = false;

    originalLines.forEach(ol => {
        if (ol.trim() !== '' && !tailoredLines.some(tl => tl.trim() === ol.trim())) {
            diff += `- Removed/reworded: ${ol.substring(0, 100)}\n`;
            changed = true;
        }
    });

    tailoredLines.forEach(tl => {
        if (tl.trim() !== '' && !originalLines.some(ol => ol.trim() === tl.trim())) {
            diff += `+ Added/emphasized: ${tl.substring(0, 100)}\n`;
            changed = true;
        }
    });

    return changed ? diff : 'No major line differences. Terminology optimization only.';
}

function getVisibleText(itemContent) {
    return itemContent
        .replace(/\\textbf\{([^}]+)\}/g, '$1')
        .replace(/\\href\{[^}]+\}\{([^}]+)\}/g, '$1')
        .replace(/\\textit\{([^}]+)\}/g, '$1')
        .replace(/\\underline\{([^}]+)\}/g, '$1')
        .replace(/\\raisebox\{[^}]+\}\{[^}]+\}/g, '')
        .replace(/\\faIcon\{[^}]+\}/g, '')
        .replace(/\\([#&%$_{}~^])/g, '$1')
        .trim();
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
            if (latex[p] === '{') braceCount++;
            else if (latex[p] === '}') braceCount--;
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
        if (rewrites[i] !== undefined) {
            newLatex += `\\resumeItem{${rewrites[i]}}`;
        } else {
            newLatex += `\\resumeItem{${b.raw}}`;
        }
        lastIdx = b.end;
    }
    newLatex += latex.substring(lastIdx);
    return newLatex;
}

async function refineJobBullets(job, extVersion, baseResumeContent) {
    const jobId = job.job_id;
    const currentVersion = job.resume_version;
    const jdText = `${job.role} at ${job.company}\n\n${job.description}`;
    let latex = extVersion.tailored_markdown;

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        const bullets = getBullets(latex);
        const outOfBounds = [];

        for (let i = 0; i < bullets.length; i++) {
            const b = bullets[i];
            if (b.length < 85 || b.length > 98) {
                outOfBounds.push({ index: i, bullet: b });
            }
        }

        if (outOfBounds.length === 0) {
            console.log(`  [Pass] All ${bullets.length} bullets are within the 85-98 range.`);
            break;
        }

        console.log(`  [Refining] Found ${outOfBounds.length} out of bounds bullets. Refining... (Attempt ${attempts + 1}/${maxAttempts})`);

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
Job Context: ${job.role} at ${job.company}
Job Description (excerpt):
${job.description.substring(0, 1000)}

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
            console.log(`  [AI Response] Received rewrites for indexes: ${Object.keys(rewrites).join(', ')}`);

            // Apply rewrites
            latex = replaceBullets(latex, bullets, rewrites);
            attempts++;
        } catch (err) {
            console.error(`  [AI Error] Failed to refine bullets via AI:`, err.message);
            break;
        }
    }

    // Save final latex
    const finalBullets = getBullets(latex);
    const finalOutOfBounds = finalBullets.filter(b => b.length < 85 || b.length > 98);

    if (finalOutOfBounds.length === 0) {
        console.log(`  [Verified] Job ${jobId} successfully refined. 0 bullets out of bounds.`);
    } else {
        console.warn(`  [Warning] Job ${jobId} finished with ${finalOutOfBounds.length} bullets still out of bounds.`);
    }

    // Compile/Render new PDF
    console.log(`  [Compiler] Rendering refined resume to PDF bytes...`);
    const pdfBuffer = await renderResumeToPdf(latex);

    // Overwrite existing PDF file on disk
    const absolutePdfPath = path.join(__dirname, 'actor', extVersion.pdf_path);
    console.log(`  [Storage] Overwriting PDF file at: ${absolutePdfPath}`);
    fs.writeFileSync(absolutePdfPath, pdfBuffer);

    // Calculate new diff
    const diff = generateBasicDiff(baseResumeContent, latex);

    // Update database record inline
    await runQuery(
        `UPDATE resume_versions
         SET tailored_markdown = ?, diff_from_master = ?, created_at = ?
         WHERE job_id = ? AND version = ?`,
        [latex, diff, new Date().toISOString(), jobId, currentVersion]
    );
    console.log(`  [Success] Overwrote version and file for job ${jobId} v${currentVersion}.`);
}

async function main() {
    console.log('====================================================');
    console.log('STARTING BULLET REFINEMENT PIPELINE...');
    console.log('====================================================');

    await initDb();

    // Fetch all jobs with active resume versions
    const jobs = await allQuery('SELECT * FROM jobs WHERE resume_version > 0');
    console.log(`Found ${jobs.length} jobs to inspect and refine.`);

    // Fetch active base resume key from settings
    const activeResumeSetting = await getQuery("SELECT value FROM settings WHERE key = 'ACTIVE_BASE_RESUME'");
    const activeResumeKey = (activeResumeSetting && activeResumeSetting.value) || 'resume_12_8_26.tex';
    let baseResumePath = path.join(__dirname, 'resumes', activeResumeKey);
    if (!fs.existsSync(baseResumePath)) {
        baseResumePath = path.join(__dirname, 'resumes/resume_12_8_26.tex');
    }
    console.log(`Using base resume: ${baseResumePath}`);
    const baseResumeContent = fs.readFileSync(baseResumePath, 'utf8');

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const jobId = job.job_id;
        const currentVersion = job.resume_version;

        console.log(`\n[${i + 1}/${jobs.length}] Checking job: "${job.role}" at ${job.company} (ID: ${jobId}, Version: ${currentVersion})...`);

        try {
            const extVersion = await getQuery(
                'SELECT * FROM resume_versions WHERE job_id = ? AND version = ?',
                [jobId, currentVersion]
            );

            if (!extVersion) {
                console.warn(`[Warning] No version entry found in DB for job ${jobId} v${currentVersion}. Skipping.`);
                continue;
            }

            await refineJobBullets(job, extVersion, baseResumeContent);
        } catch (error) {
            console.error(`[Error] Failed to process job ${jobId}:`, error.message);
        }
    }

    console.log('\n====================================================');
    console.log('BULLET REFINEMENT PIPELINE COMPLETED SUCCESSFULLY!');
    console.log('====================================================');
}

main().catch(err => {
    console.error('Pipeline crashed:', err);
    process.exit(1);
});
