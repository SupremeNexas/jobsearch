const crypto = require('crypto');
const { runQuery, getQuery, allQuery } = require('../../db');
const { logger } = require('./logs');
const { client } = require('./client');
const { browserManager } = require('./browser');
const { normalizeTitle, normalizeCompany } = require('../canonicalize');
const { checkAlreadyApplied } = require('../../pipeline/application_guard');

function generateJobKey(company, role, url) {
    const norm = `${(company || '').toLowerCase().trim()}_${(role || '').toLowerCase().trim()}`;
    return crypto.createHash('sha256').update(url || norm).digest('hex').substring(0, 16);
}

class AihawkJobService {
    async getSearchProfiles() {
        return allQuery('SELECT * FROM job_search_profiles ORDER BY updated_at DESC');
    }

    async getSearchProfileById(id) {
        return getQuery('SELECT * FROM job_search_profiles WHERE id = ?', [id]);
    }

    async createSearchProfile(data) {
        const id = data.id || `profile_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const now = new Date().toISOString();

        await runQuery(`
            INSERT INTO job_search_profiles (
                id, name, keywords, skills, location, remote_type, experience_level,
                employment_type, salary_min, salary_max, company_filters, excluded_companies,
                industry, date_posted, max_jobs, sources, is_active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            id,
            data.name || 'Default Search Profile',
            data.keywords || 'Software Engineer',
            data.skills || 'JavaScript, Node.js, React, Python, Go',
            data.location || 'Remote, India',
            data.remote_type || 'remote',
            data.experience_level || 'entry_mid',
            data.employment_type || 'full_time',
            data.salary_min || 0,
            data.salary_max || 0,
            data.company_filters || '',
            data.excluded_companies || '',
            data.industry || 'Technology',
            data.date_posted || 'all',
            data.max_jobs || 25,
            data.sources || 'greenhouse,lever,remoteok,remotive',
            data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
            now,
            now
        ]);

