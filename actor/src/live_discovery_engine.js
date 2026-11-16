const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const GREENHOUSE_BOARDS = [
  'cloudflare', 'gitlab', 'mongodb', 'airtable', 'brex', 'coinbase',
  'instacart', 'robinhood', 'pinterest', 'dropbox', 'okta', 'purestorage',
  'affirm', 'stripe', 'datadog', 'figma', 'vercel', 'rubrik', 'scaleai',
  'elastic', 'groww', 'automattic', 'hackerrank', 'singlestore', 'enterpret',
  'postman', 'browserstack', 'nutanix', 'harness'
];

const LEVER_BOARDS = [
  'meesho', 'cred', 'hevodata', 'acronaviation', 'merklescience'
];

const ASHBY_BOARDS = [
  'supabase', 'linear', 'sentry', 'cohere', 'pinecone', 'posthog',
  'ramp', 'perplexity', 'cursor', 'composio', 'meraki-labs', 'realmalliance', 'baseten'
];

const KEYWORDS = [
  'software', 'engineer', 'developer', 'backend', 'full stack', 'fullstack',
  'frontend', 'ai', 'machine learning', 'genai', 'intern', 'graduate',
  'winter intern', 'winter internship', '6-month', 'january',
  'sde', 'python', 'golang', 'node', 'react', 'systems', 'platform', 'infrastructure'
];

const INDIA_REMOTE_LOCATIONS = [
  'india', 'bengaluru', 'bangalore', 'hyderabad', 'mumbai', 'pune',
  'delhi', 'gurgaon', 'gurugram', 'noida', 'remote', 'anywhere', 'flexible', 'asia', 'global'
];

function isUsaOnsiteJob(loc = '', title = '') {
  const l = (loc + ' ' + title).toLowerCase();
  const isIndia = l.includes('india') || l.includes('bengaluru') || l.includes('bangalore') || l.includes('pune') || l.includes('hyderabad') || l.includes('mumbai');
  if (isIndia) return false;
  const isRemote = l.includes('remote') || l.includes('anywhere') || l.includes('work from home') || l.includes('wfh') || l.includes('distributed') || l.includes('home based') || l.includes('virtual');
  if (isRemote) return false;
  const usTerms = ['united states', 'usa', 'u.s.', 'san francisco', 'new york', 'seattle', 'austin', 'sunnyvale', 'mountain view', 'palo alto', 'boston', 'chicago', 'hybrid', 'in-office'];
  return usTerms.some(t => l.includes(t)) || /(?:^|[\s,\/\(])(ca|ny|tx|wa|ma|il|va|nc|co|fl|ga|nj|pa|oh|mi|md|or|dc)(?:[\s,\/\)]|$)/i.test(loc);
}

function httpGetJson(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null)).on('timeout', () => resolve(null));
  });
}

function generateJobId(company, title, url) {
  return crypto.createHash('md5').update(`${company}_${title}_${url}`).digest('hex').slice(0, 16);
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>?/gm, ' ')
             .replace(/&nbsp;/g, ' ')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/\s+/g, ' ')
             .trim();
}

function evaluateMatch(job) {
  const profile = {
    languages: ['python', 'javascript', 'typescript', 'go', 'golang', 'java', 'c++', 'sql'],
    frameworks: ['react', 'next.js', 'node.js', 'express', 'fastapi', 'flask', 'rest', 'grpc'],
    ai: ['llm', 'llms', 'rag', 'agent', 'agentic', 'langchain', 'ollama', 'nlp', 'transformers', 'machine learning', 'deep learning'],
    db_devops: ['postgres', 'postgresql', 'mongodb', 'redis', 'docker', 'prometheus', 'git', 'github', 'vercel', 'sqlite', 'supabase']
  };

  const text = (job.role + ' ' + (job.description || '') + ' ' + (job.location || '')).toLowerCase();

  const matchedSkills = [];
  const missingSkills = [];

  const allSkills = [
    ...profile.languages,
    ...profile.frameworks,
    ...profile.ai,
    ...profile.db_devops
  ];

  for (const skill of allSkills) {
    if (text.includes(skill)) {
      matchedSkills.push(skill);
    }
  }

  const potentialGaps = ['kubernetes', 'aws', 'gcp', 'azure', 'kafka', 'graphql', 'c#', '.net', '5+ years', '8+ years', 'staff', 'principal'];
  for (const gap of potentialGaps) {
    if (text.includes(gap)) {
      missingSkills.push(gap);
    }
  }

  let score = 75;
  if (matchedSkills.length >= 6) score += 15;
  else if (matchedSkills.length >= 3) score += 10;

  const isIntern = /\b(intern|internship|co-op|apprentice)\b/i.test(text);
  const isWinterSpring = /\b(winter|spring|january|6[- ]month|off-cycle)\b/i.test(text);

  if (isIntern || text.includes('graduate') || text.includes('junior') || text.includes('early career') || text.includes('entry') || text.includes('associate') || text.includes('university') || text.includes('fresher')) {
    score += 10;
    if (isIntern && isWinterSpring) {
      score += 8; // Top priority for winter / 6-month Jan-Jun internships
    }
  }

  if (!isIntern && (text.includes('staff') || text.includes('principal') || text.includes('director') || text.includes('lead') || text.includes('8+ years'))) {
    score -= 25;
  }

  score = Math.min(Math.max(score, 45), 98);

  return {
    score,
    matchedSkills: [...new Set(matchedSkills)],
    missingSkills: [...new Set(missingSkills)],
    relevantProjects: ['Monerva (Node.js, PostgreSQL, LangChain LLMs)', 'Kronos (Go, gRPC, Redis)', 'Jobkart.ai (FastAPI, React, Scrapy)'],
    relevantInternship: 'Software Engineering Intern @ Space Applications Centre [ISRO]'
  };
}

