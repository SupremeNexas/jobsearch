const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const { getQuery, runQuery } = require('../db');

/**
 * Retrieves configured Gmail credentials from environment or settings table.
 */
async function getGmailCredentials() {
    let email = process.env.GMAIL_USER || '';
    let appPassword = process.env.GMAIL_APP_PASSWORD || '';

    if (!appPassword) {
        try {
            const row = await getQuery("SELECT value FROM settings WHERE key = 'GMAIL_APP_PASSWORD'");
            if (row && row.value) {
                appPassword = row.value.trim();
            }
        } catch (e) {}
    }

    if (!appPassword) {
        try {
            const emailRow = await getQuery("SELECT value FROM settings WHERE key = 'GMAIL_USER'");
            if (emailRow && emailRow.value) {
                email = emailRow.value.trim();
            }
        } catch (e) {}
    }

    // Clean whitespace from app password (Google generates them with spaces like "abcd efgh ijkl mnop")
    if (appPassword) {
        appPassword = appPassword.replace(/\s+/g, '');
    }

    return { email, appPassword };
}

/**
 * Saves Gmail App Password to settings database table and process.env.
 */
async function saveGmailCredentials(email, appPassword) {
    const cleanedPassword = (appPassword || '').replace(/\s+/g, '');
    const userEmail = (email || '').trim();

    process.env.GMAIL_USER = userEmail;
    process.env.GMAIL_APP_PASSWORD = cleanedPassword;

    await runQuery(`
        INSERT INTO settings (key, value, updated_at)
        VALUES ('GMAIL_USER', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `, [userEmail]);

    await runQuery(`
        INSERT INTO settings (key, value, updated_at)
        VALUES ('GMAIL_APP_PASSWORD', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `, [cleanedPassword]);

    return { success: true, email: userEmail };
}

/**
 * Tests connection to Gmail (Keychain OAuth or IMAP).
 */
async function testGmailConnection() {
    // 1. Check optional local OAuth helper first
    try {
        const mcpAuthPath = path.join(require('os').homedir(), 'gmail-mcp/auth.js');
        const fs = require('fs');
        if (fs.existsSync(mcpAuthPath)) {
            const { getGmailClient } = await import(mcpAuthPath);
            const gmail = await getGmailClient();
            if (gmail) {
                const profile = await gmail.users.getProfile({ userId: 'me' });
                return {
                    success: true,
                    email: profile.data.emailAddress || '',
                    message: `Successfully connected to Gmail (${profile.data.emailAddress}) via OAuth!`
                };
            }
        }
    } catch (e) {
        // Fallback to IMAP test below
    }

    const { email, appPassword } = await getGmailCredentials();
    if (!appPassword) {
        return {
            success: false,
            error: 'No Gmail authentication found. Please run setup-auth.js or configure an App Password.'
        };
    }

    const config = {
        imap: {
            user: email,
            password: appPassword,
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
            authTimeout: 10000
        }
    };

    try {
        const connection = await imaps.connect(config);
        await connection.openBox('INBOX');
        await connection.end();
        return {
            success: true,
            email,
            message: `Successfully connected to Gmail for ${email}!`
        };
    } catch (err) {
        return {
            success: false,
            email,
            error: `Gmail IMAP authentication failed: ${err.message}. Please ensure 2-Step Verification is active and you are using a 16-character App Password (not your account login password).`
        };
    }
}

/**
 * Extracts verification codes (6-8 digits) from email text or subject.
 */
function extractOtpCode(text, subject = '') {
    if (!text && !subject) return null;
    const combined = `${subject}\n${text}`;

    // Greenhouse pattern: "Copy and paste this code into the security code field... 55517637"
    const greenhousePattern = /copy and paste this code[^:]*:\s*([0-9]{6,8})/i;
    const ghMatch = combined.match(greenhousePattern);
    if (ghMatch && ghMatch[1]) return ghMatch[1].trim();

    // Standard pattern: "security code: 55517637" or "verification code: 123456"
    const labelPattern = /(?:security\s*code|verification\s*code|confirmation\s*code|one-time\s*passcode|otp|passcode)[:\s]+([0-9]{6,8})\b/i;
    const labelMatch = combined.match(labelPattern);
    if (labelMatch && labelMatch[1]) return labelMatch[1].trim();

    // Line with only 6 to 8 digits
    const isolatedDigitMatch = combined.match(/(?:^|\n)\s*([0-9]{6,8})\s*(?:\n|$)/);
    if (isolatedDigitMatch && isolatedDigitMatch[1]) return isolatedDigitMatch[1].trim();

    // Generic 8-digit match (Greenhouse uses exactly 8 digits)
    const eightDigitMatch = combined.match(/\b([0-9]{8})\b/);
    if (eightDigitMatch && eightDigitMatch[1]) return eightDigitMatch[1].trim();

    // Generic 6-digit match
    const sixDigitMatch = combined.match(/\b([0-9]{6})\b/);
    if (sixDigitMatch && sixDigitMatch[1]) return sixDigitMatch[1].trim();

    return null;
}

