# Spec: 2026-08-12 Resume Automation System Design

## Overview
A cloud-based resume automation system running on Apify. The system runs on a daily schedule, searches for new job listings matching user criteria, determines fit, generates a tailored resume PDF using Claude, and attempts to apply automatically using Playwright or sends notification for manual application where autofill is blocked.

## System Architecture

```
┌─────────────────────────────────┐
│        Apify Cron Scheduler     │ (Daily Trigger)
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ 1. DISCOVER: Job Scraper Actor  │ -> Finds new listings from LinkedIn/Indeed/Google Jobs
└────────────────┬────────────────┘
                 │ (Found Job Listings)
                 ▼
┌─────────────────────────────────┐
│ 2. FILTER: Deduplication Check  │ -> Compares against Key-Value Store logs
└────────────────┬────────────────┘
                 │ (Unique JDs)
                 ▼
┌─────────────────────────────────┐
│ 3. TAILOR: Claude API Generator │ -> Uses Claude 3.5 Sonnet to rewrite resume to fit JD
└────────────────┬────────────────┘
                 │ (Tailored Markdown & PDF)
                 ▼
┌─────────────────────────────────┐
│ 4. APPLY: Playwright Actor      │ -> Autofills Greenhouse, Lever, and Workday forms
└────────────────┬────────────────┘
                 │ (Submit status / logs)
                 ▼
┌─────────────────────────────────┐
│ 5. REVENUE & REPORT: Email/Slack │ -> Sends email/Slack alerts with PDF attachments
└─────────────────────────────────┘
```

## Core Components

### 1. Job Crawler & Deduplicator
* **Source Scrapers:** Integrates Apify scrapers for LinkedIn, Indeed, and Google Jobs.
* **Storage Database:** Uses Apify Key-Value Store to maintain an array of already-processed job URLs to avoid double applications.

### 2. Claude Resume Generator
* **Models:** Uses `claude-3-5-sonnet` (or optimal equivalent).
* **Generation process:**
  * Contextualizes base resume and job description.
  * Formulates tailored resume in Markdown.
  * Uses a markdown-to-pdf converter to render the PDF.
  * Saves the final PDF to Apify Key-Value Store/Datasets.

### 3. Application Form Submitter (Playwright)
* Identifies target board Type (Greenhouse, Lever, Workday).
* Automates filling forms with personal info (retrieved securely from Apify Secret Environment Variables).
* Uploads the tailored PDF.
* Submits application or stops at preview step for safety, depending on user configuration.

### 4. Alert & Report Engine
* Sends email notifications via SendGrid API or Slack webhooks when:
  * Application is submitted successfully.
  * Application requires manual intervention.
  * Critical errors occur.

## Credentials & Variables
The system requires these environment variables:
* `APIFY_TOKEN`: Apify Platform access token.
* `ANTHROPIC_API_KEY`: Anthropic Claude integration API key.
* `APPLICANT_DETAILS`: JSON block containing applicant details (Name, Email, Socials, Phone).
* `SENDGRID_API_KEY` or `SLACK_WEBHOOK`: For application alerts.

## Error Handling
* Fallback to manual mode if forms contain unique fields that cannot be mapped.
* Email matching logs when jobs fail.
