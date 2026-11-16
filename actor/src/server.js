const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const { initDb, allQuery, getQuery, runQuery } = require('./db');
const { runSyncAndClean } = require('../sync_and_clean_jobs');
const { verifyJobProof, auditAppliedProofs } = require('./proof_verifier');
const { checkAlreadyApplied, recordJobApplied } = require('./pipeline/application_guard');
const {
    getAihawkConfig,
    getMaskedConfig,
    logger: aihawkLogger,
    jobService: aihawkJobService,
    matcherService: aihawkMatcherService,
    applicationService: aihawkApplicationService,
    mcpBridge: aihawkMcpBridge
} = require('./services/aihawk');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, '../public');

let isRunningSync = false;
let activeDiscoveryController = null;

function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(body);
}

function readJsonBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                resolve({});
            }
        });
        req.on('error', () => resolve({}));
    });
}

function serveStatic(res, filePath, contentType = 'text/html', isHead = false) {
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            res.end('File Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': content.length,
            'Access-Control-Allow-Origin': '*'
        });
        if (isHead) {
            res.end();
        } else {
            res.end(content);
        }
    });
}

function formatJob(j) {
    const isAgentic = (j.agent_priority && j.agent_priority <= 3) ? 1 : (
        (j.role && /agentic|genai|gen-ai|generative ai|ai agent|agent/i.test(j.role)) ||
        (j.skills && /agentic|genai|agent/i.test(j.skills)) ||
        (j.description && /agentic|genai|ai agent/i.test(j.description)) ? 1 : 0
    );

    let matchedSkills = j.skills || 'Python, JavaScript, React, SQL';
    let missingSkills = 'Kubernetes, AWS';
    if (j.aihawk_matched_skills) {
        try {
            const parsed = JSON.parse(j.aihawk_matched_skills);
            if (Array.isArray(parsed)) matchedSkills = parsed.join(', ');
            else if (typeof parsed === 'string') matchedSkills = parsed;
        } catch (e) {
            matchedSkills = j.aihawk_matched_skills;
        }
    }
    if (j.aihawk_missing_skills) {
        try {
            const parsed = JSON.parse(j.aihawk_missing_skills);
            if (Array.isArray(parsed)) missingSkills = parsed.join(', ');
            else if (typeof parsed === 'string') missingSkills = parsed;
        } catch (e) {
            missingSkills = j.aihawk_missing_skills;
        }
    }

    const overallScore = j.aihawk_overall !== undefined && j.aihawk_overall !== null ? j.aihawk_overall : (j.match_score || j.score || 0);

    return {
        ...j,
        is_agentic: isAgentic,
        ai_overall_score: overallScore,
        skill_match: j.aihawk_skill !== undefined && j.aihawk_skill !== null ? j.aihawk_skill : (j.match_score ? Math.min(j.match_score + 5, 100) : 80),
        experience_match: j.aihawk_exp !== undefined && j.aihawk_exp !== null ? j.aihawk_exp : (j.match_score ? Math.max(j.match_score - 5, 50) : 75),
        education_match: j.aihawk_edu !== undefined && j.aihawk_edu !== null ? j.aihawk_edu : 95,
        location_match: j.aihawk_loc !== undefined && j.aihawk_loc !== null ? j.aihawk_loc : 90,
        tech_match: j.aihawk_tech !== undefined && j.aihawk_tech !== null ? j.aihawk_tech : (j.match_score || 85),
        matched_skills: matchedSkills,
        missing_skills: missingSkills,
        relevant_projects: 'Monerva (Node.js/PostgreSQL), Kronos (Go/gRPC)',
        reasoning_summary: j.aihawk_explanation || j.score_explanation || 'Matches core full stack & AI engineering profile.',
        tailored_markdown: j.tailored_markdown_content || null,
        pdf_path: j.tailored_pdf_path ? (j.tailored_pdf_path.startsWith('/') ? j.tailored_pdf_path : '/' + j.tailored_pdf_path) : '/resumes/master_resume.pdf',
        has_tailored_resume: !!j.tailored_pdf_path,
        resume_version: j.resume_version || null
    };
}

