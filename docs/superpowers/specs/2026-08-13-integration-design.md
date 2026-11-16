# Integration Design: Summer2027-Internships, ai-job-search, and browser-use

**Date:** 2026-08-13
**Author:** Claude Code
**Status:** Draft

## Overview
This design integrates Summer2027-Internships job listings, ai-job-search scoring logic, and browser-use Cloud API capabilities into the existing Node.js jobsearch system. The approach augments existing functionality while maintaining backward compatibility and providing cost-controlled automation upgrades.

## System Context

### Current Architecture
- **Discovery Layer**: `crawler.js` scrapes Greenhouse/Lever APIs + RSS feeds (WeWorkRemotely)
- **Scoring Layer**: `scanner.js` uses keyword matching for basic job scoring
- **Application Layer**: `apply.js` uses Playwright for Greenhouse/Lever form filling (deterministic)
- **Storage**: SQLite database (`actor/jobsearch.db`) with tables: `jobs`, `resume_versions`, `settings`
- **Front-end**: Vue.js dashboard (`actor/public/`) for monitoring and manual controls

### Integration Requirements
1. Add Summer2027-Internships (structured JSON, hourly updates)
2. Implement multi-factor scoring (relevance, uniqueness, cover-letter dependency)
3. Add browser-use for complex/unknown forms (controlled cost)
4. Maintain existing Greenhouse/Lever Playwright reliability
5. Ensure 100% backward compatibility for existing workflows

---

## 1. Discovery Layer Enhancements

### 1.1 Summer2027-Internships Scraper (`summer2027_scraper.js`)

**Purpose**: Extract structured job listings from Summer2027-Internships repository.

**Implementation Details**:
- **GitHub Token**: Required for accessing `listings.json` raw file
- **Authentication**: Bearer token in API headers
- **Retry Logic**: Exponential backoff with max 3 attempts
- **Error Handling**: Graceful fallback if token invalid
- **Data Format**: Expected JSON array with job objects containing: `job_id`, `title`, `company`, `location`, `deadline`, `category`, `requirements`, `apply_link`

**Integration Points**:
- `scanner.js`: Called via `await fetchSummer2027Jobs(process.env.SUMMER2027_TOKEN)`
- `crawler.js`: Integrated into `crawlJobs()` function when `targetCompanies` is provided

### 1.2 Discovery Process Flow
```
1. User triggers scan (via dashboard or `npm run scan`)
2. `scanner.js.runDiscoveryCycle()` orchestrates discovery
3. For each configured source:
   a. `greenhouse_scrape()` (existing)
   b. `lever_scrape()` (existing)
   c. `summer2027_scrape()` (new)
   d. `rss_scrape()` (existing)
4. Deduplicate by SHA256 hash of job URL
5. Store with source identifier and timestamp
```

---

## 2. Scoring Layer Enhancements

### 2.1 Multi-Factor Scoring (`ai_job_scorer.js`)

**Algorithm Components**:
- **Relevance Score (40%)**: Keyword overlap between job description and applicant skills
- **Uniqueness Score (30%)**: Inverse frequency of skills across the entire job pool
- **Cover-Letter Dependency (CLD) Score (30%)**: Criticality of resume lines for this specific role

**Calculation Example**:
```js
const relevance = calculateRelevanceScore(job, applicantProfile.keywords);
const uniqueness = calculateUniquenessScore(job.skills, allJobs);
const cld = calculateCLDependenceScore(job.description, tailoredResumeLines);

const finalScore = (relevance * 0.4) + (uniqueness * 0.3) + (cld * 0.3);
```

### 2.2 Scoring Integration

**Database Schema Updates**:
- `jobs` table: Add `source` column, `score` column
- Migration script included in deployment

**Scoring Workflow**:
```
1. Crawl → Store raw jobs in database
2. Apply enhanced scoring using `ai_job_scorer.js`
3. Store scores back to database
4. Frontend displays ranked results
5. Allow users to enable/disable scoring per preferences
```

---

## 3. Application Layer Enhancement

### 3.1 Browser-Use Integration (`browseruse_applier.js`)

**Purpose**: Handle complex/unknown forms that Playwright's hardcoded selectors cannot reliably complete.

**API Integration**:
- **Endpoint**: POST `https://api.browser-use.com/v1/runs`
- **Authentication**: `X-Browser-Use-API-Key` header
- **Pricing**: Free tier (100 requests/month), paid tiers available
- **Error Handling**: API failure triggers fallback to Playwright

**Implementation Details**:
```js
async function applyWithBrowserUse(job, applicant, pdfBuffer) {
  const { default: BrowserUseAPI } = await import('browser-use-sdk');
  
  const payload = {
    task: `Fill application for ${job.title} at ${job.company}`,
    data: JSON.stringify(applicant),
    pdf: pdfBuffer.toString('base64'),
    url: job.url,
    autoSubmit: autoSubmitFlag
  };
  
  try {
    const response = await BrowserUseAPI.run(payload);
    return { success: true, method: 'browser-use', ...response };
  } catch (apiError) {
    console.warn('Browser-use API failed, falling back to Playwright');
    return await autoApply(job.url, applicant, pdfBuffer);
  }
}
```

### 3.2 Application Selection Logic

