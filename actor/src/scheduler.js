const { runDiscoveryCycle } = require('./scanner');
const { tailorJobApplication, applyToJob } = require('./autofiller');
const { getQuery, allQuery } = require('./db');
const { checkAlreadyApplied } = require('./pipeline/application_guard');

let isRunning = false;
let checkInterval = null;

async function runSchedulerCycle() {
    if (isRunning) {
        console.log('[Scheduler] A scheduling cycle is already running. Skipping.');
        return;
    }

    isRunning = true;
    console.log('[Scheduler] Executing scheduled discovery & auto-apply cycle...');

    try {
        // 1. Run job discovery (Scrapes RSS/Company boards, scores relevance, keeps unique, inserts as EVALUATED or REJECTED)
        const discoveryResult = await runDiscoveryCycle();
        console.log(`[Scheduler] Discovery done: ${JSON.stringify(discoveryResult)}`);

        // 2. Fetch system settings
        const rawSettings = await allQuery('SELECT * FROM settings');
        const settings = {};
        rawSettings.forEach(s => settings[s.key] = s.value);

        const autoApplySetting = settings.AUTO_APPLY_ENABLED === 'true';
        const minScore = parseInt(settings.MIN_SCORE_THRESHOLD || '75', 10);
        const maxAppsPerDay = parseInt(settings.MAX_APPLICATIONS_PER_DAY || '5', 10);

        // A. Auto-tailor new qualified jobs (EVALUATED, ACTIVE, or AWAITING_APPROVAL)
        const qualifiedPendingJobs = await allQuery(`
            SELECT job_id, role, company, score FROM jobs
            WHERE status IN ('EVALUATED', 'ACTIVE', 'AWAITING_APPROVAL')
              AND score >= ?
              AND (source IN ('Greenhouse', 'Ashby', 'Lever', 'greenhouse') OR url LIKE '%greenhouse.io%' OR url LIKE '%ashbyhq.com%' OR url LIKE '%lever.co%')
            ORDER BY score DESC
            LIMIT 25
        `, [minScore]);

        if (qualifiedPendingJobs.length > 0) {
            console.log(`[Scheduler] Auto-tailoring ${qualifiedPendingJobs.length} new qualified jobs...`);
            for (const job of qualifiedPendingJobs) {
                try {
                    console.log(`[Scheduler] Auto-processing tailoring: ${job.role} at ${job.company} (Score: ${job.score})`);
                    await tailorJobApplication(job.job_id);
                } catch (tailorErr) {
                    console.error(`[Scheduler] Failed auto-tailoring for job ${job.job_id}:`, tailorErr.message);
                }
            }
        }

        // B. Auto-apply (only if explicitly enabled in settings)
        if (autoApplySetting) {
            console.log(`[Scheduler] Auto-apply is ENABLED. Fetching targets to submit...`);

            // Fetch how many we've applied to in the last 24 hours
            const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const dailyApplied = await getQuery(`
                SELECT COUNT(*) as count FROM jobs
                WHERE (status = 'APPLIED' OR status = 'READY_TO_APPLY') AND applied_at >= ?
            `, [dayAgo]);

            const currentCount = dailyApplied ? dailyApplied.count : 0;
            if (currentCount >= maxAppsPerDay) {
                console.log(`[Scheduler] Daily limit reached (${currentCount}/${maxAppsPerDay} applied). Postponing remaining applications.`);
                return;
            }

            // Fetch jobs that are resume tailored / ready to apply in DB (excluding already applied)
            const jobsToApply = await allQuery(`
                SELECT job_id, role, company, score FROM jobs
                WHERE (status = 'RESUME_TAILORED' OR status = 'READY_TO_APPLY')
                  AND status != 'APPLIED'
                  AND applied_at IS NULL
                  AND score >= ?
                ORDER BY score DESC
                LIMIT ?
            `, [minScore, maxAppsPerDay - currentCount]);

            console.log(`[Scheduler] Found ${jobsToApply.length} eligible applications ready for auto-fill.`);

            for (const job of jobsToApply) {
                // Strict check against already-applied listings
                const dupCheck = await checkAlreadyApplied(job.job_id);
                if (dupCheck.alreadyApplied) {
                    console.log(`[Scheduler] Skipping already applied job: ${job.role} at ${job.company} (${dupCheck.reason})`);
                    continue;
                }
                try {
                    console.log(`[Scheduler] Automated application candidate: ${job.role} at ${job.company}`);
                    const applyResult = await applyToJob(job.job_id, { autoSubmit: true });
                    console.log(`[Scheduler] Automated application completed: ${applyResult.status}`);

                    // Random anti-detection / anti-WAF delay: 20 to 45 seconds between jobs
                    const delayMs = Math.floor(Math.random() * 25000) + 20000;
                    console.log(`[Scheduler] Waiting ${Math.round(delayMs / 1000)}s before next application...`);
                    await new Promise(r => setTimeout(r, delayMs));
                } catch (applyErr) {
                    console.error(`[Scheduler] Failed auto-apply for job ${job.job_id}:`, applyErr.message);
                }
            }
        } else {
            console.log('[Scheduler] Auto-apply is currently DISABLED in settings. Qualified jobs kept at RESUME_TAILORED.');
        }

    } catch (cycleErr) {
        console.error('[Scheduler] Error in background execution loop:', cycleErr.message);
    } finally {
        isRunning = false;
        console.log('[Scheduler] Scheduled cycle completed.');
    }
}

function startScheduler() {
    // Run immediately on boot
    runSchedulerCycle();

    // Check settings for frequency and schedule interval
    allQuery('SELECT * FROM settings').then(rawSettings => {
        const settings = {};
        rawSettings.forEach(s => settings[s.key] = s.value);
        const hours = parseFloat(settings.SEARCH_FREQUENCY_HOURS || '12');

        if (checkInterval) {
            clearInterval(checkInterval);
        }

        const msInterval = hours * 60 * 60 * 1000;
        console.log(`[Scheduler] Background worker scheduled to run every ${hours} hour(s) (${msInterval} ms).`);
        checkInterval = setInterval(runSchedulerCycle, msInterval);
    }).catch(err => {
        console.error('[Scheduler] Failed to load frequency settings, defaulting to 12 hour check loop:', err);
        checkInterval = setInterval(runSchedulerCycle, 12 * 60 * 60 * 1000);
    });
}

function stopScheduler() {
    if (checkInterval) {
        clearInterval(checkInterval);
        console.log('[Scheduler] Stopped scheduler worker.');
    }
}

module.exports = {
    startScheduler,
    runSchedulerCycle,
    isRunningState: () => isRunning
};
