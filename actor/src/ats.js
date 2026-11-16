/**
 * ats.js — Zero-LLM JD skill-gap checker (CommonJS version).
 * Adapted from career-ops-main/jd-skill-gap.mjs.
 */
const fs = require('fs');

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
  // degree / education boilerplate
  'bachelor', 'bachelors', 'master', 'masters', 'degree', 'diploma', 'certification', 'certificate',
  // experience / seniority boilerplate
  'experience', 'years', 'year', 'senior', 'junior', 'entry', 'level', 'minimum', 'preferred', 'required',
  // generic sentence-starters that show up capitalized at the start of a bullet
  'candidates', 'candidate', 'applicants', 'applicant', 'ideal', 'successful',
  'knowledge', 'understanding', 'familiarity', 'exposure', 'background',
  'skills', 'skill', 'communication', 'team', 'teams', 'work', 'working',
  // corporate names
  'figma', 'stripe', 'amazon', 'salesforce', 'infosys', 'postman', 'microsoft', 'google'
]);

/**
 * Extract candidate skill tokens from a JD's requirement-style sections.
 * @param {string} jdText
 * @returns {string[]}
 */
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

/**
 * Word-boundary, case-insensitive check for whether a skill token appears in text.
 * @param {string} skill
 * @param {string} text
 * @returns {boolean}
 */
function skillMentionedInText(skill, text) {
  if (!skill || !text) return false;
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i');
  return re.test(text);
}

const SKILLS_HEADING_RE = /^(?:#{1,4}\s*)?(?:Technical\s+|Key\s+)?Skills(?:\s*&\s*Tools)?\s*$/i;
const ANY_HEADING_RE = /^(?:#{1,4}\s*)?(?:Education|Experience|Projects|Technical\s+Skills|Key\s+Skills|Skills(?:\s*&\s*Tools)?|Extracurriculars?|Certifications(?:\s+&\s+Achievements)?|Summary|Professional\s+Summary)\s*$/i;

const LATEX_SKILLS_HEADING_RE = /\\(?:sub)?section\*?\{[^}]*skills\}/i;
const LATEX_ANY_HEADING_RE = /\\(?:sub)?section\*?\{/i;

/**
 * Check if the resume text is LaTeX based on standard document cues.
 * @param {string} text
 * @returns {boolean}
 */
function isLatexResume(text) {
  if (!text) return false;
  return text.includes('\\documentclass') || text.includes('\\begin{document}');
}

/**
 * Strip LaTeX comments, preamble, formatting commands and environments
 * to leave raw textual content for skill matching.
 * @param {string} text
 * @returns {string}
 */
function stripLatexFormatting(text) {
  if (!text) return '';

  // 1. Remove comment lines or inline comments
  let clean = text.replace(/(?<!\\)%.*/g, '');

  // 2. Remove LaTeX env layout packages/definitions in preamble if still there
  const docStart = clean.indexOf('\\begin{document}');
  if (docStart !== -1) {
    clean = clean.substring(docStart + 16);
  }
  const docEnd = clean.indexOf('\\end{document}');
  if (docEnd !== -1) {
    clean = clean.substring(0, docEnd);
  }

  // 3. Remove tabular boilerplate
  clean = clean.replace(/\\extracolsep\s*\{\s*\\fill\s*\}/g, ' ');
  clean = clean.replace(/\\begin\{tabular\*?\}\s*(?:\{[^{}]*\})\s*(?:\[[^\]]*\])?\s*(?:\{[^{}]*\})/g, ' ');
  clean = clean.replace(/\\end\{tabular\*?\}/g, ' ');

  // 4. Remove standard env starters/enders: \begin{...}, \end{...}
  clean = clean.replace(/\\(?:begin|end)\{[^}]*\}/g, ' ');

  // 5. Remove layout adjustments: \vspace{...}, \addtolength{...}, \setlength{...}
  clean = clean.replace(/\\(?:vspace\*?|addtolength|setlength)\{[^}]*\}/g, ' ');

  // 6. Handle \href{url}{text} -> text matching (handles one level of nested braces inside text)
  clean = clean.replace(/\\href\{[^{}]*\}\{((?:[^{}]*|\{[^{}]*\})*)\}/g, ' $1 ');

  // 7. Strip inline layout/formatting commands: \small, \Huge, \scshape, etc.
  clean = clean.replace(/\\(?:small|Large|Huge|scshape|linespread|titlerule)(?![a-zA-Z])/g, ' ');

  // 8. Unpack commands of form \command{value} -> value recursively
  let prev;
  do {
    prev = clean;
    clean = clean.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, ' $1 ');
  } while (clean !== prev);

  // 9. Strip any remaining commands (e.g. \resumeSubHeadingListStart, \item, etc.)
  clean = clean.replace(/\\[a-zA-Z]+/g, ' ');

  // 10. Clean up bracketed option blocks (like [leftmargin=0.15in, label={}])
  clean = clean.replace(/\[[^\]]*\]/g, ' ');

  // 11. Clean up layout/formatting punctuation and braces
  clean = clean.replace(/[\\{}]/g, ' ');

  return clean;
}

