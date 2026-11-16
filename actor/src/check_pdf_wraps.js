const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function checkPdfLines(pdfPath) {
    const absolutePath = path.resolve(pdfPath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`PDF file does not exist at ${absolutePath}`);
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Load a blank page and inject PDF.js
    await page.goto('about:blank');

    const pdfBase64 = fs.readFileSync(absolutePath).toString('base64');

    const result = await page.evaluate(async (base64Data) => {
        // Load PDF.js from CDN
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        document.head.appendChild(script);

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
        const firstPage = await pdf.getPage(1);
        const textContent = await firstPage.getTextContent();

        // Group items by their vertical position (y coordinate)
        // transform[5] is the y-coordinate.
        const linesMap = {};
        textContent.items.forEach(item => {
            if (!item.str.trim()) return;
            const y = Math.round(item.transform[5] * 10) / 10; // Round to 0.1 decimal point accuracy
            if (!linesMap[y]) {
                linesMap[y] = [];
            }
            linesMap[y].push(item);
        });

        // Sort y coordinates descending (from top of page to bottom)
        const sortedYs = Object.keys(linesMap).map(Number).sort((a, b) => b - a);

        const lines = sortedYs.map(y => {
            // Sort items on the same line from left to right (transform[4] is x coordinate)
            const sortedItems = linesMap[y].sort((a, b) => a.transform[4] - b.transform[4]);
            return {
                y: y,
                text: sortedItems.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim()
            };
        });

        return {
            pageCount: pdf.numPages,
            lines: lines
        };
    }, pdfBase64);

    await browser.close();
    return result;
}

if (require.main === module) {
    const targetPdf = process.argv[2] || 'actor/tailored_resumes/tailored_56b24c8c5318b894_v3.pdf';
    checkPdfLines(targetPdf)
        .then(result => {
            console.log(`PDF Page Count: ${result.pageCount}`);
            console.log('\n--- EXTRACTED PDF TEXT LINES (Top to Bottom) ---');
            result.lines.forEach((line, index) => {
                console.log(`[Line ${String(index + 1).padStart(2, '0')}] (y=${line.y}): ${line.text}`);
            });
            process.exit(0);
        })
        .catch(err => {
            console.error('Error analyzing PDF:', err);
            process.exit(1);
        });
}

module.exports = { checkPdfLines };
