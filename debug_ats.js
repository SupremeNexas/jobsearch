const { initDb, allQuery } = require('./actor/src/db');

const he = {
    decode: (str) => {
        if (!str) return '';
        return str
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&nbsp;/g, ' ');
    }
};

const REQUIREMENT_KEYWORDS = /\b(?:required|requirements|qualifications|must[- ]have|preferred|nice[- ]to[- ]have|hear from you|looking for|what you bring|you bring|skills|about you|background|expectations|plus|what you need|to succeed|who you are|who you)\b/i;

function isRequirementHeader(line) {
  const clean = line.trim();
  if (!clean) return false;
  if (/^[-*•]/.test(clean)) return false; // bullet lines are not headers

  if (!REQUIREMENT_KEYWORDS.test(clean)) return false;

  if (clean.startsWith('#')) return true;
  if (clean.length < 80) return true;

  return false;
}

const BULLET_LINE_RE = /^\s*[-*•]\s*(.+)$/;

const SKILL_TOKEN_RE = /\b([A-Z][A-Za-z0-9+.#]{0,29}[A-Za-z0-9+#](?:\.[a-z]{2,4})?)(?!\w)/g;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'our', 'this', 'that', 'these', 'those',
  'must', 'able', 'ability', 'strong', 'excellent', 'proven', 'a', 'an', 'or', 'in', 'of', 'to', 'as', 'is', 'are',
  'bachelor', 'bachelors', 'master', 'masters', 'degree', 'diploma', 'certification', 'certificate',
  'experience', 'years', 'year', 'senior', 'junior', 'entry', 'level', 'minimum', 'preferred', 'required',
  'candidates', 'candidate', 'applicants', 'applicant', 'ideal', 'successful',
  'knowledge', 'understanding', 'familiarity', 'exposure', 'background',
  'skills', 'skill', 'communication', 'team', 'teams', 'work', 'working',
  'figma', 'stripe', 'amazon', 'salesforce', 'infosys', 'postman', 'microsoft', 'google'
]);

function extractJdSkills(jdText) {
  if (!jdText) return [];

  // 1. Decode HTML
  const decoded = he.decode(jdText);

  // 2. Add bullet prefixes to standard <li> tags to turn them into bullet lines
  // 3. Add # headings to standard <h...> tags to identify headers
  let withBulletsFlagged = decoded
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<h[1-6]\b[^>]*>/gi, '\n# ')
      .replace(/<\/h[1-6]>/gi, '\n');

  // Convert other block tags to newlines
  const blockTags = /<\/?(p|div|br|tr|td)\b[^>]*>/gi;
  const withNewlines = withBulletsFlagged.replace(blockTags, '\n');

  // Strip all HTML tags
  const cleanText = withNewlines.replace(/<[^>]*>/g, '');

  // Split and trim
  const lines = cleanText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const skills = new Set();
  let inRequirementsBlock = false;

  for (const line of lines) {
    if (isRequirementHeader(line)) {
      inRequirementsBlock = true;
      continue;
    }

    // If we hit a heading/short line that is NOT a requirement header, we exit the block
    if (inRequirementsBlock && line.trim() === '') continue;

    const isOtherHeader = (line.startsWith('#') || (line.length < 80 && !/^[-*•]/.test(line))) && !isRequirementHeader(line);
    if (inRequirementsBlock && isOtherHeader) {
      inRequirementsBlock = false;
    }

    const bulletMatch = BULLET_LINE_RE.exec(line);
    // If we are in the requirements block and it's a bullet
    if (inRequirementsBlock && bulletMatch) {
      const bulletText = bulletMatch[1];
      let m;
      SKILL_TOKEN_RE.lastIndex = 0;
      while ((m = SKILL_TOKEN_RE.exec(bulletText)) !== null) {
        const token = m[1].trim();
        if (!STOPWORDS.has(token.toLowerCase()) && token.length > 1) {
          skills.add(token);
        }
      }
    }
  }

  // Fallback: If no skills were extracted (e.g. no requirements block was detected or no bullets),
  // parse the entire text for capitalized tech keywords.
  if (skills.size === 0) {
    const textToParse = lines.filter(l => !l.startsWith('#')).join(' ');
    let m;
    SKILL_TOKEN_RE.lastIndex = 0;
    while ((m = SKILL_TOKEN_RE.exec(textToParse)) !== null) {
      const token = m[1].trim();
      if (!STOPWORDS.has(token.toLowerCase()) && token.length > 1) {
        skills.add(token);
      }
    }
  }

  return [...skills];
}

async function debug() {
    await initDb();
    // Test on Stripe jobs
    const jobs = await allQuery("SELECT job_id, company, role, description FROM jobs WHERE company = 'stripe' LIMIT 10");
    for (const job of jobs) {
        const jdSkills = extractJdSkills(job.description);
        console.log(`Job: "${job.role}" at ${job.company} -> extracted skills (count: ${jdSkills.length}):`, jdSkills);
    }
}
debug().catch(console.error);
