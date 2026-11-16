const { allQuery, getQuery, runQuery, initDb } = require('../src/db');

function isRemoteJob(j) {
  const loc = (j.location || '').toLowerCase();
  const tit = (j.role || '').toLowerCase();
  const source = (j.source || '').toLowerCase();

  // Job boards that are 100% remote
  if (source.includes('jobicy') || source.includes('remotive')) {
    return true;
  }

  // Explicit title tags: e.g. '(Remote)', '[Remote]', ' - Remote', ', Remote'
  if (
    tit.includes('(remote)') ||
    tit.includes('[remote]') ||
    tit.includes(' - remote') ||
    tit.includes(', remote') ||
    tit.includes('remote -') ||
    tit.includes('remote |')
  ) {
    return true;
  }

  // Location explicit remote indicators
  if (
    loc.includes('remote') ||
    loc.includes('anywhere') ||
    loc.includes('work from home') ||
    loc.includes('wfh') ||
    loc.includes('telecommute') ||
    loc.includes('virtual') ||
    loc.includes('home based') ||
    loc.includes('home-based') ||
    loc.includes('homebased') ||
    loc.includes('distributed') ||
    loc.includes('work from anywhere')
  ) {
    return true;
  }

  return false;
}

const INDIA_KEYWORDS = [
  'india', 'bengaluru', 'bangalore', 'pune', 'hyderabad', 'mumbai', 
  'delhi', 'noida', 'gurgaon', 'gurugram', 'gujarat', 'gandhinagar', 
  'chennai', 'kolkata', 'ahmedabad'
];

function isIndiaJob(j) {
  const loc = (j.location || '').toLowerCase();
  const country = (j.country || '').toLowerCase();
  return INDIA_KEYWORDS.some(k => loc.includes(k) || country.includes(k));
}

const US_STATES = [
  'california', 'new york', 'texas', 'washington', 'massachusetts', 'illinois',
  'virginia', 'north carolina', 'colorado', 'florida', 'georgia', 'new jersey',
  'pennsylvania', 'ohio', 'michigan', 'maryland', 'oregon', 'arizona', 'minnesota',
  'utah', 'tennessee', 'connecticut', 'indiana', 'missouri', 'wisconsin'
];

const US_CITIES = [
  'san francisco', 'new york city', 'nyc', 'sunnyvale', 'mountain view',
  'palo alto', 'seattle', 'austin', 'chicago', 'boston', 'san jose',
  'los angeles', 'san diego', 'oakland', 'berkeley', 'cambridge',
  'atlanta', 'dallas', 'houston', 'redmond', 'menlo park', 'cupertino',
  'bellevue', 'kirkland', 'portland', 'denver', 'boulder', 'raleigh',
  'durham', 'salt lake city', 'pittsburgh', 'philadelphia', 'miami',
  'santa clara', 'culver city', 'irvine', 'san mateo', 'fremont',
  'santa monica', 'pasadena', 'burbank'
];

const US_CODES = [
  'ca', 'ny', 'tx', 'wa', 'ma', 'il', 'va', 'nc', 'co', 'fl', 'ga', 'nj',
  'pa', 'oh', 'mi', 'md', 'or', 'dc', 'az', 'mn', 'ut', 'tn', 'ct', 'in', 'mo', 'wi'
];

const US_CODE_REGEX = new RegExp('(?:^|[\\s,\\/\\(])(' + US_CODES.join('|') + ')(?:[\\s,\\/\\)]|$)', 'i');

function isUsaJob(j) {
  if (isIndiaJob(j)) return false;
  const loc = (j.location || '').toLowerCase();
  const country = (j.country || '').toLowerCase();

  if (country === 'usa' || country === 'united states' || country === 'us') return true;
  if (loc.includes('united states') || loc.includes('usa') || loc.includes('u.s.a.') || loc.includes('u.s.')) return true;
  if (US_STATES.some(s => loc.includes(s))) return true;
  if (US_CITIES.some(c => loc.includes(c))) return true;
  if (US_CODE_REGEX.test(j.location || '')) return true;

  return false;
}