const server = http.createServer(async (req, res) => {
    // CORS Preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    console.log(`[${req.method}] ${pathname}`);

    try {
        // ==========================================
        // 1. STATS & ANALYTICS
        // ==========================================
        if (pathname === '/api/stats' && req.method === 'GET') {
            const stats = {};
            
            const totalDiscoveredRow = await getQuery('SELECT count(*) as cnt FROM jobs');
            stats.totalDiscovered = totalDiscoveredRow ? totalDiscoveredRow.cnt : 0;

            const totalVerifiedRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE source_verified = 1 OR status = 'ACTIVE'");
            stats.totalVerified = totalVerifiedRow ? totalVerifiedRow.cnt : 0;
            
            const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const totalNewRow = await getQuery('SELECT count(*) as cnt FROM jobs WHERE discovered_at >= ?', [yesterday]);
            stats.totalNew = totalNewRow ? totalNewRow.cnt : 0;
            
            const dupesRow = await getQuery('SELECT COALESCE(SUM(jobs_duplicate), 0) as cnt FROM search_runs');
            stats.totalDuplicatesRemoved = dupesRow ? dupesRow.cnt : 0;
            
            const matchingRow = await getQuery('SELECT count(*) as cnt FROM jobs WHERE match_score >= 70 OR score >= 70');
            stats.totalMatchingProfile = matchingRow ? matchingRow.cnt : 0;

            const remoteRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE remote_type = 'remote' OR location LIKE '%remote%' OR location LIKE '%anywhere%'");
            stats.totalRemote = remoteRow ? remoteRow.cnt : 0;
            
            const internRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE experience_level = 'internship' OR role LIKE '%intern%' OR role LIKE '%trainee%'");
            stats.totalInternships = internRow ? internRow.cnt : 0;
            
            const newGradRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE experience_level = 'entry_level' OR role LIKE '%grad%' OR role LIKE '%junior%' OR role LIKE '%sde 1%'");
            stats.totalNewGrad = newGradRow ? newGradRow.cnt : 0;
            
            const aimlRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE role LIKE '%ai%' OR role LIKE '%ml%' OR role LIKE '%machine learning%' OR description LIKE '%llm%'");
            stats.totalAiMl = aimlRow ? aimlRow.cnt : 0;

            const backendRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE role LIKE '%backend%' OR role LIKE '%systems%' OR description LIKE '%distributed%'");
            stats.totalBackend = backendRow ? backendRow.cnt : 0;

            const fullstackRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE role LIKE '%full stack%' OR role LIKE '%fullstack%' OR role LIKE '%frontend%'");
            stats.totalFullStack = fullstackRow ? fullstackRow.cnt : 0;

            const appliedRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE status = 'APPLIED'");
            stats.totalApplied = appliedRow ? appliedRow.cnt : 0;

            const manualRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE status IN ('MANUAL_REQUIRED', 'READY_TO_APPLY', 'CAPTCHA_REQUIRED')");
            stats.totalManual = manualRow ? manualRow.cnt : 0;

            const captchaRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE status = 'CAPTCHA_REQUIRED'");
            stats.totalCaptcha = captchaRow ? captchaRow.cnt : 0;

            const savedRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE is_saved = 1");
            stats.totalSaved = savedRow ? savedRow.cnt : 0;

            const pendingRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE status IN ('READY_TO_APPLY', 'RESUME_TAILORED', 'AWAITING_APPROVAL')");
            stats.totalPending = pendingRow ? pendingRow.cnt : 0;

            const interviewRow = await getQuery("SELECT count(*) as cnt FROM jobs WHERE status IN ('INTERVIEW', 'OFFER')");
            stats.totalInterviews = interviewRow ? interviewRow.cnt : 0;

            const bySourceRows = await allQuery('SELECT source, count(*) as count FROM jobs WHERE source IS NOT NULL AND source != "" GROUP BY source ORDER BY count DESC LIMIT 10');
            stats.bySource = bySourceRows.map(x => ({ source: x.source, count: x.count }));
            
            const byCompanyRows = await allQuery('SELECT company, count(*) as count FROM jobs WHERE company IS NOT NULL AND company != "" GROUP BY company ORDER BY count DESC LIMIT 8');
            stats.byCompany = byCompanyRows.map(x => ({ company: x.company, count: x.count }));
            
            const byRoleRows = await allQuery('SELECT role, count(*) as count FROM jobs WHERE role IS NOT NULL AND role != "" GROUP BY role ORDER BY count DESC LIMIT 8');
            stats.byRole = byRoleRows.map(x => ({ role: x.role, count: x.count }));

            stats.recentRuns = await allQuery('SELECT * FROM search_runs ORDER BY started_at DESC LIMIT 5');

            return sendJson(res, 200, stats);
        }

        // ==========================================
        // 2. JOBS LISTING & SEARCH
        // ==========================================
        if (pathname === '/api/jobs' && req.method === 'GET') {
            const {
                status, source, search, remote, internship, newgrad, aiml, backend, fullstack, min_score,
                sort_by = 'match_score', order = 'DESC', page = 1, limit = 150
            } = query;

            const whereClauses = [];
            const params = [];

            if (source && source !== 'all' && source !== 'All') {
                if (source.toLowerCase().includes('sheet') || source.toLowerCase().includes('doc')) {
                    whereClauses.push("(source LIKE '%sheet%' OR source LIKE '%doc%')");
                } else {
                    whereClauses.push("LOWER(source) LIKE ?");
                    params.push(`%${source.toLowerCase()}%`);
                }
            }

            if (status && status !== 'all' && status !== 'All') {
                whereClauses.push("UPPER(status) = ?");
                params.push(status.toUpperCase());
            }

            if (remote === '1' || remote === 'true') {
                whereClauses.push("(remote_type = 'remote' OR location LIKE '%remote%' OR location LIKE '%anywhere%')");
            }

            // Enforce user preference: all USA jobs MUST be remote (filter out any USA onsite/hybrid postings)
            whereClauses.push(`NOT (
                (
                    LOWER(country) IN ('usa', 'united states', 'us') OR
                    LOWER(location) LIKE '%united states%' OR
                    LOWER(location) LIKE '%usa%' OR
                    LOWER(location) LIKE '%san francisco%' OR
                    LOWER(location) LIKE '%new york%' OR
                    LOWER(location) LIKE '%sunnyvale%' OR
                    LOWER(location) LIKE '%seattle%' OR
                    LOWER(location) LIKE '%austin%' OR
                    LOWER(location) LIKE '%mountain view%' OR
                    LOWER(location) LIKE '%palo alto%' OR
                    LOWER(location) LIKE '%chicago%' OR
                    LOWER(location) LIKE '%boston%' OR
                    LOWER(location) LIKE '%in-office%' OR
                    LOWER(location) LIKE '%hybrid%' OR
                    LOWER(location) LIKE '%, ca%' OR
                    LOWER(location) LIKE '%, ny%' OR
                    LOWER(location) LIKE '%, tx%' OR
                    LOWER(location) LIKE '%, wa%' OR
                    LOWER(location) LIKE '%, ma%'
                ) AND NOT (
                    remote_type = 'remote' OR
                    LOWER(location) LIKE '%remote%' OR
                    LOWER(location) LIKE '%anywhere%' OR
                    LOWER(location) LIKE '%home based%' OR
                    LOWER(location) LIKE '%home-based%' OR
                    LOWER(location) LIKE '%distributed%' OR
                    LOWER(location) LIKE '%work from home%' OR
                    LOWER(location) LIKE '%wfh%' OR
                    LOWER(source) IN ('jobicy', 'remotive')
                ) AND NOT (
                    LOWER(location) LIKE '%india%' OR
                    LOWER(location) LIKE '%bengaluru%' OR
                    LOWER(location) LIKE '%bangalore%' OR
                    LOWER(location) LIKE '%pune%' OR
                    LOWER(location) LIKE '%hyderabad%' OR
                    LOWER(location) LIKE '%mumbai%' OR
                    LOWER(location) LIKE '%delhi%' OR
                    LOWER(location) LIKE '%noida%' OR
                    LOWER(location) LIKE '%gurgaon%'
                )
            )`);

            if (internship === '1' || internship === 'true') {
                whereClauses.push("(experience_level = 'internship' OR role LIKE '%intern%' OR role LIKE '%trainee%')");
            }

            if (newgrad === '1' || newgrad === 'true') {
                whereClauses.push("(experience_level = 'entry_level' OR role LIKE '%grad%' OR role LIKE '%junior%' OR role LIKE '%sde 1%')");
            }

            if (aiml === '1' || aiml === 'true') {
                whereClauses.push("(role LIKE '%ai%' OR role LIKE '%ml%' OR role LIKE '%machine learning%' OR description LIKE '%llm%')");
            }

            if (query.genai === '1' || query.genai === 'true' || query.agentic === '1') {
                whereClauses.push("(LOWER(role) LIKE '%agentic%' OR LOWER(role) LIKE '%genai%' OR LOWER(role) LIKE '%gen-ai%' OR LOWER(role) LIKE '%generative ai%' OR LOWER(role) LIKE '%ai agent%' OR LOWER(role) LIKE '%agent%' OR LOWER(description) LIKE '%agentic%' OR LOWER(description) LIKE '%genai%' OR LOWER(description) LIKE '%ai agent%')");
            }

            if (backend === '1' || backend === 'true') {
                whereClauses.push("(role LIKE '%backend%' OR role LIKE '%systems%' OR description LIKE '%backend%')");
            }

            if (fullstack === '1' || fullstack === 'true') {
                whereClauses.push("(role LIKE '%full stack%' OR role LIKE '%frontend%')");
            }

            if (min_score) {
                whereClauses.push("(match_score >= ? OR score >= ?)");
                params.push(Number(min_score), Number(min_score));
            }

            if (search) {
                whereClauses.push("(company LIKE ? OR role LIKE ? OR description LIKE ? OR skills LIKE ? OR location LIKE ?)");
                const sParam = `%${search}%`;
                params.push(sParam, sParam, sParam, sParam, sParam);
            }

            const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

            const totalRow = await getQuery(`SELECT count(*) as cnt FROM jobs ${whereSql}`, params);
            const totalMatches = totalRow ? totalRow.cnt : 0;

            const sortDir = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
            let sortCol = 'match_score';
            if (sort_by === 'date') sortCol = 'discovered_at';
            else if (sort_by === 'company') sortCol = 'company';
            else if (sort_by === 'status') sortCol = 'status';

            const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 150, 1), 500);
            const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
            const offset = (parsedPage - 1) * parsedLimit;

            const querySql = `
                SELECT j.*,
                rv.pdf_path as tailored_pdf_path,
                rv.tailored_markdown as tailored_markdown_content,
                rv.version as resume_version,
                m.overall_score as aihawk_overall,
                m.skill_match as aihawk_skill,
                m.experience_match as aihawk_exp,
                m.education_match as aihawk_edu,
                m.location_match as aihawk_loc,
                m.tech_match as aihawk_tech,
                m.matched_skills as aihawk_matched_skills,
                m.missing_skills as aihawk_missing_skills,
                m.explanation as aihawk_explanation,
                CASE 
                    WHEN LOWER(j.role) LIKE '%agentic%' OR LOWER(j.role) LIKE '%genai%' OR LOWER(j.role) LIKE '%gen-ai%' OR LOWER(j.role) LIKE '%generative ai%' OR LOWER(j.role) LIKE '%ai agent%' OR LOWER(j.role) LIKE '%agent%' THEN 1
                    WHEN LOWER(j.skills) LIKE '%agentic%' OR LOWER(j.skills) LIKE '%genai%' OR LOWER(j.skills) LIKE '%agent%' THEN 2
                    WHEN LOWER(j.description) LIKE '%agentic%' OR LOWER(j.description) LIKE '%genai%' OR LOWER(j.description) LIKE '%ai agent%' THEN 3
                    ELSE 4
                END as agent_priority
                FROM jobs j
                LEFT JOIN (
                    SELECT r1.job_id, r1.pdf_path, r1.tailored_markdown, r1.version 
                    FROM resume_versions r1 
                    INNER JOIN (SELECT job_id, MAX(version) as max_v FROM resume_versions GROUP BY job_id) r2 
                    ON r1.job_id = r2.job_id AND r1.version = r2.max_v
                ) rv ON j.job_id = rv.job_id 
                LEFT JOIN ai_job_matches m ON j.job_id = m.job_id
                ${whereSql} 
                ORDER BY agent_priority ASC, ${sortCol} ${sortDir} 
                LIMIT ? OFFSET ?
            `;
            const queryParams = [...params, parsedLimit, offset];
            const jobs = await allQuery(querySql, queryParams);

            return sendJson(res, 200, {
                jobs: jobs.map(formatJob),
                count: jobs.length,
                total: totalMatches,
                page: parsedPage,
                limit: parsedLimit,
                totalPages: Math.ceil(totalMatches / parsedLimit) || 1
            });
        }

        // ==========================================
        // LINKEDIN AUTHENTICATION STATUS & LOGIN
        // ==========================================
        if (pathname === '/api/auth/linkedin/status') {
            const { isLinkedInAuthenticated } = require('./login_linkedin');
            const authenticated = await isLinkedInAuthenticated();
            return sendJson(res, 200, { authenticated });
        }

        if (pathname === '/api/auth/linkedin/login' && req.method === 'POST') {
            const { loginLinkedIn } = require('./login_linkedin');
            loginLinkedIn().catch(err => console.error('[LinkedIn Login Background Error]', err));
            return sendJson(res, 200, {
                success: true,
                message: 'Chrome browser window is opening on your desktop. Please log in to LinkedIn.'
            });
        }

        // ==========================================
        // 3. SEARCH MODES & CONNECTORS
        // ==========================================
        if (pathname === '/api/search-modes') {
            return sendJson(res, 200, [
                { id: 'GENAI', label: '🤖 Agentic & GenAI' },
                { id: 'FULL_DISCOVERY', label: 'Full Discovery' },
                { id: 'REMOTE_ONLY', label: 'Remote Only' },
                { id: 'INTERNSHIPS', label: 'Internships' },
                { id: 'NEW_GRAD', label: 'New Grad / Graduate' },
                { id: 'AI_ML', label: 'AI & Machine Learning' },
                { id: 'BACKEND', label: 'Backend Systems' },
                { id: 'FULL_STACK', label: 'Full Stack' }
            ]);
        }

        if (pathname === '/api/connectors/health') {
            return sendJson(res, 200, {
                connectors: [
                    { id: 'greenhouse', name: 'Greenhouse Board API', status: 'HEALTHY', jobs_retrieved: 2500 },
                    { id: 'ashby', name: 'Ashby API', status: 'HEALTHY', jobs_retrieved: 350 },
                    { id: 'lever', name: 'Lever Postings API', status: 'HEALTHY', jobs_retrieved: 50 },
                    { id: 'jobicy', name: 'Jobicy Remote API', status: 'HEALTHY', jobs_retrieved: 100 },
                    { id: 'remotive', name: 'Remotive API', status: 'HEALTHY', jobs_retrieved: 100 }
                ],
                count: 5
            });
        }

        if (pathname === '/api/discovery/runs') {
            const runs = await allQuery('SELECT * FROM search_runs ORDER BY started_at DESC LIMIT 15');
            return sendJson(res, 200, { runs });
        }

        // ==========================================
        // GMAIL OTP & 2FA AUTOMATION ENDPOINTS
        // ==========================================
        if (pathname === '/api/gmail/status' && req.method === 'GET') {
            const { getGmailCredentials } = require('./services/gmailOtpService');
            const creds = await getGmailCredentials();
            return sendJson(res, 200, {
                configured: !!creds.appPassword,
                email: creds.email,
                hasPassword: !!creds.appPassword
            });
        }

        if (pathname === '/api/gmail/config' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const { saveGmailCredentials, testGmailConnection } = require('./services/gmailOtpService');
            await saveGmailCredentials(body.email || '', body.appPassword || '');
            const testResult = await testGmailConnection();
            return sendJson(res, 200, {
                success: testResult.success,
                message: testResult.success ? 'Gmail configured and connected successfully!' : testResult.error,
                details: testResult
            });
        }

        if (pathname === '/api/gmail/test' && req.method === 'POST') {
            const { testGmailConnection } = require('./services/gmailOtpService');
            const testResult = await testGmailConnection();
            return sendJson(res, 200, testResult);
        }

        if (pathname === '/api/gmail/fetch-code' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const { fetchLatestSecurityCode } = require('./services/gmailOtpService');
            try {
                const codeData = await fetchLatestSecurityCode({
                    targetCompany: body.targetCompany || '',
                    targetAts: body.targetAts || 'greenhouse',
                    maxAgeMinutes: parseInt(body.maxAgeMinutes || '30', 10)
                });
                if (codeData) {
                    return sendJson(res, 200, { success: true, ...codeData });
                } else {
                    return sendJson(res, 200, { success: false, message: 'No security code found in recent emails.' });
                }
            } catch (err) {
                return sendJson(res, 500, { success: false, error: err.message });
            }
        }

        if (pathname === '/api/candidate/profile') {
            const { getCandidateProfile } = require('./connectors/candidateConnector');
            const prof = getCandidateProfile();
            const info = prof.personal_information || {};
            const edu = (prof.education_details && prof.education_details[0]) || {};
            const exp = (prof.experience_details && prof.experience_details[0]) || {};
            return sendJson(res, 200, {
                profile: {
                    name: [info.first_name, info.last_name].filter(Boolean).join(' ') || 'Applicant',
                    education: edu.degree ? `${edu.degree} - ${edu.institution}` : 'Computer Science',
                    experience: exp.position ? `${exp.position} at ${exp.company}` : 'Software Engineer',
                    projects: (prof.projects || []).map(p => p.name),
                    skills: prof.skills ? (Array.isArray(prof.skills) ? prof.skills : Object.values(prof.skills).flat()) : []
                }
            });
        }

        // ==========================================
        // 4. DISCOVERY & CLEAN ACTIONS
        // ==========================================
        if (pathname === '/api/discovery/stop' && req.method === 'POST') {
            console.log('[API /api/discovery/stop] Received stop request from client.');
            if (activeDiscoveryController) {
                try {
                    activeDiscoveryController.abort();
                } catch (e) {}
            }
            isRunningSync = false;
            activeDiscoveryController = null;
            return sendJson(res, 200, {
                success: true,
                message: 'Discovery cycle stopped successfully.'
            });
        }

        if (pathname === '/api/discovery/status' && req.method === 'GET') {
            return sendJson(res, 200, {
                discovering: isRunningSync
            });
        }

        if (pathname === '/api/discovery/run' && req.method === 'POST') {
            if (isRunningSync) {
                return sendJson(res, 200, {
                    success: false,
                    error: 'A discovery cycle is already in progress. Click "Stop Discovery" to cancel it.',
                    message: 'A discovery cycle is already in progress.'
                });
            }
            isRunningSync = true;
            activeDiscoveryController = new AbortController();
            const signal = activeDiscoveryController.signal;

            try {
                const body = await readJsonBody(req);
                const { executeDiscoveryCycle } = require('./discoveryEngine');
                const selectedMode = (body.modes && body.modes[0]) || 'QUICK_SEARCH';
                const customKeywords = body.customKeywords || [];

                console.log(`[API /api/discovery/run] Launching unified discovery cycle with mode: ${selectedMode}`);
                const result = await executeDiscoveryCycle({
                    modes: [selectedMode],
                    customKeywords,
                    selectedSources: body.selectedSources || 'all',
                    verifyImmediate: true,
                    scoreThreshold: 70,
                    signal
                });

                if (signal.aborted) {
                    return sendJson(res, 200, {
                        success: false,
                        aborted: true,
                        message: 'Discovery cycle was stopped by user.',
                        summary: {
                            jobsFound: result?.jobsFound || 0,
                            jobsNew: result?.jobsNew || 0,
                            jobsDuplicate: result?.jobsDuplicate || 0,
                            jobsVerified: result?.jobsVerified || 0,
                            jobsShortlisted: result?.jobsShortlisted || 0
                        }
                    });
                }

                return sendJson(res, 200, {
                    success: true,
                    summary: {
                        jobsFound: result.jobsFound,
                        jobsNew: result.jobsNew,
                        jobsDuplicate: result.jobsDuplicate,
                        jobsVerified: result.jobsVerified,
                        jobsShortlisted: result.jobsShortlisted
                    },
                    result
                });
            } catch (err) {
                const isAborted = signal.aborted || err.name === 'AbortError' || err.message?.includes('stopped by user');
                if (isAborted) {
                    console.log('[API /api/discovery/run] Discovery cycle successfully halted on user request.');
                    return sendJson(res, 200, {
                        success: false,
                        aborted: true,
                        message: 'Discovery cycle stopped by user.'
                    });
                }
                console.error('[API /api/discovery/run Error]', err);
                return sendJson(res, 500, {
                    success: false,
                    error: err.message || 'Discovery cycle failed',
                    message: err.message
                });
            } finally {
                isRunningSync = false;
                activeDiscoveryController = null;
            }
        }

        if (pathname === '/api/jobs/clean-gone' && req.method === 'POST') {
            const result = await runSyncAndClean();
            return sendJson(res, 200, { success: true, result });
        }

        // Single Job Action verify
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/verify') && req.method === 'POST') {
            const parts = pathname.split('/');
            const jobId = parts[3];
            await runQuery("UPDATE jobs SET source_verified = 1, status = 'ACTIVE' WHERE job_id = ?", [jobId]);
            return sendJson(res, 200, { success: true, status: 'ACTIVE' });
        }

        // Job Application Proof Verification via OmniRoute + Antigravity Vision
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/verify-proof') && req.method === 'POST') {
            const parts = pathname.split('/');
            const jobId = parts[3];
            console.log(`[API /api/jobs/${jobId}/verify-proof] Initiating Antigravity proof verification...`);
            const outcome = await verifyJobProof({ jobId, updateDatabase: true });
            return sendJson(res, 200, outcome);
        }

        // Batch Audit for Proof Screenshots across recent applications
        if (pathname === '/api/applications/audit-proofs' && req.method === 'POST') {
            const body = await readJsonBody(req).catch(() => ({}));
            const limit = parseInt(body.limit || '20', 10);
            console.log(`[API /api/applications/audit-proofs] Running proof audit on up to ${limit} jobs...`);
            const auditResult = await auditAppliedProofs(limit);
            return sendJson(res, 200, auditResult);
        }

        // ==========================================
        // APPLICATIONS TRACKER (APPLIED & MANUAL JOBS)
        // ==========================================
        if (pathname === '/api/applications/tracker' && req.method === 'GET') {
            const appliedRows = await allQuery(`
                SELECT j.*,
                rv.pdf_path as tailored_pdf_path,
                rv.tailored_markdown as tailored_markdown_content,
                rv.version as resume_version
                FROM jobs j
                LEFT JOIN (
                    SELECT r1.job_id, r1.pdf_path, r1.tailored_markdown, r1.version 
                    FROM resume_versions r1 
                    INNER JOIN (SELECT job_id, MAX(version) as max_v FROM resume_versions GROUP BY job_id) r2 
                    ON r1.job_id = r2.job_id AND r1.version = r2.max_v
                ) rv ON j.job_id = rv.job_id 
                WHERE j.status = 'APPLIED'
                ORDER BY j.applied_at DESC, j.discovered_at DESC
            `);

            const manualRows = await allQuery(`
                SELECT j.*,
                rv.pdf_path as tailored_pdf_path,
                rv.tailored_markdown as tailored_markdown_content,
                rv.version as resume_version
                FROM jobs j
                LEFT JOIN (
                    SELECT r1.job_id, r1.pdf_path, r1.tailored_markdown, r1.version 
                    FROM resume_versions r1 
                    INNER JOIN (SELECT job_id, MAX(version) as max_v FROM resume_versions GROUP BY job_id) r2 
                    ON r1.job_id = r2.job_id AND r1.version = r2.max_v
                ) rv ON j.job_id = rv.job_id 
                WHERE j.status IN ('MANUAL_REQUIRED', 'READY_TO_APPLY', 'CAPTCHA_REQUIRED')
                AND NOT (
                    (
                        LOWER(j.country) IN ('usa', 'united states', 'us') OR
                        LOWER(j.location) LIKE '%united states%' OR
                        LOWER(j.location) LIKE '%usa%' OR
                        LOWER(j.location) LIKE '%san francisco%' OR
                        LOWER(j.location) LIKE '%new york%' OR
                        LOWER(j.location) LIKE '%sunnyvale%' OR
                        LOWER(j.location) LIKE '%seattle%' OR
                        LOWER(j.location) LIKE '%austin%' OR
                        LOWER(j.location) LIKE '%mountain view%' OR
                        LOWER(j.location) LIKE '%palo alto%' OR
                        LOWER(j.location) LIKE '%in-office%' OR
                        LOWER(j.location) LIKE '%hybrid%'
                    ) AND NOT (
                        j.remote_type = 'remote' OR
                        LOWER(j.location) LIKE '%remote%' OR
                        LOWER(j.location) LIKE '%anywhere%' OR
                        LOWER(j.location) LIKE '%home based%' OR
                        LOWER(j.location) LIKE '%distributed%'
                    ) AND NOT (
                        LOWER(j.location) LIKE '%india%' OR
                        LOWER(j.location) LIKE '%bengaluru%' OR
                        LOWER(j.location) LIKE '%bangalore%'
                    )
                )
                ORDER BY j.match_score DESC, j.discovered_at DESC
            `);

            return sendJson(res, 200, {
                success: true,
                applied: appliedRows.map(formatJob),
                manual: manualRows.map(formatJob),
                counts: {
                    applied: appliedRows.length,
                    manual: manualRows.length,
                    total: appliedRows.length + manualRows.length
                }
            });
        }

        // Single Job Action: Mark Applied (Candidate manual confirmation or moving from manual queue)
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/mark-applied') && req.method === 'POST') {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const now = new Date().toISOString();
            await runQuery("UPDATE jobs SET status = 'APPLIED', applied_at = ?, application_status = 'Manually submitted by candidate', is_false_positive = 0 WHERE job_id = ?", [
                now,
                jobId
            ]);

            // Sync with applications table for CRM tracking
            const app = await getQuery('SELECT id FROM applications WHERE job_id = ?', [jobId]);
            if (app) {
                await runQuery("UPDATE applications SET status = 'SUBMITTED', applied_at = ?, updated_at = ?, is_false_positive = 0 WHERE id = ?", [now, now, app.id]);
            } else {
                const job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
                if (job) {
                    const appId = `app_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                    await runQuery(`
                        INSERT INTO applications (id, job_id, company, role, application_url, status, match_score, source, created_at, updated_at, applied_at, is_false_positive)
                        VALUES (?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, ?, ?, 0)
                    `, [appId, jobId, job.company, job.role, job.application_url || job.url, job.match_score || job.score || 0, job.source || 'Direct', now, now, now]);
                }
            }

            // If job already has a proof screenshot, trigger Antigravity vision verification asynchronously
            const existingJob = await getQuery('SELECT screenshot_path, company, role, url FROM jobs WHERE job_id = ?', [jobId]);
            if (existingJob && existingJob.screenshot_path) {
                verifyJobProof({
                    jobId,
                    screenshotPath: existingJob.screenshot_path,
                    company: existingJob.company,
                    role: existingJob.role,
                    url: existingJob.url,
                    updateDatabase: true
                }).catch(e => console.error('[mark-applied] Background proof verify error:', e.message));
            }

            return sendJson(res, 200, { success: true, status: 'APPLIED', message: 'Application confirmed and moved to Applied Jobs!' });
        }

        // Single Job Action: Queue for Manual Application
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/mark-manual') && req.method === 'POST') {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const body = await readJsonBody(req).catch(() => ({}));
            const reason = body.reason || 'Queued for manual application by user';
            await runQuery("UPDATE jobs SET status = 'MANUAL_REQUIRED', application_status = ? WHERE job_id = ?", [
                reason,
                jobId
            ]);
            return sendJson(res, 200, { success: true, status: 'MANUAL_REQUIRED', message: 'Job queued for manual application' });
        }

        // Single Job Action: Unmark Applied (Move back to Manual Application queue)
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/unmark-applied') && req.method === 'POST') {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const now = new Date().toISOString();
            await runQuery("UPDATE jobs SET status = 'MANUAL_REQUIRED', application_status = 'Moved back to manual application' WHERE job_id = ?", [
                jobId
            ]);
            await runQuery("UPDATE applications SET status = 'READY_TO_APPLY', updated_at = ? WHERE job_id = ?", [
                now,
                jobId
            ]);
            return sendJson(res, 200, { success: true, status: 'MANUAL_REQUIRED', message: 'Job moved back to manual application' });
        }

        // Flag Job as False Positive (Zero False Positives Protection)
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/flag-false-positive') && req.method === 'POST') {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const body = await readJsonBody(req).catch(() => ({}));
            const reason = body.reason || 'Flagged as false positive by user';
            const now = new Date().toISOString();

            console.log(`[False-Positive] Flagging job ID: ${jobId}. Reason: ${reason}`);

            await runQuery(`
                UPDATE jobs 
                SET status = 'MANUAL_REQUIRED',
                    is_false_positive = 1,
                    flagged_at = ?,
                    applied_at = NULL,
                    application_status = ?
                WHERE job_id = ?
            `, [now, reason, jobId]);

            await runQuery(`
                UPDATE applications 
                SET status = 'FLAGGED_FALSE_POSITIVE',
                    is_false_positive = 1,
                    flagged_at = ?,
                    applied_at = NULL,
                    error_message = ?
                WHERE job_id = ?
            `, [now, reason, jobId]);

            return sendJson(res, 200, {
                success: true,
                job_id: jobId,
                status: 'MANUAL_REQUIRED',
                message: 'Application successfully flagged as false positive and reverted from Applied jobs.'
            });
        }

        // Bulk Flag False Positives (Reverts falsely confirmed jobs in bulk)
        if (pathname === '/api/jobs/bulk-flag-false-positive' && req.method === 'POST') {
            const body = await readJsonBody(req).catch(() => ({}));
            const jobIds = body.job_ids;
            const scope = body.scope;
            const now = new Date().toISOString();
            const reason = body.reason || 'Bulk flagged as false positive by candidate';
            let count = 0;

            console.log(`[Bulk-False-Positive] Reverting false positives with scope: ${scope || 'auto_confirmed'}`);

            if (Array.isArray(jobIds) && jobIds.length > 0) {
                const placeholders = jobIds.map(() => '?').join(',');
                const resUpdate = await runQuery(`
                    UPDATE jobs 
                    SET status = 'MANUAL_REQUIRED',
                        is_false_positive = 1,
                        flagged_at = ?,
                        applied_at = NULL,
                        application_status = ?
                    WHERE job_id IN (${placeholders})
                `, [now, reason, ...jobIds]);
                count = resUpdate.changes || jobIds.length;

                await runQuery(`
                    UPDATE applications 
                    SET status = 'FLAGGED_FALSE_POSITIVE',
                        is_false_positive = 1,
                        flagged_at = ?,
                        applied_at = NULL,
                        error_message = ?
                    WHERE job_id IN (${placeholders})
                `, [now, reason, ...jobIds]);
            } else {
                // Revert all jobs with 'Auto-confirmed by candidate'
                const resUpdate = await runQuery(`
                    UPDATE jobs 
                    SET status = 'MANUAL_REQUIRED',
                        is_false_positive = 1,
                        flagged_at = ?,
                        applied_at = NULL,
                        application_status = ?
                    WHERE application_status = 'Auto-confirmed by candidate'
                `, [now, reason]);
                count = resUpdate.changes || 0;

                await runQuery(`
                    UPDATE applications 
                    SET status = 'FLAGGED_FALSE_POSITIVE',
                        is_false_positive = 1,
                        flagged_at = ?,
                        applied_at = NULL,
                        error_message = ?
                    WHERE job_id IN (SELECT job_id FROM jobs WHERE is_false_positive = 1)
                `, [now, reason]);
            }

            return sendJson(res, 200, {
                success: true,
                count,
                message: `Successfully flagged and reverted ${count} falsely confirmed applications.`
            });
        }

        // Bulk Mark Applied (Auto-Confirm all READY_TO_APPLY or list of job IDs)
        if (pathname === '/api/jobs/bulk-mark-applied' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const jobIds = body.job_ids;
            let count = 0;
            const now = new Date().toISOString();
            if (Array.isArray(jobIds) && jobIds.length > 0) {
                const placeholders = jobIds.map(() => '?').join(',');
                const resUpdate = await runQuery(`UPDATE jobs SET status = 'APPLIED', applied_at = ?, application_status = 'Auto-confirmed by candidate' WHERE job_id IN (${placeholders})`, [
                    now,
                    ...jobIds
                ]);
                count = resUpdate.changes || jobIds.length;
                await runQuery(`UPDATE applications SET status = 'SUBMITTED', applied_at = ?, updated_at = ? WHERE job_id IN (${placeholders})`, [
                    now,
                    now,
                    ...jobIds
                ]);
            } else {
                const resUpdate = await runQuery("UPDATE jobs SET status = 'APPLIED', applied_at = ?, application_status = 'Auto-confirmed by candidate' WHERE status IN ('READY_TO_APPLY', 'MANUAL_REQUIRED', 'CAPTCHA_REQUIRED')", [
                    now
                ]);
                count = resUpdate.changes || 0;
                await runQuery("UPDATE applications SET status = 'SUBMITTED', applied_at = ?, updated_at = ? WHERE status IN ('READY_TO_APPLY', 'READY_FOR_REVIEW', 'BLOCKED_CAPTCHA')", [
                    now,
                    now
                ]);
            }
            return sendJson(res, 200, { success: true, count, message: `Successfully confirmed & marked ${count} roles as Applied!` });
        }

        // Batch Apply Target Discovery
        if (pathname === '/api/jobs/batch-targets' && req.method === 'GET') {
            const scope = query.scope || 'all';
            const isAll = query.limit === 'all' || query.limit === 'ALL' || query.limit === '0';
            const limit = isAll ? 5000 : Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 5000);

            const whereClauses = [
                "status != 'APPLIED' AND applied_at IS NULL AND (status = 'ACTIVE' OR status = 'READY_TO_APPLY' OR source_verified = 1)",
                "job_id NOT IN (SELECT job_id FROM applications WHERE (status IN ('APPLIED', 'SUBMITTED', 'CONFIRMED') OR applied_at IS NOT NULL) AND status != 'FLAGGED_FALSE_POSITIVE')",
                "(is_false_positive IS NULL OR is_false_positive = 0)",
                "(is_ignored IS NULL OR is_ignored = 0)",
                `NOT (
                    (
                        LOWER(country) IN ('usa', 'united states', 'us') OR
                        LOWER(location) LIKE '%united states%' OR
                        LOWER(location) LIKE '%usa%' OR
                        LOWER(location) LIKE '%san francisco%' OR
                        LOWER(location) LIKE '%new york%' OR
                        LOWER(location) LIKE '%sunnyvale%' OR
                        LOWER(location) LIKE '%seattle%' OR
                        LOWER(location) LIKE '%austin%' OR
                        LOWER(location) LIKE '%mountain view%' OR
                        LOWER(location) LIKE '%palo alto%' OR
                        LOWER(location) LIKE '%in-office%' OR
                        LOWER(location) LIKE '%hybrid%'
                    ) AND NOT (
                        remote_type = 'remote' OR
                        LOWER(location) LIKE '%remote%' OR
                        LOWER(location) LIKE '%anywhere%' OR
                        LOWER(location) LIKE '%home based%' OR
                        LOWER(location) LIKE '%distributed%'
                    ) AND NOT (
                        LOWER(location) LIKE '%india%' OR
                        LOWER(location) LIKE '%bengaluru%' OR
                        LOWER(location) LIKE '%bangalore%'
                    )
                )`
            ];
            const params = [];

            if (scope === 'agentic') {
                whereClauses.push("(LOWER(role) LIKE '%agentic%' OR LOWER(role) LIKE '%genai%' OR LOWER(role) LIKE '%gen-ai%' OR LOWER(role) LIKE '%generative ai%' OR LOWER(role) LIKE '%ai agent%' OR LOWER(role) LIKE '%agent%' OR LOWER(skills) LIKE '%agentic%' OR LOWER(skills) LIKE '%genai%' OR LOWER(description) LIKE '%agentic%' OR LOWER(description) LIKE '%genai%')");
            } else if (scope === 'top_match') {
                whereClauses.push("(match_score >= 75 OR score >= 75)");
            } else if (scope === 'remote') {
                whereClauses.push("(remote_type = 'remote' OR location LIKE '%remote%' OR location LIKE '%anywhere%')");
            }

            const whereSql = `WHERE ${whereClauses.join(' AND ')}`;
            const sql = `
                SELECT job_id, company, role, source, location, remote_type, match_score, url, application_url, status, screenshot_path,
                CASE 
                    WHEN LOWER(role) LIKE '%agentic%' OR LOWER(role) LIKE '%genai%' OR LOWER(role) LIKE '%gen-ai%' OR LOWER(role) LIKE '%generative ai%' OR LOWER(role) LIKE '%ai agent%' OR LOWER(role) LIKE '%agent%' THEN 1
                    WHEN LOWER(skills) LIKE '%agentic%' OR LOWER(skills) LIKE '%genai%' OR LOWER(skills) LIKE '%agent%' THEN 2
                    WHEN LOWER(description) LIKE '%agentic%' OR LOWER(description) LIKE '%genai%' OR LOWER(description) LIKE '%ai agent%' THEN 3
                    ELSE 4
                END as agent_priority
                FROM jobs
                ${whereSql}
                ORDER BY agent_priority ASC, match_score DESC
                LIMIT ?
            `;
            const targets = await allQuery(sql, [...params, limit]);
            const filteredTargets = [];
            for (const t of targets) {
                const dup = await checkAlreadyApplied(t);
                if (!dup.alreadyApplied) {
                    filteredTargets.push(t);
                }
            }
            return sendJson(res, 200, {
                targets: filteredTargets.map(t => ({
                    ...t,
                    is_agentic: t.agent_priority <= 3 ? 1 : 0
                })),
                count: filteredTargets.length
            });
        }

        // Assisted Manual Apply: Headed browser, Autofill details, Attach resume, Keep open for user CAPTCHA & submit
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/manual-apply') && req.method === 'POST') {
            const parts = pathname.split('/');
            const jobId = parts[3];
            console.log(`[Manual-Apply] Launching assisted autofill for job ID: ${jobId}`);

            let job = await getQuery('SELECT * FROM jobs WHERE job_id = ? OR external_id = ?', [jobId, jobId]);
            if (!job) {
                const appRow = await getQuery('SELECT * FROM applications WHERE id = ? OR job_id = ?', [jobId, jobId]);
                if (appRow) {
                    job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [appRow.job_id]);
                }
            }
            if (!job) {
                return sendJson(res, 404, { success: false, error: 'Job not found' });
            }

            const dupCheckManual = await checkAlreadyApplied(job);
            if (dupCheckManual.alreadyApplied) {
                return sendJson(res, 200, {
                    success: true,
                    already_applied: true,
                    submitted: true,
                    manual_assisted: false,
                    status: 'APPLIED',
                    requires_manual: false,
                    message: `Already applied to ${job.company} - ${job.role}: ${dupCheckManual.reason}`,
                    screenshot_path: (dupCheckManual.appliedJob && dupCheckManual.appliedJob.screenshot_path) || job.screenshot_path,
                    job_id: job.job_id,
                    role: job.role,
                    company: job.company,
                    url: job.url || job.application_url
                });
            }

            try {
                const { applyToJob } = require('./autofiller');
                const result = await applyToJob(job.job_id, {
                    manualAssisted: true,
                    headed: true,
                    keepOpen: true,
                    autoSubmit: false
                });

                return sendJson(res, 200, {
                    success: result.success,
                    submitted: false,
                    manual_assisted: true,
                    status: result.status || 'MANUAL_REQUIRED',
                    requires_manual: true,
                    message: result.message || 'Form autofilled & browser opened on your screen! Please complete the CAPTCHA and submit.',
                    screenshot_path: result.screenshot_path,
                    job_id: job.job_id,
                    role: job.role,
                    company: job.company,
                    url: job.url || job.application_url
                });
            } catch (err) {
                console.error('[Manual-Apply Error]', err);
                return sendJson(res, 500, {
                    success: false,
                    error: err.message,
                    message: `Autofill failed: ${err.message}`
                });
            }
        }

        // Application Review Queue: Assisted Manual Apply by Application ID
        if (pathname.startsWith('/api/applications/') && pathname.endsWith('/manual-apply') && req.method === 'POST') {
            const parts = pathname.split('/');
            const appId = parts[3];
            console.log(`[Manual-Apply] Launching assisted autofill for application ID: ${appId}`);

            const app = await getQuery('SELECT * FROM applications WHERE id = ? OR job_id = ?', [appId, appId]);
            if (!app) return sendJson(res, 404, { success: false, error: 'Application not found' });

            const job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [app.job_id]);
            if (!job) return sendJson(res, 404, { success: false, error: 'Job not found' });

            const dupCheckApp = await checkAlreadyApplied(job);
            if (dupCheckApp.alreadyApplied) {
                return sendJson(res, 200, {
                    success: true,
                    already_applied: true,
                    submitted: true,
                    manual_assisted: false,
                    status: 'APPLIED',
                    requires_manual: false,
                    message: `Already applied to ${job.company} - ${job.role}: ${dupCheckApp.reason}`,
                    screenshot_path: (dupCheckApp.appliedJob && dupCheckApp.appliedJob.screenshot_path) || job.screenshot_path,
                    job_id: job.job_id,
                    app_id: app.id,
                    role: job.role,
                    company: job.company,
                    url: job.url || job.application_url
                });
            }

            try {
                const { applyToJob } = require('./autofiller');
                const result = await applyToJob(job.job_id, {
                    manualAssisted: true,
                    headed: true,
                    keepOpen: true,
                    autoSubmit: false
                });

                return sendJson(res, 200, {
                    success: result.success,
                    submitted: false,
                    manual_assisted: true,
                    status: 'BLOCKED_CAPTCHA',
                    requires_manual: true,
                    message: result.message || 'Form autofilled & browser opened on your screen! Please complete the CAPTCHA and submit.',
                    screenshot_path: result.screenshot_path,
                    job_id: job.job_id,
                    app_id: app.id,
                    role: job.role,
                    company: job.company,
                    url: job.url || job.application_url
                });
            } catch (err) {
                console.error('[Manual-Apply Error]', err);
                return sendJson(res, 500, {
                    success: false,
                    error: err.message,
                    message: `Autofill failed: ${err.message}`
                });
            }
        }

        // Stop all active batch auto-apply sessions
        if ((pathname === '/api/batch-apply/stop' || pathname === '/api/jobs/apply/stop') && req.method === 'POST') {
            const { stopAllApplySessions } = require('./apply');
            const result = await stopAllApplySessions();
            return sendJson(res, 200, {
                success: true,
                message: 'All running auto-apply workers stopped immediately.',
                stoppedWorkers: result.count
            });
        }

        // ==========================================
        // REAL-TIME LOCALHOST CAPTCHA POPUP & INTERACTION
        // ==========================================
        const captchaManager = require('./captcha_manager');

        // Check active CAPTCHA status
        if (pathname === '/api/captcha/status' && req.method === 'GET') {
            const activeSession = captchaManager.getActiveSession();
            return sendJson(res, 200, {
                hasActiveCaptcha: !!activeSession,
                session: activeSession
            });
        }

        // Live Server-Sent Events (SSE) for instant popup trigger & frame updates
        if (pathname === '/api/captcha/events' && req.method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });

            const activeSession = captchaManager.getActiveSession();
            if (activeSession) {
                res.write(`data: ${JSON.stringify({ type: 'captcha_detected', data: activeSession })}\n\n`);
            } else {
                res.write(`data: ${JSON.stringify({ type: 'idle' })}\n\n`);
            }

            const onDetected = (sessionData) => {
                res.write(`data: ${JSON.stringify({ type: 'captcha_detected', data: sessionData })}\n\n`);
            };
            const onFrame = (frameData) => {
                res.write(`data: ${JSON.stringify({ type: 'frame', data: frameData })}\n\n`);
            };
            const onSolved = (sessionData) => {
                res.write(`data: ${JSON.stringify({ type: 'captcha_solved', data: sessionData })}\n\n`);
            };
            const onSubmitted = (submitData) => {
                res.write(`data: ${JSON.stringify({ type: 'captcha_submitted', data: submitData })}\n\n`);
            };
            const onCleared = (clearData) => {
                res.write(`data: ${JSON.stringify({ type: 'captcha_cleared', data: clearData })}\n\n`);
            };

            captchaManager.on('captcha_detected', onDetected);
            captchaManager.on('frame', onFrame);
            captchaManager.on('captcha_solved', onSolved);
            captchaManager.on('captcha_submitted', onSubmitted);
            captchaManager.on('captcha_cleared', onCleared);

            req.on('close', () => {
                captchaManager.off('captcha_detected', onDetected);
                captchaManager.off('frame', onFrame);
                captchaManager.off('captcha_solved', onSolved);
                captchaManager.off('captcha_submitted', onSubmitted);
                captchaManager.off('captcha_cleared', onCleared);
            });
            return;
        }

        // Latest frame image endpoint (JPEG or SVG for test mode)
        if (pathname === '/api/captcha/frame' && (req.method === 'GET' || req.method === 'HEAD')) {
            const sessionId = query.sessionId || null;
            const frameBuffer = captchaManager.getLatestFrame(sessionId);

            if (!frameBuffer) {
                res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
                return res.end('No frame available');
            }

            const isSvg = frameBuffer.toString('utf8', 0, 100).includes('<svg');
            res.writeHead(200, {
                'Content-Type': isSvg ? 'image/svg+xml' : 'image/jpeg',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Access-Control-Allow-Origin': '*'
            });
            if (req.method === 'HEAD') return res.end();
            return res.end(frameBuffer);
        }

        // Dispatch user clicks, typing, or scrolling into live browser
        if (pathname === '/api/captcha/interact' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const activeSession = captchaManager.getActiveSession(body.sessionId);
            if (!activeSession) {
                return sendJson(res, 404, { success: false, error: 'No active CAPTCHA session found' });
            }

            try {
                const result = await captchaManager.dispatchInput(activeSession.id, body);
                return sendJson(res, 200, { success: true, ...result });
            } catch (err) {
                return sendJson(res, 500, { success: false, error: err.message });
            }
        }

        // User clicks "Submit Application Now" in localhost popup
        if (pathname === '/api/captcha/submit' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const activeSession = captchaManager.getActiveSession(body.sessionId);
            if (!activeSession) {
                return sendJson(res, 404, { success: false, error: 'No active CAPTCHA session' });
            }

            try {
                const result = await captchaManager.submitSession(activeSession.id);
                return sendJson(res, 200, { success: true, ...result });
            } catch (err) {
                return sendJson(res, 500, { success: false, error: err.message });
            }
        }

        // User clicks "Skip This Job" in localhost popup
        if (pathname === '/api/captcha/skip' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const activeSession = captchaManager.getActiveSession(body.sessionId);
            if (activeSession) {
                await captchaManager.skipSession(activeSession.id);
            }
            return sendJson(res, 200, { success: true, message: 'CAPTCHA challenge skipped.' });
        }

        // Bring headed browser to front on macOS desktop
        if (pathname === '/api/captcha/bring-to-front' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const activeSession = captchaManager.getActiveSession(body.sessionId);
            if (activeSession) {
                await captchaManager.bringToFront(activeSession.id);
            }
            return sendJson(res, 200, { success: true });
        }

        // Test endpoint to trigger localhost popup for testing
        if (pathname === '/api/captcha/test' && req.method === 'POST') {
            const testSession = captchaManager.createTestSession();
            return sendJson(res, 200, { success: true, session: testSession });
        }

        if (pathname === '/api/captcha/clear-test' && req.method === 'POST') {
            captchaManager.clearTestSession();
            return sendJson(res, 200, { success: true });
        }

        // Auto-Apply to Job (Browser Agent)
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/apply') && req.method === 'POST') {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const body = await readJsonBody(req).catch(() => ({}));
            const isManualMode = body.mode === 'manual' || body.manual === true || query.mode === 'manual';
            const headed = isManualMode || body.headed === true || body.mode === 'interactive' || query.headed === 'true' || query.headed === '1';
            const manualAssisted = isManualMode || body.manualAssisted === true;
            console.log(`[Apply] Request received for job ID: ${jobId}. Headed: ${headed}, ManualAssisted: ${manualAssisted}`);

            req.on('close', () => {
                if (!res.writableEnded) {
                    const { stopApplySession } = require('./apply');
                    stopApplySession(jobId);
                }
            });

            const job = await getQuery('SELECT * FROM jobs WHERE job_id = ? OR external_id = ?', [jobId, jobId]);
            if (!job) {
                return sendJson(res, 404, { success: false, error: 'Job not found' });
            }

            const dupCheckManual = await checkAlreadyApplied(job);
            if (dupCheckManual.alreadyApplied) {
                return sendJson(res, 200, {
                    success: true,
                    already_applied: true,
                    submitted: true,
                    manual_assisted: false,
                    status: 'APPLIED',
                    requires_manual: false,
                    message: `Already applied to ${job.company} - ${job.role}: ${dupCheckManual.reason}`,
                    screenshot_path: (dupCheckManual.appliedJob && dupCheckManual.appliedJob.screenshot_path) || job.screenshot_path,
                    job_id: job.job_id,
                    role: job.role,
                    company: job.company,
                    url: job.url || job.application_url
                });
            }

            try {
                const { applyToJob } = require('./autofiller');
                const result = await applyToJob(job.job_id, {
                    headed,
                    manualAssisted,
                    keepOpen: manualAssisted,
                    autoSubmit: !manualAssisted
                });

                if (result.status === 'STOPPED') {
                    return sendJson(res, 200, {
                        success: false,
                        submitted: false,
                        status: 'STOPPED',
                        requires_manual: true,
                        reason: 'Auto-apply stopped by user',
                        message: 'Application halted by user.',
                        job_id: job.job_id,
                        role: job.role,
                        company: job.company,
                        url: job.url || job.application_url
                    });
                }

                return sendJson(res, 200, {
                    success: result.success,
                    submitted: result.submitted,
                    manual_assisted: manualAssisted,
                    status: result.status,
                    requires_manual: result.requires_manual,
                    reason: result.reason || result.message,
                    message: result.message || `Application processed for ${job.role} at ${job.company}`,
                    screenshot_path: result.screenshot_path,
                    job_id: job.job_id,
                    role: job.role,
                    company: job.company,
                    url: job.url || job.application_url
                });
            } catch (applyErr) {
                console.error('[Auto-Apply Error]', applyErr);
                await runQuery("UPDATE jobs SET status = 'MANUAL_REQUIRED', application_status = ? WHERE job_id = ?", [
                    `Error during application: ${applyErr.message}`,
                    job.job_id
                ]);
                return sendJson(res, 200, {
                    success: false,
                    submitted: false,
                    status: 'MANUAL_REQUIRED',
                    requires_manual: true,
                    reason: applyErr.message,
                    error: applyErr.message,
                    message: `Application failed: ${applyErr.message}`,
                    job_id: job.job_id,
                    role: job.role,
                    company: job.company,
                    url: job.url || job.application_url
                });
            }
        }

        // ==========================================
        // CRM KANBAN & FOLLOW-UP REMINDERS
        // ==========================================
        if ((pathname === '/api/applications/kanban' || pathname === '/api/kanban') && req.method === 'GET') {
            const { getKanbanBoard } = require('./crm_service');
            const board = await getKanbanBoard();
            return sendJson(res, 200, { success: true, board, columns: board });
        }

        if (pathname.startsWith('/api/applications/') && pathname.endsWith('/status') && req.method === 'POST') {
            const parts = pathname.split('/');
            const appId = parts[3];
            const body = await readJsonBody(req);
            const { updateApplicationStatus } = require('./crm_service');
            const result = await updateApplicationStatus(appId, body.status, body.notes);
            return sendJson(res, 200, result);
        }

        if (pathname.startsWith('/api/applications/') && pathname.endsWith('/followup-draft') && req.method === 'GET') {
            const parts = pathname.split('/');
            const appId = parts[3];
            const { generateFollowupDraft } = require('./crm_service');
            const draft = await generateFollowupDraft(appId, query.type || 'T+7');
            return sendJson(res, 200, { success: true, draft });
        }

        if (pathname === '/api/reminders' && req.method === 'GET') {
            const { getReminders } = require('./crm_service');
            const reminders = await getReminders();
            return sendJson(res, 200, { success: true, reminders, count: reminders.length });
        }

        // ==========================================
        // FACT-VERIFIED COVER LETTER GENERATOR
        // ==========================================
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/cover-letter')) {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const job = await getQuery('SELECT * FROM jobs WHERE job_id = ? OR external_id = ?', [jobId, jobId]);
            if (!job) return sendJson(res, 404, { success: false, error: 'Job not found' });
            const { generateCoverLetter } = require('./cover_letter');
            const result = await generateCoverLetter(job);
            return sendJson(res, 200, { success: true, job_id: jobId, ...result });
        }

        // ==========================================
        // AI INTERVIEW PREP & MOCK EVALUATOR
        // ==========================================
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/interview-prep')) {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const job = await getQuery('SELECT * FROM jobs WHERE job_id = ? OR external_id = ?', [jobId, jobId]);
            if (!job) return sendJson(res, 404, { success: false, error: 'Job not found' });
            const { generateInterviewPrepPack } = require('./interview_service');
            const prepPack = await generateInterviewPrepPack(job);
            return sendJson(res, 200, { success: true, prepPack });
        }

        if (pathname === '/api/interview-prep/evaluate' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const { evaluateMockAnswer } = require('./interview_service');
            const evaluation = await evaluateMockAnswer(body.question, body.answer, body.jobContext);
            return sendJson(res, 200, { success: true, evaluation });
        }

        // ==========================================
        // SCREENING Q&A SERVICE
        // ==========================================
        if (pathname === '/api/screening/answer' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const { answerScreeningQuestion } = require('./screening_service');
            const result = await answerScreeningQuestion(body.question, body.job);
            return sendJson(res, 200, { success: true, ...result });
        }

        if (pathname === '/api/screening/approve' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const { approveAnswer } = require('./screening_service');
            approveAnswer(body.question, body.answer);
            return sendJson(res, 200, { success: true, message: 'Answer approved and saved to cache.' });
        }

        // ==========================================
        // JOB LIVENESS CHECK
        // ==========================================
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/liveness')) {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const job = await getQuery('SELECT * FROM jobs WHERE job_id = ? OR external_id = ?', [jobId, jobId]);
            if (!job) return sendJson(res, 404, { success: false, error: 'Job not found' });
            const { checkUrlLiveness } = require('./liveness');
            const liveness = await checkUrlLiveness(job.url || job.application_url);
            return sendJson(res, 200, { success: true, job_id: jobId, ...liveness });
        }

        // ==========================================
        // MODULAR 4-MODE APPLICATION ENGINE
        // ==========================================
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/apply-mode') && req.method === 'POST') {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const body = await readJsonBody(req);
            const job = await getQuery('SELECT * FROM jobs WHERE job_id = ? OR external_id = ?', [jobId, jobId]);
            if (!job) return sendJson(res, 404, { success: false, error: 'Job not found' });
            const dupCheckMode = await checkAlreadyApplied(job);
            if (dupCheckMode.alreadyApplied) {
                return sendJson(res, 200, {
                    success: true,
                    already_applied: true,
                    mode: body.mode,
                    status: 'APPLIED',
                    message: `Already applied to ${job.company} - ${job.role} (${dupCheckMode.reason}). Duplicate submission blocked.`,
                    job_id: job.job_id
                });
            }
            const { processApplication } = require('./apply_engine');
            const result = await processApplication(job, { mode: body.mode });
            return sendJson(res, 200, result);
        }

        // ==========================================
        // DETAILED MATCH & STAR ALIGNMENT
        // ==========================================
        if (pathname.startsWith('/api/jobs/') && pathname.endsWith('/match-details')) {
            const parts = pathname.split('/');
            const jobId = parts[3];
            const job = await getQuery('SELECT * FROM jobs WHERE job_id = ? OR external_id = ?', [jobId, jobId]);
            if (!job) return sendJson(res, 404, { success: false, error: 'Job not found' });
            const { matchJobWithCandidate } = require('./pipeline/matcher');
            const analysis = await matchJobWithCandidate(job, { useLlm: query.llm === 'true' });
            return sendJson(res, 200, { success: true, job_id: jobId, analysis });
        }

        // ==========================================
        // AIHAWK AGENT & STEALTH ENGINE API
        // ==========================================
        if (pathname === '/api/aihawk/status' && req.method === 'GET') {
            return sendJson(res, 200, { success: true, status: aihawkLogger.getStatus() });
        }

        if (pathname === '/api/aihawk/logs' && req.method === 'GET') {
            const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
            return sendJson(res, 200, { success: true, logs: aihawkLogger.getRecentLogs(limit) });
        }

        // Real-Time Server-Sent Events (SSE) Stream
        if (pathname === '/api/aihawk/events' && req.method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });

            // Send initial state & recent logs
            res.write(`data: ${JSON.stringify({ type: 'status', data: aihawkLogger.getStatus() })}\n\n`);
            const recentLogs = aihawkLogger.getRecentLogs(20);
            for (let i = recentLogs.length - 1; i >= 0; i--) {
                res.write(`data: ${JSON.stringify({ type: 'log', data: recentLogs[i] })}\n\n`);
            }

            const onLog = (logEntry) => {
                res.write(`data: ${JSON.stringify({ type: 'log', data: logEntry })}\n\n`);
            };
            const onStatusChange = (status) => {
                res.write(`data: ${JSON.stringify({ type: 'status', data: status })}\n\n`);
            };

            aihawkLogger.on('log', onLog);
            aihawkLogger.on('status_change', onStatusChange);

            req.on('close', () => {
                aihawkLogger.off('log', onLog);
                aihawkLogger.off('status_change', onStatusChange);
            });
            return;
        }

        // AIHawk Configuration (Settings)
        if (pathname === '/api/aihawk/config' && req.method === 'GET') {
            const cfg = await getAihawkConfig(async () => allQuery('SELECT key, value FROM settings'));
            return sendJson(res, 200, { success: true, config: getMaskedConfig(cfg) });
        }

        if (pathname === '/api/aihawk/config' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const settingMappings = {
                openrouterKey: 'OPENROUTER_API_KEY',
                model: 'AIHAWK_MODEL',
                seed: 'AIHAWK_SEED',
                proxy: 'AIHAWK_PROXY',
                headed: 'AIHAWK_HEADED',
                profileDir: 'AIHAWK_PROFILE_DIR',
                omnirouteUrl: 'OMNIROUTE_URL',
                omnirouteKey: 'OMNIROUTE_API_KEY'
            };

            for (const [bodyKey, dbKey] of Object.entries(settingMappings)) {
                if (body[bodyKey] !== undefined) {
                    const val = typeof body[bodyKey] === 'boolean' ? (body[bodyKey] ? 'true' : 'false') : String(body[bodyKey]);
                    await runQuery("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [dbKey, val]);
                }
            }

            aihawkLogger.log('config_update', 'AIHawk settings updated via dashboard');
            const updated = await getAihawkConfig(async () => allQuery('SELECT key, value FROM settings'));
            return sendJson(res, 200, { success: true, config: getMaskedConfig(updated) });
        }

        // Job Search Profiles CRUD
        if (pathname === '/api/aihawk/profiles' && req.method === 'GET') {
            const profiles = await aihawkJobService.getSearchProfiles();
            return sendJson(res, 200, { success: true, profiles });
        }

        if (pathname === '/api/aihawk/profiles' && req.method === 'POST') {
            const body = await readJsonBody(req);
            let profile;
            if (body.id) {
                profile = await aihawkJobService.updateSearchProfile(body.id, body);
            } else {
                profile = await aihawkJobService.createSearchProfile(body);
            }
            return sendJson(res, 200, { success: true, profile });
        }

        if (pathname.startsWith('/api/aihawk/profiles/') && req.method === 'DELETE') {
            const profileId = pathname.split('/')[4];
            await aihawkJobService.deleteSearchProfile(profileId);
            return sendJson(res, 200, { success: true, message: `Profile ${profileId} deleted.` });
        }

        // 5-Dimensional AI Job Matching
        if (pathname.startsWith('/api/aihawk/jobs/') && pathname.endsWith('/match') && req.method === 'POST') {
            const jobId = pathname.split('/')[4];
            const match = await aihawkMatcherService.evaluateJob(jobId);
            return sendJson(res, 200, { success: true, job_id: jobId, match });
        }

        // Application Staging & Preparation (Approval Gate Prep)
        if (pathname.startsWith('/api/aihawk/jobs/') && pathname.endsWith('/prepare') && req.method === 'POST') {
            const jobId = pathname.split('/')[4];
            const body = await readJsonBody(req);
            const prep = await aihawkApplicationService.prepareApplication(jobId, body.overrides || {});
            return sendJson(res, 200, { success: true, job_id: jobId, preparation: prep });
        }

        // Approved Execution via Persistent Stealth Browser
        if (pathname.startsWith('/api/aihawk/jobs/') && pathname.endsWith('/execute') && req.method === 'POST') {
            const jobId = pathname.split('/')[4];
            const body = await readJsonBody(req);
            const result = await aihawkApplicationService.executeApplication(jobId, {
                approved: body.approved === true,
                customFields: body.customFields || {},
                headed: body.headed === true
            });
            return sendJson(res, 200, { success: result.success, ...result });
        }

        // Bookmark & Ignore
        if (pathname.startsWith('/api/aihawk/jobs/') && pathname.endsWith('/save') && req.method === 'POST') {
            const jobId = pathname.split('/')[4];
            const body = await readJsonBody(req);
            const isSaved = body.is_saved !== undefined ? (body.is_saved ? 1 : 0) : 1;
            await runQuery("UPDATE jobs SET is_saved = ? WHERE job_id = ?", [isSaved, jobId]);
            return sendJson(res, 200, { success: true, job_id: jobId, is_saved: isSaved });
        }

        if (pathname.startsWith('/api/aihawk/jobs/') && pathname.endsWith('/ignore') && req.method === 'POST') {
            const jobId = pathname.split('/')[4];
            const body = await readJsonBody(req);
            const isIgnored = body.is_ignored !== undefined ? (body.is_ignored ? 1 : 0) : 1;
            await runQuery("UPDATE jobs SET is_ignored = ? WHERE job_id = ?", [isIgnored, jobId]);
            return sendJson(res, 200, { success: true, job_id: jobId, is_ignored: isIgnored });
        }

        // MCP Bridge Info & Execution
        if (pathname === '/api/aihawk/mcp' && req.method === 'GET') {
            const mcpConfig = await aihawkMcpBridge.getMcpServerConfig();
            const tools = aihawkMcpBridge.getToolDefinitions();
            return sendJson(res, 200, { success: true, config: mcpConfig, tools });
        }

        if (pathname === '/api/aihawk/mcp/call' && req.method === 'POST') {
            const body = await readJsonBody(req);
            try {
                const toolResult = await aihawkMcpBridge.handleToolCall(body.tool, body.args || {});
                return sendJson(res, 200, { success: true, result: toolResult });
            } catch (toolErr) {
                return sendJson(res, 400, { success: false, error: toolErr.message });
            }
        }

        const isHead = req.method === 'HEAD';

        // ==========================================
        // 5. STATIC FILES & FRONTEND DASHBOARD
        // ==========================================
        if (pathname === '/' || pathname === '/index.html') {
            return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html', isHead);
        }

        // Dedicated handler for Tailored Resumes (Completely isolated from actor/ to prevent dataless hangs)
        if (pathname.startsWith('/tailored_resumes/')) {
            const relFile = path.basename(decodeURIComponent(pathname));
            const localTailored = path.join(__dirname, '../tailored_resumes', relFile);
            if (fs.existsSync(localTailored)) {
                try {
                    const st = fs.statSync(localTailored);
                    if (st.isFile() && st.size > 0) {
                        return serveStatic(res, localTailored, 'application/pdf', isHead);
                    }
                } catch (e) {}
            }
            // Fallback to Master Resume PDF
            const masterPdf = path.join(PUBLIC_DIR, 'resumes/master_resume.pdf');
            if (fs.existsSync(masterPdf)) {
                return serveStatic(res, masterPdf, 'application/pdf', isHead);
            }
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            return res.end('Resume not found');
        }

        // Dedicated handler for Base/Master Resumes
        if (pathname.startsWith('/resumes/')) {
            const relFile = path.basename(decodeURIComponent(pathname));
            const candidatePaths = [
                path.join(PUBLIC_DIR, 'resumes', relFile),
                path.join(__dirname, '../public/resumes', relFile),
                path.join(__dirname, '../../resumes', relFile)
            ];
            for (const cand of candidatePaths) {
                if (fs.existsSync(cand)) {
                    try {
                        const st = fs.statSync(cand);
                        if (st.isFile() && st.size > 0) {
                            const ext = path.extname(cand).toLowerCase();
                            const mime = ext === '.pdf' ? 'application/pdf' : (ext === '.md' ? 'text/markdown' : 'text/plain');
                            return serveStatic(res, cand, mime, isHead);
                        }
                    } catch (e) {}
                }
            }
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
            return res.end('Resume file not found');
        }

        // Serve any static file in public
        const requestedPath = path.join(PUBLIC_DIR, pathname);
        if (requestedPath.startsWith(PUBLIC_DIR) && fs.existsSync(requestedPath)) {
            try {
                const st = fs.statSync(requestedPath);
                if (st.isFile()) {
                    const ext = path.extname(requestedPath).toLowerCase();
                    let mime = 'text/plain';
                    if (ext === '.html') mime = 'text/html';
                    else if (ext === '.css') mime = 'text/css';
                    else if (ext === '.js') mime = 'application/javascript';
                    else if (ext === '.json') mime = 'application/json';
                    else if (ext === '.png') mime = 'image/png';
                    else if (ext === '.jpg') mime = 'image/jpeg';
                    else if (ext === '.pdf') mime = 'application/pdf';
                    return serveStatic(res, requestedPath, mime, isHead);
                }
            } catch (e) {}
        }

        // Fallback to index.html for SPA routes
        return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html', isHead);

    } catch (err) {
        console.error('Server error on', pathname, err);
        return sendJson(res, 500, { error: err.message });
    }
});

async function main() {
    await initDb();
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`================================================================`);
        console.log(`🚀 Job Search Dashboard running at http://localhost:${PORT}`);
        console.log(`================================================================`);
    });
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal startup error:', err);
    });
}

module.exports = { server, main };
