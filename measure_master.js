const fs = require('fs');

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

const latex = fs.readFileSync('/Users/supryo/Desktop/jobsearch/resumes/resume_12_8_26.tex', 'utf8');
const bullets = [];
const command = '\\resumeItem{';
let idx = latex.indexOf('\\begin{document}');
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
    bullets.push({ text: visibleText, length: visibleText.length });
    idx = p;
}
bullets.forEach((b, i) => console.log(`Bullet ${i+1} (${b.length}): ${b.text}`));
