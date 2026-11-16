const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env') });

const DEFAULT_PROFILE_DIR = path.resolve(process.env.AIHAWK_PROFILE_DIR || path.join(__dirname, '../../../../data/aihawk_profiles'));

// Ensure profile directory exists safely outside source code
if (!fs.existsSync(DEFAULT_PROFILE_DIR)) {
    try {
        fs.mkdirSync(DEFAULT_PROFILE_DIR, { recursive: true });
    } catch (e) {
        console.warn('[AIHawk Config] Could not create profile directory:', e.message);
    }
}

function maskSecret(secret) {
    if (!secret || typeof secret !== 'string') return '';
    if (secret.length <= 8) return '********';
    return `${secret.substring(0, 4)}...${secret.substring(secret.length - 4)}`;
}

async function getAihawkConfig(dbGetQuery = null) {
    let dbSettings = {};
    if (dbGetQuery) {
        try {
            const rows = await dbGetQuery();
            if (Array.isArray(rows)) {
                rows.forEach(r => { dbSettings[r.key] = r.value; });
            }
        } catch (e) {
            // fallback to env
        }
    }

    const openrouterKey = dbSettings.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || process.env.AIHAWK_OPENROUTER_KEY || '';
    const anthropicKey = dbSettings.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '';
    const omnirouteUrl = dbSettings.OMNIROUTE_URL || process.env.OMNIROUTE_URL || 'http://localhost:20128/v1';
    const omnirouteKey = dbSettings.OMNIROUTE_API_KEY || process.env.OMNIROUTE_API_KEY || '';

    const model = dbSettings.AIHAWK_MODEL || process.env.AIHAWK_MODEL || 'gemini-3.8-flash';
    const profileDir = dbSettings.AIHAWK_PROFILE_DIR || process.env.AIHAWK_PROFILE_DIR || DEFAULT_PROFILE_DIR;
    const proxy = dbSettings.AIHAWK_PROXY || process.env.AIHAWK_PROXY || '';
    const seed = parseInt(dbSettings.AIHAWK_SEED || process.env.AIHAWK_SEED || '42', 10);
    const headed = (dbSettings.AIHAWK_HEADED || process.env.AIHAWK_HEADED || 'false') === 'true';
    const host = dbSettings.AIHAWK_HOST || process.env.AIHAWK_HOST || '127.0.0.1';
    const port = parseInt(dbSettings.AIHAWK_PORT || process.env.AIHAWK_PORT || '8765', 10);
    const mcpEnabled = (dbSettings.AIHAWK_MCP_ENABLED || process.env.AIHAWK_MCP_ENABLED || 'true') === 'true';

    return {
        openrouterKey,
        anthropicKey,
        omnirouteUrl,
        omnirouteKey,
        model,
        profileDir,
        proxy,
        seed,
        headed,
        host,
        port,
        mcpEnabled
    };
}

function getMaskedConfig(config) {
    return {
        openrouterKeyMasked: maskSecret(config.openrouterKey),
        hasOpenrouterKey: Boolean(config.openrouterKey),
        anthropicKeyMasked: maskSecret(config.anthropicKey),
        hasAnthropicKey: Boolean(config.anthropicKey),
        omnirouteUrl: config.omnirouteUrl,
        omnirouteKeyMasked: maskSecret(config.omnirouteKey),
        hasOmnirouteKey: Boolean(config.omnirouteKey),
        model: config.model,
        profileDir: config.profileDir,
        proxyMasked: config.proxy ? (config.proxy.includes('@') ? `http://***@${config.proxy.split('@')[1]}` : config.proxy) : '',
        seed: config.seed,
        headed: config.headed,
        host: config.host,
        port: config.port,
        mcpEnabled: config.mcpEnabled
    };
}

module.exports = {
    DEFAULT_PROFILE_DIR,
    getAihawkConfig,
    getMaskedConfig,
    maskSecret
};
