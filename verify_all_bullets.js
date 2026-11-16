const { initDb, allQuery, getQuery } = require('./actor/src/db');

async function main() {
    await initDb();
    const rows = await allQuery('SELECT job_id, resume_version, company, role FROM jobs WHERE resume_version > 0');
    console.log(`Analyzing bullets for ${rows.length} tailored resumes...`);

    let totalBullets = 0;
    let outOfBoundsCount = 0;

    for (const r of rows) {
        const extVersion = await getQuery(
            'SELECT tailored_markdown FROM resume_versions WHERE job_id = ? AND version = ?',
            [r.job_id, r.resume_version]
        );

        if (!extVersion) continue;
        const latex = extVersion.tailored_markdown;

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
            idx = p;

            let visibleText = itemContent
                .replace(/\\textbf\{([^}]+)\}/g, '$1')
                .replace(/\\href\{[^}]+\}\{([^}]+)\}/g, '$1')
                .replace(/\\textit\{([^}]+)\}/g, '$1')
                .replace(/\\underline\{([^}]+)\}/g, '$1')
                .replace(/\\raisebox\{[^}]+\}\{[^}]+\}/g, '')
                .replace(/\\faIcon\{[^}]+\}/g, '')
                .replace(/\\([#&%$_{}~^])/g, '$1')
                .trim();

            totalBullets++;
            const len = visibleText.length;
            if (len < 85 || len > 98) {
                outOfBoundsCount++;
                console.log(`[Out of bounds] Job: ${r.company} - ${r.role} (ID: ${r.job_id})`);
                console.log(`  Content: "${visibleText}"`);
                console.log(`  Length: ${len} chars`);
            }
        }
    }

    console.log(`\nVerification Complete.`);
    console.log(`Total bullets analyzed: ${totalBullets}`);
    console.log(`Bullets outside 85-98 range: ${outOfBoundsCount} (${((outOfBoundsCount / totalBullets) * 100).toFixed(1)}%)`);
}

main().catch(console.error);
