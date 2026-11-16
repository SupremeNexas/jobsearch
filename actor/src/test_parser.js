const path = require('path');
const { parseSheet1Jobs, parseSheet2Jobs, parseDocJobs } = require('./parse_docs');

function testParser() {
    console.log("=== STARTING PARSER VERIFICATION ===");

    const rootDir = path.join(__dirname, '../..');
    const path1 = path.join(rootDir, 'sheet1.csv');
    const path2 = path.join(rootDir, 'sheet2.csv');
    const pathDoc = path.join(rootDir, 'doc1.html');

    console.log(`Checking path 1: ${path1}`);
    console.log(`Checking path 2: ${path2}`);
    console.log(`Checking path Doc: ${pathDoc}`);

    // Parse Sheet 1
    const sheet1Jobs = parseSheet1Jobs(path1);
    console.log(`Sheet 1: Total parsed = ${sheet1Jobs.length}`);
    if (sheet1Jobs.length > 0) {
        console.log("Sheet 1 Sample:", JSON.stringify(sheet1Jobs[0], null, 2));
    }

    // Parse Sheet 2
    const sheet2Jobs = parseSheet2Jobs(path2);
    console.log(`Sheet 2: Total parsed = ${sheet2Jobs.length}`);
    if (sheet2Jobs.length > 0) {
        console.log("Sheet 2 Sample:", JSON.stringify(sheet2Jobs[0], null, 2));
    }

    // Parse Doc 1
    const docJobs = parseDocJobs(pathDoc);
    console.log(`Doc 1: Total parsed = ${docJobs.length}`);
    if (docJobs.length > 0) {
        console.log("Doc 1 Sample:", JSON.stringify(docJobs[0], null, 2));
    }

    console.log("=== PARSER VERIFICATION DONE ===");
}

testParser();