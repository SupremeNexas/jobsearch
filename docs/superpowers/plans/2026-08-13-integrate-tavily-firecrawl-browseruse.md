# Job Search Integration Implementation Plan

**Goal:** Integrate Tavily, Firecrawl, and BrowserUse into the existing job-search Agent pipeline to increase job discovery coverage and allow for robust ATS form-filling.

**Architecture:** Extend `scanner.js` to optionally pull from new tool endpoints, and update `autofiller.js` to implement a fallback-based application submission (Playwright -> BrowserUse).

**Tech Stack:** Node.js, SQLite, Tavily SDK, Firecrawl SDK, BrowserUse SDK.

## Global Constraints

- **Language/Runtime:** Node.js (CommonJS modules)
- **Framework:** Express.js (Express 5.x)
- **Database:** SQLite3 (`sqlite3` module)
- **AI Gateway:** OmniRoute (OpenAI-compatible)

---

## Task 1: Database Migration

**Files:**
- Create: `actor/src/migrate.js`
- Modify: `actor/src/db.js`

**Interfaces:**
- Consumes: N/A
- Produces: SQLite schema updates (`source_tool` column, new settings).

- [ ] **Step 1: Write migration script to update DB schema**
```javascript
const { runQuery } = require('./db');

async function migrate() {
    console.log('Running DB migration...');
    // Add source_tool column to jobs
    await runQuery("ALTER TABLE jobs ADD COLUMN source_tool TEXT DEFAULT 'scanner'");
    // Add new settings
    await runQuery("INSERT OR IGNORE INTO settings (key, value) VALUES ('USE_TAVILY', 'false')");
    await runQuery("INSERT OR IGNORE INTO settings (key, value) VALUES ('USE_FIRECRAWL', 'false')");
    await runQuery("INSERT OR IGNORE INTO settings (key, value) VALUES ('USE_BROWSER_USE', 'false')");
    await runQuery("INSERT OR IGNORE INTO settings (key, value) VALUES ('MAX_REQUESTS_PER_CYCLE', '5')");
    console.log('Migration complete.');
}
migrate();
```
- [ ] **Step 2: Run migration**
Run: `node actor/src/migrate.js`

- [ ] **Step 3: Commit migration**
```bash
git add actor/src/migrate.js actor/src/db.js
git commit -m "feat: db migration for new tools"
```

---

## Task 2: Implement Scanner Wrappers

**Files:**
- Create: `actor/src/scanners/tavilyScanner.js`
- Create: `actor/src/scanners/firecrawlScanner.js`
- Modify: `actor/src/scanner.js`

**Interfaces:**
- Consumes: Scanned keywords, location settings.
- Produces: Merged job lists.

- [ ] **Step 1: Create `tavilyScanner.js`**
(Implementation details omitted, assume async `search(keywords, location)` returning array of `{url, title, company, description}`)

- [ ] **Step 2: Create `firecrawlScanner.js`**
(Implementation details omitted, assume async `crawl(url)` returning array of `{url, title, company, description}`)

- [ ] **Step 3: Modify `scanner.js` to integrate new scanners**
```javascript
const { search: tavilySearch } = require('./scanners/tavilyScanner');
const { crawl: firecrawlCrawl } = require('./scanners/firecrawlScanner');

// Inside runDiscoveryCycle():
if (settings.USE_TAVILY === 'true') {
    const tavilyData = await tavilySearch(keywords, locationPreference);
    tavilyData.forEach(j => j.source_tool = 'tavily');
    crawledList.push(...tavilyData);
}
// Similar logic for Firecrawl...
```
- [ ] **Step 4: Commit**
```bash
git add actor/src/scanner.js actor/src/scanners/
git commit -m "feat: integrate tavily and firecrawl scanners"
```

---

## Task 3: Implement BrowserUse Autofiller

**Files:**
- Modify: `actor/src/autofiller.js`
- Modify: `actor/src/apply.js`

**Interfaces:**
- Consumes: Job URL, applicant profile, tailored PDF.
- Produces: Submission status (SUCCESS/FAIL/MANUAL_REQUIRED).

- [ ] **Step 1: Modify `autofiller.js` / `applyToJob`**
```javascript
// Add:
const { browserUseApply } = require('./apply_browser_use'); 

// Modify logic:
async function applyToJob(jobId) {
    // ... try Playwright ...
    if (!success && settings.USE_BROWSER_USE === 'true') {
        // Fallback to BrowserUse
        const result = await browserUseApply(jobUrl, applicant, pdfBuffer);
        // ... process result ...
    }
}
```
- [ ] **Step 2: Commit**
```bash
git add actor/src/apply.js actor/src/autofiller.js
git commit -m "feat: add browser-use as automation fallback"
```

---

## Task 4: Integration Test

**Files:**
- Modify: `actor/src/test_mock_run.js`

- [ ] **Step 1: Update test suite to toggle new settings**

- [ ] **Step 2: Verify full run success**
Run: `npm --prefix actor test`

- [ ] **Step 3: Commit**
```bash
git commit -am "chore: update integration tests"
```
