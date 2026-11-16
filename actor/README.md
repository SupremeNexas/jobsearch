# Resume Automation System Actor

This is a scheduled Apify Actor designed to find job listings, tailor your Markdown resume to match each role using Claude, convert it to a print-ready PDF, auto-fill Lever/Greenhouse forms using Playwright, and send Slack notifications with verification screenshots.

## How it works

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

1. **Deduplication:** The actor maintains a state list of applied URLs inside its Apify Key-Value Store.
2. **Resume Generation:** Claude reads your base resume, matches it with the scraped job requirements, changes formatting/vocabulary style to match without fabricating any details, and converts it to a professional PDF.
3. **Autofill Submission:** Playwright starts a headless browser in the cloud, navigates to Lever or Greenhouse, matches input selectors for names, emails, portfolios and social profiles, uploads the tailored resume, optionally clicks submit, and snaps screenshots.

---

## Direct Deployment to Apify (Run when Laptop is Closed)

To deploy this Actor to your Apify console so that it runs automatically:

### Prerequisites
Make sure you have installed the `apify-cli` locally or use the Apify web interface:
```bash
npm install -g apify-cli
```

### Steps:
1. Login to your Apify console in your terminal:
   ```bash
   apify login
   ```
2. Navigate to this actor folder:
   ```bash
   cd actor
   ```
3. Push/Deploy the actor to Apify:
   ```bash
   apify push
   ```
4. Once deployed:
   - Go to [Apify Console - Actors](https://console.apify.com/actors).
   - Locate **resume-autofill-actor**.
   - Input your parameters (shown in inputs schema below).
   - Go to **Schedules** -> Create schedule to run this Actor at a scheduled time (e.g. everyday at 9:00 AM).

---

## Configuration Variables & Inputs

Configure these inputs inside your Apify Console input editor:

| Parameter | Type | Required | Description |
|---|---|---|---|
| **searchKeywords** | Array | Yes | Keywords to search (e.g. `["React Developer", "Node.js Engineer"]`) |
| **location** | String | No | Location of jobs (e.g. `"Remote"`, `"Gujarat"`, `"San Francisco"`) |
| **targetCompanies** | Array | No | Direct target companies list (e.g. `["stripe", "openai", "figma"]`) |
| **baseResume** | String | Yes | Your resume in **Markdown** format |
| **anthropicApiKey** | String | Yes | Secret API Key for Anthropic Claude API |
| **applicantDetails** | Object | Yes | Personal autofill details (First Name, Last Name, Email, Phone, LinkedIn, GitHub, Portfolio) |
| **autoSubmit** | Boolean | No | Set to `true` to auto-click submit. Set to `false` to just autofill and review screenshots. |
| **notificationWebhook** | String | No | Incoming Slack/Discord Webhook URL for status reports. |