**Platform Detection Strategy**:
```js
function selectApplicationMethod(jobUrl, jobPlatform) {
  switch (jobPlatform) {
    case 'greenhouse':
    case 'lever':
      return 'playwright';  // Most reliable for known platforms
    
    case 'workday':
    case 'unknown':
      return 'browser-use'; // AI intelligence needed
    
    default:
      // Smart heuristic based on form complexity
      return detectFormComplexity(jobUrl) > threshold ? 'browser-use' : 'playwright';
  }
}
```

---

## 4. Configuration Management

### 4.1 Environment Variables
```env
# Summer2027 access
SUMMER2027_TOKEN=your_github_personal_access_token

# Browser-Use API
BROWSER_USE_API_KEY=your_browseruse_api_key

# Cost controls
BROWSER_USE_MAX_REQUESTS_PER_MONTH=100
BROWSER_USE_FALLBACK_THRESHOLD=0.8  # Fallback to Playwright after X% failures

# Optional features
ENABLE_ADVANCED_SCORING=true
INTEGRATE_SUMMER2027=true
```

### 4.2 Feature Flags
- `integrate_summer2027`: Toggle Summer2027 source
- `enable_advanced_scoring`: Toggle multi-factor scoring
- `use_browseruse_for_complex`: Toggle browser-use fallback

---

## 5. Error Handling and Resilience

### 5.1 API Resilience
- **Browser-Use**: Exponential backoff with Jitter (1s, 2s, 4s, 8s)
- **GitHub Token**: Cache failures with retry after 24h
- **Database**: Retry on connection errors with max 3 attempts

### 5.2 Fallback Strategy
```
Browser-Use API fails → Fallback to Playwright
GitHub token invalid → Skip Summer2027, warn user
Scoring fails → Keep basic relevance score
Unknown form type → Use generic Playwright logic
```

### 5.3 Monitoring and Alerting
- API request rate monitoring (to stay within limits)
- Success/failure rates per application method
- Database operation latency alerts

---

## 6. User Interface Changes

### 6.1 Dashboard Enhancements
- Job source distribution chart (Greenhouse, Lever, Summer2027, RSS)
- Score breakdown visualization (Relevance/Uniqueness/CLD)
- Method usage indicator (Playwright vs Browser-Use per application)
- Cost tracking (Browser-Use API requests remaining/used)

### 6.2 New User Actions
- `/summer2027`: Manually trigger Summer2027 job discovery
- `/integrate-scoring`: Enable/disable advanced scoring
- `/test-browseruse`: Test Browser-Use integration

### 6.3 Settings Page
- API key management
- Request limits and alerts
- Source toggling

---

## 7. Testing Strategy

### 7.1 Unit Tests
- `summer2027_scraper`: Token validation, JSON parsing
- `ai_job_scorer`: Scoring algorithm accuracy
- `browseruse_applier`: API response parsing, fallback logic

### 7.2 Integration Tests
- End-to-end discovery → scoring → application pipeline
- API integration with mock responses
- Database schema migration testing

### 7.3 Performance Tests
- Application completion times by method
- API request rate limits and failures
- Memory usage during bulk operations

---

## 8. Deployment and Migration

### 8.1 Migration Steps
1. Pull latest code
2. Update `.env` with new keys
3. Run database migration script
4. Test new functionality
5. Gradual rollout (users can opt-in)

### 8.2 Rollback Plan
- Version-controlled database migrations
- Feature flag quick disable
- API key rotation capability

---

## 9. Security Considerations

### 9.1 API Keys
- Store GitHub token and Browser-Use API key in `.env` (not committed)
- Key rotation capability
- Alerting on unusual usage patterns

### 9.2 Data Privacy
- Resume data only sent to browser-use when explicitly requested
- Local AI processing for scoring (no external API calls)
- Encrypted database storage

---

## 10. Future Enhancements

### 10.1 Scalability
- Add more job sources (future repositories)
- Parallel processing of discovery tasks
- Caching layer for frequently accessed jobs

### 10.2 AI Enhancements
- Fine-tune scoring algorithms with historical data
- ML-based form complexity detection
- Automatic selector discovery for Playwright

### 10.3 Cost Optimization
- Predictive API usage based on application patterns
- Automated cleanup of old job listings
- Tiered feature pricing based on organization size

---

## Implementation Timeline

**Phase 1 (Week 1)**: Core discovery integration (Summer2027 scraper)
**Phase 2 (Week 2)**: Scoring layer implementation
**Phase 3 (Week 3)**: Browser-Use API integration
**Phase 4 (Week 4)**: Frontend enhancements and testing
**Phase 5 (Week 5)**: User training and documentation

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| API key exposure | Medium | High | Secure storage, rotation |
| Browser-Use API rate limits | Low | Medium | User-friendly alerts |
| Scoring algorithm accuracy | Low | Medium | Regular A/B testing |
| GitHub token invalidation | Medium | Medium | Alerting, fallback |
| Migration database issues | Low | High | Version control, backup |

---

## Conclusion

This integration delivers the best of all worlds:
- **Summer2027**: Expanded job source (500+ additional roles)
- **ai-job-search**: Professional-level scoring accuracy
- **browser-use**: Future-proof automation for unknown forms
- **Existing System**: Maintained reliability and cost control

The approach is conservative (high confidence in Playwright), incremental (opt-in features), and cost-aware (controlled Browser-Use usage).

---

*Design approved for implementation. Ready to proceed with Phase 1.*