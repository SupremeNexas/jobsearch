# Spec: 2026-08-12 Resume Automation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a scheduled resume automation system on the Apify platform that crawls job platforms, filters new roles, tailors the resume PDF using Claude, auto-fills applications using Playwright, and sends notifications.

**Architecture:** A serverless Apify Actor executing daily under Apify Scheduler. The actor uses internal Key-Value Stores for database-less state persistence and deduplication.

**Tech Stack:** JavaScript/TypeScript, Apify SDK, Playwright, Anthropic API, SendGrid API.

---

### Task 1: Scaffolding and Setup
We'll scaffold the Apify Actor project structure, initialize packages, and declare configuration schemes.

**Files:**
* Create: `actor/actor.json`
* Create: `actor/package.json`
* Create: `actor/src/main.js`
* Create: `actor/src/utils.js`

**Interfaces:**
* Consumes: Environment variables (`APIFY_TOKEN`, `ANTHROPIC_API_KEY`, `APPLICANT_DETAILS`, `NOTIFICATION_HOOK`)
* Produces: Basic actor runtime verification and configuration loading.

- [ ] **Step 1: Create package.json configuration file**
Save the package definition to `actor/package.json`:
```json
{
  "name": "resume-autofill-actor",
  "version": "1.0.0",
  "description": "Scrapes, tailors resumes, and applies automatically",
  "dependencies": {
    "apify": "^3.0.0",
    "crawlee": "^3.0.0",
    "playwright": "^1.40.0",
    "@anthropic-ai/sdk": "^0.20.0"
  },
  "scripts": {
    "start": "node src/main.js"
  }
}
```

- [ ] **Step 2: Create Actor metadata configuration file**
Save the actor setup to `actor/actor.json`:
```json
{
  "actorSpecification": 1,
  "name": "resume-autofill-actor",
  "title": "Resume Autofill Actor",
  "version": "1.0.0",
  "dockerfile": "./Dockerfile"
}
```

- [ ] **Step 3: Create src/utils.js with configuration helpers**
Write helper functions for config loading:
```javascript
const { Actor } = require('apify');

async function getConfiguration() {
  const input = await Actor.getInput() || {};
  return {
    anthropicKey: process.env.ANTHROPIC_API_KEY || input.anthropicKey,
    applicantDetails: process.env.APPLICANT_DETAILS ? JSON.parse(process.env.APPLICANT_DETAILS) : input.applicantDetails,
    notificationHook: process.env.NOTIFICATION_HOOK || input.notificationHook,
    searchKeywords: input.searchKeywords || ["Software Engineer"]
  };
}

module.exports = { getConfiguration };
```

- [ ] **Step 4: Create src/main.js entry point**
Initialize Actor inside `actor/src/main.js`:
```javascript
const { Actor } = require('apify');
const { getConfiguration } = require('./utils');

Actor.main(async () => {
  const config = await getConfiguration();
  console.log('Actor initiated with keywords', config.searchKeywords);
  await Actor.setValue('STATUS', { initialized: true });
});
```

- [ ] **Step 5: Run execution test**
Verify by simulating execution locally:
Run: `cd actor && node src/main.js`
Expected output: Logs showing "Actor initiated" and exits successfully with no errors.

---

### Task 2: Job Crawling & Deduplication
We will construct the crawler to search job sites (Lever, Greenhouse) and implement Key-Value deduplication logic.

**Files:**
* Modify: `actor/src/main.js`
* Create: `actor/src/crawler.js`

**Interfaces:**
* Consumes: `searchKeywords` from configuration.
* Produces: `crawlJobs(keywords)` returns an array of listing details `[{ url, title, company, description, platform }]`.

