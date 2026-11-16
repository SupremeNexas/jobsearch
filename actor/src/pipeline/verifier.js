/**
 * Job Verification Engine
 * Verifies job listing existence, validates official ATS endpoints, and updates job verification status.
 */

const https = require('https');
const http = require('http');
const { runQuery } = require('../db');

function checkUrlStatus(targetUrl) {
    return new Promise((resolve) => {
        if (!targetUrl || !targetUrl.startsWith('http')) {
            return resolve({ active: false, statusCode: 0, error: 'Invalid URL format' });
        }

        const client = targetUrl.startsWith('https') ? https : http;
        const req = client.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/json'
            },
            timeout: 3000
        }, (res) => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
                resolve({ active: true, statusCode: res.statusCode });
            } else if (res.statusCode === 404 || res.statusCode === 410) {
                resolve({ active: false, statusCode: res.statusCode, error: 'Job posting closed (404/410)' });
            } else {
                resolve({ active: res.statusCode < 500, statusCode: res.statusCode });
            }
        });

        req.on('error', (err) => {
            resolve({ active: false, statusCode: 0, error: err.message });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ active: false, statusCode: 408, error: 'Verification timeout' });
        });
    });
}

/**
 * Verifies a single job listing and persists verification record.
 */
async function verifyJob(job) {
    const urlToVerify = job.verification_url || job.application_url;
    const now = new Date().toISOString();

    // If already verified from direct live ATS board API in this run
    let check = null;
    if (['Greenhouse', 'Lever', 'Ashby', 'Jobicy', 'Remotive', 'JobYap'].includes(job.source) && job.source_verified === 1) {
        check = { active: true, statusCode: 200 };
    } else {
        check = await checkUrlStatus(urlToVerify);
    }

    let newStatus = 'ACTIVE';
    if (!check.active) {
        if (check.statusCode === 404 || check.statusCode === 410) {
            newStatus = 'CLOSED';
        } else if (check.statusCode === 408) {
            newStatus = 'STALE';
        } else {
            newStatus = 'SOURCE_ERROR';
        }
    }

    job.status = newStatus;
    job.source_verified = check.active ? 1 : 0;
    job.verification_url = urlToVerify;

    // Persist to job_verifications
    try {
        await runQuery(`
            INSERT INTO job_verifications (job_id, status, verification_url, verification_source, http_status, is_active, notes, verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            job.id || job.job_id,
            newStatus,
            urlToVerify,
            job.source,
            check.statusCode || 200,
            check.active ? 1 : 0,
            check.error || 'Verified active posting',
            now
        ]);
    } catch (e) {
        // Safe db fallback
    }

    return {
        jobId: job.id,
        status: newStatus,
        statusCode: check.statusCode,
        verifiedAt: now,
        isVerified: check.active
    };
}

/**
 * Batch verifies a list of jobs concurrently.
 */
async function batchVerifyJobs(jobsList, maxConcurrent = 30, signal = null) {
    console.log(`[Job Verifier] Verifying ${jobsList.length} jobs (batch size: ${maxConcurrent})...`);
    let verifiedActive = 0;
    let staleOrClosed = 0;

    for (let i = 0; i < jobsList.length; i += maxConcurrent) {
        if (signal?.aborted) {
            console.log('[Job Verifier] Verification halted by abort signal.');
            break;
        }
        const chunk = jobsList.slice(i, i + maxConcurrent);
        await Promise.all(chunk.map(async (job) => {
            if (signal?.aborted) return;
            const res = await verifyJob(job);
            if (res.isVerified) {
                verifiedActive++;
            } else {
                staleOrClosed++;
            }
        }));
    }

    console.log(`[Job Verifier] Verification complete: ${verifiedActive} ACTIVE, ${staleOrClosed} STALE/CLOSED/UNVERIFIED.`);
    return {
        total: jobsList.length,
        active: verifiedActive,
        staleOrClosed
    };
}

module.exports = {
    verifyJob,
    batchVerifyJobs,
    checkUrlStatus
};
