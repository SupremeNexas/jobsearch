# Design Spec: Integrating Tavily, Firecrawl, and BrowserUse

## Overview
This design outlines the integration of three new automation tools into the existing job-search Agent codebase:
1. **Tavily:** For broad, keyword‑based search across the open web.
2. **Firecrawl:** For reliable extraction of structured data from JavaScript‑heavy career pages.
3. **BrowserUse:** For advanced, AI‑driven form‑filling automation on complex job boards where standard Playwright scripts fail.

## Architectural Changes

### 1. Settings Extensions
The `settings` table in `jobsearch.db` will be updated to include new toggle flags and quota limits:
- `USE_TAVILY` (boolean)
- `USE_FIRECRAWL` (boolean)
- `USE_BROWSER_USE` (boolean)
- `MAX_REQUESTS_PER_CYCLE` (integer, default 5)

### 2. Scanner (`src/scanner.js`)
Update `runDiscoveryCycle()` to check the new `settings` flags:
- If `USE_TAVILY` is true, invoke a new `tavilyScanner.search(keywords, ...)` utility.
- If `USE_FIRECRAWL` is true, invoke a new `firecrawlScanner.crawl(url, ...)` utility.
- Unified result set: All sources (crawlers + new tools) are merged and deduplicated by `job_id` before scoring.

### 3. Autofiller (`src/autofiller.js`)
Redesign `applyToJob()` to implement a fallback strategy for submission:
- Attempt existing Playwright `autoApply`.
- If failed (catch block), check if `USE_BROWSER_USE` is enabled.
- If enabled, attempt submission via `browserUse.fillAndSubmit()` before ultimately failing to `MANUAL_REQUIRED`.

### 4. Database Schema
A migration script will be added to ensure:
- The new `source_tool` column is added to the `jobs` table to aid in debugging/logging where a job came from.

## Development Path
1. **Migration:** Add new columns/settings.
2. **Scanner update:** Implement wrapper modules for new tools, update discovery cycle.
3. **Autofiller update:** Inject `BrowserUse` as an alternative automation layer.
4. **Testing:** Run a dry‑run with a minimal budget to verify API integration (Tavily/Firecrawl) and submission logic (BrowserUse).