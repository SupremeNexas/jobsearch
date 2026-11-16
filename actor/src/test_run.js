const fs = require('fs');
const path = require('path');
const { renderResumeToPdf } = require('./tailor');
const { autoApply } = require('./apply');

async function testApplyRun() {
    const jobUrl = 'https://boards.greenhouse.io/figma/jobs/5691911004?gh_jid=5691911004';
    console.log(`Setting up test execution for Greenhouse job: ${jobUrl}...`);

    // Load inputs
    const inputData = JSON.parse(fs.readFileSync(path.join(__dirname, 'test_input.json'), 'utf8'));

    // Load resume Markdown
    const resumePath = path.join(__dirname, '../../resumes/resume_12_8_26.md');
    if (!fs.existsSync(resumePath)) {
        throw new Error(`Base resume not found at expected path: ${resumePath}`);
    }
    const resumeMarkdown = fs.readFileSync(resumePath, 'utf8');

    // 1. Convert Markdown to PDF
    console.log('Rendering markdown resume to PDF bytes...');
    const pdfBuffer = await renderResumeToPdf(resumeMarkdown);
    fs.writeFileSync(path.join(__dirname, '../test_resume_output.pdf'), pdfBuffer);
    console.log('Saved rendered test PDF to: actor/test_resume_output.pdf');

    // 2. Run autofill engine (with autoSubmit: false)
    console.log('Executing autofill logic...');
    const result = await autoApply(jobUrl, inputData.applicantDetails, pdfBuffer, false);

    console.log('\n--- AUTOFILL TEST RESULT ---');
    console.log('Success:', result.success);
    console.log('Message:', result.message);

    if (result.screenshotBuffer) {
        const screenshotPath = path.join(__dirname, '../autofill_result.png');
        fs.writeFileSync(screenshotPath, result.screenshotBuffer);
        console.log(`Form filled check screenshot saved to: ${screenshotPath}`);
    } else {
        console.log('No confirmation screenshot captured.');
    }
}

testApplyRun().catch((err) => {
    console.error('Test run crashed:', err);
});
