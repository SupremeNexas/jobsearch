const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { allQuery, getQuery, runQuery, closeDb } = require('./src/db');
const { matchJobWithCandidate, evaluateDeterministicMatch } = require('./src/pipeline/matcher');
const { normalizeTitle, normalizeCompany } = require('./src/services/canonicalize');
const { checkAlreadyApplied } = require('./src/pipeline/application_guard');

const GREENHOUSE_BOARDS = [
  'stripe', 'cloudflare', 'okta', 'purestorage', 'datadog', 'affirm',
  'gitlab', 'coinbase', 'mongodb', 'elastic', 'anthropic', 'scaleai',
  'pinterest', 'robinhood', 'instacart', 'brex', 'figma', 'vercel',
  'retool', 'sentry', 'notion', 'airtable', 'dropbox', 'rubrik', 'groww', 'automattic',
  'databricks', 'canonical', 'airbnb', 'lyft', 'mozilla', 'assemblyai', 'grafanalabs', 'reddit', 'togetherai', 'tavily'
];

const ASHBY_BOARDS = [
  'supabase', 'linear', 'cohere', 'pinecone', 'posthog',
  'ramp', 'perplexity', 'cursor',
  'cognition', 'modal', 'replit', 'braintrust', 'composio', 'livekit', 'warp', 'mintlify', 'resend',
  'infisical', 'runway', 'speckle', 'poolside', 'langchain', 'temporal', 'snyk', 'cartesia', 'anyscale',
  'deepgram', 'render', 'railway', 'vapi', 'llamaindex', 'weaviate', 'harvey', 'cerebras', 'baseten',
  'factory', 'writer', 'taktile', 'character', 'unstructured', 'firecrawl'
];

const LEVER_BOARDS = [
  'meesho', 'cred', 'palantir'
];

const KEYWORDS = [
  'software', 'engineer', 'developer', 'backend', 'full stack', 'fullstack',
  'frontend', 'ai', 'machine learning', 'ml', 'genai', 'intern', 'graduate',
  'sde', 'python', 'golang', 'go', 'node', 'react', 'systems', 'platform engineer',
  'infrastructure', 'data engineer', 'cloud', 'security engineer', 'algorithms',
  'research engineer', 'web developer', 'distributed systems'
];

const EXCLUDED_KEYWORDS = [
  'account executive', 'sales', 'account manager', 'business development',
  'recruiter', 'recruiting', 'talent acquisition', 'sourcer', 'hr manager',
  'marketing', 'copywriter', 'customer support', 'customer success', 'support specialist',
  'finance analyst', 'accountant', 'legal counsel', 'attorney', 'general counsel',
  'office manager', 'executive assistant', 'workplace coordinator', 'grower', 'hunter',
  'sales development', 'bdr', 'sdr'
];

function httpGetJson(urlStr) {
  return new Promise((resolve) => {
    try {
      const client = urlStr.startsWith('https') ? https : http;
      const req = client.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/html'
        },
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
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    } catch (e) {
      resolve(null);
    }
  });
}

