const https = require('https');
const http = require('http');
const { allQuery, getQuery, runQuery } = require('./src/db');
const { GREENHOUSE_BOARDS, ASHBY_BOARDS, LEVER_BOARDS } = require('./sync_and_clean_jobs');

const CLOSED_PHRASES = [
  'no longer accepting applications',
  'no longer taking applications',
  'job is no longer available',
  'position has been filled',
  'this opening has been closed',
  'this job has expired',
  'this listing has expired',
  'job posting has expired',
  'this job is closed',
  'application is closed',
  'applications are closed',
  'applications are no longer being accepted',
  'we are no longer accepting applications',
  'job has been unlisted',
  'this requisition has been closed',
  'i18n_redirected_from_missing_job',
  'the posting you are looking for has been removed',
  'this role is now closed',
  'this job is no longer open',
  'this position is no longer available',
  'isjobclosed":true',
  'job is not active',
  'no longer active'
];

function checkUrlStatus(urlStr) {
  return new Promise((resolve) => {
    if (!urlStr || !urlStr.startsWith('http')) {
      return resolve({ active: false, reason: 'Invalid URL' });
    }

    try {
      const client = urlStr.startsWith('https') ? https : http;
      const req = client.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/json'
        },
        timeout: 4000
      }, (res) => {
        // HTTP 404 or 410 means gone
        if (res.statusCode === 404 || res.statusCode === 410) {
          req.destroy();
          return resolve({ active: false, reason: `HTTP ${res.statusCode} Not Found/Gone` });
        }

        let body = '';
        res.on('data', chunk => {
          if (body.length < 25000) body += chunk;
        });

        res.on('end', () => {
          const lower = body.toLowerCase();
          for (const phrase of CLOSED_PHRASES) {
            if (lower.includes(phrase)) {
              return resolve({ active: false, reason: `Page text indicates: "${phrase}"` });
            }
          }
          resolve({ active: res.statusCode < 400, reason: res.statusCode < 400 ? 'OK' : `HTTP ${res.statusCode}` });
        });
      });

      req.on('error', (err) => resolve({ active: false, reason: `Network error: ${err.message}` }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ active: false, reason: 'Request timed out' });
      });
    } catch (e) {
      resolve({ active: false, reason: e.message });
    }
  });
}

async function removeJob(jobId, reason) {
  const now = new Date().toISOString();
  await runQuery(`
    INSERT OR REPLACE INTO jobs_archive 
    SELECT job_id, company, role, location, source, url, description, score, 'CLOSED', discovered_at, ?, ?
    FROM jobs WHERE job_id = ?
  `, [now, reason, jobId]).catch(() => {});

  await runQuery('DELETE FROM jobs WHERE job_id = ?', [jobId]);
  await runQuery('DELETE FROM ai_job_matches WHERE job_id = ?', [jobId]).catch(() => {});
}

async function cleanClosedJobs() {
  console.log('========================================================');
  console.log('🧹 Purging Jobs That Are No Longer Accepting Applications');
  console.log('========================================================\n');

  let totalRemoved = 0;

  // 1. Purge all LinkedIn jobs that are no longer accepting applications
  console.log('--- Step 1: Checking LinkedIn job postings ---');
  const linkedInJobs = await allQuery("SELECT job_id, company, role, application_url, url FROM jobs WHERE LOWER(source) LIKE '%linkedin%' OR url LIKE '%linkedin.com%'");
  for (const lj of linkedInJobs) {
    const targetUrl = lj.application_url || lj.url;
    console.log(`Checking [${lj.company}] ${lj.role}...`);
    const status = await checkUrlStatus(targetUrl);
    if (!status.active) {
      console.log(`  ❌ CLOSED: ${lj.company} - ${lj.role} (${status.reason})`);
      await removeJob(lj.job_id, `LinkedIn job closed: ${status.reason}`);
      totalRemoved++;
    } else {
      console.log(`  ✓ Active`);
    }
  }

  // 2. Check jobs from Sheets, Docs, Naukri, JobYap
  console.log('\n--- Step 2: Checking custom/sheet/doc listings ---');
  const customJobs = await allQuery(`
    SELECT job_id, company, role, application_url, url, source FROM jobs 
    WHERE source IN ('JobYap', 'Naukri', 'Verified Sheets & Docs', 'Verified Sheets Index', 'doc1', 'sheet1')
  `);

  console.log(`Auditing ${customJobs.length} custom / sheet listings...`);
  // Process in batches of 10 concurrently
  const concurrency = 10;
  for (let i = 0; i < customJobs.length; i += concurrency) {
    const chunk = customJobs.slice(i, i + concurrency);
    await Promise.all(chunk.map(async (cj) => {
      const targetUrl = cj.application_url || cj.url;
      const status = await checkUrlStatus(targetUrl);
      if (!status.active) {
        console.log(`  ❌ CLOSED: [${cj.source}] ${cj.company} - ${cj.role} (${status.reason})`);
        await removeJob(cj.job_id, `Listing closed/unreachable: ${status.reason}`);
        totalRemoved++;
      }
    }));
  }

  // 3. Check for any jobs in DB explicitly marked CLOSED or EXPIRED
  const markedClosed = await allQuery("SELECT job_id, company, role FROM jobs WHERE status IN ('CLOSED', 'EXPIRED', 'NO_LONGER_AVAILABLE')");
  for (const mc of markedClosed) {
    await removeJob(mc.job_id, 'Marked as closed in status');
    totalRemoved++;
  }

  console.log(`\n========================================================`);
  console.log(`✅ Cleanup Complete: Removed ${totalRemoved} expired/closed jobs.`);
  const remaining = await getQuery("SELECT count(*) as cnt FROM jobs");
  console.log(`📊 Active verified jobs remaining in DB: ${remaining ? remaining.cnt : 0}`);
  console.log(`========================================================\n`);

  return { totalRemoved, remainingJobs: remaining ? remaining.cnt : 0 };
}

if (require.main === module) {
  cleanClosedJobs()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error during cleanup:', err);
      process.exit(1);
    });
}

module.exports = { cleanClosedJobs, checkUrlStatus };
