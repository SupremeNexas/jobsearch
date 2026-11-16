const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { extractJdSkills, classifySkillGaps, calculateAtsScore } = require('./ats');

/**
 * Verifies the compiled PDF properties: page count, searchability, and ATS keyword coverage.
 * @param {Buffer|string} pdfBufferOrPath The PDF file buffer or file path
 * @param {string} [jdText] Optional Job Description text to verify ATS compatibility
 * @returns {Promise<{
 *   success: boolean,
 *   pageCount: number,
 *   charCount: number,
 *   searchable: boolean,
 *   atsScore: number,
 *   skillGaps: { existing: string[], supportedByResume: string[], gap: string[] },
 *   errors: string[]
 * }>}
 */
async function verifyPdf(pdfBufferOrPath, jdText = '') {
    let pdfBase64 = '';

    if (Buffer.isBuffer(pdfBufferOrPath)) {
        pdfBase64 = pdfBufferOrPath.toString('base64');
    } else if (typeof pdfBufferOrPath === 'string') {
        const absolutePath = path.resolve(pdfBufferOrPath);
        if (!fs.existsSync(absolutePath)) {
            throw new Error(`PDF file does not exist at ${absolutePath}`);
        }
        pdfBase64 = fs.readFileSync(absolutePath).toString('base64');
    } else {
        throw new Error('Invalid PDF input. Must be a Buffer or file path string.');
    }

    const browser = await chromium.launch({ headless: true });

    try {
        const page = await browser.newPage();
        await page.goto('about:blank');

        const { pageCount, text } = await page.evaluate(async (base64Data) => {
            // Load PDF.js from CDN
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            document.head.appendChild(script);

            // Wait for pdfjsLib to load
            await new Promise((resolve) => {
                const check = setInterval(() => {
                    if (window['pdfjs-dist/build/pdf'] || window.pdfjsLib) {
                        clearInterval(check);
                        resolve();
                    }
                }, 50);
            });

            const pdfjs = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
            pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

            // Convert base64 to binary array
            const binStr = atob(base64Data);
            const len = binStr.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; ++i) {
                bytes[i] = binStr.charCodeAt(i);
            }

            const loadingTask = pdfjs.getDocument({ data: bytes });
            const pdf = await loadingTask.promise;

            // Extract all text page-by-page
            let fullText = '';
            for (let i = 1; i <= pdf.numPages; i++) {
                const pdfPage = await pdf.getPage(i);
                const textContent = await pdfPage.getTextContent();
                const pageText = textContent.items.map(item => item.str).join(' ');
                fullText += pageText + '\n';
            }

            return {
                pageCount: pdf.numPages,
                text: fullText.trim()
            };
        }, pdfBase64);

        await browser.close();

        const errors = [];
        if (pageCount !== 1) {
            errors.push(`Resume violates the single-page constraint: compiled PDF has ${pageCount} pages.`);
        }

        const charCount = text.length;
        const minimumChars = 500; // A reasonable lower bound for a one-page resume's text content
        const searchable = charCount >= minimumChars;
        if (!searchable) {
            errors.push(`PDF lacks sufficient searchable text (${charCount} chars found, expected at least ${minimumChars}). It might be blank or corrupted.`);
        }

        let atsScore = 0;
        let skillGaps = { existing: [], supportedByResume: [], gap: [] };

        if (jdText) {
            const jdSkills = extractJdSkills(jdText);
            if (jdSkills.length > 0) {
                skillGaps = classifySkillGaps(jdSkills, text);
                atsScore = calculateAtsScore(skillGaps);

                // Warn if there's a low ATS score or massive skill gaps
                if (atsScore < 50) {
                    errors.push(`Low ATS match score: ${atsScore}/100. Missing critical skills: ${skillGaps.gap.slice(0, 5).join(', ')}.`);
                }
            } else {
                console.log('[VerifyPDF] No skill requirements extracted from the provided Job Description.');
            }
        }

        return {
            success: errors.length === 0,
            pageCount,
            charCount,
            searchable,
            atsScore,
            skillGaps,
            errors
        };
    } catch (err) {
        await browser.close();
        return {
            success: false,
            pageCount: 0,
            charCount: 0,
            searchable: false,
            atsScore: 0,
            skillGaps: { existing: [], supportedByResume: [], gap: [] },
            errors: [`Failed to verify PDF: ${err.message}`]
        };
    }
}

module.exports = { verifyPdf };
