/**
 * crm_service.js — Central Application Tracking CRM & Follow-Up Cadence Engine
 * Adapted from career-ops-main/followup-cadence.mjs & set-status.mjs
 * 
 * Features:
 * 1. Strict State Machine with transition audits.
 * 2. Automatic follow-up cadence calculation (T+3 touchpoint, T+7 check-in, T+1 interview thank-you).
 * 3. Overdue detection and personalized outreach email generator.
 * 4. Multi-column Kanban aggregation.
 */

const { runQuery, allQuery, getQuery } = require('./db');

const VALID_STATUSES = [
    'SAVED',
    'MATCHED',
    'READY_FOR_REVIEW',
    'SUBMITTED',
    'UNDER_REVIEW',
    'INTERVIEW',
    'OFFER',
    'REJECTED',
    'ARCHIVED'
];

const VALID_TRANSITIONS = {
    'SAVED': ['MATCHED', 'READY_FOR_REVIEW', 'ARCHIVED'],
    'MATCHED': ['READY_FOR_REVIEW', 'SAVED', 'ARCHIVED'],
    'READY_FOR_REVIEW': ['SUBMITTED', 'SAVED', 'ARCHIVED'],
    'BLOCKED_CAPTCHA': ['READY_FOR_REVIEW', 'SUBMITTED', 'ARCHIVED'],
    'SUBMITTED': ['UNDER_REVIEW', 'INTERVIEW', 'REJECTED', 'OFFER', 'ARCHIVED'],
    'UNDER_REVIEW': ['INTERVIEW', 'REJECTED', 'OFFER', 'ARCHIVED'],
    'INTERVIEW': ['OFFER', 'REJECTED', 'ARCHIVED'],
    'OFFER': ['ARCHIVED'],
    'REJECTED': ['ARCHIVED', 'SAVED'],
    'ARCHIVED': ['SAVED', 'READY_FOR_REVIEW']
};

/**
 * Validates whether a state transition is legal.
 */
function isValidTransition(fromStatus, toStatus) {
    if (!fromStatus) return true;
    if (fromStatus === toStatus) return true;
    const allowed = VALID_TRANSITIONS[fromStatus] || [];
    return allowed.includes(toStatus);
}

/**
 * Calculates due dates for follow-up reminders.
 */
function calculateDueDate(baseDateIso, daysToAdd) {
    const d = new Date(baseDateIso);
    d.setDate(d.getDate() + daysToAdd);
    return d.toISOString();
}

/**
 * Retrieves applications grouped into Kanban columns.
 */
async function getKanbanBoard() {
    const apps = await allQuery(`
        SELECT 
            a.*,
            j.location,
            j.remote_type,
            j.skills,
            j.salary,
            j.score as job_score
        FROM applications a
        LEFT JOIN jobs j ON a.job_id = j.job_id
        ORDER BY a.updated_at DESC
    `);

    const columns = {
        saved: [],
        ready_for_review: [],
        submitted: [],
        interviewing: [],
        offers: [],
        archived: []
    };

    const now = new Date();

    for (const app of apps) {
        // Calculate follow-up status if submitted
        let followupBadge = null;
        if (app.status === 'SUBMITTED' && app.applied_at) {
            const appliedDate = new Date(app.applied_at);
            const daysSinceApplied = Math.floor((now - appliedDate) / (1000 * 60 * 60 * 24));
            if (daysSinceApplied >= 7) {
                followupBadge = { text: 'Follow-up Overdue (T+7)', urgent: true, days: daysSinceApplied };
            } else if (daysSinceApplied >= 3) {
                followupBadge = { text: 'Check-in Due (T+3)', urgent: false, days: daysSinceApplied };
            } else {
                followupBadge = { text: `Applied ${daysSinceApplied}d ago`, urgent: false, days: daysSinceApplied };
            }
        }

        const appCard = {
            ...app,
            followupBadge
        };

        switch (app.status) {
            case 'SAVED':
            case 'MATCHED':
                columns.saved.push(appCard);
                break;
            case 'READY_FOR_REVIEW':
            case 'AWAITING_APPROVAL':
            case 'READY_TO_APPLY':
            case 'BLOCKED_CAPTCHA':
                columns.ready_for_review.push(appCard);
                break;
            case 'SUBMITTED':
            case 'UNDER_REVIEW':
                columns.submitted.push(appCard);
                break;
            case 'INTERVIEW':
                columns.interviewing.push(appCard);
                break;
            case 'OFFER':
                columns.offers.push(appCard);
                break;
            case 'REJECTED':
            case 'ARCHIVED':
            default:
                columns.archived.push(appCard);
                break;
        }
    }

    return columns;
}

/**
 * Updates application status and schedules follow-up cadence reminders.
 */
