const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function getPdfPageCount(pdfPath) {
    const absolutePath = path.resolve(pdfPath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`PDF file does not exist at ${absolutePath}`);
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Load a blank page and inject PDF.js
    await page.goto('about:blank');

    // Read the PDF file as base64
    const pdfBase64 = fs.readFileSync(absolutePath).toString('base64');

    const pageCount = await page.evaluate(async (base64Data) => {
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
        return pdf.numPages;
    }, pdfBase64);

    await browser.close();
    return pageCount;
}

if (require.main === module) {
    const targetPdf = process.argv[2] || 'actor/tailored_resumes/tailored_56b24c8c5318b894_v2.pdf';
    getPdfPageCount(targetPdf)
        .then(count => {
            console.log(`PDF Page Count: ${count}`);
            process.exit(0);
        })
        .catch(err => {
            console.error('Error counting PDF pages:', err);
            process.exit(1);
        });
}

module.exports = { getPdfPageCount };
