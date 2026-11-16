/**
 * ingest_winter_internships.js
 * Actively discovers, ingests, scores, and registers Winter & 6-Month (January-June) internships
 * into the SQLite jobs database.
 */

const https = require('https');
const crypto = require('crypto');
const { allQuery, runQuery, initDb } = require('../src/db');
const { normalizeCompany, normalizeTitle, ensureJobLocationsTable } = require('../src/services/canonicalize');

function fetchJson(urlStr) {
  return new Promise((resolve) => {
    https.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      timeout: 10000
    }, (res) => {
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

function fetchText(urlStr) {
  return new Promise((resolve) => {
    https.get(urlStr, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(null)).on('timeout', () => resolve(null));
  });
}

function generateJobId(urlStr) {
  return crypto.createHash('sha256').update(urlStr).digest('hex').substring(0, 16);
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

function evaluateScore(role, company, desc, location) {
  const text = `${role} ${company} ${desc} ${location}`.toLowerCase();

  // Strict check: must be an actual internship
  const hasInternKeyword = /\b(intern|internship|co-op|apprentice)\b/i.test(role) || /\b(intern|internship)\b/i.test(text);
  const isInternalAudit = /\b(internal audit|international payroll|international tax)\b/i.test(role);
  if (!hasInternKeyword || isInternalAudit) {
    return { score: 30, classification: 'Reject', reasons: ['Not a student/tech internship role'] };
  }

  let score = 75;
  const reasons = [];

  // Winter / Spring / 6-Month boost (Targeting January to June period)
  const isWinterSpring = /\b(winter|spring|january|jan|6[- ]month|6mo|off-cycle)\b/i.test(text);
  if (isWinterSpring) {
    score += 15;
    reasons.push('Direct match: Winter / 6-Month January to June internship');
  }

  // Location scoring
  const locLower = (location + ' ' + text).toLowerCase();
  const isIndia = locLower.includes('india') || locLower.includes('bengaluru') || locLower.includes('bangalore') ||
                  locLower.includes('pune') || locLower.includes('hyderabad') || locLower.includes('gurgaon') ||
                  locLower.includes('gurugram') || locLower.includes('noida') || locLower.includes('mumbai') ||
                  locLower.includes('delhi') || locLower.includes('ahmedabad') || locLower.includes('gandhinagar');
  const isRemote = locLower.includes('remote') || locLower.includes('anywhere') || locLower.includes('wfh') || locLower.includes('virtual');

  if (isIndia) {
    score += 5;
    reasons.push('Preferred India location');
  } else if (isRemote) {
    score += 5;
    reasons.push('Remote flexibility');
  } else if (locLower.includes('united states') || locLower.includes('canada') || locLower.includes('uk')) {
    // International on-site
    score -= 10;
    reasons.push('International location (may require visa or work authorization)');
  }

  // Technical skill match
  const candidateSkills = [
    'python', 'javascript', 'typescript', 'go', 'golang', 'node', 'express',
    'fastapi', 'react', 'next.js', 'sql', 'postgres', 'redis', 'docker',
    'ai', 'llm', 'ml', 'machine learning', 'agent', 'langchain', 'rest', 'grpc'
  ];
  let matchedSkillsCount = 0;
  for (const s of candidateSkills) {
    if (text.includes(s)) matchedSkillsCount++;
  }

  if (matchedSkillsCount >= 5) {
    score += 8;
    reasons.push(`Strong tech stack match (${matchedSkillsCount} skills)`);
  } else if (matchedSkillsCount >= 2) {
    score += 4;
    reasons.push(`Good tech stack match (${matchedSkillsCount} skills)`);
  }

  score = Math.min(Math.max(score, 40), 98);

  return {
    score,
    classification: score >= 90 ? 'Excellent' : (score >= 75 ? 'Strong' : 'Possible'),
    reasons,
    isWinterSpring
  };
}

async function run() {
  console.log('=== ACTIVELY DISCOVERING WINTER & 6-MONTH INTERNSHIPS (JANUARY - JUNE) ===');
  await initDb();
  await ensureJobLocationsTable();

  const candidateJobs = [];

  // 1. Sarthzk India Tech Internship Tracker (live JSON)
  console.log('\n[Source 1] Querying Sarthzk India Tech Internship Tracker...');
  const sarthzkData = await fetchJson('https://raw.githubusercontent.com/Sarthzk/internship-tracker/main/data/listings.json');
  if (Array.isArray(sarthzkData)) {
    const open = sarthzkData.filter(j => j.status === 'open');
    for (const item of open) {
      const title = item.title || '';
      const loc = item.locations ? item.locations.join(', ') : (item.is_remote ? 'Remote - India' : 'India');
      const url = item.url || '';
      const company = item.company || 'Unknown';
      candidateJobs.push({
        url,
        title,
        company,
        location: loc,
        description: `Official opening from ${company}. Category: ${item.category || 'Tech/SWE'}. Location: ${loc}. Direct career listing.`,
        source: 'sarthzk-tracker'
      });
    }
    console.log(`[Source 1] Added ${open.length} open postings from Sarthzk tracker.`);
  }

  // 2. SpeedyApply International 2027 SWE Intern Tracker
  console.log('\n[Source 2] Querying SpeedyApply 2027 International SWE Intern Tracker...');
  const speedIntlMd = await fetchText('https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/INTERN_INTL.md');
  if (speedIntlMd) {
    const lines = speedIntlMd.split('\n');
    let addedCount = 0;
    for (const line of lines) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 4 && !cells[0].includes('Company') && !cells[0].includes('---')) {
        const compMatch = cells[0].match(/<strong>(.*?)<\/strong>/);
        const company = compMatch ? compMatch[1] : cells[0].replace(/<[^>]+>/g, '').trim();
        const title = cells[1].replace(/<[^>]+>/g, '').trim();
        const loc = cells[2].replace(/<[^>]+>/g, '').trim();
        const linkMatch = cells[3].match(/href="([^"]+)"/);
        const jobUrl = linkMatch ? linkMatch[1] : '';

        const locLower = loc.toLowerCase();
        const isTarget = locLower.includes('india') || locLower.includes('remote') || locLower.includes('bengaluru') ||
                         locLower.includes('bangalore') || locLower.includes('pune') || locLower.includes('hyderabad') ||
                         locLower.includes('gurgaon') || locLower.includes('delhi') || locLower.includes('noida') ||
                         locLower.includes('global') || locLower.includes('anywhere');

        if (jobUrl && isTarget && /\b(intern|internship|co-op)\b/i.test(title)) {
          candidateJobs.push({
            url: jobUrl,
            title,
            company,
            location: loc,
            description: `Software Engineering / Tech college internship at ${company}. Location: ${loc}. 2027 cycle.`,
            source: 'speedyapply-intl'
          });
          addedCount++;
        }
      }
    }
    console.log(`[Source 2] Added ${addedCount} India & Remote internships from SpeedyApply International.`);
  }

  // 3. SpeedyApply USA Remote / Winter Internships
  console.log('\n[Source 3] Querying SpeedyApply 2027 USA Tracker (Remote & Winter/Spring)...');
  const speedUsaMd = await fetchText('https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/README.md');
  if (speedUsaMd) {
    const lines = speedUsaMd.split('\n');
    let addedCount = 0;
    for (const line of lines) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 4 && !cells[0].includes('Company') && !cells[0].includes('---')) {
        const compMatch = cells[0].match(/<strong>(.*?)<\/strong>/);
        const company = compMatch ? compMatch[1] : cells[0].replace(/<[^>]+>/g, '').trim();
        const title = cells[1].replace(/<[^>]+>/g, '').trim();
        const loc = cells[2].replace(/<[^>]+>/g, '').trim();
        const linkMatch = cells[3].match(/href="([^"]+)"/);
        const jobUrl = linkMatch ? linkMatch[1] : '';

        const titleLower = title.toLowerCase();
        const locLower = loc.toLowerCase();
        const isWinter = titleLower.includes('winter') || titleLower.includes('spring');
        const isRemote = locLower.includes('remote');

        if (jobUrl && (isWinter || isRemote) && /\b(intern|internship|co-op)\b/i.test(title)) {
          candidateJobs.push({
            url: jobUrl,
            title,
            company,
            location: loc,
            description: `SWE / AI / ML Internship at ${company}. Location: ${loc}.`,
            source: 'speedyapply-usa'
          });
          addedCount++;
        }
      }
    }
    console.log(`[Source 3] Added ${addedCount} Remote/Winter listings from SpeedyApply USA.`);
  }

  // 4. Direct Greenhouse boards for top companies
  console.log('\n[Source 4] Direct Greenhouse boards check...');
  const ghBoards = ['rubrik', 'hackerrank', 'enterpret', 'singlestore', 'mongodb', 'stripe', 'datadog'];
  for (const board of ghBoards) {
    const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`);
    if (data && data.jobs) {
      for (const j of data.jobs) {
        const title = j.title || '';
        const loc = (j.location && j.location.name) || '';
        if (/\b(intern|internship)\b/i.test(title) && !/\b(internal audit|international)\b/i.test(title)) {
          candidateJobs.push({
            url: j.absolute_url,
            title,
            company: board.charAt(0).toUpperCase() + board.slice(1),
            location: loc || 'Remote / Hybrid',
            description: stripHtml(j.content || ''),
            source: 'greenhouse'
          });
        }
      }
    }
  }

  // 5. Direct Ashby boards check
  console.log('\n[Source 5] Direct Ashby boards check...');
  const ashbyBoards = ['composio', 'meraki-labs', 'realmalliance', 'cohere'];
  for (const board of ashbyBoards) {
    const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${board}`);
    if (data && data.jobs) {
      for (const j of data.jobs) {
        const title = j.title || '';
        const loc = j.location || (j.isRemote ? 'Remote' : '');
        if (/\b(intern|internship)\b/i.test(title) && !/\b(internal|international)\b/i.test(title)) {
          candidateJobs.push({
            url: j.jobUrl,
            title,
            company: board.charAt(0).toUpperCase() + board.slice(1),
            location: loc || 'Remote',
            description: stripHtml(j.descriptionPlain || title),
            source: 'ashby'
          });
        }
      }
    }
  }

  console.log(`\nTotal candidate raw internship listings discovered: ${candidateJobs.length}`);

  // Deduplicate candidate jobs by URL
  const seen = new Set();
  const uniqueJobs = [];
  for (const j of candidateJobs) {
    if (!j.url || seen.has(j.url)) continue;
    seen.add(j.url);
    uniqueJobs.push(j);
  }
  console.log(`Unique internship URLs to evaluate: ${uniqueJobs.length}`);

  let addedCount = 0;
  let updatedCount = 0;
  let winterSpecificCount = 0;
  const topWinterJobs = [];

  const now = new Date().toISOString();

  for (const j of uniqueJobs) {
    const evalRes = evaluateScore(j.title, j.company, j.description, j.location);
    if (evalRes.score < 60) continue; // Skip irrelevant or low-fit roles

    if (evalRes.isWinterSpring) {
      winterSpecificCount++;
    }

    const jobId = generateJobId(j.url);
    const existing = await allQuery('SELECT job_id, score, status FROM jobs WHERE job_id = ? OR url = ?', [jobId, j.url]);

    const status = evalRes.score >= 75 ? 'AWAITING_APPROVAL' : 'EVALUATED';
    const notes = evalRes.isWinterSpring
      ? '[PRIORITY: Winter / 6-Month Jan-Jun 2027 Internship]'
      : '[College / Student Tech Internship]';

    if (existing && existing.length > 0) {
      // Update score and notes if the new evaluation gives higher priority to winter internships
      const curr = existing[0];
      if (evalRes.score > curr.score || evalRes.isWinterSpring) {
        await runQuery(`
          UPDATE jobs SET
            score = ?,
            score_explanation = ?,
            notes = ?,
            employment_type = 'Internship'
          WHERE job_id = ?
        `, [
          evalRes.score,
          JSON.stringify({ classification: evalRes.classification, explanation: evalRes.reasons.join('; ') }),
          notes,
          curr.job_id
        ]);
        updatedCount++;
      }
    } else {
      // Insert new job
      await runQuery(`
        INSERT INTO jobs (
          job_id, company, role, location, source, url, description,
          score, score_explanation, status, discovered_at,
          salary, employment_type, experience_level, required_skills, preferred_skills,
          posted_date, application_url, is_canonical, canonical_id, location_count, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)
      `, [
        jobId,
        j.company,
        j.title,
        j.location || 'Remote',
        j.source,
        j.url,
        j.description || '',
        evalRes.score,
        JSON.stringify({ classification: evalRes.classification, explanation: evalRes.reasons.join('; ') }),
        status,
        now,
        'Competitive Stipend',
        'Internship',
        'Internship / College Student',
        '[]',
        '[]',
        now,
        j.url,
        jobId,
        notes
      ]);
      addedCount++;
    }

    if (evalRes.score >= 88) {
      topWinterJobs.push({
        company: j.company,
        role: j.title,
        location: j.location,
        score: evalRes.score,
        isWinter: evalRes.isWinterSpring,
        url: j.url
      });
    }
  }

  console.log(`\n=== INGESTION & DISCOVERY SUMMARY ===`);
  console.log(`Total new internships inserted: ${addedCount}`);
  console.log(`Existing internships refreshed/boosted: ${updatedCount}`);
  console.log(`Direct Winter / Spring / 6-Month Jan-Jun internships: ${winterSpecificCount}`);
  console.log(`\nTop Highest-Scoring Winter & Tech Internships (Score >= 88):`);
  topWinterJobs.sort((a, b) => b.score - a.score);
  topWinterJobs.slice(0, 25).forEach((j, i) => {
    const tag = j.isWinter ? '[JAN-JUN / WINTER]' : '[TECH INTERN]';
    console.log(`${i + 1}. ${tag} ${j.company} — ${j.role} (${j.location}) | Score: ${j.score}\n   ${j.url}`);
  });
}

run().catch(console.error);