/**
 * Split cv.md into its named "Skills" section (if any) and the remaining
 * prose, without relying on a Python-style end-of-string regex anchor.
 * Supports both Markdown and LaTeX base resumes.
 * @param {string} cvText
 * @returns {{namedSkillsText: string, proseText: string}}
 */
function splitSkillsSection(cvText) {
  if (!cvText) return { namedSkillsText: '', proseText: '' };
  const lines = cvText.split('\n');

  let start = -1;
  const isLatex = isLatexResume(cvText);
  const skillsHeadingRe = isLatex ? LATEX_SKILLS_HEADING_RE : SKILLS_HEADING_RE;

  for (let i = 0; i < lines.length; i++) {
    if (skillsHeadingRe.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return { namedSkillsText: '', proseText: cvText };
  }

  const anyHeadingRe = isLatex ? LATEX_ANY_HEADING_RE : ANY_HEADING_RE;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (anyHeadingRe.test(lines[i])) {
      end = i;
      break;
    }
  }

  const namedSkillsText = lines.slice(start, end).join('\n');
  const proseText = lines.slice(0, start - 1).concat(lines.slice(end)).join('\n');
  return { namedSkillsText, proseText };
}

/**
 * Pre-splits and formats the resume skills and prose section.
 * Useful for caching/optimizing repeated matches.
 * @param {string} cvText
 * @returns {{namedSkillsText: string, proseText: string}}
 */
function prepareResumeSkillsAndProse(cvText) {
  if (!cvText) return { namedSkillsText: '', proseText: '' };
  let { namedSkillsText, proseText } = splitSkillsSection(cvText);

  if (isLatexResume(cvText)) {
    namedSkillsText = stripLatexFormatting(namedSkillsText);
    proseText = stripLatexFormatting(proseText);
  }

  return { namedSkillsText, proseText };
}

/**
 * Classify each JD skill against cv.md into existing / supportedByResume / gap.
 * Supports both Markdown and LaTeX resumes.
 * @param {string[]} jdSkills
 * @param {string|object} cvTextOrPreprocessed
 * @returns {{existing: string[], supportedByResume: string[], gap: string[]}}
 */
function classifySkillGaps(jdSkills, cvTextOrPreprocessed) {
  if (!jdSkills || !cvTextOrPreprocessed) return { existing: [], supportedByResume: [], gap: [] };

  let preprocessed;
  if (typeof cvTextOrPreprocessed === 'string') {
    preprocessed = prepareResumeSkillsAndProse(cvTextOrPreprocessed);
  } else {
    preprocessed = cvTextOrPreprocessed;
  }

  const { namedSkillsText, proseText } = preprocessed;

  const existing = [];
  const supportedByResume = [];
  const gap = [];

  for (const skill of jdSkills) {
    if (skillMentionedInText(skill, namedSkillsText)) {
      existing.push(skill);
    } else if (skillMentionedInText(skill, proseText)) {
      supportedByResume.push(skill);
    } else {
      gap.push(skill);
    }
  }

  return { existing, supportedByResume, gap };
}

/**
 * Calculate the overall ATS score (from 0 to 100).
 * Scoring formula:
 * Existing (named skills) = 1.0 weight
 * Supported by Resume (in prose) = 0.6 weight
 * Gaps = 0.0 weight
 * ATS Score = (existing * 1.0 + supported * 0.6) / total * 100
 */
function calculateAtsScore(classification) {
  const total = classification.existing.length + classification.supportedByResume.length + classification.gap.length;
  if (total === 0) return 0;
  const existingCount = classification.existing.length;
  const supportedCount = classification.supportedByResume.length;

  const score = ((existingCount * 1.0 + supportedCount * 0.6) / total) * 100;
  return Math.round(score);
}

module.exports = {
  extractJdSkills,
  skillMentionedInText,
  classifySkillGaps,
  calculateAtsScore,
  prepareResumeSkillsAndProse
};