async function migrateUsaJobs() {
  console.log('--- STARTING USA ONSITE CLEANUP & REMOTE NORMALIZATION MIGRATION ---');
  await initDb();

  // Ensure archive table exists
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

  const allJobs = await allQuery('SELECT * FROM jobs');
  console.log(`Auditing ${allJobs.length} total jobs in database...`);

  let normalizedRemoteCount = 0;
  let archivedUsaOnsiteCount = 0;
  let keptJobsCount = 0;
  const now = new Date().toISOString();

  for (const j of allJobs) {
    const isInd = isIndiaJob(j);
    const isRem = isRemoteJob(j);
    const isUs = isUsaJob(j);

    // If job is already confirmed APPLIED by candidate, do not remove it
    if (j.status === 'APPLIED') {
      keptJobsCount++;
      continue;
    }

    if (isUs && !isRem && !isInd) {
      // It is a USA onsite/hybrid job! Move to archive and delete from jobs
      await runQuery(`
        INSERT OR REPLACE INTO jobs_archive (
          job_id, company, role, location, source, url, description, score, status, discovered_at, archived_at, archive_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CLOSED', ?, ?, ?)
      `, [
        j.job_id,
        j.company || 'Unknown',
        j.role || 'Unknown',
        j.location || 'USA',
        j.source || 'Aggregated',
        j.url || j.application_url || '',
        (j.description || '').substring(0, 4000),
        j.match_score || j.score || 0,
        j.discovered_at || now,
        now,
        'USA onsite/hybrid - filtered out per remote preference'
      ]);

      await runQuery('DELETE FROM jobs WHERE job_id = ?', [j.job_id]);
      await runQuery('DELETE FROM ai_job_matches WHERE job_id = ?', [j.job_id]).catch(() => {});
      archivedUsaOnsiteCount++;
    } else {
      // If genuine remote, ensure remote_type = 'remote'
      if (isRem && j.remote_type !== 'remote') {
        await runQuery("UPDATE jobs SET remote_type = 'remote' WHERE job_id = ?", [j.job_id]);
        normalizedRemoteCount++;
      } else if (!isRem && isUs) {
        // In case it's kept somehow, set onsite
        await runQuery("UPDATE jobs SET remote_type = 'onsite' WHERE job_id = ?", [j.job_id]);
      }
      keptJobsCount++;
    }
  }

  console.log('--- MIGRATION COMPLETED ---');
  console.log(`Archived USA Onsite / Hybrid Jobs: ${archivedUsaOnsiteCount}`);
  console.log(`Standardized Remote Jobs to 'remote': ${normalizedRemoteCount}`);
  console.log(`Remaining Jobs in Database: ${keptJobsCount}`);

  // Summary of remaining active jobs
  const remainingActive = await getQuery("SELECT COUNT(*) as cnt FROM jobs WHERE status = 'ACTIVE'");
  const remainingRemote = await getQuery("SELECT COUNT(*) as cnt FROM jobs WHERE remote_type = 'remote' OR location LIKE '%remote%' OR location LIKE '%anywhere%'");
  const remainingIndia = await getQuery("SELECT COUNT(*) as cnt FROM jobs WHERE location LIKE '%India%' OR location LIKE '%Bengaluru%' OR location LIKE '%Bangalore%' OR location LIKE '%Pune%' OR location LIKE '%Hyderabad%' OR location LIKE '%Delhi%' OR location LIKE '%Noida%' OR location LIKE '%Gurgaon%' OR location LIKE '%Mumbai%'");

  console.log('\n--- CURRENT STATUS OF JOBS TABLE ---');
  console.log(`Active Jobs: ${remainingActive ? remainingActive.cnt : 0}`);
  console.log(`Remote Jobs: ${remainingRemote ? remainingRemote.cnt : 0}`);
  console.log(`India Jobs: ${remainingIndia ? remainingIndia.cnt : 0}`);
}

migrateUsaJobs()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
