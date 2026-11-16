/**
 * liveness.js — High-precision Job Liveness & Expiration Classifier
 * Adapted from career-ops-main/liveness-core.mjs and check-liveness.mjs
 *
 * Detects:
 * - HTTP 404/410 gone status
 * - 23+ ATS expiration phrases ("no longer accepting applications", "position has been filled", etc.)
 * - Job ID dropping redirects (e.g. redirected to search or homepage)
 * - Bot/Cloudflare challenges (marked 'uncertain' rather than falsely 'expired')
 */

const https = require('https');
const http = require('http');

const HARD_EXPIRED_PATTERNS = [
    /job (is )?no longer available/i,
    /job.*no longer open/i,
    /position has been filled/i,
    /this job has expired/i,
    /job posting has expired/i,
    /no longer accepting applications/i,
    /this (position|role|job) (is )?no longer/i,
    /this job (listing )?is closed/i,
    /job (listing )?not found/i,
    /the page you are looking for doesn.t exist/i,
    /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
    /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
    /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
    /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
    /offre (expirée|n'est plus disponible)/i,
    /i18n_redirected_from_missing_job/i,
    /career page does not exist/i,
    /page you requested was not found/i,
    /this requisition has been closed/i
];

const BOT_CHALLENGE_PATTERNS = [
    /just a moment/i,
    /performing security verification/i,
    /checking your browser before/i,
    /verify you are (a |not a )?human/i,
    /enable javascript and cookies to continue/i,
    /attention required.*cloudflare/i,
    /\bray id\b/i,
    /\bcf-ray\b/i,
    /please complete the security check/i
];

const JOB_ID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/gi;

function extractJobIdToken(url = '') {
    const matches = url.match(JOB_ID_TOKEN);
    return matches ? matches[matches.length - 1].toLowerCase() : null;
}

/**
 * Classifies liveness based on HTTP status, requested/final URL, and text.
 */
function classifyLiveness({ status = 0, requestedUrl = '', finalUrl = '', bodyText = '' } = {}) {
    if (status === 404 || status === 410) {
        return { isLive: false, status: 'EXPIRED', code: 'http_gone', reason: `HTTP ${status}` };
    }

    // Anti-bot detection: treat as uncertain/live, not expired!
    for (const pat of BOT_CHALLENGE_PATTERNS) {
        if (pat.test(bodyText)) {
            return { isLive: true, status: 'UNCERTAIN', code: 'bot_challenge', reason: `Anti-bot challenge: ${pat.source}` };
        }
    }
    if (status === 403 || status === 503) {
        return { isLive: true, status: 'UNCERTAIN', code: 'access_blocked', reason: `HTTP ${status} (Access restricted/bot wall)` };
    }

    // Check URL patterns
    if (/[?&]error=true/i.test(finalUrl)) {
        return { isLive: false, status: 'EXPIRED', code: 'url_error', reason: 'URL indicates error/expired' };
    }

    // Check ID dropping redirect
    const reqToken = extractJobIdToken(requestedUrl);
    const finalToken = extractJobIdToken(finalUrl);
    if (reqToken && finalToken && reqToken !== finalToken) {
        return { isLive: false, status: 'EXPIRED', code: 'id_redirect_drop', reason: `Redirected to different token: ${reqToken} -> ${finalToken}` };
    }

    // Check closed text patterns in body
    for (const pattern of HARD_EXPIRED_PATTERNS) {
        if (pattern.test(bodyText)) {
            return { isLive: false, status: 'EXPIRED', code: 'closed_banner', reason: `Matched pattern: ${pattern.source}` };
        }
    }

    return { isLive: true, status: 'LIVE', code: 'ok', reason: 'Posting active' };
}

/**
 * Performs a lightweight HTTP check to test if a job URL is live.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ isLive: boolean, status: string, code: string, reason: string }>}
 */
async function checkUrlLiveness(url, timeoutMs = 8000) {
    if (!url || !url.startsWith('http')) {
        return { isLive: false, status: 'INVALID', code: 'invalid_url', reason: 'URL missing or invalid' };
    }

    return new Promise((resolve) => {
        try {
            const parsedUrl = new URL(url);
            const client = parsedUrl.protocol === 'https:' ? https : http;

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                timeout: timeoutMs
            };

            const req = client.request(options, (res) => {
                const status = res.statusCode;
                const finalUrl = res.headers.location || url;

                if (status === 404 || status === 410) {
                    return resolve({ isLive: false, status: 'EXPIRED', code: 'http_gone', reason: `HTTP ${status}` });
                }

                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    data += chunk;
                    if (data.length > 50000) {
                        req.destroy();
                    }
                });

                res.on('end', () => {
                    const result = classifyLiveness({
                        status,
                        requestedUrl: url,
                        finalUrl,
                        bodyText: data
                    });
                    resolve(result);
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ isLive: true, status: 'UNCERTAIN', code: 'timeout', reason: 'Request timed out' });
            });

            req.on('error', (err) => {
                resolve({ isLive: true, status: 'UNCERTAIN', code: 'network_err', reason: err.message });
            });

            req.end();
        } catch (e) {
            resolve({ isLive: false, status: 'ERROR', code: 'exception', reason: e.message });
        }
    });
}

module.exports = {
    HARD_EXPIRED_PATTERNS,
    BOT_CHALLENGE_PATTERNS,
    classifyLiveness,
    checkUrlLiveness
};
