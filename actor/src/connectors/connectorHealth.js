/**
 * Real-time connector health tracking and registry.
 * Records status, last run, last success, exact errors, and jobs retrieved.
 */

const { runQuery, allQuery } = require('../db');

// In-memory status map initialized with standard connectors
const connectorStatusMap = new Map();

const REGISTERED_CONNECTORS = [
    { id: 'jobicy', name: 'Jobicy', type: 'API / Public Feed', category: 'Job Source' },
    { id: 'remotive', name: 'Remotive', type: 'MCP / Public API', category: 'Job Source' },
    { id: 'jobyap', name: 'JobYap', type: 'MCP / Aggregator', category: 'Job Source' },
    { id: 'greenhouse', name: 'Greenhouse ATS', type: 'Board API', category: 'Job Source' },
    { id: 'lever', name: 'Lever ATS', type: 'Board API', category: 'Job Source' },
    { id: 'ashby', name: 'Ashby ATS', type: 'Board API', category: 'Job Source' },
    { id: 'linkedin', name: 'LinkedIn Jobs', type: 'Apify / Public Feed', category: 'Job Source' },
    { id: 'naukri', name: 'Naukri Tech', type: 'Direct Adapter / Apify', category: 'Job Source' },
    { id: 'apify', name: 'Apify Store Actors', type: 'MCP / Actor Hub', category: 'Scraper / Crawler' },
    { id: 'firecrawl', name: 'Firecrawl', type: 'MCP / Career Scraper', category: 'Scraper / Crawler' },
    { id: 'playwright', name: 'Playwright Browser', type: 'Browser Automation', category: 'Automation' },
    { id: 'sheets_docs', name: 'Verified Sheets & Docs', type: 'Curated Tech Programs', category: 'Job Source' },
    { id: 'omniroute', name: 'OmniRoute AI Gateway', type: 'LLM Gateway', category: 'AI Intelligence' },
    { id: 'github', name: 'GitHubNew', type: 'Candidate Codebase', category: 'Candidate Data' },
    { id: 'render', name: 'Render', type: 'Candidate Deployments', category: 'Candidate Data' },
    { id: 'vercel', name: 'Vercel', type: 'Candidate Deployments', category: 'Candidate Data' },
    { id: 'supabase', name: 'Supabase', type: 'Candidate DB / Cloud', category: 'Candidate Data' },
    { id: 'prisma', name: 'Prisma Postgres', type: 'Candidate DB / Cloud', category: 'Candidate Data' },
    { id: 'happenstance', name: 'Happenstance Network', type: 'MCP / Referral Graph', category: 'Referrals' },
    { id: 'google_contacts', name: 'Google Contacts', type: 'MCP / Contacts', category: 'Referrals' },
    { id: 'google_drive', name: 'Google Drive', type: 'MCP / Documents', category: 'Candidate Data' },
    { id: 'google_calendar', name: 'Google Calendar', type: 'MCP / Events', category: 'Tracking' },
    { id: 'gmail', name: 'Gmail Intelligence', type: 'MCP / Email', category: 'Email Intelligence' }
];

// Initialize default statuses
REGISTERED_CONNECTORS.forEach(c => {
    connectorStatusMap.set(c.id, {
        id: c.id,
        name: c.name,
        type: c.type,
        category: c.category,
        status: 'WORKING', // WORKING, AUTHENTICATION REQUIRED, FAILED, NOT REGISTERED
        statusLabel: '✅ WORKING',
        lastRun: null,
        lastSuccess: null,
        lastError: null,
        jobsRetrieved: 0
    });
});

function recordConnectorStatus(connectorId, { status, error, jobsCount = 0 }) {
    const existing = connectorStatusMap.get(connectorId) || {
        id: connectorId,
        name: connectorId,
        type: 'Custom',
        category: 'Connector',
        jobsRetrieved: 0
    };

    const now = new Date().toISOString();
    existing.lastRun = now;

    if (status === 'WORKING' || status === 'SUCCESS') {
        existing.status = 'WORKING';
        existing.statusLabel = '✅ WORKING';
        existing.lastSuccess = now;
        existing.lastError = null;
        existing.jobsRetrieved = (existing.jobsRetrieved || 0) + (jobsCount || 0);
    } else if (status === 'AUTH_REQUIRED' || status === 'AUTHENTICATION_REQUIRED') {
        existing.status = 'AUTHENTICATION_REQUIRED';
        existing.statusLabel = '⚠️ AUTHENTICATION REQUIRED';
        existing.lastError = error ? String(error) : 'Authentication required or token expired';
    } else if (status === 'NOT_REGISTERED') {
        existing.status = 'NOT_REGISTERED';
        existing.statusLabel = '⚠️ NOT REGISTERED';
        existing.lastError = error ? String(error) : 'Connector is not registered or configured';
    } else {
        existing.status = 'FAILED';
        existing.statusLabel = '❌ FAILED';
        existing.lastError = error ? (typeof error === 'object' ? (error.message || JSON.stringify(error)) : String(error)) : 'Unknown execution error';
    }

    connectorStatusMap.set(connectorId, existing);

    // Async persist to DB
    runQuery(`
        INSERT INTO job_sources (id, name, type, enabled, status, last_scraped_at, last_success_at, last_error, jobs_retrieved, created_at)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            last_scraped_at = excluded.last_scraped_at,
            last_success_at = COALESCE(excluded.last_success_at, job_sources.last_success_at),
            last_error = excluded.last_error,
            jobs_retrieved = job_sources.jobs_retrieved + excluded.jobs_retrieved
    `, [
        existing.id,
        existing.name,
        existing.type,
        existing.status,
        existing.lastRun,
        existing.lastSuccess,
        existing.lastError,
        jobsCount,
        now
    ]).catch(() => {});
}

function getAllConnectorStatuses() {
    return Array.from(connectorStatusMap.values());
}

function getConnectorStatus(connectorId) {
    return connectorStatusMap.get(connectorId);
}

module.exports = {
    REGISTERED_CONNECTORS,
    recordConnectorStatus,
    getAllConnectorStatuses,
    getConnectorStatus
};