/**
 * Checks Gmail via macOS Keychain OAuth tokens (from gmail-mcp).
 */
async function fetchFromGmailMcpKeychain(options = {}) {
    const { targetCompany = '', maxAgeMinutes = 15 } = options;
    try {
        const { getGmailClient } = await import('/Users/supryo/gmail-mcp/auth.js');
        const gmail = await getGmailClient();
        if (!gmail) return null;

        const q = 'from:greenhouse OR from:us.greenhouse-mail.io OR subject:"security code" OR subject:"verification code" OR subject:"code requested"';
        const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
        if (!res.data.messages || res.data.messages.length === 0) return null;

        const sinceMs = Date.now() - (maxAgeMinutes * 60 * 1000);
        let bestCode = null;
        let newestDate = 0;
        let matchedEmailInfo = null;

        for (const m of res.data.messages) {
            const msg = await gmail.users.messages.get({ userId: 'me', id: m.id });
            const internalDate = parseInt(msg.data.internalDate, 10);
            if (internalDate < sinceMs) continue;

            const headers = msg.data.payload?.headers || [];
            const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
            const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
            const snippet = msg.data.snippet || '';

            let bodyText = snippet;
            function extractBody(part) {
                if (part.body && part.body.data) {
                    try {
                        const decoded = Buffer.from(part.body.data, 'base64').toString('utf8');
                        bodyText += '\n' + decoded;
                    } catch (e) {}
                }
                if (part.parts) {
                    part.parts.forEach(extractBody);
                }
            }
            if (msg.data.payload) extractBody(msg.data.payload);

            const companyMatch = targetCompany
                ? (subjectHeader.toLowerCase().includes(targetCompany.toLowerCase()) || bodyText.toLowerCase().includes(targetCompany.toLowerCase()))
                : true;

            if (companyMatch) {
                const code = extractOtpCode(bodyText, subjectHeader);
                if (code && internalDate > newestDate) {
                    newestDate = internalDate;
                    bestCode = code;
                    matchedEmailInfo = {
                        code,
                        subject: subjectHeader,
                        from: fromHeader,
                        date: new Date(internalDate),
                        timestamp: internalDate
                    };
                }
            }
        }

        if (bestCode) {
            console.log(`[Gmail OTP] Successfully extracted code via macOS Keychain OAuth: ${bestCode} (Subject: "${matchedEmailInfo.subject}")`);
            return matchedEmailInfo;
        }
    } catch (e) {
        // Fallback to IMAP if Keychain OAuth fails
    }
    return null;
}

/**
 * Searches Gmail for the latest security/verification code from an ATS (Greenhouse, Lever, etc.).
 * @param {object} options Filter options: { targetCompany, targetAts, maxAgeMinutes }
 */
