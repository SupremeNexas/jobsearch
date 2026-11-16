const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

function compile(latexContent) {
    const uniqueId = `test_compile_${Date.now()}`;
    const tempDir = os.tmpdir();
    const texPath = path.join(tempDir, `${uniqueId}.tex`);
    const pdfPath = path.join(tempDir, `${uniqueId}.pdf`);
    fs.writeFileSync(texPath, latexContent, 'utf8');

    try {
        execSync(`"/opt/homebrew/bin/tectonic" "${texPath}" --outdir "${tempDir}"`, { stdio: 'pipe' });
        const pages = parseInt(execSync(`python3 -c "import pypdf; print(len(pypdf.PdfReader('${pdfPath}').pages))"`).toString().trim());
        fs.unlinkSync(texPath);
        fs.unlinkSync(pdfPath);
        return pages;
    } catch (e) {
        try { fs.unlinkSync(texPath); } catch(_) {}
        try { fs.unlinkSync(pdfPath); } catch(_) {}
        return -1;
    }
}

const baseTex = fs.readFileSync('/Users/supryo/Desktop/jobsearch/resumes/resume_12_8_26.tex', 'utf8');

function search() {
    console.log("Analyzing page limits for different bullet lengths...");

    function makeBullet(length) {
        const base = "Engineered PulsarNav.ai autonomous navigation across space missions by implementing epoch folding ";
        let text = base.substring(0, length);
        if (text.length < length) {
            text = text.padEnd(length, 'x');
        }
        return text;
    }

    for (let len = 95; len <= 112; len += 1) {
        let tempLatex = baseTex;
        let idx = tempLatex.indexOf('\\begin{document}');
        const command = '\\resumeItem{';
        let count = 0;

        while (true) {
            const startIdx = tempLatex.indexOf(command, idx);
            if (startIdx === -1) break;
            const contentStart = startIdx + command.length;
            let braceCount = 1;
            let p = contentStart;
            while (braceCount > 0 && p < tempLatex.length) {
                if (tempLatex[p] === '{') braceCount++;
                else if (tempLatex[p] === '}') braceCount--;
                p++;
            }

            const bulletText = makeBullet(len);
            tempLatex = tempLatex.substring(0, startIdx) + `\\resumeItem{${bulletText}}` + tempLatex.substring(p);
            idx = startIdx + `\\resumeItem{${bulletText}}`.length;
            count++;
        }

        const pages = compile(tempLatex);
        console.log(`Length: ${len} chars. Page count: ${pages} (Total replaced bullets: ${count})`);
    }
}

search();
