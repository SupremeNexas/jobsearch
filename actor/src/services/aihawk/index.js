const { getAihawkConfig, getMaskedConfig, maskSecret } = require('./config');
const { logger, AihawkLogger } = require('./logs');
const { client, AihawkClient } = require('./client');
const { browserManager, AihawkBrowserManager } = require('./browser');
const { jobService, AihawkJobService, generateJobKey } = require('./jobs');
const { matcherService, AihawkMatcherService } = require('./matcher');
const { applicationService, AihawkApplicationService } = require('./applications');
const { mcpBridge, AihawkMcpBridge } = require('./mcp');

module.exports = {
    getAihawkConfig,
    getMaskedConfig,
    maskSecret,
    logger,
    AihawkLogger,
    client,
    AihawkClient,
    browserManager,
    AihawkBrowserManager,
    jobService,
    AihawkJobService,
    generateJobKey,
    matcherService,
    AihawkMatcherService,
    applicationService,
    AihawkApplicationService,
    mcpBridge,
    AihawkMcpBridge
};
