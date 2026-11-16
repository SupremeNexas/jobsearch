/**
 * Job Discovery Engine
 * Unified orchestrator: Connectors -> Normalization -> Deduplication -> Verification -> Matching -> Database -> Search Runs History
 */

const crypto = require('crypto');
const { runAllConnectors } = require('./connectors');
const { normalizeJob } = require('./pipeline/normalizer');
const { deduplicateJobs } = require('./pipeline/deduplicator');
const { batchVerifyJobs } = require('./pipeline/verifier');
const { matchJobWithCandidate } = require('./pipeline/matcher');
const { runQuery, allQuery, getQuery } = require('./db');

const SEARCH_MODES = {
    QUICK_SEARCH: {
        id: 'QUICK_SEARCH',
        label: 'Quick Search',
        sources: ['greenhouse', 'lever', 'ashby', 'remotive', 'jobyap'],
        keywords: ['software engineer', 'backend engineer', 'full stack']
    },
    FULL_DISCOVERY: {
        id: 'FULL_DISCOVERY',
        label: 'Full Discovery',
        sources: 'all',
        keywords: ['software', 'engineer', 'backend', 'full stack', 'developer', 'ai', 'systems']
    },
    REMOTE_ONLY: {
        id: 'REMOTE_ONLY',
        label: 'Remote Only',
        sources: 'all',
        keywords: ['remote software engineer', 'remote backend', 'remote fullstack', 'remote ai']
    },
    INTERNSHIPS: {
        id: 'INTERNSHIPS',
        label: 'Internships',
        sources: 'all',
        keywords: ['software intern', 'swe intern', 'engineering intern', 'developer intern', 'ai intern']
    },
    NEW_GRAD: {
        id: 'NEW_GRAD',
        label: 'New Grad / Graduate',
        sources: 'all',
        keywords: ['graduate software engineer', 'new grad engineer', 'junior software engineer', 'sde 1', 'associate engineer']
    },
    AI_ML: {
        id: 'AI_ML',
        label: 'AI / ML Roles',
        sources: 'all',
        keywords: ['machine learning engineer', 'ai engineer', 'ml engineer', 'deep learning', 'nlp engineer']
    },
    GENAI: {
        id: 'GENAI',
        label: 'GenAI & Agentic AI',
        sources: 'all',
        keywords: ['genai engineer', 'agentic ai', 'llm engineer', 'rag engineer', 'ai agents', 'langchain']
    },
    BACKEND: {
        id: 'BACKEND',
        label: 'Backend Systems',
        sources: 'all',
        keywords: ['backend engineer', 'distributed systems', 'go engineer', 'python backend', 'node backend', 'microservices']
    },
    FULL_STACK: {
        id: 'FULL_STACK',
        label: 'Full Stack',
        sources: 'all',
        keywords: ['full stack engineer', 'fullstack developer', 'react node', 'nextjs developer', 'typescript engineer']
    },
    SOFTWARE_ENGINEERING: {
        id: 'SOFTWARE_ENGINEERING',
        label: 'Software Engineering Core',
        sources: 'all',
        keywords: ['software engineer', 'sde', 'systems engineer', 'platform engineer']
    },
    CUSTOM: {
        id: 'CUSTOM',
        label: 'Custom Search',
        sources: 'all',
        keywords: []
    }
};

/**
 * Runs a complete discovery cycle with the requested modes and keyword filters.
 */
