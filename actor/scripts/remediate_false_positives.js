/**
 * False Positive Remediation Script
 * 
 * Inspects all jobs currently marked 'APPLIED' using OmniRoute + Antigravity Vision.
 * Identifies unsubmitted forms, validation errors, CAPTCHAs, blank screens, and
 * reverts them to READY_TO_APPLY / MANUAL_REQUIRED with clear audit notes.
 */

const { allQuery, runQuery } = require('../src/db');
const { verifyJobProof } = require('../src/proof_verifier');

async function remediate() {
    console.log('================================================================');
    console.log('🔍 AUDITING ALL CURRENT "APPLIED" JOBS FOR FALSE POSITIVES');
    console.log('================================================================\n');

    const appliedJobs = await allQuery(`
        SELECT job_id, company, role, url, application_url, screenshot_path, status, applied_at, application_status
        FROM jobs
        WHERE status = 'APPLIED'
        ORDER BY applied_at DESC, discovered_at DESC
    `);

    console.log(`Found ${appliedJobs.length} jobs currently marked as APPLIED in database.\n`);

    let falsePositiveCount = 0;
    let confirmedCount = 0;
    let noProofCount = 0;
    const remediatedList = [];

    for (let i = 0; i < appliedJobs.length; i++) {
        const job = appliedJobs[i];
        process.stdout.write(`[${i + 1}/${appliedJobs.length}] Checking ${job.company} - ${job.role}... `);

        if (!job.screenshot_path) {
            console.log('⚠️ NO PROOF SCREENSHOT');
            noProofCount++;
            const now = new Date().toISOString();
            await runQuery(`
                UPDATE jobs
                SET status = 'READY_TO_APPLY',
                    is_false_positive = 1,
                    flagged_at = ?,
                    application_status = 'Unverified false positive: Missing submission proof screenshot'
                WHERE job_id = ?
            `, [now, job.job_id]);

            await runQuery(`
                UPDATE applications
                SET status = 'READY_TO_APPLY',
                    is_false_positive = 1,
                    flagged_at = ?,
                    error_message = 'Unverified false positive: Missing submission proof screenshot'
                WHERE job_id = ?
            `, [now, job.job_id]).catch(() => {});

            remediatedList.push({
                company: job.company,
                role: job.role,
                status: 'READY_TO_APPLY',
                reason: 'No proof screenshot captured'
            });
            continue;
        }

        try {
            const verification = await verifyJobProof({
                jobId: job.job_id,
                screenshotPath: job.screenshot_path,
                company: job.company,
                role: job.role,
                url: job.url || job.application_url,
                updateDatabase: true
            });

            if (verification.is_false_positive) {
                console.log(`❌ FALSE POSITIVE (${verification.status})`);
                console.log(`   Reason: ${verification.reason}`);
                falsePositiveCount++;
                remediatedList.push({
                    company: job.company,
                    role: job.role,
                    status: verification.status,
                    reason: verification.reason
                });
            } else if (verification.applied) {
                console.log(`✅ CONFIRMED APPLIED`);
                confirmedCount++;
            } else {
                console.log(`⚠️ UNVERIFIED (${verification.error || 'Unknown outcome'})`);
                falsePositiveCount++;
                const now = new Date().toISOString();
                await runQuery(`
                    UPDATE jobs
                    SET status = 'READY_TO_APPLY',
                        is_false_positive = 1,
                        flagged_at = ?,
                        application_status = ?
                    WHERE job_id = ?
                `, [now, `Unconfirmed application: ${verification.error || 'Screenshot unverified'}`, job.job_id]);
                remediatedList.push({
                    company: job.company,
                    role: job.role,
                    status: 'READY_TO_APPLY',
                    reason: verification.error || 'Screenshot unverified'
                });
            }
        } catch (err) {
            console.log(`⚠️ ERROR: ${err.message}`);
        }
    }

    console.log('\n================================================================');
    console.log('📊 REMEDIATION SUMMARY');
    console.log('================================================================');
    console.log(`Total Audited:         ${appliedJobs.length}`);
    console.log(`False Positives Reset: ${falsePositiveCount + noProofCount}`);
    console.log(`Genuinely Confirmed:   ${confirmedCount}`);
    console.log('================================================================\n');

    return {
        total: appliedJobs.length,
        falsePositives: falsePositiveCount + noProofCount,
        confirmed: confirmedCount,
        remediatedList
    };
}

if (require.main === module) {
    remediate().catch(err => {
        console.error('Fatal remediation error:', err);
        process.exit(1);
    });
}

module.exports = { remediate };
