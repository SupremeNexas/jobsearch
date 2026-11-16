# AIHawk Job Application & Discovery Platform

Autonomous agentic job discovery, 5-dimensional AI match scoring, and stealth browser automation integrated seamlessly into your existing jobsearch platform.

---

## 🚀 Key Capabilities

1. **AI Job Discovery Engine**
   - Multi-source scanning across Greenhouse, Lever, RemoteOK, Remotive, and direct employer boards.
   - Configurable **Job Search Profiles** (keywords, skills, location, remote preference, salary range, company inclusions/exclusions).
   - Real-time deduplication with SHA256 URL hashing and active candidate filtering.

2. **5-Dimensional AI Matching**
   - Evaluates job descriptions against candidate resume & structured profile across:
     - **Skill Match** (0-100%)
     - **Experience Match** (0-100%)
     - **Education Match** (0-100%)
     - **Location Match** (0-100%)
     - **Tech Stack Match** (0-100%)
   - Generates structured matched skills, missing skills / gap analysis, and plain-English fit reasoning.
   - OpenRouter LLM gateway integration with fallback to OmniRoute local gateway (`http://localhost:20128/v1`) and local deterministic heuristics.

3. **Stealth Browser Execution Agent**
   - Persistent Playwright contexts stored outside repo in `data/aihawk_profiles/` preserving cookies and login sessions across restarts.
   - Anti-detection evasion suite (disabling `navigator.webdriver`, realistic viewport, human typing delays, plugin arrays, language headers).
   - Support for HTTP/SOCKS5 proxies and configurable fingerprint seeds (`AIHAWK_SEED`).

4. **Strict User Approval Gate**
   - **Review Before Submit Workflow**:
     1. Prepares candidate payload & 1-page tailored resume draft in `READY_TO_APPLY` state.
     2. Presents full form fields preview in the dashboard modal.
     3. Requires explicit confirmation (`approved: true`) before launching the browser submit action.
     4. Captures automated verification screenshots on completion.

5. **Model Context Protocol (MCP) Bridge**
   - Exposes standard MCP tools (`browser_open`, `browser_navigate`, `browser_screenshot`, `job_search`, `job_match`, `job_apply_prepare`, `job_apply_execute`) compatible with Claude Code, Codex, and Gemini CLI.

6. **Real-time Server-Sent Events (SSE)**
   - Streaming live agent state (`initializing_browser`, `searching_jobs`, `evaluating_job`, `waiting_for_approval`, `applying`, `completed`) and structured event logs directly to the frontend.

---

## 🛠️ Architecture

```
actor/
├── src/
│   ├── services/aihawk/           # Modular AIHawk Service Layer
│   │   ├── config.js              # Config manager & secret masking
│   │   ├── logs.js                # Structured event logger & SSE emitter
│   │   ├── client.js              # OpenRouter & OmniRoute LLM client
│   │   ├── browser.js             # Persistent stealth browser manager
│   │   ├── jobs.js                # Multi-source discovery & search profiles
│   │   ├── matcher.js             # 5-dimensional AI evaluation
│   │   ├── applications.js        # Staging & browser execution
│   │   ├── mcp.js                 # Model Context Protocol bridge
│   │   └── index.js               # Clean unified export
│   ├── db.js                      # Extended SQLite schema & migrations
│   ├── server.js                  # Express API routes & SSE endpoints
│   ├── ai.js                      # Core LLM prompt wrappers
│   ├── autofiller.js              # Resume tailoring & auto-apply runner
│   ├── scanner.js                 # Background discovery scanner
│   ├── tailor.js                  # 1-page PDF compiler (Tectonic/Playwright)
│   └── test_aihawk_integration.js # Comprehensive integration test suite
├── public/
│   ├── index.html                 # Vue 3 Dashboard with AIHawk tabs & modals
│   └── screenshots/               # Application verification captures
└── tailored_resumes/              # Rendered PDF resumes
```

---

## ⚙️ Environment Variables

Add to `actor/.env` or configure directly in the UI dashboard **AIHawk Settings** tab:

| Variable | Description | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API Key for reasoning models | Optional / via Settings |
| `AIHAWK_MODEL` | Target AI model identifier | `z-ai/glm-5.3-flash` |
| `AIHAWK_SEED` | Browser fingerprint random seed | `42` |
| `AIHAWK_PROXY` | HTTP/SOCKS5 proxy address | Optional |
| `AIHAWK_HEADED` | Show visible browser window for debugging | `false` |
| `AIHAWK_PROFILE_DIR` | Storage directory for browser profiles & cookies | `data/aihawk_profiles` |
| `OMNIROUTE_URL` | Local OpenAI-compatible LLM gateway URL | `http://localhost:20128/v1` |
| `PORT` | Web dashboard server port | `3000` |

---

## 🧪 Testing & Verification

Run the comprehensive AIHawk integration test suite:

```bash
node actor/src/test_aihawk_integration.js
```

Run the legacy mock pipeline test:

```bash
npm --prefix actor test
```

---

## 🚦 Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/SupremeNexas/jobsearch.git
   cd jobsearch
   ```

2. **Install dependencies:**
   ```bash
   npm --prefix actor install
   ```

3. **Configure Candidate Profile:**
   - Customize `actor/src/profile.json` (or copy from `actor/src/profile.example.json`) with your personal details, education, experience, and target roles.
   - Place your resume in `resumes/` (see `resumes/sample_resume.md` for format).

4. **Environment Setup (Optional):**
   ```bash
   cp .env.example actor/.env
   ```
   Add any optional LLM keys (e.g. `OPENROUTER_API_KEY`) or configure them directly in the dashboard UI.

5. **Start the Dashboard:**
   ```bash
   npm --prefix actor start
   ```

Open [http://localhost:3000](http://localhost:3000) to access the interactive web dashboard.
