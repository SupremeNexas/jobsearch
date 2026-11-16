# Spec: 2026-08-12 Autonomous Job Search & Application Automation System

## Overview
A local-first, production-grade autonomous job-application system. It includes:
1. **SQLite Database** to store candidates, configurations, discovered jobs, tailored resumes, cover letters, and application steps.
2. **Express.js Backend API** to expose endpoints for the dashboard and schedule background operations.
3. **Background Worker** (Scheduler) that runs discovery, scoring, tailoring, and application loops.
4. **Vite/React Dashboard Frontend** to monitor search analytics, browse jobs, edit configurations, adjust resumes, and check application outcomes/screenshots.
5. **AI Processing Layer** wrapping regional LLM calls via Anthropic SDK to score relevance, extract jobs, answer application questions, and customize resumes/cover letters.
6. **Playwright Browser Automation Agent** that navigates Greenhouse, Lever, and general web forms, uploads PDFs, answers questions truthfully, and takes screenshots.

---

## 1. Database Schema (SQLite)

We use SQLite via `better-sqlite3` for local persistence.

### `jobs`
* `job_id` (TEXT, PK): SHA-256 hash of the job URL.
* `company` (TEXT): Name of hiring organization.
* `role` (TEXT): Job title.
* `location` (TEXT): Location of work.
* `source` (TEXT): Platform discovered (e.g. lever, greenhouse, weworkremotely).
* `url` (TEXT, UNIQUE): Original link to ATS/listing.
* `description` (TEXT): Sanitized job description text.
* `score` (INTEGER): Calculated match score (0-100).
* `score_explanation` (TEXT): LLM-generated breakdown of match quality.
* `status` (TEXT): Active tracker status: `DISCOVERED`, `EVALUATED`, `REJECTED`, `SELECTED`, `RESUME_TAILORED`, `READY_TO_APPLY`, `APPLIED`, `ASSESSMENT`, `INTERVIEW`, `REJECTED_AFTER_APPLICATION`, `OFFER`, `WITHDRAWN`, `MANUAL_REQUIRED`.
* `discovered_at` (TEXT): ISO-8601 timestamp.
* `resume_version` (INTEGER): Version counter for tailored resumes.
* `cover_letter_version` (INTEGER): Version counter for tailored cover letters.
* `applied_at` (TEXT): ISO-8601 timestamp of application.
* `application_status` (TEXT): Description of application state.
* `screenshot_path` (TEXT): Path to verification png screenshot.
* `notes` (TEXT): Custom markdown notes.

### `resume_versions`
* `id` (INTEGER, PK, AI)
* `job_id` (TEXT, FK): References `jobs(job_id)`.
* `version` (INTEGER)
* `tailored_markdown` (TEXT)
* `cover_letter` (TEXT)
* `diff_from_master` (TEXT)
* `pdf_path` (TEXT)
* `created_at` (TEXT)

### `settings`
* `key` (TEXT, PRIMARY KEY)
* `value` (TEXT)
Holds configurations: `MIN_SCORE_THRESHOLD` (default 75), `AUTO_APPLY_MODE` (default false), `MAX_APPLICATIONS_PER_DAY` (default 5), `PREFERRED_ROLES`, `EXCLUDED_ROLES`, `PREFERRED_LOCATIONS`, `EXCLUDED_LOCATIONS`, `MIN_SALARY`, `SLACK_WEBHOOK`, `AUTO_APPLY_ENABLED`.

---

## 2. API Endpoints (Backend)

* `GET /api/jobs`: List all jobs (filter by status, search queries, order).
* `GET /api/jobs/:id`: Fetch specific job details, tailored resume markdown, diff, and screenshot.
* `POST /api/jobs/:id/tailor`: Explicitly trigger resume/CL generation for a job.
* `POST /api/jobs/:id/apply`: Explicitly trigger browser auto-apply for a job.
* `PATCH /api/jobs/:id`: Update job status or custom notes.
* `GET /api/settings`: Fetch current preference state.
* `POST /api/settings`: Save updated configurations.
* `POST /api/actions/discover`: Run manual discovery sync cycle.
* `GET /api/stats`: Fetch dashboard summary calculations.

---

## 3. Playwright Apply Pipeline

1. **Launcher**: Opens local Chromium headless or headful (under development mode).
2. **Form Autofill**:
   * Inspects name, email, phone, location input tags.
   * Matches LinkedIn, GitHub, portfolio custom fields.
   * Leverages regular expression labels for work authorization and sponsorship queries.
3. **resume/File Attachment**: Loads generated PDF buffer, maps it to input `type="file"`.
4. **Verification**: Captures a full-page desktop screenshot before submitting.
5. **Autosubmit Policy**: Only clicks submit if `AUTO_APPLY_MODE` is enabled *and* the match score is above `MIN_SCORE_THRESHOLD`. Otherwise, saves the filled state as `READY_TO_APPLY` and snaps screenshots.

---

## 4. LLM Processor (Claude Gateway)

* Uses `@anthropic-ai/sdk` connecting to Anthropics models.
* Prompt structures output JSON schemas using markdown blocks:
  1. **Scoring Prompt**: Weighs job requirements (skills, degrees, experience) against candidate profile, outputting score, matched parameters, missing parameters, and textual explanation.
  2. **Tailoring Prompt**: Adjusts bullet points and skill priorities in Markdown without adding fabricated items.
  3. **Cover Letter Prompt**: Generates a professional, targeted, brief (approx 200-250 words) cover letter connecting base experience to the job.
