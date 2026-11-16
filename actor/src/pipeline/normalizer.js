/**
 * Job Normalizer Pipeline Step
 * Maps any raw job object into the unified Normalized Job Schema.
 */

const crypto = require('crypto');

function cleanText(str) {
    if (!str) return '';
    return String(str)
        .replace(/<[^>]*>?/gm, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTitle(title) {
    if (!title) return 'Software Engineer';
    let clean = cleanText(title);
    return clean;
}

function normalizeCompany(company) {
    if (!company) return 'Unknown Company';
    return cleanText(company).replace(/\s+(Inc\.?|LLC|Ltd\.?|Corporation|Corp\.?)$/i, '');
}

function normalizeLocation(loc, remoteType) {
    if (!loc) return remoteType === 'remote' ? 'Remote (Worldwide)' : 'India / Remote';
    return cleanText(loc);
}

function determineRemoteType(title, loc, desc) {
    const locLower = (loc || '').toLowerCase();
    const titleLower = (title || '').toLowerCase();
    const descLower = (desc || '').toLowerCase();

    // Explicit remote in location or title
    if (
        locLower.includes('remote') || locLower.includes('anywhere') || locLower.includes('work from home') ||
        locLower.includes('wfh') || locLower.includes('telecommute') || locLower.includes('virtual') ||
        locLower.includes('home based') || locLower.includes('home-based') || locLower.includes('distributed') ||
        titleLower.includes('(remote)') || titleLower.includes('[remote]') || titleLower.includes(' - remote') ||
        titleLower.includes(', remote') || titleLower.includes('remote -') ||
        descLower.includes('100% remote') || descLower.includes('workplace type: remote') || descLower.includes('location: remote')
    ) {
        return 'remote';
    }

    if (locLower.includes('hybrid') || locLower.includes('flexible') || descLower.includes('workplace type: hybrid')) {
        return 'hybrid';
    }

    return 'onsite';
}

function determineExperienceLevel(title, desc) {
    const text = `${title} ${desc}`.toLowerCase();
    if (text.includes('intern') || text.includes('trainee') || text.includes('co-op')) {
        return 'internship';
    }
    if (text.includes('graduate') || text.includes('junior') || text.includes('fresher') || text.includes('entry') || text.includes('associate') || text.includes('sde 1') || text.includes('sde-1') || text.includes('level 1')) {
        return 'entry_level';
    }
    if (text.includes('senior') || text.includes('sr.') || text.includes('lead') || text.includes('staff') || text.includes('principal') || text.includes('director')) {
        return 'senior';
    }
    return 'entry_mid';
}

function extractSkillsFromText(text) {
    if (!text) return [];
    const techCatalog = [
        'python', 'javascript', 'typescript', 'go', 'golang', 'java', 'c++', 'c#', 'rust',
        'react', 'next.js', 'node.js', 'express', 'fastapi', 'flask', 'django', 'spring', 'grpc', 'graphql', 'rest',
        'postgresql', 'postgres', 'mongodb', 'redis', 'mysql', 'sqlite', 'supabase', 'prisma', 'dynamodb',
        'docker', 'kubernetes', 'aws', 'gcp', 'azure', 'vercel', 'render', 'git', 'github', 'ci/cd',
        'llm', 'llms', 'rag', 'agentic', 'langchain', 'ollama', 'transformers', 'pytorch', 'tensorflow', 'scikit-learn'
    ];

    const lower = text.toLowerCase();
    const found = [];
    techCatalog.forEach(skill => {
        const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|[^a-zA-Z0-9_+#])${escaped}($|[^a-zA-Z0-9_+#])`, 'i');
        if (regex.test(lower)) {
            found.push(skill);
        }
    });
    return [...new Set(found)];
}

function generateJobId(company, role, url) {
    const key = `${normalizeCompany(company).toLowerCase()}_${normalizeTitle(role).toLowerCase()}_${url}`;
    return crypto.createHash('sha256').update(key).digest('hex').substring(0, 16);
}

function normalizeJob(rawJob) {
    const role = normalizeTitle(rawJob.role || rawJob.title);
    const company = normalizeCompany(rawJob.company);
    const applicationUrl = rawJob.application_url || rawJob.url || rawJob.apply_url || '';
    const description = cleanText(rawJob.description || rawJob.body || '');
    const location = normalizeLocation(rawJob.location, rawJob.remote_type);
    const remoteType = rawJob.remote_type || determineRemoteType(role, location, description);
    const experienceLevel = rawJob.experience_level || determineExperienceLevel(role, description);

    const extractedSkills = extractSkillsFromText(`${role} ${description}`);
    const skillsString = rawJob.skills || extractedSkills.join(', ');

    const now = new Date().toISOString();
    const jobId = generateJobId(company, role, applicationUrl);

    return {
        id: jobId,
        job_id: jobId,
        external_id: rawJob.external_id ? String(rawJob.external_id) : null,
        source: rawJob.source || 'Aggregated',
        source_url: rawJob.source_url || applicationUrl,
        company: company,
        company_url: rawJob.company_url || (company ? `https://${company.toLowerCase().replace(/[^a-z0-9]/g, '')}.com` : null),
        role: role,
        department: rawJob.department || 'Engineering',
        location: location,
        country: rawJob.country || (location.toLowerCase().includes('india') ? 'India' : (remoteType === 'remote' ? 'Worldwide' : 'USA')),
        remote_type: remoteType,
        employment_type: rawJob.employment_type || 'full_time',
        experience_level: experienceLevel,
        salary_min: rawJob.salary_min ? Number(rawJob.salary_min) : 0,
        salary_max: rawJob.salary_max ? Number(rawJob.salary_max) : 0,
        salary_currency: rawJob.salary_currency || 'USD',
        salary: rawJob.salary || (rawJob.salary_min && rawJob.salary_max ? `${rawJob.salary_min} - ${rawJob.salary_max} ${rawJob.salary_currency || 'USD'}` : null),
        skills: skillsString,
        required_skills: rawJob.required_skills || skillsString,
        preferred_skills: rawJob.preferred_skills || null,
        education_requirements: rawJob.education_requirements || 'Bachelor’s degree in Computer Science, Engineering or related technical field',
        experience_requirements: rawJob.experience_requirements || (experienceLevel === 'internship' ? 'Student / Recent Graduate' : '0-3 years experience'),
        description: description,
        posted_at: rawJob.posted_at || rawJob.date || now,
        deadline: rawJob.deadline || null,
        application_url: applicationUrl,
        company_description: rawJob.company_description || company,
        source_verified: rawJob.source_verified !== undefined ? (rawJob.source_verified ? 1 : 0) : 1,
        verification_url: rawJob.verification_url || applicationUrl,
        discovered_at: now,
        last_seen_at: now,
        status: rawJob.status || 'ACTIVE',
        match_score: rawJob.match_score || 0,
        raw_data: JSON.stringify(rawJob.raw || rawJob)
    };
}

module.exports = {
    normalizeJob,
    normalizeTitle,
    normalizeCompany,
    determineRemoteType,
    determineExperienceLevel,
    extractSkillsFromText,
    generateJobId
};