- [ ] **Step 1: Write crawler module**
Define job crawler logic in `actor/src/crawler.js`:
```javascript
const { Actor } = require('apify');

async function getDeduplicatedJobs(rawJobs) {
  const store = await Actor.openKeyValueStore();
  const appliedJobs = await store.getValue('appliedJobs') || [];
  
  const newJobs = rawJobs.filter(job => !appliedJobs.includes(job.url));
  return newJobs;
}

async function markJobApplied(url) {
  const store = await Actor.openKeyValueStore();
  const appliedJobs = await store.getValue('appliedJobs') || [];
  appliedJobs.push(url);
  await store.setValue('appliedJobs', appliedJobs);
}

module.exports = { getDeduplicatedJobs, markJobApplied };
```

- [ ] **Step 2: Update entry point to verify deduplication**
Add draft execution to `actor/src/main.js`:
```javascript
const { Actor } = require('apify');
const { getDeduplicatedJobs, markJobApplied } = require('./crawler');

Actor.main(async () => {
  const mockJobs = [
    { url: 'https://lever.co/job-1', title: 'Developer', company: 'Google' },
    { url: 'https://lever.co/job-2', title: 'Specialist', company: 'Stripe' }
  ];
  
  const filtered = await getDeduplicatedJobs(mockJobs);
  console.log('Filtered jobs:', filtered.length);
  await markJobApplied('https://lever.co/job-1');
  
  const refiltered = await getDeduplicatedJobs(mockJobs);
  console.log('After applying, filtered jobs:', refiltered.length);
});
```

- [ ] **Step 3: Test deduplication**
Run: `cd actor && node src/main.js`
Expected Output logs:
"Filtered jobs: 2"
"After applying, filtered jobs: 1"

---

### Task 3: Claude Resume Tailoring Integration
We will integrate the Anthropic JS SDK to fetch, optimize, and parse resume Markdown strings.

**Files:**
* Create: `actor/src/tailor.js`

**Interfaces:**
* Consumes: `baseResumeMarkdown`, `jobDescription`
* Produces: `tailorResume(baseResumeMarkdown, jobDescription)` returning tailored markdown description string.

- [ ] **Step 1: Write Claude tailoring module**
Save to `actor/src/tailor.js`:
```javascript
const { Anthropic } = require('@anthropic-ai/sdk');

async function tailorResume(apiKey, baseResume, jobDescription) {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 4000,
    system: "You are an expert resume optimizer. Rephrase, prioritize and optimize the applicant's experience to align with the provided Job Description without fabricating achievements or modifying degree details, metrics, names, dates or companies. Return ONLY the finalized Markdown.",
    messages: [
      {
        role: 'user',
        content: `BASE_RESUME:\n${baseResume}\n\nJOB_DESCRIPTION:\n${jobDescription}`
      }
    ]
  });
  return response.content[0].text;
}

module.exports = { tailorResume };
```

- [ ] **Step 2: Test API Integration with mock parameters**
Verify communication with Anthropic.

---

### Task 4: Playwright Submitter (Apply Engine)
Automate Greenhouse and Lever forms.

**Files:**
* Create: `actor/src/apply.js`

**Interfaces:**
* Consumes: `url`, `applicantDetails`, `pdfPath`
* Produces: `submitApplication(url, details, pdfPath)` resolving to a status boolean `success`.

- [ ] **Step 1: Add Playwright solver**
Implement form parser and filler in `actor/src/apply.js`:
```javascript
const { chromium } = require('playwright');

async function submitApplication(url, details, pdfBuffer) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto(url);
  
  if (url.includes('greenhouse.io')) {
    await page.fill('#first_name', details.firstName);
    await page.fill('#last_name', details.lastName);
    await page.fill('#email', details.email);
    await page.fill('#phone', details.phone);
    // Handle files upload
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('[data-source="attach"]')
    ]);
    await fileChooser.setFiles({
      name: 'Resume.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBuffer
    });
    // Click submit
    await page.click('#submit_app');
  }
  
  await browser.close();
  return true;
}

module.exports = { submitApplication };
```

- [ ] **Step 2: Dry run submit application tests on Greenhouse test endpoints**
Verify inputs are populated cleanly.