        return this.getSearchProfileById(id);
    }

    async updateSearchProfile(id, data) {
        const existing = await this.getSearchProfileById(id);
        if (!existing) {
            throw new Error(`Search profile not found: ${id}`);
        }

        const now = new Date().toISOString();
        const updates = [];
        const params = [];

        const fields = [
            'name', 'keywords', 'skills', 'location', 'remote_type', 'experience_level',
            'employment_type', 'salary_min', 'salary_max', 'company_filters', 'excluded_companies',
            'industry', 'date_posted', 'max_jobs', 'sources', 'is_active'
        ];

        fields.forEach(field => {
            if (data[field] !== undefined) {
                updates.push(`${field} = ?`);
                params.push(data[field]);
            }
        });

        if (updates.length === 0) return existing;

        updates.push('updated_at = ?');
        params.push(now);
        params.push(id);

        await runQuery(`UPDATE job_search_profiles SET ${updates.join(', ')} WHERE id = ?`, params);
        return this.getSearchProfileById(id);
    }

    async deleteSearchProfile(id) {
        return runQuery('DELETE FROM job_search_profiles WHERE id = ?', [id]);
    }

    /**
     * Executes AIHawk Job Discovery using configured parameters/profile
     */
    async searchAndCollectJobs(searchParams = {}, userProfile = {}, masterResume = '') {
        const runId = searchParams.runId || `run_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const startedAt = new Date().toISOString();

        // Parse sources
        let sourcesList = ['greenhouse', 'lever', 'remoteok', 'remotive', 'aihawk'];
        if (searchParams.sources) {
            if (typeof searchParams.sources === 'string') {
                sourcesList = searchParams.sources.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            } else if (Array.isArray(searchParams.sources)) {
                sourcesList = searchParams.sources.map(s => String(s).trim().toLowerCase()).filter(Boolean);
            } else if (typeof searchParams.sources === 'object') {
                sourcesList = Object.keys(searchParams.sources).filter(k => searchParams.sources[k]).map(s => s.toLowerCase());
            }
        }
        if (sourcesList.length === 0) {
            sourcesList = ['greenhouse', 'lever', 'remoteok', 'remotive', 'aihawk'];
        }

        // Record discovery run in database
        try {
            await runQuery(`
                INSERT INTO discovery_runs (id, status, configuration, total_found, new_added, matched_evaluated, started_at)
                VALUES (?, 'running', ?, 0, 0, 0, ?)
            `, [runId, JSON.stringify({ ...searchParams, sources: sourcesList }), startedAt]);
        } catch (e) {
            // discovery_runs table may be initializing
        }

        logger.setStatus('searching_jobs', `Searching jobs with criteria: ${searchParams.keywords || 'Software Engineer'}`);
        logger.log('job_search_start', `Starting AIHawk multi-source discovery (Run: ${runId})`, {
            ...searchParams,
            sources: sourcesList
        });

        const keywords = (searchParams.keywords || 'Software Engineer')
            .split(',')
            .map(k => k.trim())
            .filter(Boolean);

        if (keywords.length === 0) {
            keywords.push('Software Engineer');
        }

        const locationFilter = (searchParams.location || 'Remote').toLowerCase();
        const maxJobs = parseInt(searchParams.max_jobs || searchParams.maxJobs || '25', 10);
        const collectedJobs = [];

        const targetCompanies = (searchParams.company_filters || searchParams.companyFilters || 'figma,stripe,openai,datadog,sentry,vercel,notion,linear,supabase,posthog')
            .split(',')
            .map(c => c.trim().toLowerCase())
            .filter(Boolean);

        // 1. Crawl Greenhouse API endpoints concurrently
        if (sourcesList.includes('greenhouse')) {
            logger.setStatus('searching_jobs', 'Scanning Greenhouse ATS endpoints...');
            const ghPromises = targetCompanies.map(async (company) => {
                try {
                    const ghUrl = `https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`;
                    const ghRes = await fetch(ghUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
                    if (ghRes.ok) {
                        const ghData = await ghRes.json();
                        if (Array.isArray(ghData.jobs)) {
                            const matched = [];
                            for (const j of ghData.jobs) {
                                const titleMatches = keywords.some(k => (j.title || '').toLowerCase().includes(k.toLowerCase()));
                                if (titleMatches) {
                                    matched.push({
                                        job_id: generateJobKey(company, j.title, j.absolute_url),
                                        company: company.charAt(0).toUpperCase() + company.slice(1),
                                        role: j.title,
                                        location: j.location ? j.location.name : 'Remote',
                                        source: 'greenhouse',
                                        url: j.absolute_url,
                                        application_url: j.absolute_url,
                                        description: j.content || j.title,
                                        employment_type: 'Full-time',
                                        experience_level: searchParams.experience_level || 'Mid-Level',
                                        salary: 'Competitive',
                                        required_skills: JSON.stringify(['Node.js', 'React', 'JavaScript', 'APIs']),
                                        preferred_skills: JSON.stringify(['TypeScript', 'Docker', 'AWS']),
                                        posted_date: j.updated_at || new Date().toISOString(),
                                        source_job_id: j.internal_job_id || j.id || null,
                                        requisition_id: j.requisition_id || null,
                                        greenhouse_id: j.id || null,
                                        normalized_title: normalizeTitle(j.title),
                                        normalized_company: normalizeCompany(company.charAt(0).toUpperCase() + company.slice(1))
                                    });
                                }
                            }
                            return matched;
                        }
                    }
                } catch (e) {}
                return [];
            });

            const ghResults = await Promise.allSettled(ghPromises);
            for (const res of ghResults) {
                if (res.status === 'fulfilled' && Array.isArray(res.value)) {
                    for (const job of res.value) {
                        if (collectedJobs.length < maxJobs) {
                            collectedJobs.push(job);
                        }
                    }
                }
            }
        }

        // 2. Crawl Lever API endpoints concurrently
        if (sourcesList.includes('lever') && collectedJobs.length < maxJobs) {
            logger.setStatus('searching_jobs', 'Scanning Lever Postings endpoints...');
            const leverPromises = targetCompanies.map(async (company) => {
                try {
                    const leverUrl = `https://api.lever.co/v0/postings/${company}?mode=json`;
                    const leverRes = await fetch(leverUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000) });
                    if (leverRes.ok) {
                        const leverData = await leverRes.json();
                        if (Array.isArray(leverData)) {
                            const matched = [];
                            for (const j of leverData) {
                                const titleMatches = keywords.some(k => (j.text || '').toLowerCase().includes(k.toLowerCase()));
                                if (titleMatches) {
                                    matched.push({
                                        job_id: generateJobKey(company, j.text, j.hostedUrl),
                                        company: company.charAt(0).toUpperCase() + company.slice(1),
                                        role: j.text,
                                        location: (j.categories && j.categories.location) || 'Remote',
                                        source: 'lever',
                                        url: j.hostedUrl,
                                        application_url: j.applyUrl || j.hostedUrl,
                                        description: j.descriptionPlain || j.description || j.text,
                                        employment_type: (j.categories && j.categories.commitment) || 'Full-time',
                                        experience_level: searchParams.experience_level || 'Mid-Level',
                                        salary: 'Competitive',
                                        required_skills: JSON.stringify(['Node.js', 'React', 'TypeScript']),
                                        preferred_skills: JSON.stringify(['SQL', 'Docker', 'Cloud']),
                                        posted_date: j.createdAt ? new Date(j.createdAt).toISOString() : new Date().toISOString()
                                    });
                                }
                            }
                            return matched;
                        }
                    }
                } catch (e) {}
                return [];
            });

            const leverResults = await Promise.allSettled(leverPromises);
            for (const res of leverResults) {
                if (res.status === 'fulfilled' && Array.isArray(res.value)) {
                    for (const job of res.value) {
                        if (collectedJobs.length < maxJobs) {
                            collectedJobs.push(job);
                        }
                    }
                }
            }
        }

        // 3. Crawl RemoteOK API
        if (sourcesList.includes('remoteok') && (locationFilter.includes('remote') || locationFilter.includes('any')) && collectedJobs.length < maxJobs) {
            logger.setStatus('searching_jobs', 'Scanning RemoteOK feed...');
            try {
                const remoteOkRes = await fetch('https://remoteok.com/api', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) });
                if (remoteOkRes.ok) {
                    const jobsArr = await remoteOkRes.json();
                    if (Array.isArray(jobsArr)) {
                        for (const item of jobsArr.slice(1)) {
                            if (collectedJobs.length >= maxJobs) break;
                            const titleMatches = keywords.some(k => (item.position || '').toLowerCase().includes(k.toLowerCase()));
                            if (titleMatches) {
                                collectedJobs.push({
                                    job_id: generateJobKey(item.company, item.position, item.url),
                                    company: item.company || 'Tech Company',
                                    role: item.position || 'Software Engineer',
                                    location: 'Remote',
                                    source: 'remoteok',
                                    url: item.url ? (item.url.startsWith('http') ? item.url : `https://remoteok.com${item.url}`) : 'https://remoteok.com',
                                    application_url: item.apply_url || item.url || '',
                                    description: item.description || item.position,
                                    employment_type: 'Full-time',
                                    experience_level: 'Mid-Level',
                                    salary: item.salary_min ? `$${item.salary_min} - $${item.salary_max || ''}` : 'Competitive',
                                    required_skills: JSON.stringify(item.tags || ['JavaScript', 'Node.js']),
                                    preferred_skills: JSON.stringify(['TypeScript', 'PostgreSQL']),
                                    posted_date: item.date || new Date().toISOString()
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        // 4. Crawl Remotive API
        if ((sourcesList.includes('remotive') || sourcesList.includes('remoteok')) && collectedJobs.length < maxJobs) {
            logger.setStatus('searching_jobs', 'Scanning Remotive remote jobs API...');
            try {
                const remotiveRes = await fetch('https://remotive.com/api/remote-jobs?limit=50', {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    signal: AbortSignal.timeout(6000)
                });
                if (remotiveRes.ok) {
                    const data = await remotiveRes.json();
                    if (data && Array.isArray(data.jobs)) {
                        for (const item of data.jobs) {
                            if (collectedJobs.length >= maxJobs) break;
                            const titleMatches = keywords.some(k => (item.title || '').toLowerCase().includes(k.toLowerCase()));
                            if (titleMatches) {
                                collectedJobs.push({
                                    job_id: generateJobKey(item.company_name, item.title, item.url),
                                    company: item.company_name || 'Tech Company',
                                    role: item.title,
                                    location: item.candidate_required_location || 'Remote',
                                    source: 'remotive',
                                    url: item.url,
                                    application_url: item.url,
                                    description: item.description ? item.description.replace(/<[^>]+>/g, ' ').substring(0, 3000) : item.title,
                                    employment_type: item.job_type || 'Full-time',
                                    experience_level: searchParams.experience_level || 'Mid-Level',
                                    salary: item.salary || 'Competitive',
                                    required_skills: JSON.stringify(item.tags || ['JavaScript', 'Python']),
                                    preferred_skills: JSON.stringify(['React', 'Node.js']),
                                    posted_date: item.publication_date || new Date().toISOString()
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        // 5. AIHawk Stealth Browser Engine Discovery
        if (sourcesList.includes('aihawk') && collectedJobs.length < maxJobs) {
            logger.setStatus('initializing_browser', 'Launching AIHawk stealth browser session for deep discovery...');
            try {
                const session = await browserManager.openSession('aihawk_discovery', { headed: false });
                logger.setStatus('searching_jobs', 'AIHawk stealth browser actively discovering postings...');

                const browserCompanies = targetCompanies.slice(0, 4);
                for (const company of browserCompanies) {
                    if (collectedJobs.length >= maxJobs) break;
                    try {
                        const targetUrl = `https://boards.greenhouse.io/${company}`;
                        await session.page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});

                        const pageJobs = await session.page.evaluate(() => {
                            const links = Array.from(document.querySelectorAll('a[href*="/jobs/"], .opening a'));
                            return links.map(l => ({
                                title: (l.textContent || '').trim(),
                                url: l.href
                            })).filter(j => j.title && j.url);
                        }).catch(() => []);

                        for (const pj of pageJobs) {
                            if (collectedJobs.length >= maxJobs) break;
                            const matches = keywords.some(k => pj.title.toLowerCase().includes(k.toLowerCase()));
                            if (matches) {
                                collectedJobs.push({
                                    job_id: generateJobKey(company, pj.title, pj.url),
                                    company: company.charAt(0).toUpperCase() + company.slice(1),
                                    role: pj.title,
                                    location: 'Remote / Hybrid',
                                    source: 'aihawk_browser',
                                    url: pj.url,
                                    application_url: pj.url,
                                    description: pj.title,
                                    employment_type: 'Full-time',
                                    experience_level: searchParams.experience_level || 'Mid-Level',
                                    salary: 'Competitive',
                                    required_skills: JSON.stringify(['Node.js', 'Python', 'React']),
                                    preferred_skills: JSON.stringify(['TypeScript', 'Docker']),
                                    posted_date: new Date().toISOString()
                                });
                            }
                        }
                    } catch (err) {
                        // ignore individual browser navigation errors
                    }
                }
            } catch (browserErr) {
                logger.log('browser_error', `AIHawk browser discovery notice: ${browserErr.message}`);
            }
        }

        // 6. Deduplicate and Save to Database concurrently in batches
        let newJobsAdded = 0;
        let matchedEvaluated = 0;
        logger.setStatus('extracting_jobs', `Processing & matching ${collectedJobs.length} discovered listings...`);

        // Filter out already existing jobs first
        const novelJobs = [];
        for (const job of collectedJobs) {
            const existing = await getQuery('SELECT job_id, status FROM jobs WHERE job_id = ? OR url = ?', [job.job_id, job.url]);
            if (!existing) {
                novelJobs.push(job);
            }
        }

        // Evaluate and insert novel jobs in concurrency batches of 5
        const batchSize = 5;
        for (let i = 0; i < novelJobs.length; i += batchSize) {
            const batch = novelJobs.slice(i, i + batchSize);
            await Promise.all(batch.map(async (job) => {
                const now = new Date().toISOString();
                logger.setStatus('extracting_job', `Evaluating match: ${job.role} at ${job.company}`, {
                    jobId: job.job_id,
                    company: job.company
                });

                // Run AI Multi-Dimensional Match
                const matchResult = await client.matchJob(job, userProfile, masterResume);
                matchedEvaluated++;

                // Duplicate Check: Don't mark as DISCOVERED if candidate already applied
                const dupApplied = await checkAlreadyApplied(job);
                const finalStatus = dupApplied.alreadyApplied ? 'APPLIED' : 'DISCOVERED';
                const appliedAtVal = dupApplied.alreadyApplied ? ((dupApplied.appliedJob && dupApplied.appliedJob.applied_at) || now) : null;

                await runQuery(`
                    INSERT INTO jobs (
                        job_id, company, role, location, source, url, description,
                        score, score_explanation, status, discovered_at, salary,
                        employment_type, experience_level, required_skills, preferred_skills,
                        posted_date, application_url, is_saved, is_ignored, stage, search_profile_id, applied_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
                `, [
                    job.job_id,
                    job.company,
                    job.role,
                    job.location,
                    job.source,
                    job.url,
                    job.description,
                    matchResult.overall_score,
                    JSON.stringify(matchResult),
                    finalStatus,
                    now,
                    job.salary || 'Not specified',
                    job.employment_type || 'Full-time',
                    job.experience_level || 'Mid-Level',
                    job.required_skills || '[]',
                    job.preferred_skills || '[]',
                    job.posted_date || now,
                    job.application_url || job.url,
                    finalStatus,
                    searchParams.search_profile_id || null,
                    appliedAtVal
                ]);

                // Store in ai_job_matches table
                await runQuery(`
                    INSERT INTO ai_job_matches (
                        job_id, overall_score, skill_match, experience_match, education_match,
                        location_match, tech_match, matched_skills, missing_skills,
                        recommended_resume, explanation, evaluated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [
                    job.job_id,
                    matchResult.overall_score,
                    matchResult.skill_match,
                    matchResult.experience_match,
                    matchResult.education_match,
                    matchResult.location_match,
                    matchResult.tech_match,
                    JSON.stringify(matchResult.matched_skills),
                    JSON.stringify(matchResult.missing_skills),
                    matchResult.recommended_resume,
                    matchResult.explanation,
                    now
                ]);

                newJobsAdded++;
                logger.log('job_discovered', `New job collected: ${job.role} at ${job.company} (Match: ${matchResult.overall_score}%)`, {
                    jobId: job.job_id,
                    company: job.company,
                    match: matchResult
                });
            }));
        }

        const completedAt = new Date().toISOString();
        try {
            await runQuery(`
                UPDATE discovery_runs
                SET status = 'completed', total_found = ?, new_added = ?, matched_evaluated = ?, completed_at = ?
                WHERE id = ?
            `, [collectedJobs.length, newJobsAdded, matchedEvaluated, completedAt, runId]);
        } catch (e) {}

        logger.setStatus('completed', `Discovery finished. Found ${collectedJobs.length}, added ${newJobsAdded} new jobs.`);
        logger.log('job_search_completed', `Search completed. Found ${collectedJobs.length} total, added ${newJobsAdded} new jobs.`);

        return {
            runId,
            status: 'completed',
            totalFound: collectedJobs.length,
            newJobsAdded,
            matchedEvaluated
        };
    }
}

const jobService = new AihawkJobService();
module.exports = {
    AihawkJobService,
    jobService,
    generateJobKey
};
