const fs = require('fs');

// Helper to strip tags and extract cell/text content
function cleanText(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseSheet(filename) {
    console.log(`=== Parsing ${filename} ===`);
    const content = fs.readFileSync(filename, 'utf8');

    // A very simple regex parser for <tr> and <td>
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;

    let trMatch;
    let rowIdx = 0;
    while ((trMatch = trRegex.exec(content)) !== null) {
        const rowHtml = trMatch[1];
        let tdMatch;
        const cells = [];
        while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
            cells.push(cleanText(tdMatch[1]));
        }
        if (cells.length > 0 && cells.some(c => c.length > 0)) {
            console.log(`Row ${rowIdx++}:`, cells.slice(0, 8));
        }
    }
}

function parseDoc(filename) {
    console.log(`=== Parsing ${filename} ===`);
    const content = fs.readFileSync(filename, 'utf8');

    // Look for paragraph text, lists, or headers
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>|<h\d[^>]*>([\s\S]*?)<\/h\d>/gi;
    let match;
    let limit = 50;
    while ((match = pRegex.exec(content)) !== null && limit > 0) {
        const text = cleanText(match[0]);
        if (text.length > 5) {
            console.log(`Text: ${text}`);
            limit--;
        }
    }
}

// Read sheet1.html
parseSheet('sheet1.html');

// Read sheet2.html
parseSheet('sheet2.html');

// Read doc1.html
parseDoc('doc1.html');