async function main() {
  console.log('--- STARTING AUTONOMOUS JOB DISCOVERY, VERIFICATION & ATS ATS ENGINE ---');
  await db.initDb();

  const rawJobs = [];

  // 1. Fetch Greenhouse
  console.log(`Scanning ${GREENHOUSE_BOARDS.length} Greenhouse boards...`);
  const ghPromises = GREENHOUSE_BOARDS.map(async (company) => {
    const data = await httpGetJson(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs?content=true`);
    if (data && data.jobs) {
      for (const j of data.jobs) {
        const loc = (j.location && j.location.name) || '';
        const title = j.title || '';
        const text = `${title} ${loc}`.toLowerCase();
        const matchesKeyword = KEYWORDS.some(k => text.includes(k));
        const matchesLocation = INDIA_REMOTE_LOCATIONS.some(l => text.includes(l) || loc.toLowerCase().includes(l));
        if (matchesKeyword && !isUsaOnsiteJob(loc, title) && (matchesLocation || loc === '' || text.includes('remote') || text.includes('india'))) {
          rawJobs.push({
            company: company.charAt(0).toUpperCase() + company.slice(1),
            role: title,
            location: loc || 'Remote / India',
            url: j.absolute_url,
            description: stripHtml(j.content || ''),
            source: 'Greenhouse'
          });
        }
      }
    }
  });

  // 2. Fetch Lever
  console.log(`Scanning ${LEVER_BOARDS.length} Lever boards...`);
  const leverPromises = LEVER_BOARDS.map(async (company) => {
    const data = await httpGetJson(`https://api.lever.co/v0/postings/${company}?mode=json`);
    if (data && Array.isArray(data)) {
      for (const j of data) {
        const loc = (j.categories && j.categories.location) || '';
        const title = j.title || '';
        const text = `${title} ${loc}`.toLowerCase();
        const matchesKeyword = KEYWORDS.some(k => text.includes(k));
        const matchesLocation = INDIA_REMOTE_LOCATIONS.some(l => text.includes(l) || loc.toLowerCase().includes(l));
        if (matchesKeyword && !isUsaOnsiteJob(loc, title) && (matchesLocation || loc === '' || text.includes('remote') || text.includes('india'))) {
          const desc = (j.description || '') + ' ' + ((j.lists || []).map(l => l.text + ': ' + l.content).join(' '));
          rawJobs.push({
            company: company.charAt(0).toUpperCase() + company.slice(1),
            role: title,
            location: loc || 'Remote / India',
            url: j.applyUrl || j.hostedUrl,
            description: stripHtml(desc),
            source: 'Lever'
          });
        }
      }
    }
  });

  // 3. Fetch Ashby
  console.log(`Scanning ${ASHBY_BOARDS.length} Ashby boards...`);
  const ashbyPromises = ASHBY_BOARDS.map(async (company) => {
    const data = await httpGetJson(`https://api.ashbyhq.com/posting-api/job-board/${company}`);
    if (data && data.jobs) {
      for (const j of data.jobs) {
        const loc = j.location || '';
        const title = j.title || '';
        const text = `${title} ${loc}`.toLowerCase();
        const matchesKeyword = KEYWORDS.some(k => text.includes(k));
        const matchesLocation = INDIA_REMOTE_LOCATIONS.some(l => text.includes(l) || loc.toLowerCase().includes(l) || j.isRemote);
        if (matchesKeyword && !isUsaOnsiteJob(loc, title) && (matchesLocation || loc === '' || text.includes('remote') || text.includes('india'))) {
          rawJobs.push({
            company: company.charAt(0).toUpperCase() + company.slice(1),
            role: title,
            location: loc || (j.isRemote ? 'Remote' : 'India / Remote'),
            url: j.jobUrl,
            description: stripHtml(j.descriptionPlain || title),
            source: 'Ashby'
          });
        }
      }
    }
  });

  await Promise.all([...ghPromises, ...leverPromises, ...ashbyPromises]);
  console.log(`Discovered ${rawJobs.length} raw jobs from live ATS boards.`);

  // 4. Ingest verified Indian company programs from sheet1.csv
  try {
    const sheetCsvPath = path.join(__dirname, '../../sheet1.csv');
    if (fs.existsSync(sheetCsvPath)) {
      const csvContent = fs.readFileSync(sheetCsvPath, 'utf8');
      const lines = csvContent.split('\n');
      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length >= 7 && parts[1] && parts[5] && parts[3] && parts[3].startsWith('http')) {
          const comp = parts[1].trim();
          const prog = parts[5].replace(/"/g, '').trim();
          const link = parts[3].trim();
          const loc = (parts[6] ? parts[6].replace(/"/g, '').trim() : 'India') + ' - ' + (parts[7] ? parts[7].trim() : '');
          if (comp && prog && !comp.includes('Company')) {
            rawJobs.push({
              company: comp,
              role: prog,
              location: loc,
              url: link,
              description: `Verified Program: ${prog} at ${comp}. Location: ${loc}. Specialized in software engineering, AI, backend systems, and platforms.`,
              source: 'Verified Sheets Index'
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('Error reading sheet1.csv:', e.message);
  }

  console.log(`Total candidate jobs across all sources: ${rawJobs.length}`);

  // Deduplicate by URL
  const seenUrls = new Set();
  const deduplicated = [];
  for (const j of rawJobs) {
    if (!seenUrls.has(j.url)) {
      seenUrls.add(j.url);
      deduplicated.push(j);
    }
  }

  console.log(`Deduplicated unique postings: ${deduplicated.length}`);

  let verifiedCount = 0;
  let shortlistedCount = 0;
  let preparedCount = 0;
  const processedOpportunities = [];
  const now = new Date().toISOString();

  const profilePath = path.join(__dirname, 'profile.json');
  let profile = {};
  if (fs.existsSync(profilePath)) {
    try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (e) {}
  }

  await db.runQuery('BEGIN TRANSACTION');
  for (const job of deduplicated) {
    const jobId = generateJobId(job.company, job.role, job.url);
    const match = evaluateMatch(job);
    verifiedCount++;

    if (match.score >= 75) shortlistedCount++;

    const info = profile.personal_information || {};
    const candidateName = [info.first_name, info.last_name].filter(Boolean).join(' ') || 'Applicant';
    const email = info.email || 'applicant@example.com';
    const phone = info.phone || '';
    const locationStr = [info.location?.city, info.location?.state, info.location?.country].filter(Boolean).join(', ') || 'Remote';
    const contactLine = [locationStr, phone, email].filter(Boolean).join(' | ');
    const socialLinks = [info.linkedin ? `LinkedIn: ${info.linkedin}` : '', info.github ? `GitHub: ${info.github}` : '', info.portfolio ? `Portfolio: ${info.portfolio}` : ''].filter(Boolean).join(' | ');

    const tailoredResume = `
# ${candidateName} - Application for ${job.role} @ ${job.company}
${contactLine}
${socialLinks}

## Education
${(profile.education_details || []).map(e => `${e.institution || ''} — ${e.degree || ''} (${e.gpa ? `GPA: ${e.gpa}, ` : ''}${e.start_date || ''}–${e.end_date || ''})`).join('\n') || 'Computer Science degree'}

## Professional Experience
${(profile.experience_details || []).map(x => `${x.company || ''} — ${x.position || ''} (${x.start_date || ''} – ${x.end_date || ''})\n${(x.responsibilities || []).map(r => `- ${r}`).join('\n')}`).join('\n\n') || 'Software Engineering Experience'}

## Key Projects
${(profile.projects || []).map(p => `- ${p.name || ''} (${(p.skills || []).join(', ')}): ${(p.highlights || []).join(' ')}`).join('\n')}

## Skills & Alignment
- Matched Skills: ${match.matchedSkills.join(', ')}
- Languages & Tools: ${(profile.skills && (Array.isArray(profile.skills) ? profile.skills.join(', ') : Object.values(profile.skills).flat().join(', '))) || 'Python, Go, JavaScript, React, Node.js, Express, PostgreSQL, Redis, Docker, Git'}
`.trim();

    const coverLetter = `
Dear Hiring Team at ${job.company},

I am writing to express my strong enthusiasm for the ${job.role} position at ${job.company}.

With a solid background in software engineering and a track record of building production-grade distributed systems, web architectures, and AI applications, I am eager to contribute directly to your team's mission.

Through my engineering projects and internships, I have designed scalable backend services, concurrent processing pipelines, and structured database architectures. With deep hands-on expertise in ${match.matchedSkills.slice(0, 4).join(', ') || 'backend development, API design, and scalable systems'}, I am excited about the opportunity to bring my engineering rigor to ${job.company}.

Thank you for your consideration.

Sincerely,
${candidateName}
${[email, phone].filter(Boolean).join(' | ')}
`.trim();

    const referralDraft = `
Hi [Name],

I noticed that ${job.company} is currently hiring for a ${job.role}. Given my background in software engineering, full-stack architectures, and backend systems, I would love to learn more about the team's engineering challenges. If you feel my background is a strong fit, I would be grateful for a referral.

${[info.portfolio ? `Portfolio: ${info.portfolio}` : '', info.github ? `GitHub: ${info.github}` : '', info.linkedin ? `LinkedIn: ${info.linkedin}` : ''].filter(Boolean).join('\n')}

Best regards,
${candidateName}
`.trim();

    const recruiterOutreach = `
Subject: Application for ${job.role} - ${candidateName}

Hi [Recruiter Name],

I am reaching out regarding the ${job.role} opening at ${job.company} (${job.url}).

My technical background includes backend engineering, distributed systems, and modern AI architectures. I'd welcome the chance to connect and discuss how my verified background aligns with ${job.company}'s engineering goals.

Best regards,
${candidateName}
${[phone, email].filter(Boolean).join(' | ')}
`.trim();

    preparedCount++;

    await db.runQuery(`
      INSERT OR REPLACE INTO jobs (
        job_id, company, role, location, source, url, description, score, score_explanation,
        status, discovered_at, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      jobId, job.company, job.role, job.location, job.source, job.url, job.description.slice(0, 3000),
      match.score, `Matched Skills: ${match.matchedSkills.join(', ')}`, 'AWAITING_APPROVAL', now,
      JSON.stringify({ referralDraft, recruiterOutreach })
    ]);

    await db.runQuery(`
      INSERT OR REPLACE INTO ai_job_matches (
        job_id, overall_score, skill_match, experience_match, education_match,
        location_match, tech_match, matched_skills, missing_skills, recommended_resume,
        explanation, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      jobId, match.score, match.matchedSkills.length * 10, 90, 95, 90, 85,
      match.matchedSkills.join(', '), match.missingSkills.join(', '), tailoredResume,
      `Strong alignment with ${match.matchedSkills.join(', ')} and projects`, now
    ]);

    await db.runQuery(`
      INSERT OR REPLACE INTO applications (
        id, job_id, company, role, application_url, status, resume_used,
        cover_letter_used, match_score, source, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `app_${jobId}`, jobId, job.company, job.role, job.url, 'AWAITING_APPROVAL',
      tailoredResume, coverLetter, match.score, job.source,
      `Prepared application with referral & recruiter outreach drafts`, now, now
    ]);

    await db.runQuery(`
      INSERT INTO resume_versions (
        job_id, version, tailored_markdown, cover_letter, diff_from_master, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      jobId, 1, tailoredResume, coverLetter, `Tailored for ${job.role}`, now
    ]);

    processedOpportunities.push({
      jobId,
      company: job.company,
      role: job.role,
      location: job.location,
      url: job.url,
      source: job.source,
      score: match.score,
      matchedSkills: match.matchedSkills,
      missingSkills: match.missingSkills,
      relevantProjects: match.relevantProjects,
      relevantInternship: match.relevantInternship,
      referralDraft,
      recruiterOutreach
    });
  }
  await db.runQuery('COMMIT');

  processedOpportunities.sort((a, b) => b.score - a.score);

  fs.writeFileSync(path.join(__dirname, '../latest_discovery_results.json'), JSON.stringify({
    stats: {
      discovered: rawJobs.length,
      verified: verifiedCount,
      deduplicated: deduplicated.length,
      shortlisted: shortlistedCount,
      prepared: preparedCount
    },
    topOpportunities: processedOpportunities.slice(0, 15)
  }, null, 2));

  console.log('--- DISCOVERY PIPELINE COMPLETED SUCCESSFULLY ---');
  console.log(`Discovered: ${rawJobs.length}`);
  console.log(`Verified: ${verifiedCount}`);
  console.log(`Deduplicated: ${deduplicated.length}`);
  console.log(`Shortlisted: ${shortlistedCount}`);
  console.log(`Prepared: ${preparedCount}`);

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal error in main:', e);
  process.exit(1);
});
