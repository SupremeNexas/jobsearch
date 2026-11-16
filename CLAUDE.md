# Project Instructions

## Tech Stack
- **Language/Runtime:** Node.js (CommonJS modules)
- **Framework:** Express.js (Express 5.x)
- **Database:** SQLite3 (`sqlite3` module)
- **Automation / Filling:** Playwright (Chromium)
- **Scraping / Crawling:** Apify SDK / RSS crawler Feeds / Greenhouse & Lever JSON board APIs
- **LLM Gateway:** OmniRoute OpenAI-compatible model gateway (`http://localhost:20128/v1`) using `claude-sonnet-4` model

## Code Style & Conventions
- **Naming Conventions:** CamelCase for functions and variables, snake_case or CAPS for settings/constants.
- **Dependency Loading:** CommonJS standard `require(...)`.
- **Async Pattern:** Promises and `async/await`.
- **Error Handling:** Standard try-catch blocks with logging and fallbacks.

## Testing & Verification
- **Run Tests:** `npm --prefix actor test` (which executes `node src/test_mock_run.js`)
- **Action Checked:** Launches a mock local integration server, seeds a mock job list pointing to a local Greenhouse mockup page, pulls settings, performs resume tailoring via LLM or fallback, runs Playwright to fill-in inputs, and captures a screenshot validation.

## Build & Run
- **Start Web Dashboard / Scheduler:** `npm --prefix actor start` (or `node actor/src/main.js`)
- **Configuration Files:** Local environment variables stored in `actor/.env`. User database configurations are mapped inside the `settings` table of `actor/jobsearch.db`.

## Project Structure
- `actor/src/main.js` — Process entry loader.
- `actor/src/server.js` — Dashboard API routes and Express server setup.
- `actor/src/db.js` — SQLite database initialization and SQL queries wrapper.
- `actor/src/ai.js` — OmniRoute LLM caller wrapper (scores, tailors, generates cover letters, answers questions).
- `actor/src/scanner.js` — Manages discovery cycle, keywords, location filters, and calls the crawler.
- `actor/src/crawler.js` — Scrapes jobs from Greenhouse/Lever boards lists and RSS feeds.
- `actor/src/autofiller.js` — Service to process tailoring (PDF compilation) and trigger the application automation.
- `actor/src/apply.js` — Playwright headless browser script implementing custom filling rules for Greenhouse and Lever.
- `actor/src/scheduler.js` — Background check worker that schedules periodic scanning and applying.
- `actor/public/` — Frontend client single page app (HTML/JS code) displaying dashboard stats and job grids.
- `actor/tailored_resumes/` — Output storage folder for PDF tailored resume outcomes.
