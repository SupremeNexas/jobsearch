const fs = require('fs');
const path = require('path');

// Helper to strip HTML tags and normalize text
function cleanText(html) {
    if (!html) return '';
    return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
               .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
               .replace(/<[^>]*>/g, ' ')
               .replace(/\s+/g, ' ')
               .trim();
}

// Simple and robust parser for CSV lines handling double-quotes
function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++; // skip escaped quote character
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current);
    return result;
}

// Helper to extract company name from candidate strengths in Sheet 2
function extractCompany(name, strengths) {
    if (!strengths) return name;

    const internMatch = strengths.match(/INTERNED AT\s+([A-Za-z0-9_\-\.]+)/i);
    if (internMatch) return internMatch[1].trim();

    const internshipMatch = strengths.match(/([A-Za-z0-9_\-\.]+)\s+internship/i);
    if (internshipMatch) return internshipMatch[1].trim();

    const coFoundedMatch = strengths.match(/Co-founded\s+fintech\s+startup\s+([A-Za-z0-9_\-\.]+)/i) ||
                           strengths.match(/Co-founded\s+([A-Za-z0-9_\-\.]+)/i);
    if (coFoundedMatch) return coFoundedMatch[1].trim();

    const foundedMatch = strengths.match(/(?<![A-Za-z0-9\-])Founded\s+(?:the)?\s*([A-Za-z0-9_\-\.]+)/i);
    if (foundedMatch) return foundedMatch[1].trim();

    const builtMatch = strengths.match(/\bBuilt\s+([A-Za-z0-9_\-\.]+)/i);
    if (builtMatch) return builtMatch[1].trim();

    const winnerMatch = strengths.match(/\bWinner\s+([A-Za-z0-9_\-\.\s]+?)\s+(?:Code|for|Good)/i);
    if (winnerMatch) return winnerMatch[1].trim();

    const firstWordMatch = strengths.match(/^([A-Za-z0-9_\-\.]+)\b/);
    if (firstWordMatch) return firstWordMatch[1].trim();

    return `${name}'s Startup/Project`;
}

/**
 * Parses sheet1.csv to extract companies and verified roles
 */