async function updateApplicationStatus(appId, newStatus, notes = '') {
    const app = await getQuery('SELECT * FROM applications WHERE id = ?', [appId]);
    if (!app) {
        throw new Error(`Application ${appId} not found`);
    }

    const currentStatus = app.status;
    const now = new Date().toISOString();

    // Check transition
    if (!isValidTransition(currentStatus, newStatus)) {
        console.warn(`[CRM] Non-standard transition from ${currentStatus} to ${newStatus}`);
    }

    let appliedAt = app.applied_at;
    if (newStatus === 'SUBMITTED' && !appliedAt) {
        appliedAt = now;
    }

    await runQuery(`
        UPDATE applications SET
            status = ?,
            notes = COALESCE(?, notes),
            applied_at = ?,
            updated_at = ?
        WHERE id = ?
    `, [newStatus, notes || null, appliedAt, now, appId]);

    // Schedule reminders if transitioning to SUBMITTED
    if (newStatus === 'SUBMITTED') {
        const t3Due = calculateDueDate(now, 3);
        const t7Due = calculateDueDate(now, 7);

        await runQuery(`
            INSERT INTO application_reminders (id, application_id, job_id, company, role, followup_type, due_date, status, message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'T+3', ?, 'PENDING', ?, ?, ?)
        `, [
            `rem_${Date.now()}_t3`,
            appId,
            app.job_id,
            app.company,
            app.role,
            t3Due,
            `Touchpoint: Check application status with recruiter at ${app.company}`,
            now,
            now
        ]);

        await runQuery(`
            INSERT INTO application_reminders (id, application_id, job_id, company, role, followup_type, due_date, status, message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'T+7', ?, 'PENDING', ?, ?, ?)
        `, [
            `rem_${Date.now()}_t7`,
            appId,
            app.job_id,
            app.company,
            app.role,
            t7Due,
            `Follow-up: Second status check for ${app.role} at ${app.company}`,
            now,
            now
        ]);
    }

    // Schedule post-interview thank you
    if (newStatus === 'INTERVIEW') {
        const t1Due = calculateDueDate(now, 1);
        await runQuery(`
            INSERT INTO application_reminders (id, application_id, job_id, company, role, followup_type, due_date, status, message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'T+1', ?, 'PENDING', ?, ?, ?)
        `, [
            `rem_${Date.now()}_t1`,
            appId,
            app.job_id,
            app.company,
            app.role,
            t1Due,
            `Send thank-you email following interview at ${app.company}`,
            now,
            now
        ]);
    }

    // Audit log
    await runQuery(`
        INSERT INTO application_logs (application_id, job_id, event_type, message, details, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [
        appId,
        app.job_id || null,
        'STATUS_CHANGE',
        `Status changed from ${currentStatus} to ${newStatus}. Notes: ${notes || 'none'}`,
        JSON.stringify({ previousStatus: currentStatus, newStatus, notes }),
        now
    ]);

    return {
        success: true,
        previousStatus: currentStatus,
        newStatus,
        updatedAt: now
    };
}

/**
 * Returns pending reminders and flags overdue items.
 */
async function getReminders() {
    const reminders = await allQuery(`
        SELECT * FROM application_reminders
        WHERE status = 'PENDING'
        ORDER BY due_date ASC
    `);

    const now = new Date();
    return reminders.map(r => {
        const due = new Date(r.due_date);
        const diffMs = due - now;
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        return {
            ...r,
            isOverdue: diffMs < 0,
            daysUntilDue: diffDays
        };
    });
}

/**
 * Drafts a follow-up email template for a specific application.
 */
async function generateFollowupDraft(appId, type = 'T+7') {
    const app = await getQuery('SELECT * FROM applications WHERE id = ?', [appId]);
    if (!app) throw new Error('Application not found');

    const { getCandidateProfile } = require('./connectors/candidateConnector');
    const profile = getCandidateProfile();
    const info = (profile && profile.personal_information) || {};
    const candidateName = [info.first_name, info.last_name].filter(Boolean).join(' ') || 'Applicant';
    const email = info.email || '';
    const phone = info.phone || '';
    const portfolio = info.portfolio ? `Portfolio: ${info.portfolio}` : '';
    const linkedin = info.linkedin ? `LinkedIn: ${info.linkedin}` : '';
    const github = info.github ? `GitHub: ${info.github}` : '';
    const contactLine = [phone, email].filter(Boolean).join(' | ');
    const socialLinks = [portfolio, linkedin, github].filter(Boolean).join('\n');

    if (type === 'T+1' || type === 'THANK_YOU') {
        return {
            subject: `Thank you for the interview — ${app.role} | ${candidateName}`,
            body: `Hi [Interviewer Name],

Thank you for taking the time to speak with me today about the ${app.role} role at ${app.company}. I thoroughly enjoyed discussing the team's engineering goals and architecture.

Our conversation reaffirmed my enthusiasm for joining ${app.company}. I look forward to the next steps.

Best regards,
${candidateName}
${contactLine}
${portfolio}`.trim()
        };
    }

    return {
        subject: `Following up on application: ${app.role} — ${candidateName}`,
        body: `Hi [Recruiter / Hiring Team],

I hope you're having a productive week.

I recently submitted my application for the ${app.role} opening at ${app.company}. With my background in software engineering, full-stack systems, and autonomous applications, I am very interested in contributing to ${app.company}'s engineering initiatives.

I wanted to politely follow up to see if you needed any additional details or work samples.

Thank you for your time and consideration.

Best regards,
${candidateName}
${contactLine}
${socialLinks}`.trim()
    };
}

module.exports = {
    VALID_STATUSES,
    isValidTransition,
    getKanbanBoard,
    updateApplicationStatus,
    getReminders,
    generateFollowupDraft
};