async function fetchLatestSecurityCode(options = {}) {
    // 1. Try macOS Keychain Gmail OAuth first (zero credentials required)
    const keychainResult = await fetchFromGmailMcpKeychain(options);
    if (keychainResult && keychainResult.code) {
        return keychainResult;
    }

    const { email, appPassword } = await getGmailCredentials();
    if (!appPassword) {
        return null;
    }

    const {
        targetCompany = '',
        targetAts = 'greenhouse',
        maxAgeMinutes = 15
    } = options;

    const config = {
        imap: {
            user: email,
            password: appPassword,
            host: 'imap.gmail.com',
            port: 993,
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
            authTimeout: 10000
        }
    };

    const connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    const sinceDate = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    // Format date for IMAP SEARCH (e.g. 06-Nov-2026)
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const imapDateStr = `${String(sinceDate.getDate()).padStart(2, '0')}-${monthNames[sinceDate.getMonth()]}-${sinceDate.getFullYear()}`;

    // Search criteria: search recent messages
    const searchCriteria = [
        ['SINCE', imapDateStr]
    ];

    const fetchOptions = {
        bodies: ['HEADER', 'TEXT', ''],
        markSeen: false
    };

    const messages = await connection.search(searchCriteria, fetchOptions);

    let bestCode = null;
    let newestDate = 0;
    let matchedEmailInfo = null;

    for (const message of messages) {
        try {
            const all = message.parts.find(part => part.which === '');
            let parsed;
            if (all && all.body) {
                parsed = await simpleParser(all.body);
            } else {
                const headerPart = message.parts.find(part => part.which === 'HEADER');
                const textPart = message.parts.find(part => part.which === 'TEXT');
                const rawHeader = headerPart ? headerPart.body : {};
                parsed = {
                    subject: rawHeader.subject ? rawHeader.subject[0] : '',
                    from: rawHeader.from ? { text: rawHeader.from[0] } : null,
                    date: message.attributes && message.attributes.date ? new Date(message.attributes.date) : new Date(),
                    text: textPart ? String(textPart.body) : ''
                };
            }

            const fromText = (parsed.from && parsed.from.text) || '';
            const subject = parsed.subject || '';
            const bodyText = parsed.text || parsed.html || '';
            const emailDate = parsed.date ? new Date(parsed.date).getTime() : 0;

            // Check if email is from Greenhouse or matches security verification
            const isGreenhouse = fromText.toLowerCase().includes('greenhouse') ||
                                 fromText.toLowerCase().includes('greenhouse-mail.io') ||
                                 subject.toLowerCase().includes('greenhouse') ||
                                 bodyText.toLowerCase().includes('greenhouse recruiting');

            const isSecuritySubject = subject.toLowerCase().includes('security code') ||
                                      subject.toLowerCase().includes('verification code') ||
                                      subject.toLowerCase().includes('application to') ||
                                      subject.toLowerCase().includes('code requested') ||
                                      bodyText.toLowerCase().includes('security code field');

            const companyMatch = targetCompany
                ? (subject.toLowerCase().includes(targetCompany.toLowerCase()) || bodyText.toLowerCase().includes(targetCompany.toLowerCase()))
                : true;

            if ((isGreenhouse || isSecuritySubject) && companyMatch) {
                const code = extractOtpCode(bodyText, subject);
                if (code && emailDate > newestDate) {
                    newestDate = emailDate;
                    bestCode = code;
                    matchedEmailInfo = {
                        code,
                        subject,
                        from: fromText,
                        date: parsed.date,
                        timestamp: emailDate
                    };
                }
            }
        } catch (msgErr) {
            console.warn('[Gmail OTP] Message parsing note:', msgErr.message);
        }
    }

    await connection.end();

    if (bestCode) {
        console.log(`[Gmail OTP] Successfully extracted code: ${bestCode} (Subject: "${matchedEmailInfo.subject}")`);
        return matchedEmailInfo;
    }

    return null;
}

/**
 * Polls Gmail repeatedly until a security code email arrives (useful during live form submissions).
 */
async function pollForSecurityCode(options = {}) {
    const {
        timeoutMs = 45000,
        intervalMs = 3000,
        targetCompany = '',
        targetAts = 'greenhouse'
    } = options;

    const startTime = Date.now();
    console.log(`[Gmail OTP] Starting live polling for ${targetAts} security code (Timeout: ${timeoutMs / 1000}s)...`);

    while (Date.now() - startTime < timeoutMs) {
        try {
            const result = await fetchLatestSecurityCode({
                targetCompany,
                targetAts,
                maxAgeMinutes: 10
            });

            if (result && result.code) {
                return result;
            }
        } catch (e) {
            console.warn(`[Gmail OTP Poll] Check note: ${e.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    console.warn(`[Gmail OTP] Polling timed out after ${timeoutMs / 1000}s.`);
    return null;
}

module.exports = {
    getGmailCredentials,
    saveGmailCredentials,
    testGmailConnection,
    extractOtpCode,
    fetchLatestSecurityCode,
    pollForSecurityCode
};
