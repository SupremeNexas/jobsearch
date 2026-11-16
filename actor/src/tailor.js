const { Anthropic } = require('@anthropic-ai/sdk');
const { chromium } = require('playwright-core');
const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { verifyContentFacts } = require('./verify_facts');

function safeDelete(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (e) {
        console.warn(`Failed to clean up temp file ${filePath}:`, e.message);
    }
}

function getPdfPageCount(pdfPath) {
    try {
        const output = execSync(`python3 -c "from pypdf import PdfReader; print(len(PdfReader('${pdfPath}').pages))"`, { stdio: 'pipe' });
        return parseInt(output.toString().trim(), 10);
    } catch (e) {
        console.warn(`[Pagecheck Warning] Failed to check page count using python pypdf:`, e.message);
        return 1;
    }
}

async function compileLatexWithTectonic(latexContent) {
    let currentLatex = latexContent;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
        const uniqueId = `resume_compile_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const tempDir = os.tmpdir();
        const texPath = path.join(tempDir, `${uniqueId}.tex`);
        const pdfPath = path.join(tempDir, `${uniqueId}.pdf`);

        console.log(`[Tectonic] Writing temporary LaTeX content to ${texPath}`);
        fs.writeFileSync(texPath, currentLatex, 'utf8');

        try {
            console.log(`[Tectonic] Running tectonic compiler on ${texPath}...`);
            const tectonicPath = process.env.TECTONIC_PATH || '/opt/homebrew/bin/tectonic';
            execSync(`"${tectonicPath}" "${texPath}" --outdir "${tempDir}"`, { stdio: 'pipe' });

            if (!fs.existsSync(pdfPath)) {
                throw new Error(`Tectonic compilation finished but PDF was not created at ${pdfPath}`);
            }

            const pageCount = getPdfPageCount(pdfPath);
            console.log(`[Tectonic] Compiled PDF page count: ${pageCount}`);

            if (pageCount <= 1 || attempts === maxAttempts - 1) {
                const pdfBuffer = fs.readFileSync(pdfPath);
                safeDelete(texPath);
                safeDelete(pdfPath);
                return pdfBuffer;
            }

            safeDelete(texPath);
            safeDelete(pdfPath);

            attempts++;
            console.log(`[Tectonic] PDF is ${pageCount} pages. Compressing LaTeX layout to fit 1 page (Attempt ${attempts}/${maxAttempts})...`);

            const linespreadMatch = currentLatex.match(/\\linespread\s*\{([0-9.]+)\}/);
            if (linespreadMatch) {
                const currentSpread = parseFloat(linespreadMatch[1]);
                const nextSpread = (currentSpread - 0.03 * attempts).toFixed(2);
                console.log(`[Tectonic] Lowering linespread: ${currentSpread} -> ${nextSpread}`);
                currentLatex = currentLatex.replace(/\\linespread\s*\{[0-9.]+\}/, `\\linespread{${nextSpread}}`);
            } else {
                console.log(`[Tectonic] No line spacing command found. Overriding topmargin & textheight...`);
                currentLatex = currentLatex.replace(/\\addtolength\{\\topmargin\}\{\s*-\s*([0-9.]+)in\}/g, (m, val) => {
                    const nextVal = (parseFloat(val) + 0.05).toFixed(2);
                    return `\\addtolength{\\topmargin}{-${nextVal}in}`;
                });
                currentLatex = currentLatex.replace(/\\addtolength\{\\textheight\}\{\s*([0-9.]+)in\}/g, (m, val) => {
                    const nextVal = (parseFloat(val) + 0.1).toFixed(2);
                    return `\\addtolength{\\textheight}{${nextVal}in}`;
                });
            }

        } catch (err) {
            console.error(`[Tectonic Error] Tectonic failed to compile:`, err.message);
            console.error(`--- FAILED LATEX CONTENT START ---`);
            console.error(currentLatex);
            console.error(`--- FAILED LATEX CONTENT END ---`);
            if (err.stdout) console.error(`[Tectonic stdout]:`, err.stdout.toString());
            if (err.stderr) console.error(`[Tectonic stderr]:`, err.stderr.toString());

            safeDelete(texPath);
            safeDelete(pdfPath);
            throw err;
        }
    }
}

/**
 * Tailors your markdown resume against a target job description.
 * @param {string} apiKey Anthropic API key
 * @param {string} baseResume Markdown base CV
 * @param {string} jobDescription Target JD text
 * @returns {Promise<string>} Tailored Markdown resume
 */
async function tailorResumeMarkdown(apiKey, baseResume, jobDescription) {
    const sdkOptions = { apiKey };
    if (process.env.ANTHROPIC_BASE_URL) {
        sdkOptions.baseURL = process.env.ANTHROPIC_BASE_URL;
    }
    const anthropic = new Anthropic(sdkOptions);
    console.log('Sending resume to Claude via Gateway for tailoring...');

    const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4000,
        system: `You are an expert resume writer. Your job is to optimize the provided Markdown resume to fit the Job Description.

CORE PRINCIPLES:
1. TRUTH-PRESERVING: Never fabricate metrics, experience, companies, degrees, locations or dates.
2. NARRATIVE REFRAMING: Highlight and prioritize projects, techniques, and terminology from the base resume that directly align with keywords and responsibilities in the Job Description.
3. Keep the same contact information, name, and general sections intact.
4. NO STYLING/LATEX CHANGES: Do NOT change any LaTeX formatting, markdown layout, headers, dividers/separators, list symbols, or any styling elements. Keep the layout, sections, spacing, and styling exactly the same as the original. Only change the descriptions/bullet points of the experiences/projects to match the job description. Never change any styling.
5. ONE-PAGE CONSTRAINT: The resume MUST fit on exactly one page. Keep descriptions and bullet points extremely concise. For the primary internship (ISRO), select/rewrite at most 5 main bullets and omit the rest. For each project, select at most 2 bullets and omit the rest. Keep sentences short and impact-focused.
6. Return ONLY the optimized Markdown content. Do not include any explanation or preamble.`,
        messages: [
            {
                role: 'user',
                content: `BASE_RESUME:\n${baseResume}\n\nJOB_DESCRIPTION:\n${jobDescription}`
            }
        ]
    });

    const tailoredText = response.content[0].text;
    const factCheck = verifyContentFacts(tailoredText);
    console.log(`[Tailor Fact-Check] ${factCheck.summary}`);
    return tailoredText;
}

/**
 * Renders Markdown or LaTeX resume into a high-quality PDF.
 * If the input is LaTeX (detected by \documentclass or \begin{document}), it uses Tectonic.
 * Otherwise, it uses Playwright Print rendering.
 * @param {string} resumeContent The optimized resume text (Markdown or LaTeX)
 * @returns {Promise<Buffer>} PDF file bytes buffer
 */
async function renderResumeToPdf(resumeContent) {
    const isLatex = resumeContent.includes('\\documentclass') || resumeContent.includes('\\begin{document}');
    if (isLatex) {
        console.log('Detected LaTeX document. Compiling with Tectonic...');
        return compileLatexWithTectonic(resumeContent);
    }

    console.log('Converting tailored Markdown to PDF...');

    // Very simple conversion of Markdown headers, subheaders, lists and links to HTML
    let htmlContent = resumeContent
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^\* (.*$)/gim, '<li>$1</li>')
        .replace(/^\- (.*$)/gim, '<li>$1</li>')
        .replace(/^(?!<h|<li|<ul|<p)(.*$)/gim, '<p>$1</p>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/---/g, '<hr />');

    // Wrap list items nicely
    htmlContent = htmlContent.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');

    const htmlDocument = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <style>
            body {
                font-family: 'Calibri', 'Arial', sans-serif;
                color: #222;
                line-height: 1.45;
                font-size: 11pt;
                margin: 0.5in 0.6in;
            }
            h1 {
                text-align: center;
                font-size: 20pt;
                margin-bottom: 2px;
                color: #111;
                font-weight: bold;
            }
            h2 {
                font-size: 13pt;
                border-bottom: 1.5px solid #444;
                margin-top: 18px;
                margin-bottom: 6px;
                text-transform: uppercase;
                color: #222;
                letter-spacing: 0.5px;
            }
            h3 {
                font-size: 11pt;
                margin-top: 8px;
                margin-bottom: 4px;
                color: #333;
                display: flex;
                justify-content: space-between;
                font-weight: bold;
            }
            p {
                margin: 3px 0;
            }
            ul {
                margin: 4px 0;
                padding-left: 18px;
            }
            li {
                margin-bottom: 3px;
            }
            a {
                color: #333;
                text-decoration: none;
            }
            hr {
                border: 0;
                height: 1px;
                background: #ccc;
                margin: 12px 0;
            }
            .center-sub {
                text-align: center;
                font-size: 10pt;
                color: #555;
                margin-bottom: 15px;
            }
            @media print {
                body {
                    margin: 0;
                }
            }
        </style>
    </head>
    <body>
        ${htmlContent}
    </body>
    </html>
    `;

    const launchOptions = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
    if (fs.existsSync('/Applications/Google Chrome.app')) {
        launchOptions.channel = 'chrome';
    }
    const browser = await chromium.launch(launchOptions);
    const page = await browser.newPage();

    // Set viewport size to match printable width and height of Letter page at 96 DPI
    // Printable width: 8.5in - 0.5in - 0.5in = 7.5in -> 720px
    // Printable height: 11in - 0.4in - 0.4in = 10.2in -> 979.2px
    await page.setViewportSize({ width: 720, height: 979 });

    await page.setContent(htmlDocument);
    await page.emulateMedia({ media: 'print' });

    // Dynamically adjust font-size and micro-spacing if content exceeds one page
    await page.evaluate(() => {
        const maxPageHeight = 979; // 10.2 inches * 96 dpi
        let fontSize = 11.0;
        let lineHeight = 1.45;
        let marginTop = 18;
        let h3MarginTop = 8;
        let liMarginBottom = 3;
        let hrMargin = 12;

        const body = document.body;
        // Check if content exceeds exactly 1 page
        while (document.documentElement.scrollHeight > maxPageHeight && fontSize > 8.0) {
            fontSize -= 0.1;
            lineHeight = Math.max(1.15, lineHeight - 0.015);
            marginTop = Math.max(6, marginTop - 0.5);
            h3MarginTop = Math.max(3, h3MarginTop - 0.25);
            liMarginBottom = Math.max(1, liMarginBottom - 0.25);
            hrMargin = Math.max(4, hrMargin - 0.5);

            body.style.fontSize = fontSize + 'pt';
            body.style.lineHeight = lineHeight;

            const h2s = document.querySelectorAll('h2');
            h2s.forEach(h2 => {
                h2.style.marginTop = marginTop + 'px';
                h2.style.marginBottom = Math.max(3, marginTop / 3) + 'px';
            });

            const h3s = document.querySelectorAll('h3');
            h3s.forEach(h3 => {
                h3.style.marginTop = h3MarginTop + 'px';
                h3.style.marginBottom = Math.max(2, h3MarginTop / 2) + 'px';
            });

            const lis = document.querySelectorAll('li');
            lis.forEach(li => {
                li.style.marginBottom = liMarginBottom + 'px';
            });

            const hrs = document.querySelectorAll('hr');
            hrs.forEach(hr => {
                hr.style.marginTop = hrMargin + 'px';
                hr.style.marginBottom = hrMargin + 'px';
            });
        }
    });

    // Render to PDF with standard letter margins
    const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        margin: {
            top: '0.4in',
            bottom: '0.4in',
            left: '0.5in',
            right: '0.5in'
        }
    });

    await browser.close();
    return pdfBuffer;
}

module.exports = { tailorResumeMarkdown, renderResumeToPdf };
