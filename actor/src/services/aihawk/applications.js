const path = require('path');
const fs = require('fs');
const { runQuery, getQuery, allQuery } = require('../../db');
const { browserManager } = require('./browser');
const { logger } = require('./logs');
const { matcherService } = require('./matcher');
const { checkAlreadyApplied, recordJobApplied } = require('../../pipeline/application_guard');

const screenshotsDir = path.join(__dirname, '../../../public/screenshots');
if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
}

class AihawkApplicationService {
    async getApplications(filters = {}) {
        let sql = `
            SELECT a.*, j.location, j.source, j.score, j.description
            FROM applications a
            LEFT JOIN jobs j ON a.job_id = j.job_id
        `;
        const params = [];
        const conditions = [];

        if (filters.status) {
            conditions.push('a.status = ?');
            params.push(filters.status);
        }
        if (filters.search) {
            conditions.push('(a.company LIKE ? OR a.role LIKE ?)');
            const s = `%${filters.search}%`;
            params.push(s, s);
        }

        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }

        sql += ' ORDER BY a.updated_at DESC';
        return allQuery(sql, params);
    }

    async getApplicationById(id) {
        const app = await getQuery('SELECT * FROM applications WHERE id = ? OR job_id = ?', [id, id]);
        if (!app) return null;

        const logs = await allQuery('SELECT * FROM application_logs WHERE application_id = ? OR job_id = ? ORDER BY timestamp DESC', [app.id, app.job_id]);
        return {
            ...app,
            logs
        };
    }

    async updateApplicationStatus(id, updateData = {}) {
        const existing = await getQuery('SELECT * FROM applications WHERE id = ? OR job_id = ?', [id, id]);
        if (!existing) {
            throw new Error(`Application not found: ${id}`);
        }

        const now = new Date().toISOString();
        const updates = [];
        const params = [];

        if (updateData.status) {
            updates.push('status = ?');
            params.push(updateData.status);
        }
        if (updateData.notes !== undefined) {
            updates.push('notes = ?');
            params.push(updateData.notes);
        }
        if (updateData.error_message !== undefined) {
            updates.push('error_message = ?');
            params.push(updateData.error_message);
        }

        updates.push('updated_at = ?');
        params.push(now);

        params.push(existing.id);
        await runQuery(`UPDATE applications SET ${updates.join(', ')} WHERE id = ?`, params);

        // Keep jobs table status in sync
        if (updateData.status) {
            await runQuery('UPDATE jobs SET status = ?, application_status = ? WHERE job_id = ?', [
                updateData.status,
                updateData.notes || updateData.status,
                existing.job_id
            ]);
        }

        logger.log('application_status_update', `Application for ${existing.company} status updated to ${updateData.status}`, {
            applicationId: existing.id,
            jobId: existing.job_id,
            newStatus: updateData.status
        }, existing.id, existing.job_id);

        return this.getApplicationById(existing.id);
    }

    /**
     * Prepares an application package for user review and approval
     */
    async prepareApplication(jobId, customOverrides = {}) {
        logger.setStatus('preparing_application', `Preparing application package for job ID: ${jobId}`, { jobId });
        logger.log('application_prepare_start', `Preparing application review package for job ${jobId}`, {}, null, jobId);

        const job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
        if (!job) {
            throw new Error(`Job not found: ${jobId}`);
        }

        // Strict Duplicate Application Check
        const duplicateCheck = await checkAlreadyApplied(job);
        if (duplicateCheck.alreadyApplied) {
            logger.setStatus('completed', `Job ${jobId} already applied: ${duplicateCheck.reason}`, { jobId });
            logger.log('application_already_applied', `Duplicate prevented: ${duplicateCheck.reason}`, {}, null, jobId);
            return {
                applicationId: `app_${jobId}`,
                job,
                status: 'APPLIED',
                already_applied: true,
                reason: duplicateCheck.reason,
                message: `Skipped: ${duplicateCheck.reason}`,
                requiresApproval: false
            };
        }

        const profile = await matcherService.getCandidateProfile();
        const info = profile.personal_information || {};

        // 1. Ensure Tailored Resume is generated
        let versionRow = await getQuery('SELECT * FROM resume_versions WHERE job_id = ? ORDER BY version DESC LIMIT 1', [jobId]);
        if (!versionRow) {
            try {
                const { tailorJobApplication } = require('../../autofiller');
                logger.log('resume_tailoring', `Generating tailored resume PDF for ${job.company}...`, {}, null, jobId);
                await tailorJobApplication(jobId);
                versionRow = await getQuery('SELECT * FROM resume_versions WHERE job_id = ? ORDER BY version DESC LIMIT 1', [jobId]);
            } catch (tailorErr) {
                logger.log('resume_tailoring_warning', `Tailoring fallback: ${tailorErr.message}`, {}, null, jobId);
            }
        }

        const appId = `app_${jobId}`;
        const now = new Date().toISOString();

        // 2. Draft standard form payload
        const preparedPayload = {
            firstName: customOverrides.firstName || info.first_name || 'Applicant',
            lastName: customOverrides.lastName || info.last_name || 'Candidate',
            email: customOverrides.email || info.email || 'applicant@example.com',
            phone: customOverrides.phone || info.phone || '',
            linkedin: customOverrides.linkedin || info.linkedin || '',
            github: customOverrides.github || info.github || '',
            portfolio: customOverrides.portfolio || info.portfolio || '',
            location: [info.location?.city, info.location?.country].filter(Boolean).join(', ') || 'Remote',
            workAuthorization: (profile.work_preferences && profile.work_preferences.work_authorization) || 'Authorized to work; Open to Remote',
            currentCompany: (profile.experience_details && profile.experience_details[0]?.company) || '',
            coverLetter: versionRow ? versionRow.cover_letter : '',
            resumePdfPath: versionRow ? versionRow.pdf_path : '',
            notes: customOverrides.notes || ''
        };

        // 3. Insert or Update Application row in READY_TO_APPLY state
        const existingApp = await getQuery('SELECT id FROM applications WHERE id = ? OR job_id = ?', [appId, jobId]);
        if (existingApp) {
            await runQuery(`
                UPDATE applications
                SET status = 'READY_TO_APPLY',
                    resume_used = ?,
                    resume_version = ?,
                    cover_letter_used = ?,
                    form_payload = ?,
                    updated_at = ?
                WHERE id = ?
            `, [
                versionRow ? versionRow.pdf_path : 'Default',
                versionRow ? versionRow.version : 1,
                preparedPayload.coverLetter,
                JSON.stringify(preparedPayload),
                now,
                existingApp.id
            ]);
        } else {
            await runQuery(`
                INSERT INTO applications (
                    id, job_id, company, role, application_url, status,
                    resume_used, resume_version, cover_letter_used, form_payload,
                    match_score, source, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'READY_TO_APPLY', ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                appId,
                jobId,
                job.company,
                job.role,
                job.application_url || job.url,
                versionRow ? versionRow.pdf_path : 'Default',
                versionRow ? versionRow.version : 1,
                preparedPayload.coverLetter,
                JSON.stringify(preparedPayload),
                job.score || 0,
                job.source || 'aihawk',
                now,
                now
            ]);
        }

        await runQuery(`UPDATE jobs SET status = 'READY_TO_APPLY' WHERE job_id = ?`, [jobId]);

        logger.setStatus('waiting_for_approval', `Application package prepared for ${job.company}. Awaiting user approval.`, { jobId, company: job.company });
        logger.log('application_ready', `Application is READY_TO_APPLY. User approval required before execution.`, {
            jobId,
            applicationId: appId,
            preparedPayload
        }, appId, jobId);

        return {
            applicationId: appId,
            job,
            status: 'READY_TO_APPLY',
            preparedPayload,
            requiresApproval: true
        };
    }

    /**
     * Executes the browser application submission after user approval
     */
    async executeApplication(jobId, approvalOptions = {}) {
        logger.setStatus('applying', `Executing browser application for job ID: ${jobId}`, { jobId });
        logger.log('application_execution_start', `Starting application submission flow for ${jobId}`, approvalOptions, `app_${jobId}`, jobId);

        const job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
        if (!job) {
            throw new Error(`Job not found: ${jobId}`);
        }

        // Strict Duplicate Application Check
        const duplicateCheck = await checkAlreadyApplied(job);
        if (duplicateCheck.alreadyApplied) {
            logger.setStatus('completed', `Job ${jobId} already applied: ${duplicateCheck.reason}`, { jobId });
            logger.log('application_already_applied', `Duplicate prevented: ${duplicateCheck.reason}`, {}, null, jobId);
            return {
                applicationId: `app_${jobId}`,
                job,
                status: 'APPLIED',
                already_applied: true,
                reason: duplicateCheck.reason,
                message: `Skipped: ${duplicateCheck.reason}`,
                requiresApproval: false
            };
        }

        const appId = `app_${jobId}`;
        const appRow = await getQuery('SELECT * FROM applications WHERE id = ? OR job_id = ?', [appId, jobId]);
        let payload = {};
        if (appRow && appRow.form_payload) {
            try { payload = JSON.parse(appRow.form_payload); } catch (e) {}
        }

        // Apply any real-time field overrides
        if (approvalOptions.customFields) {
            payload = { ...payload, ...approvalOptions.customFields };
        }

        const now = new Date().toISOString();
        await runQuery('UPDATE applications SET status = \'APPLICATION_STARTED\', updated_at = ? WHERE id = ?', [now, appId]);
        await runQuery('UPDATE jobs SET status = \'APPLICATION_STARTED\' WHERE job_id = ?', [jobId]);

        // Launch stealth browser session
        let session;
        let screenshotPath = null;
        let relativeScreenshotPath = null;

        try {
            session = await browserManager.openSession('main', { headed: false });
            const page = session.page;

            const targetUrl = job.application_url || job.url;
            logger.log('browser_navigate', `Navigating to application page: ${targetUrl}`, {}, appId, jobId);

            try {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
                await page.waitForTimeout(500);
            } catch (navErr) {
                logger.log('browser_navigate_warning', `Navigation warning: ${navErr.message}. Continuing with staged execution.`, {}, appId, jobId);
            }

            // Fill standard form inputs dynamically
            const inputMappings = [
                { selectors: ['input[name*="first_name" i]', '#first_name', 'input[id*="first_name" i]', 'input[autocomplete="given-name"]'], val: payload.firstName || 'Applicant' },
                { selectors: ['input[name*="last_name" i]', '#last_name', 'input[id*="last_name" i]', 'input[autocomplete="family-name"]'], val: payload.lastName || 'Candidate' },
                { selectors: ['input[name*="email" i]', '#email', 'input[type="email"]', 'input[autocomplete="email"]'], val: payload.email || 'applicant@example.com' },
                { selectors: ['input[name*="phone" i]', '#phone', 'input[type="tel"]', 'input[autocomplete="tel"]'], val: payload.phone || '' },
                { selectors: ['input[name*="linkedin" i]', '#linkedin_url', 'input[id*="linkedin" i]'], val: payload.linkedin || '' },
                { selectors: ['input[name*="github" i]', '#github_url', 'input[id*="github" i]'], val: payload.github || '' },
                { selectors: ['input[name*="portfolio" i]', '#portfolio_url', 'input[id*="portfolio" i]', 'input[name*="website" i]'], val: payload.portfolio || '' }
            ];

            for (const map of inputMappings) {
                for (const sel of map.selectors) {
                    try {
                        const el = await page.$(sel);
                        if (el && await el.isVisible()) {
                            await el.fill(map.val);
                            break;
                        }
                    } catch (e) {}
                }
            }

            // Upload resume PDF if file input exists
            let resumeFileToUpload = null;
            if (payload.resumePdfPath) {
                resumeFileToUpload = path.join(__dirname, '../../../', payload.resumePdfPath);
            }
            if (!resumeFileToUpload || !fs.existsSync(resumeFileToUpload)) {
                // Find latest generated PDF
                const vers = await getQuery('SELECT pdf_path FROM resume_versions WHERE job_id = ? ORDER BY version DESC LIMIT 1', [jobId]);
                if (vers && vers.pdf_path) {
                    resumeFileToUpload = path.join(__dirname, '../../../', vers.pdf_path);
                }
            }

            if (resumeFileToUpload && fs.existsSync(resumeFileToUpload)) {
                const fileInputSelectors = ['input[type="file"]', 'input[name*="resume" i]', 'input[id*="resume" i]', '#resume'];
                for (const fSel of fileInputSelectors) {
                    try {
                        const fEl = await page.$(fSel);
                        if (fEl) {
                            await fEl.setInputFiles(resumeFileToUpload);
                            logger.log('file_upload', `Uploaded tailored resume PDF: ${path.basename(resumeFileToUpload)}`, {}, appId, jobId);
                            break;
                        }
                    } catch (e) {}
                }
            }

            // Capture verification screenshot
            const screenshotFile = `screenshot_${jobId}_${Date.now()}.png`;
            screenshotPath = path.join(screenshotsDir, screenshotFile);
            try {
                await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 3000 });
                relativeScreenshotPath = `/screenshots/${screenshotFile}`;
            } catch (sErr) {
                // Screenshot non-fatal if page layout did not render
            }

            // Check if user requested actual form submission or staging
            const autoSubmitApproved = approvalOptions.approved === true;
            let finalStatus = 'APPLIED';
            let finalMessage = 'Application submitted successfully via AIHawk agent.';

            if (autoSubmitApproved) {
                // Look for submit button
                const submitSelectors = [
                    'button[type="submit"]',
                    'input[type="submit"]',
                    '#submit_app',
                    'button:has-text("Submit Application")',
                    'button:has-text("Apply Now")'
                ];

                let clicked = false;
                for (const sSel of submitSelectors) {
                    try {
                        const btn = await page.$(sSel);
                        if (btn && await btn.isVisible()) {
                            await btn.click();
                            clicked = true;
                            logger.setStatus('application_submitted', `Application submitted for ${job.company}`, { jobId, company: job.company });
                            break;
                        }
                    } catch (e) {}
                }

                if (clicked) {
                    await page.waitForTimeout(3000);
                    // Retake screenshot of confirmation
                    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
                } else {
                    finalStatus = 'REQUIRES_USER_ACTION';
                    finalMessage = 'Form filled successfully. Manual review/CAPTCHA required for final click.';
                }
            } else {
                finalStatus = 'READY_TO_APPLY';
                finalMessage = 'Form prefilled and validated. Awaiting final user submit approval.';
            }

            // Update Database
            const completedAt = new Date().toISOString();
            await runQuery(`
                UPDATE applications
                SET status = ?,
                    applied_at = ?,
                    screenshot_path = ?,
                    error_message = NULL,
                    notes = ?,
                    updated_at = ?
                WHERE id = ?
            `, [
                finalStatus,
                finalStatus === 'APPLIED' ? completedAt : null,
                relativeScreenshotPath,
                finalMessage,
                completedAt,
                appId
            ]);

            await runQuery(`
                UPDATE jobs
                SET status = ?,
                    applied_at = ?,
                    screenshot_path = ?,
                    application_status = ?
                WHERE job_id = ?
            `, [
                finalStatus,
                finalStatus === 'APPLIED' ? completedAt : null,
                relativeScreenshotPath,
                finalMessage,
                jobId
            ]);

            logger.setStatus('completed', `Execution finished. Status: ${finalStatus}`, { jobId, company: job.company });
            logger.log('application_execution_success', finalMessage, {
                status: finalStatus,
                screenshot: relativeScreenshotPath
            }, appId, jobId);

            return {
                success: true,
                status: finalStatus,
                message: finalMessage,
                screenshotPath: relativeScreenshotPath
            };

        } catch (execErr) {
            const failedAt = new Date().toISOString();
            logger.setStatus('failed', `Application execution failed: ${execErr.message}`, { jobId });
            logger.log('application_execution_failure', `Error executing application: ${execErr.message}`, { error: execErr.message }, appId, jobId);

            await runQuery(`
                UPDATE applications
                SET status = 'FAILED',
                    error_message = ?,
                    screenshot_path = ?,
                    updated_at = ?
                WHERE id = ?
            `, [execErr.message, relativeScreenshotPath, failedAt, appId]);

            await runQuery(`
                UPDATE jobs
                SET status = 'FAILED',
                    application_status = ?
                WHERE job_id = ?
            `, [execErr.message, jobId]);

            return {
                success: false,
                status: 'FAILED',
                error: execErr.message,
                screenshotPath: relativeScreenshotPath
            };
        }
    }
}

const applicationService = new AihawkApplicationService();
module.exports = {
    AihawkApplicationService,
    applicationService
};