async function executeDiscoveryCycle(options = {}) {
    const {
        modes = ['FULL_DISCOVERY'],
        customKeywords = [],
        selectedSources = 'all',
        verifyImmediate = true,
        scoreThreshold = 70,
        signal = null
    } = options;

    const runId = `run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startedAt = new Date().toISOString();
    const modeString = Array.isArray(modes) ? modes.join(',') : String(modes);

    const checkAborted = async () => {
        if (signal?.aborted) {
            console.log(`[Discovery Engine] Discovery run ${runId} was aborted by user.`);
            await runQuery(`
                UPDATE search_runs SET
                    status = 'aborted',
                    completed_at = ?,
                    errors = ?
                WHERE id = ?
            `, [new Date().toISOString(), JSON.stringify(['Discovery cycle aborted by user']), runId]).catch(() => {});
            const err = new Error('Discovery cycle stopped by user');
            err.name = 'AbortError';
            err.aborted = true;
            throw err;
        }
    };

    console.log(`================================================================`);
    console.log(`[Discovery Engine] STARTING SEARCH RUN ${runId} (Modes: ${modeString})`);
    console.log(`================================================================`);

    // 1. Compile aggregate keywords based on search modes
    const aggregateKeywords = new Set();
    const modeList = Array.isArray(modes) ? modes : [modes];
    modeList.forEach(m => {
        const modeConfig = SEARCH_MODES[m] || SEARCH_MODES.FULL_DISCOVERY;
        if (modeConfig.keywords) {
            modeConfig.keywords.forEach(k => aggregateKeywords.add(k));
        }
    });

    if (customKeywords && customKeywords.length > 0) {
        customKeywords.forEach(k => aggregateKeywords.add(k));
    }

    const keywordArray = Array.from(aggregateKeywords);

    // 2. Persist initial SearchRun record
    await runQuery(`
        INSERT INTO search_runs (
            id, search_mode, status, configuration, started_at
        ) VALUES (?, ?, 'running', ?, ?)
    `, [
        runId,
        modeString,
        JSON.stringify({ modes, keywords: keywordArray, selectedSources }),
        startedAt
    ]);

    await checkAborted();

    // 3. Run all connectors concurrently with error isolation and abort support
    const connectorOutput = await runAllConnectors({
        keywords: keywordArray,
        selectedSources,
        mode: modeString,
        signal
    });

    await checkAborted();

    const rawJobs = connectorOutput.rawJobs || [];
    const sourceStats = connectorOutput.stats;

    // 4. Normalization Phase
    console.log(`[Discovery Engine] Normalizing ${rawJobs.length} raw jobs...`);
    const normalizedJobs = rawJobs.map(j => normalizeJob(j));

    await checkAborted();

    // 5. Deduplication Phase
    console.log(`[Discovery Engine] Running multi-stage deduplication...`);
    const dedupResult = deduplicateJobs(normalizedJobs);
    const uniqueJobs = dedupResult.deduplicated;

    await checkAborted();

    // 6. Verification Phase
    if (verifyImmediate && uniqueJobs.length > 0) {
        console.log(`[Discovery Engine] Verifying active status for ${uniqueJobs.length} unique jobs...`);
        await batchVerifyJobs(uniqueJobs, 12, signal);
    }

    await checkAborted();

    // 7. AI Matching & Profile Alignment Phase
    console.log(`[Discovery Engine] Matching jobs against candidate profile (ISRO / Monerva / Kronos / PDEU)...`);
    let shortlistedCount = 0;

    for (const job of uniqueJobs) {
        if (signal?.aborted) await checkAborted();
        await matchJobWithCandidate(job);
        if (job.match_score >= scoreThreshold) {
            shortlistedCount++;
        }
    }

    await checkAborted();

    // 8. Database Persistence (Insert or Update normalized jobs and companies)
    console.log(`[Discovery Engine] Persisting ${uniqueJobs.length} jobs to SQLite database...`);
    let newJobsCount = 0;
    const now = new Date().toISOString();

    for (const job of uniqueJobs) {
        if (signal?.aborted) {
            await checkAborted();
            break;
        }
        try {
            // Check if existing
            const existing = await getQuery("SELECT job_id, discovered_at FROM jobs WHERE job_id = ? OR application_url = ?", [job.id, job.application_url]);

            if (!existing) {
                newJobsCount++;
            }

            // Insert or replace company
            if (job.company) {
                await runQuery(`
                    INSERT INTO companies (id, name, domain, careers_url, ats_platform, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at
                `, [
                    `comp_${job.company.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
                    job.company,
                    job.company_url || null,
                    job.source_url || null,
                    job.source,
                    now,
                    now
                ]).catch(() => {});
            }

            // Insert or replace job
            await runQuery(`
                INSERT OR REPLACE INTO jobs (
                    job_id, external_id, source, source_url, company, company_url, role,
                    department, location, country, remote_type, employment_type, experience_level,
                    salary_min, salary_max, salary_currency, salary, skills, required_skills,
                    preferred_skills, education_requirements, experience_requirements, description,
                    posted_at, deadline, application_url, url, company_description, source_verified,
                    verification_url, discovered_at, last_seen_at, status, match_score, score,
                    score_explanation, notes, raw_data, is_canonical, location_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                job.id,
                job.external_id,
                job.source,
                job.source_url,
                job.company,
                job.company_url,
                job.role,
                job.department,
                job.location,
                job.country,
                job.remote_type,
                job.employment_type,
                job.experience_level,
                job.salary_min,
                job.salary_max,
                job.salary_currency,
                job.salary,
                job.skills,
                job.required_skills,
                job.preferred_skills,
                job.education_requirements,
                job.experience_requirements,
                job.description,
                job.posted_at,
                job.deadline,
                job.application_url,
                job.application_url,
                job.company_description,
                job.source_verified,
                job.verification_url,
                existing ? existing.discovered_at : now,
                now,
                job.status,
                job.match_score,
                job.match_score,
                job.score_explanation,
                job.notes,
                job.raw_data,
                job.is_canonical || 1,
                job.location_count || 1
            ]);
        } catch (dbErr) {
            console.error(`[Discovery Engine] Error storing job ${job.company} - ${job.role}:`, dbErr.message);
        }
    }

    const completedAt = new Date().toISOString();

    // 9. Update SearchRun record with final metrics
    await runQuery(`
        UPDATE search_runs SET
            status = 'completed',
            sources_attempted = ?,
            sources_succeeded = ?,
            sources_failed = ?,
            jobs_found = ?,
            jobs_new = ?,
            jobs_duplicate = ?,
            jobs_verified = ?,
            jobs_shortlisted = ?,
            errors = ?,
            completed_at = ?
        WHERE id = ?
    `, [
        sourceStats.attempted,
        sourceStats.succeeded,
        sourceStats.failed,
        rawJobs.length,
        newJobsCount,
        dedupResult.duplicatesRemoved,
        uniqueJobs.filter(j => j.status === 'ACTIVE').length,
        shortlistedCount,
        JSON.stringify(sourceStats.errors || []),
        completedAt,
        runId
    ]);

    console.log(`================================================================`);
    console.log(`[Discovery Engine] DISCOVERY RUN COMPLETED SUCCESSFULLY:`);
    console.log(`- Total Raw Found: ${rawJobs.length}`);
    console.log(`- Unique Postings: ${uniqueJobs.length}`);
    console.log(`- Duplicates Merged: ${dedupResult.duplicatesRemoved}`);
    console.log(`- New Added: ${newJobsCount}`);
    console.log(`- Verified Active: ${uniqueJobs.filter(j => j.status === 'ACTIVE').length}`);
    console.log(`- High Profile Match (>= ${scoreThreshold}%): ${shortlistedCount}`);
    console.log(`================================================================`);

    return {
        runId,
        startedAt,
        completedAt,
        modes: modeList,
        sourcesAttempted: sourceStats.attempted,
        sourcesSucceeded: sourceStats.succeeded,
        sourcesFailed: sourceStats.failed,
        jobsFound: rawJobs.length,
        jobsNew: newJobsCount,
        jobsDuplicate: dedupResult.duplicatesRemoved,
        jobsVerified: uniqueJobs.filter(j => j.status === 'ACTIVE').length,
        jobsShortlisted: shortlistedCount,
        jobs: uniqueJobs
    };
}

module.exports = {
    SEARCH_MODES,
    executeDiscoveryCycle
};