function checkUrlActive(urlStr) {
  return new Promise((resolve) => {
    if (!urlStr || !urlStr.startsWith('http')) return resolve(false);
    try {
      const client = urlStr.startsWith('https') ? https : http;
      const req = client.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml'
        },
        timeout: 3500
      }, (res) => {
        if (res.statusCode === 404 || res.statusCode === 410) {
          req.destroy();
          return resolve(false);
        }
        let chunkCount = 0;
        let body = '';
        res.on('data', chunk => {
          chunkCount++;
          if (body.length < 5000) body += chunk;
          if (chunkCount > 5) req.destroy();
        });
        res.on('end', () => {
          const lower = body.toLowerCase();
          if (lower.includes('job is no longer available') ||
              lower.includes('position has been filled') ||
              lower.includes('job has expired') ||
              lower.includes('no longer accepting applications') ||
              lower.includes('this opening has been closed')) {
            return resolve(false);
          }
          resolve(res.statusCode < 400);
        });
        res.on('close', () => {
          const lower = body.toLowerCase();
          if (lower.includes('job is no longer available') ||
              lower.includes('position has been filled') ||
              lower.includes('job has expired') ||
              lower.includes('no longer accepting applications') ||
              lower.includes('this opening has been closed')) {
            return resolve(false);
          }
          resolve(res.statusCode < 400);
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch (e) {
      resolve(false);
    }
  });
}

function matchesKeywords(title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  if (EXCLUDED_KEYWORDS.some(e => lower.includes(e))) return false;
  return KEYWORDS.some(k => lower.includes(k));
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

function generateJobId(urlStr) {
  return crypto.createHash('sha256').update(urlStr).digest('hex').substring(0, 16);
}

async function insertAndMatchJob({
  externalId,
  source,
  sourceUrl,
  company,
  role,
  location,
  description,
  url,
  applicationUrl,
  now
}) {
  const jobUrl = applicationUrl || url || sourceUrl;
  const jid = generateJobId(jobUrl);
  const locLower = (location || '').toLowerCase();
  const roleLower = (role || '').toLowerCase();
  const isRemote = (
    locLower.includes('remote') || locLower.includes('anywhere') || locLower.includes('work from home') ||
    locLower.includes('wfh') || locLower.includes('distributed') || locLower.includes('home based') ||
    locLower.includes('home-based') || locLower.includes('virtual') || locLower.includes('telecommute') ||
    roleLower.includes('(remote)') || roleLower.includes('[remote]') || roleLower.includes(' - remote') ||
    roleLower.includes(', remote') || roleLower.includes('remote -') ||
    (source && (source.toLowerCase().includes('jobicy') || source.toLowerCase().includes('remotive')))
  );

  const isIndia = (
    locLower.includes('india') || locLower.includes('bengaluru') || locLower.includes('bangalore') ||
    locLower.includes('pune') || locLower.includes('hyderabad') || locLower.includes('mumbai') ||
    locLower.includes('delhi') || locLower.includes('gujarat') || locLower.includes('gandhinagar') ||
    locLower.includes('noida') || locLower.includes('gurgaon')
  );

  const isUsa = !isIndia && (
    locLower.includes('united states') || locLower.includes('usa') || locLower.includes('u.s.a.') ||
    locLower.includes('san francisco') || locLower.includes('new york') || locLower.includes('seattle') ||
    locLower.includes('austin') || locLower.includes('sunnyvale') || locLower.includes('mountain view') ||
    locLower.includes('palo alto') || locLower.includes('boston') || locLower.includes('chicago') ||
    locLower.includes('in-office') || locLower.includes('hybrid') ||
    /(?:^|[\s,\/\(])(ca|ny|tx|wa|ma|il|va|nc|co|fl|ga|nj|pa|oh|mi|md|or|dc)(?:[\s,\/\)]|$)/i.test(location || '')
  );

  // Per candidate preference: exclude all USA postings unless they are remote
  if (isUsa && !isRemote) {
    return null;
  }

  const jobObj = {
    id: jid,
    job_id: jid,
    external_id: externalId ? String(externalId) : jid,
    source,
    source_url: sourceUrl || jobUrl,
    company,
    role,
    department: 'Engineering',
    location: location || 'Remote',
    country: isIndia ? 'India' : (isRemote ? (isUsa ? 'USA (Remote)' : 'Remote (Worldwide)') : (location || 'Global')),
    remote_type: isRemote ? 'remote' : 'hybrid',
    employment_type: 'full_time',
    description: description || '',
    url: jobUrl,
    application_url: jobUrl,
    discovered_at: now,
    last_seen_at: now,
    source_verified: 1,
    is_canonical: 1,
    location_count: 1
  };

  // Duplicate Check: Preserve already applied jobs
  const existingJob = await getQuery('SELECT status, applied_at, screenshot_path FROM jobs WHERE job_id = ? OR url = ?', [jid, jobUrl]);
  if (existingJob && (existingJob.status === 'APPLIED' || existingJob.applied_at)) {
    return existingJob;
  }

  const dupCheck = await checkAlreadyApplied({ company, role, url: jobUrl, jobId: jid });
  const finalStatus = dupCheck.alreadyApplied ? 'APPLIED' : 'ACTIVE';
  const appliedAtVal = dupCheck.alreadyApplied ? ((dupCheck.appliedJob && dupCheck.appliedJob.applied_at) || now) : null;

  const matchRes = await matchJobWithCandidate(jobObj);

  await runQuery(`
    INSERT OR REPLACE INTO jobs (
      job_id, external_id, source, source_url, company, role, location,
      remote_type, status, match_score, score, description, url, application_url,
      discovered_at, last_seen_at, source_verified, is_canonical, location_count, notes, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, ?)
  `, [
    jobObj.id,
    jobObj.external_id,
    jobObj.source,
    jobObj.source_url,
    jobObj.company,
    jobObj.role,
    jobObj.location,
    jobObj.remote_type,
    finalStatus,
    matchRes.overall_score || 80,
    matchRes.overall_score || 80,
    (description || '').substring(0, 4000),
    jobObj.url,
    jobObj.application_url,
    now,
    now,
    dupCheck.alreadyApplied ? (dupCheck.reason || 'Already applied') : (jobObj.notes || ''),
    appliedAtVal
  ]);

  return jobObj;
}

async function ensureArchiveTable() {
  await runQuery(`
    CREATE TABLE IF NOT EXISTS jobs_archive (
      job_id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      role TEXT NOT NULL,
      location TEXT NOT NULL,
      source TEXT NOT NULL,
      url TEXT,
      description TEXT,
      score INTEGER DEFAULT 0,
      status TEXT NOT NULL,
      discovered_at TEXT,
      archived_at TEXT NOT NULL,
      archive_reason TEXT
    );
  `);
}

async function runSyncAndClean() {
  console.log('================================================================');
  console.log('🚀 STARTING JOB SYNC & OBSOLETE POSTING CLEANUP');
  console.log('================================================================\n');

  await ensureArchiveTable();

  const initialCountRow = await getQuery('SELECT count(*) as cnt FROM jobs');
  const initialTotal = initialCountRow.cnt;
  console.log(`[Status] Initial total jobs in database: ${initialTotal}`);

  let totalGoneRemoved = 0;
  let totalNewAdded = 0;
  const now = new Date().toISOString();

  // 0. CLEANUP NON-ENGINEERING / SALES / RECRUITER POSTINGS
  console.log('\n--- 0. Pruning non-engineering / sales / recruiter listings ---');
  try {
    const nonTechJobs = await allQuery(`
      SELECT job_id, role, company FROM jobs 
      WHERE lower(role) LIKE '%account executive%' 
         OR lower(role) LIKE '%sales development%'
         OR lower(role) LIKE '%account manager%'
         OR lower(role) LIKE '%business development%'
         OR lower(role) LIKE '%recruiter%'
         OR lower(role) LIKE '%talent acquisition%'
         OR lower(role) LIKE '%customer success manager%'
         OR lower(role) LIKE '%legal counsel%'
         OR lower(role) LIKE '%enterprise grower%'
         OR lower(role) LIKE '%platforms hunter%'
         OR lower(role) LIKE '%copywriter%'
         OR lower(role) LIKE '%office manager%'
    `);
    let prunedNonTech = 0;
    for (const nt of nonTechJobs) {
      await runQuery(`
        INSERT OR REPLACE INTO jobs_archive 
        SELECT job_id, company, role, location, source, url, description, score, 'CLOSED', discovered_at, ?, 'Non-engineering role pruned'
        FROM jobs WHERE job_id = ?
      `, [now, nt.job_id]).catch(() => {});
      await runQuery('DELETE FROM jobs WHERE job_id = ?', [nt.job_id]);
      await runQuery('DELETE FROM ai_job_matches WHERE job_id = ?', [nt.job_id]).catch(() => {});
      prunedNonTech++;
    }
    console.log(`[Pruning] Removed ${prunedNonTech} non-engineering roles.`);
    totalGoneRemoved += prunedNonTech;
  } catch (pruneErr) {
    console.error('[Pruning Error]', pruneErr.message);
  }

  // 0.5. PRUNE USA ONSITE / HYBRID POSTINGS
  console.log('\n--- 0.5. Pruning USA onsite / hybrid postings (candidate requires remote for USA) ---');
  try {
    const usaOnsiteJobs = await allQuery(`
      SELECT job_id, role, company, location FROM jobs 
      WHERE status != 'APPLIED' AND (
        lower(country) IN ('usa', 'united states', 'us') OR
        lower(location) LIKE '%united states%' OR lower(location) LIKE '%usa%' OR
        lower(location) LIKE '%san francisco%' OR lower(location) LIKE '%new york%' OR
        lower(location) LIKE '%sunnyvale%' OR lower(location) LIKE '%mountain view%' OR
        lower(location) LIKE '%palo alto%' OR lower(location) LIKE '%seattle%' OR
        lower(location) LIKE '%austin%' OR lower(location) LIKE '%chicago%' OR
        lower(location) LIKE '%boston%' OR lower(location) LIKE '%, ca%' OR
        lower(location) LIKE '%, ny%' OR lower(location) LIKE '%, tx%' OR
        lower(location) LIKE '%, wa%' OR lower(location) LIKE '%hybrid%' OR
        lower(location) LIKE '%in-office%'
      ) AND NOT (
        remote_type = 'remote' OR lower(location) LIKE '%remote%' OR lower(location) LIKE '%anywhere%' OR
        lower(location) LIKE '%home based%' OR lower(location) LIKE '%distributed%' OR lower(location) LIKE '%work from home%' OR
        lower(location) LIKE '%wfh%' OR lower(source) IN ('jobicy', 'remotive')
      ) AND NOT (
        lower(location) LIKE '%india%' OR lower(location) LIKE '%bengaluru%' OR lower(location) LIKE '%bangalore%' OR
        lower(location) LIKE '%pune%' OR lower(location) LIKE '%hyderabad%' OR lower(location) LIKE '%mumbai%' OR lower(location) LIKE '%delhi%'
      )
    `);
    let prunedUsaOnsite = 0;
    for (const uj of usaOnsiteJobs) {
      await runQuery(`
        INSERT OR REPLACE INTO jobs_archive 
        SELECT job_id, company, role, location, source, url, description, score, 'CLOSED', discovered_at, ?, 'USA onsite/hybrid - filtered out per remote preference'
        FROM jobs WHERE job_id = ?
      `, [now, uj.job_id]).catch(() => {});
      await runQuery('DELETE FROM jobs WHERE job_id = ?', [uj.job_id]);
      await runQuery('DELETE FROM ai_job_matches WHERE job_id = ?', [uj.job_id]).catch(() => {});
      prunedUsaOnsite++;
    }
    if (prunedUsaOnsite > 0) {
      console.log(`[Pruning] Removed ${prunedUsaOnsite} USA onsite/hybrid roles.`);
      totalGoneRemoved += prunedUsaOnsite;
    }
  } catch (usaPruneErr) {
    console.error('[USA Pruning Error]', usaPruneErr.message);
  }

  // 1. GREENHOUSE BOARDS RECONCILIATION
  console.log('\n--- 1. Checking Greenhouse Boards ---');
  for (const board of GREENHOUSE_BOARDS) {
    try {
      const url = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
      const res = await httpGetJson(url);
      if (!res || !Array.isArray(res.jobs)) {
        console.log(`[Greenhouse] ${board}: board could not be fetched or empty.`);
        continue;
      }

      const liveJobs = res.jobs;
      const liveIds = new Set(liveJobs.map(j => String(j.id)));
      console.log(`[Greenhouse] ${board}: ${liveJobs.length} live jobs found on official board.`);

      // Check existing jobs in DB for this board
      const dbJobs = await allQuery(`
        SELECT job_id, role, url, external_id FROM jobs 
        WHERE LOWER(company) = LOWER(?) OR url LIKE ?
      `, [board, `%boards.greenhouse.io/${board}%`]);

      let goneForBoard = 0;
      for (const dj of dbJobs) {
        let idFromUrl = null;
        const match = dj.url && dj.url.match(/jobs\/(\d+)/);
        if (match) idFromUrl = match[1];
        const match2 = dj.url && dj.url.match(/gh_jid=(\d+)/);
        if (match2) idFromUrl = match2[1];
        const jid = dj.external_id || idFromUrl;

        if (jid && !liveIds.has(String(jid))) {
          await runQuery(`
            INSERT OR REPLACE INTO jobs_archive 
            SELECT job_id, company, role, location, source, url, description, score, 'CLOSED', discovered_at, ?, 'Greenhouse job removed from board'
            FROM jobs WHERE job_id = ?
          `, [now, dj.job_id]).catch(() => {});

          await runQuery('DELETE FROM jobs WHERE job_id = ?', [dj.job_id]);
          await runQuery('DELETE FROM ai_job_matches WHERE job_id = ?', [dj.job_id]).catch(() => {});
          goneForBoard++;
          totalGoneRemoved++;
        }
      }
      if (goneForBoard > 0) {
        console.log(`  └─ Removed ${goneForBoard} older gone jobs for ${board}.`);
      }

      // Add new matching jobs
      let newForBoard = 0;
      for (const lj of liveJobs) {
        if (!matchesKeywords(lj.title)) continue;
        const jobUrl = lj.absolute_url;
        const existing = await getQuery('SELECT job_id FROM jobs WHERE url = ? OR external_id = ?', [jobUrl, String(lj.id)]);
        if (!existing) {
          const location = (lj.location && lj.location.name) || 'Remote';
          const desc = stripHtml(lj.content || '');
          await insertAndMatchJob({
            externalId: lj.id,
            source: 'Greenhouse',
            sourceUrl: jobUrl,
            company: board.charAt(0).toUpperCase() + board.slice(1),
            role: lj.title,
            location: location,
            description: desc,
            url: jobUrl,
            applicationUrl: jobUrl,
            now
          });
          newForBoard++;
          totalNewAdded++;
        }
      }
      if (newForBoard > 0) {
        console.log(`  └─ Added ${newForBoard} new matching jobs for ${board}.`);
      }
    } catch (err) {
      console.error(`[Greenhouse] Error syncing ${board}:`, err.message);
    }
  }

  // 2. ASHBY BOARDS RECONCILIATION
  console.log('\n--- 2. Checking Ashby Boards ---');
  for (const board of ASHBY_BOARDS) {
    try {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${board}`;
      const res = await httpGetJson(url);
      if (!res || !Array.isArray(res.jobs)) {
        console.log(`[Ashby] ${board}: board could not be fetched.`);
        continue;
      }

      const liveJobs = res.jobs;
      const liveIds = new Set(liveJobs.map(j => String(j.id)));
      console.log(`[Ashby] ${board}: ${liveJobs.length} live jobs found on official board.`);

      const dbJobs = await allQuery(`
        SELECT job_id, role, url, external_id FROM jobs 
        WHERE LOWER(company) = LOWER(?) OR url LIKE ?
      `, [board, `%jobs.ashbyhq.com/${board}%`]);

      let goneForBoard = 0;
      for (const dj of dbJobs) {
        let idFromUrl = null;
        const match = dj.url && dj.url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (match) idFromUrl = match[1];
        const jid = dj.external_id || idFromUrl;

        if (jid && !liveIds.has(String(jid))) {
          await runQuery(`
            INSERT OR REPLACE INTO jobs_archive 
            SELECT job_id, company, role, location, source, url, description, score, 'CLOSED', discovered_at, ?, 'Ashby job removed from board'
            FROM jobs WHERE job_id = ?
          `, [now, dj.job_id]).catch(() => {});

          await runQuery('DELETE FROM jobs WHERE job_id = ?', [dj.job_id]);
          await runQuery('DELETE FROM ai_job_matches WHERE job_id = ?', [dj.job_id]).catch(() => {});
          goneForBoard++;
          totalGoneRemoved++;
        }
      }
      if (goneForBoard > 0) {
        console.log(`  └─ Removed ${goneForBoard} older gone jobs for ${board}.`);
      }

      let newForBoard = 0;
      for (const lj of liveJobs) {
        if (!matchesKeywords(lj.title)) continue;
        const jobUrl = lj.jobUrl || `https://jobs.ashbyhq.com/${board}/${lj.id}`;
        const existing = await getQuery('SELECT job_id FROM jobs WHERE url = ? OR external_id = ?', [jobUrl, String(lj.id)]);
        if (!existing) {
          const location = lj.location || 'Remote';
          const desc = stripHtml(lj.descriptionHtml || lj.descriptionPlain || '');
          await insertAndMatchJob({
            externalId: lj.id,
            source: 'Ashby',
            sourceUrl: jobUrl,
            company: board.charAt(0).toUpperCase() + board.slice(1),
            role: lj.title,
            location: location,
            description: desc,
            url: jobUrl,
            applicationUrl: jobUrl,
            now
          });
          newForBoard++;
          totalNewAdded++;
        }
      }
      if (newForBoard > 0) {
        console.log(`  └─ Added ${newForBoard} new matching jobs for ${board}.`);
      }
    } catch (err) {
      console.error(`[Ashby] Error syncing ${board}:`, err.message);
    }
  }

  // 3. LEVER BOARDS RECONCILIATION
  console.log('\n--- 3. Checking Lever Boards ---');
  for (const board of LEVER_BOARDS) {
    try {
      const url = `https://api.lever.co/v0/postings/${board}?mode=json`;
      const res = await httpGetJson(url);
      if (!res || !Array.isArray(res)) {
        console.log(`[Lever] ${board}: board could not be fetched.`);
        continue;
      }

      const liveJobs = res;
      const liveIds = new Set(liveJobs.map(j => String(j.id)));
      console.log(`[Lever] ${board}: ${liveJobs.length} live jobs found on official board.`);

      const dbJobs = await allQuery(`
        SELECT job_id, role, url, external_id FROM jobs 
        WHERE LOWER(company) = LOWER(?) OR url LIKE ?
      `, [board, `%jobs.lever.co/${board}%`]);

      let goneForBoard = 0;
      for (const dj of dbJobs) {
        let idFromUrl = null;
        const match = dj.url && dj.url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (match) idFromUrl = match[1];
        const jid = dj.external_id || idFromUrl;

        if (jid && !liveIds.has(String(jid))) {
          await runQuery(`
            INSERT OR REPLACE INTO jobs_archive 
            SELECT job_id, company, role, location, source, url, description, score, 'CLOSED', discovered_at, ?, 'Lever job removed from board'
            FROM jobs WHERE job_id = ?
          `, [now, dj.job_id]).catch(() => {});

          await runQuery('DELETE FROM jobs WHERE job_id = ?', [dj.job_id]);
          await runQuery('DELETE FROM ai_job_matches WHERE job_id = ?', [dj.job_id]).catch(() => {});
          goneForBoard++;
          totalGoneRemoved++;
        }
      }
      if (goneForBoard > 0) {
        console.log(`  └─ Removed ${goneForBoard} older gone jobs for ${board}.`);
      }

      let newForBoard = 0;
      for (const lj of liveJobs) {
        if (!matchesKeywords(lj.text)) continue;
        const jobUrl = lj.hostedUrl;
        const existing = await getQuery('SELECT job_id FROM jobs WHERE url = ? OR external_id = ?', [jobUrl, String(lj.id)]);
        if (!existing) {
          const location = (lj.categories && lj.categories.location) || 'Remote';
          const desc = stripHtml(lj.descriptionPlain || '');
          await insertAndMatchJob({
            externalId: lj.id,
            source: 'Lever',
            sourceUrl: jobUrl,
            company: board.charAt(0).toUpperCase() + board.slice(1),
            role: lj.text,
            location: location,
            description: desc,
            url: jobUrl,
            applicationUrl: jobUrl,
            now
          });
          newForBoard++;
          totalNewAdded++;
        }
      }
      if (newForBoard > 0) {
        console.log(`  └─ Added ${newForBoard} new matching jobs for ${board}.`);
      }
    } catch (err) {
      console.error(`[Lever] Error syncing ${board}:`, err.message);
    }
  }

  // 4. REMOTE APIs (JOBICY, REMOTIVE, REMOTEOK)
  console.log('\n--- 4. Checking Remote APIs (Jobicy, Remotive, RemoteOK) ---');
  try {
    const jobicyRes = await httpGetJson('https://jobicy.com/api/v2/remote-jobs?count=100');
    if (jobicyRes && Array.isArray(jobicyRes.jobs)) {
      let jobicyAdded = 0;
      for (const j of jobicyRes.jobs) {
        if (!matchesKeywords(j.jobTitle)) continue;
        const existing = await getQuery('SELECT job_id FROM jobs WHERE url = ?', [j.url]);
        if (!existing) {
          const desc = stripHtml(j.jobDescription || '');
          await insertAndMatchJob({
            externalId: j.id,
            source: 'Jobicy',
            sourceUrl: j.url,
            company: j.companyName || 'Remote Company',
            role: j.jobTitle,
            location: j.jobGeo || 'Remote',
            description: desc,
            url: j.url,
            applicationUrl: j.url,
            now
          });
          jobicyAdded++;
          totalNewAdded++;
        }
      }
      console.log(`[Jobicy] Added ${jobicyAdded} new remote engineering jobs.`);
    }

    const remotiveRes = await httpGetJson('https://remotive.com/api/remote-jobs?category=software-dev&limit=100');
    if (remotiveRes && Array.isArray(remotiveRes.jobs)) {
      let remotiveAdded = 0;
      for (const j of remotiveRes.jobs) {
        if (!matchesKeywords(j.title)) continue;
        const existing = await getQuery('SELECT job_id FROM jobs WHERE url = ?', [j.url]);
        if (!existing) {
          const desc = stripHtml(j.description || '');
          await insertAndMatchJob({
            externalId: j.id,
            source: 'Remotive',
            sourceUrl: j.url,
            company: j.company_name || 'Remote Company',
            role: j.title,
            location: j.candidate_required_location || 'Remote',
            description: desc,
            url: j.url,
            applicationUrl: j.url,
            now
          });
          remotiveAdded++;
          totalNewAdded++;
        }
      }
      console.log(`[Remotive] Added ${remotiveAdded} new remote engineering jobs.`);
    }

    const remoteOkRes = await httpGetJson('https://remoteok.com/api');
    if (Array.isArray(remoteOkRes) && remoteOkRes.length > 1) {
      let remoteOkAdded = 0;
      const jobsList = remoteOkRes.slice(1);
      for (const j of jobsList) {
        if (!j || !matchesKeywords(j.position)) continue;
        const jobUrl = j.url || (j.id ? `https://remoteok.com/remote-jobs/${j.id}` : null);
        if (!jobUrl) continue;
        const existing = await getQuery('SELECT job_id FROM jobs WHERE url = ?', [jobUrl]);
        if (!existing) {
          const desc = stripHtml(j.description || '');
          await insertAndMatchJob({
            externalId: j.id,
            source: 'RemoteOK',
            sourceUrl: jobUrl,
            company: j.company || 'Remote Company',
            role: j.position,
            location: j.location || 'Remote',
            description: desc,
            url: jobUrl,
            applicationUrl: jobUrl,
            now
          });
          remoteOkAdded++;
          totalNewAdded++;
        }
      }
      console.log(`[RemoteOK] Added ${remoteOkAdded} new remote engineering jobs.`);
    }
  } catch (apiErr) {
    console.error('[Remote APIs] Error:', apiErr.message);
  }

  // 5. OTHER EXISTING POSTINGS LIVENESS CHECK (Spreadsheets / Other URLs)
  console.log('\n--- 5. Checking other older job postings for liveness ---');
  const otherJobs = await allQuery(`
    SELECT job_id, company, role, url FROM jobs 
    WHERE status != 'CLOSED' 
      AND url NOT LIKE '%boards.greenhouse.io%' 
      AND url NOT LIKE '%jobs.ashbyhq.com%' 
      AND url NOT LIKE '%jobs.lever.co%'
    ORDER BY discovered_at ASC
    LIMIT 30
  `);

  console.log(`[Liveness] Sampling ${otherJobs.length} older non-board jobs in parallel batches...`);
  let otherGone = 0;
  const batchSize = 5;
  for (let i = 0; i < otherJobs.length; i += batchSize) {
    const batch = otherJobs.slice(i, i + batchSize);
    await Promise.all(batch.map(async (oj) => {
      try {
        const isActive = await checkUrlActive(oj.url);
        if (!isActive) {
          await runQuery(`
            INSERT OR REPLACE INTO jobs_archive 
            SELECT job_id, company, role, location, source, url, description, score, 'CLOSED', discovered_at, ?, 'HTTP 404 / posting closed'
            FROM jobs WHERE job_id = ?
          `, [now, oj.job_id]).catch(() => {});

          await runQuery('DELETE FROM jobs WHERE job_id = ?', [oj.job_id]);
          otherGone++;
          totalGoneRemoved++;
        }
      } catch (e) {}
    }));
  }
  console.log(`[Liveness] Tested ${otherJobs.length} jobs; removed ${otherGone} closed/expired jobs.`);

  // Record Search Run
  const finalCountRow = await getQuery('SELECT count(*) as cnt FROM jobs');
  const finalTotal = finalCountRow.cnt;
  const runId = `sync_${Date.now()}`;
  await runQuery(`
    INSERT INTO search_runs (
      id, search_mode, status, configuration, sources_attempted, sources_succeeded,
      jobs_found, jobs_new, jobs_duplicate, jobs_verified, started_at, completed_at
    ) VALUES (?, 'SYNC_AND_CLEAN', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    runId,
    JSON.stringify({ greenhouseBoards: GREENHOUSE_BOARDS.length, ashbyBoards: ASHBY_BOARDS.length, leverBoards: LEVER_BOARDS.length, remoteSources: 3 }),
    GREENHOUSE_BOARDS.length + ASHBY_BOARDS.length + LEVER_BOARDS.length + 3,
    GREENHOUSE_BOARDS.length + ASHBY_BOARDS.length + LEVER_BOARDS.length + 3,
    totalNewAdded,
    totalNewAdded,
    0,
    finalTotal,
    now,
    new Date().toISOString()
  ]).catch(() => {});

  console.log('\n================================================================');
  console.log('✅ SYNC & CLEAN COMPLETE');
  console.log(`• Initial Jobs:          ${initialTotal}`);
  console.log(`• Older Gone Removed:    ${totalGoneRemoved}`);
  console.log(`• New Jobs Discovered:   ${totalNewAdded}`);
  console.log(`• Current Active Jobs:   ${finalTotal}`);
  console.log('================================================================\n');

  if (require.main === module) {
    await closeDb();
  }
  return {
    initialTotal,
    totalGoneRemoved,
    totalNewAdded,
    finalTotal
  };
}

if (require.main === module) {
  runSyncAndClean().then(() => process.exit(0)).catch(err => {
    console.error('Fatal error during sync & clean:', err);
    process.exit(1);
  });
}

module.exports = { runSyncAndClean };