function parseSheet1Jobs(filePath) {
    const jobs = [];
    if (!fs.existsSync(filePath)) {
        console.warn(`[Parser] CSV File sheet1 not found at ${filePath}`);
        return jobs;
    }
    try {
        const st = fs.lstatSync(filePath);
        if (st.blocks === 0 && st.size > 0) {
            console.warn(`[Parser] CSV File sheet1 is an unhydrated APFS stub (${filePath}), skipping.`);
            return jobs;
        }
    } catch (e) {
        return jobs;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    let rowIndex = 0;
    for (const line of lines) {
        if (!line.trim()) continue;
        rowIndex++;

        // Skip headers & descriptive text rows (Sheet 1 starts with titles in rows 1-3)
        // Header labels: #,Company,Type,Website,Hiring Specialty / Domain,Program / Role,Cities,Work Mode,Verification Notes
        const cells = parseCsvLine(line);
        if (cells.length < 6) continue;

        const rowNumStr = cells[0].trim();
        const company = cells[1].trim();
        const type = cells[2].trim();
        const website = cells[3].trim();
        const domain = cells[4].trim();
        const programRole = cells[5].trim();
        const cities = cells.length > 6 ? cells[6].trim() : '';
        const workMode = cells.length > 7 ? cells[7].trim() : '';
        const notes = cells.length > 8 ? cells[8].trim() : '';

        // Must be a valid row (row number column is numeric)
        if (isNaN(parseInt(rowNumStr, 10)) || !company || company.toLowerCase() === 'company') {
            continue;
        }

        // Clean website
        let cleanUrl = website;
        if (cleanUrl && !cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
            cleanUrl = 'https://' + cleanUrl;
        }

        // Generate a unique URL by appending a query index to prevent DB URL conflict across shareable pages
        const uniqueUrl = cleanUrl ? `${cleanUrl}?ref=sheet1_row_${rowIndex}` : `https://example.com/sheet1/job/${rowIndex}`;

        const location = [cities, workMode].filter(x => x).join(' - ');

        const description = `Hiring Specialty / Domain: ${domain}\nProgram / Role: ${programRole}\nCompany: ${company}\nEmployment Type: ${type}\nVerification Notes: ${notes}`;

        jobs.push({
            url: uniqueUrl,
            title: programRole || `${company} General Role`,
            company: company,
            location: location || 'India',
            description: description,
            platform: 'sheet1'
        });
    }

    console.log(`[Parser] Parsed ${jobs.length} jobs from sheet1.csv`);
    return jobs;
}

/**
 * Parses sheet2.csv to extract companies/roles from candidate shortlists
 */
function parseSheet2Jobs(filePath) {
    const jobs = [];
    if (!fs.existsSync(filePath)) {
        console.warn(`[Parser] CSV File sheet2 not found at ${filePath}`);
        return jobs;
    }
    try {
        const st = fs.lstatSync(filePath);
        if (st.blocks === 0 && st.size > 0) {
            console.warn(`[Parser] CSV File sheet2 is an unhydrated APFS stub (${filePath}), skipping.`);
            return jobs;
        }
    } catch (e) {
        return jobs;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    let rowIndex = 0;
    for (const line of lines) {
        if (!line.trim()) continue;
        rowIndex++;

        // Schema: #,Roll No,Name,CGPA,Applied For,Key Strengths
        const cells = parseCsvLine(line);
        if (cells.length < 5) continue;

        const rowNumStr = cells[0].trim();
        const rollNo = cells[1].trim();
        const name = cells[2].trim();
        const cgpa = cells[3].trim();
        const appliedFor = cells[4].trim();
        const strengths = cells.length > 5 ? cells[5].trim() : '';

        // Must be a valid student data row
        if (isNaN(parseInt(rowNumStr, 10)) || !name || name.toLowerCase() === 'name') {
            continue;
        }

        // Extract company from strengths
        const companyName = extractCompany(name, strengths);

        // Generate a unique pseudo-URL for candidate reference
        const uniqueUrl = `https://pdeu.edu/students/${rollNo || rowIndex}?ref=sheet2_row_${rowIndex}`;

        const description = `Candidate Profile Name: ${name}\nRoll No: ${rollNo}\nCGPA: ${cgpa}\nPreferred Discipline / Applied For: ${appliedFor}\nKey Strengths & Details: ${strengths}`;

        jobs.push({
            url: uniqueUrl,
            title: appliedFor || 'Full Stack Engineer',
            company: companyName,
            location: 'Gandhinagar, Gujarat',
            description: description,
            platform: 'sheet2'
        });
    }

    console.log(`[Parser] Parsed ${jobs.length} jobs from sheet2.csv`);
    return jobs;
}

/**
 * Parses doc1.html to extract platforms, roles and details
 */
function parseDocJobs(filePath) {
    const jobs = [];
    if (!fs.existsSync(filePath)) {
        console.warn(`[Parser] Google Doc File doc1 not found at ${filePath}`);
        return jobs;
    }
    try {
        const st = fs.lstatSync(filePath);
        if (st.blocks === 0 && st.size > 0) {
            console.warn(`[Parser] Google Doc File doc1 is an unhydrated APFS stub (${filePath}), skipping.`);
            return jobs;
        }
    } catch (e) {
        return jobs;
    }

    const content = fs.readFileSync(filePath, 'utf8');

    // Extract paragraphs and list points from the doc content
    const pRegex = /<(p|h1|h2|h3|h4|h5|h6|li)[^>]*>([\s\S]*?)<\/\1>/gi;
    const textLines = [];

    let match;
    while ((match = pRegex.exec(content)) !== null) {
        const text = cleanText(match[2]);
        if (text.length > 2) {
            textLines.push(text);
        }
    }

    // Iterate textLines and find numerical items
    // Examples: "1.⁠ ⁠AUTOMATTIC (WordPress.com)", "2.⁠ ⁠TOPTAL"
    let currentItem = null;
    let index = 0;

    for (let i = 0; i < textLines.length; i++) {
        const line = textLines[i].trim();

        // Match line starting with: "[number]. [company]" or "[number].⁠ ⁠[company]" where some weird spaces occur
        // e.g. "1.⁠ ⁠AUTOMATTIC (WordPress.com)" - it contains non-breaking spaces or zero width characters.
        // Let's use regex that is forgiving about whitespaces and special characters between digits and text.
        const itemHeaderMatch = line.match(/^(\d+)[.\s⁠​]+([\s\S]+)$/i);

        if (itemHeaderMatch) {
            // Found a new company item
            if (currentItem) {
                jobs.push(currentItem);
            }
            index++;
            const companyName = itemHeaderMatch[2].trim();
            currentItem = {
                title: '',
                company: companyName,
                url: '',
                location: 'Remote',
                descriptionLines: [line],
                platform: 'doc1'
            };
        } else if (currentItem) {
            // Keep appending lines to current company matching roles, process, salary or apply links
            currentItem.descriptionLines.push(line);

            // Assign specialized variables
            if (line.startsWith('Roles:')) {
                currentItem.title = line.replace('Roles:', '').trim();
            } else if (line.startsWith('Apply:')) {
                let applyUrl = line.replace('Apply:', '').trim();
                const urls = applyUrl.split(/\s+\/\s+/); // Handle lists like "flex.amazon.in / partner.swiggy.com"
                let targetUrl = urls[0].trim();
                if (targetUrl && !targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
                    targetUrl = 'https://' + targetUrl;
                }
                currentItem.url = targetUrl;
            } else if (line.startsWith('How to find:')) {
                // If there's no apply link but custom instruction
                let search = line.replace('How to find:', '').trim();
                currentItem.url = `https://google.com/search?q=${encodeURIComponent(search)}`;
            }
        }
    }

    // Push the last item
    if (currentItem) {
        jobs.push(currentItem);
    }

    // Final mapping and validation
    const parsedJobs = jobs.map((j, idx) => {
        // Build description
        const desc = j.descriptionLines.join('\n');
        // Uniquify URL
        const uniqueUrl = j.url ? `${j.url}?ref=doc1_row_${idx + 1}` : `https://example.com/doc1/job/${idx + 1}`;
        // Fallback for title if Roles listing is blank
        const finalTitle = j.title || `${j.company} Opportunities`;

        return {
            url: uniqueUrl,
            title: finalTitle,
            company: j.company,
            location: j.location,
            description: desc,
            platform: 'doc1'
        };
    });

    console.log(`[Parser] Parsed ${parsedJobs.length} jobs from doc1.html`);
    return parsedJobs;
}

module.exports = {
    parseSheet1Jobs,
    parseSheet2Jobs,
    parseDocJobs
};