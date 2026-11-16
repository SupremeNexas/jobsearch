const { runQuery, getQuery, allQuery } = require('../../db');
const { client } = require('./client');
const { logger } = require('./logs');
const fs = require('fs');
const path = require('path');

class AihawkMatcherService {
    async getCandidateProfile() {
        const profilePath = path.join(__dirname, '../../profile.json');
        if (fs.existsSync(profilePath)) {
            try {
                return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            } catch (e) {
                console.warn('[Matcher] Could not parse profile.json:', e.message);
            }
        }
        return {
            personal_information: {
                first_name: 'Applicant',
                last_name: 'Candidate',
                email: 'applicant@example.com',
                phone: '',
                linkedin: '',
                github: ''
            },
            skills: ['Node.js', 'Express', 'React', 'TypeScript', 'JavaScript', 'Python', 'FastAPI', 'Go', 'SQLite', 'PostgreSQL', 'Docker', 'Git', 'Playwright']
        };
    }

    async getActiveResumeContent() {
        const activeSetting = await getQuery("SELECT value FROM settings WHERE key = 'ACTIVE_BASE_RESUME'");
        const activeResume = (activeSetting && activeSetting.value) || 'sample_resume.md';
        const candidatePaths = [
            path.join(__dirname, '../../../../resumes', activeResume),
            path.join(__dirname, '../../../../resumes/sample_resume.md')
        ];
        for (const p of candidatePaths) {
            try {
                if (fs.existsSync(p)) {
                    const stat = fs.statSync(p);
                    if (stat.blocks > 0 || stat.size === 0) {
                        return fs.readFileSync(p, 'utf8');
                    }
                }
            } catch (err) {
                // skip unreadable
            }
        }
        return '';
    }

    async evaluateJob(jobId) {
        const job = await getQuery('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
        if (!job) {
            throw new Error(`Job not found: ${jobId}`);
        }

        logger.setStatus('evaluating_job', `Evaluating match for ${job.role} at ${job.company}`, { jobId, company: job.company });

        const profile = await this.getCandidateProfile();
        const resumeText = await this.getActiveResumeContent();

        const match = await client.matchJob(job, profile, resumeText);
        const now = new Date().toISOString();

        // Update jobs table
        await runQuery(`
            UPDATE jobs
            SET score = ?,
                score_explanation = ?,
                status = CASE WHEN status = 'DISCOVERED' THEN 'EVALUATED' ELSE status END
            WHERE job_id = ?
        `, [
            match.overall_score,
            JSON.stringify(match),
            jobId
        ]);

        // Insert or update ai_job_matches table
        const existingMatch = await getQuery('SELECT id FROM ai_job_matches WHERE job_id = ?', [jobId]);
        if (existingMatch) {
            await runQuery(`
                UPDATE ai_job_matches
                SET overall_score = ?, skill_match = ?, experience_match = ?, education_match = ?,
                    location_match = ?, tech_match = ?, matched_skills = ?, missing_skills = ?,
                    recommended_resume = ?, explanation = ?, evaluated_at = ?
                WHERE job_id = ?
            `, [
                match.overall_score,
                match.skill_match,
                match.experience_match,
                match.education_match,
                match.location_match,
                match.tech_match,
                JSON.stringify(match.matched_skills),
                JSON.stringify(match.missing_skills),
                match.recommended_resume,
                match.explanation,
                now,
                jobId
            ]);
        } else {
            await runQuery(`
                INSERT INTO ai_job_matches (
                    job_id, overall_score, skill_match, experience_match, education_match,
                    location_match, tech_match, matched_skills, missing_skills,
                    recommended_resume, explanation, evaluated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                jobId,
                match.overall_score,
                match.skill_match,
                match.experience_match,
                match.education_match,
                match.location_match,
                match.tech_match,
                JSON.stringify(match.matched_skills),
                JSON.stringify(match.missing_skills),
                match.recommended_resume,
                match.explanation,
                now
            ]);
        }

        logger.log('job_evaluated', `Match score for ${job.company}: ${match.overall_score}%`, {
            jobId,
            match
        });

        return match;
    }

    async getJobMatch(jobId) {
        return getQuery('SELECT * FROM ai_job_matches WHERE job_id = ?', [jobId]);
    }
}

const matcherService = new AihawkMatcherService();
module.exports = {
    AihawkMatcherService,
    matcherService
};
