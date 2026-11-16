/**
 * Central Connectors Hub
 * Coordinates all job sources with concurrent execution, timeouts, isolation, and health logging.
 */

const { recordConnectorStatus, getAllConnectorStatuses, getConnectorStatus } = require('./connectorHealth');
const jobicyConnector = require('./jobicyConnector');
const remotiveConnector = require('./remotiveConnector');
const jobyapConnector = require('./jobyapConnector');
const greenhouseConnector = require('./greenhouseConnector');
const leverConnector = require('./leverConnector');
const ashbyConnector = require('./ashbyConnector');
const linkedinConnector = require('./linkedinConnector');
const naukriConnector = require('./naukriConnector');
const apifyConnector = require('./apifyConnector');
const firecrawlConnector = require('./firecrawlConnector');
const playwrightConnector = require('./playwrightConnector');
const sheetsDocsConnector = require('./sheetsDocsConnector');
const candidateConnector = require('./candidateConnector');

const SOURCE_CONNECTORS = [
    greenhouseConnector,
    leverConnector,
    ashbyConnector,
    jobicyConnector,
    remotiveConnector,
    jobyapConnector,
    linkedinConnector,
    naukriConnector,
    apifyConnector,
    firecrawlConnector,
    sheetsDocsConnector,
    playwrightConnector
];

/**
 * Executes all or selected job discovery connectors concurrently with error isolation.
 */
async function runAllConnectors(options = {}) {
    const {
        keywords = ['software', 'engineer', 'backend', 'full stack', 'developer', 'ai'],
        selectedSources = 'all',
        mode = 'FULL_DISCOVERY',
        signal = null
    } = options;

    console.log(`[Connectors Hub] Launching discovery across sources (Mode: ${mode})...`);

    // Ensure candidate profile & status are refreshed
    candidateConnector.getCandidateProfile();

    const enabledConnectors = SOURCE_CONNECTORS.filter(c => {
        if (selectedSources === 'all') return true;
        const list = Array.isArray(selectedSources) ? selectedSources : selectedSources.split(',').map(s => s.trim());
        return list.includes(c.id) || list.includes(c.name);
    });

    const resultsBySource = {};
    const allRawJobs = [];
    const executionStats = {
        attempted: enabledConnectors.length,
        succeeded: 0,
        failed: 0,
        errors: []
    };

    const promises = enabledConnectors.map(async (connector) => {
        if (signal?.aborted) {
            console.log(`[Connector Hub] ${connector.name} skipped (abort requested).`);
            return;
        }
        const startTime = Date.now();
        try {
            console.log(`[Connector Hub] Starting ${connector.name}...`);

            const abortPromise = new Promise((_, reject) => {
                if (signal) {
                    if (signal.aborted) reject(new Error('Discovery aborted by user'));
                    signal.addEventListener('abort', () => reject(new Error('Discovery aborted by user')), { once: true });
                }
            });

            const jobs = await Promise.race([
                connector.searchJobs({ keywords, mode }),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after 20s`)), 20000)),
                abortPromise
            ]);

            resultsBySource[connector.id] = jobs || [];
            allRawJobs.push(...(jobs || []));
            executionStats.succeeded++;
            console.log(`[Connector Hub] ${connector.name} finished: ${(jobs || []).length} jobs retrieved in ${Date.now() - startTime}ms.`);
        } catch (err) {
            if (signal?.aborted || err.message?.includes('aborted by user')) {
                console.log(`[Connector Hub] ${connector.name} aborted.`);
                return;
            }
            console.error(`[Connector Hub] ${connector.name} failed:`, err.message);
            resultsBySource[connector.id] = [];
            executionStats.failed++;
            executionStats.errors.push({ connector: connector.id, error: err.message });
            recordConnectorStatus(connector.id, { status: 'FAILED', error: err.message });
        }
    });

    await Promise.all(promises);

    console.log(`[Connectors Hub] Discovery run completed: ${allRawJobs.length} total raw jobs collected (${executionStats.succeeded}/${executionStats.attempted} sources succeeded).`);

    return {
        rawJobs: allRawJobs,
        resultsBySource,
        stats: executionStats
    };
}

module.exports = {
    SOURCE_CONNECTORS,
    runAllConnectors,
    recordConnectorStatus,
    getAllConnectorStatuses,
    getConnectorStatus,
    candidateConnector,
    firecrawlConnector,
    playwrightConnector
};
