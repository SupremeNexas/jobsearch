const { getAihawkConfig } = require('./config');
const { browserManager } = require('./browser');
const { jobService } = require('./jobs');
const { matcherService } = require('./matcher');
const { applicationService } = require('./applications');
const { logger } = require('./logs');

class AihawkMcpBridge {
    async getMcpServerConfig() {
        const config = await getAihawkConfig();
        return {
            name: 'aihawk-stealth',
            description: 'AIHawk stealth browser and automated job intelligence agent',
            command: 'uvx',
            args: [
                'aihawk',
                ...(config.openrouterKey ? ['--openrouter-key', config.openrouterKey] : []),
                ...(config.model ? ['--model', config.model] : []),
                ...(config.proxy ? ['--proxy', config.proxy] : []),
                ...(config.profileDir ? ['--profile-dir', config.profileDir] : []),
                ...(config.seed ? ['--seed', String(config.seed)] : []),
                ...(config.headed ? ['--headed'] : []),
                '--port', String(config.port || 8765),
                '--host', config.host || '127.0.0.1'
            ],
            env: {
                OPENROUTER_API_KEY: config.openrouterKey,
                AIHAWK_MODEL: config.model,
                AIHAWK_PROFILE_DIR: config.profileDir,
                AIHAWK_PROXY: config.proxy,
                AIHAWK_SEED: String(config.seed)
            }
        };
    }

    getToolDefinitions() {
        return [
            {
                name: 'browser_open',
                description: 'Open a stealth persistent browser session (main or support)',
                parameters: {
                    type: 'object',
                    properties: {
                        session: { type: 'string', enum: ['main', 'support'], default: 'main' },
                        headed: { type: 'boolean', default: false }
                    }
                }
            },
            {
                name: 'browser_close',
                description: 'Close an active browser session',
                parameters: {
                    type: 'object',
                    properties: {
                        session: { type: 'string', enum: ['main', 'support'], default: 'main' }
                    }
                }
            },
            {
                name: 'browser_navigate',
                description: 'Navigate the active browser to a URL',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: 'Target destination URL' },
                        session: { type: 'string', default: 'main' }
                    },
                    required: ['url']
                }
            },
            {
                name: 'browser_screenshot',
                description: 'Take a screenshot of the current page',
                parameters: {
                    type: 'object',
                    properties: {
                        session: { type: 'string', default: 'main' }
                    }
                }
            },
            {
                name: 'job_search',
                description: 'Discover and extract real job listings using AIHawk search profiles',
                parameters: {
                    type: 'object',
                    properties: {
                        keywords: { type: 'string' },
                        location: { type: 'string' },
                        experience_level: { type: 'string' },
                        max_jobs: { type: 'number', default: 20 }
                    }
                }
            },
            {
                name: 'job_match',
                description: 'Perform deep AI multi-dimensional matching of a job against user profile',
                parameters: {
                    type: 'object',
                    properties: {
                        job_id: { type: 'string' }
                    },
                    required: ['job_id']
                }
            },
            {
                name: 'job_apply_prepare',
                description: 'Prepare and stage an application with tailored resume and form fields draft',
                parameters: {
                    type: 'object',
                    properties: {
                        job_id: { type: 'string' }
                    },
                    required: ['job_id']
                }
            },
            {
                name: 'job_apply_execute',
                description: 'Execute job application via browser agent with user approval flag',
                parameters: {
                    type: 'object',
                    properties: {
                        job_id: { type: 'string' },
                        approved: { type: 'boolean', description: 'Explicit user approval flag' }
                    },
                    required: ['job_id', 'approved']
                }
            }
        ];
    }

    async handleToolCall(toolName, args = {}) {
        logger.log('mcp_tool_call', `Executing MCP tool: ${toolName}`, args);

        switch (toolName) {
            case 'browser_open': {
                const sessionName = args.session || 'main';
                const session = await browserManager.openSession(sessionName, { headed: args.headed });
                return { success: true, session: sessionName, profileDir: session.profileDir };
            }
            case 'browser_close': {
                const sessionName = args.session || 'main';
                await browserManager.closeSession(sessionName);
                return { success: true, message: `Session ${sessionName} closed.` };
            }
            case 'browser_navigate': {
                const sessionName = args.session || 'main';
                await browserManager.navigate(sessionName, args.url);
                return { success: true, url: args.url };
            }
            case 'browser_screenshot': {
                const sessionName = args.session || 'main';
                const buf = await browserManager.captureScreenshot(sessionName);
                return { success: true, bytes: buf.length };
            }
            case 'job_search': {
                const results = await jobService.searchAndCollectJobs(args);
                return { success: true, results };
            }
            case 'job_match': {
                const match = await matcherService.evaluateJob(args.job_id);
                return { success: true, match };
            }
            case 'job_apply_prepare': {
                const prep = await applicationService.prepareApplication(args.job_id);
                return { success: true, preparation: prep };
            }
            case 'job_apply_execute': {
                const result = await applicationService.executeApplication(args.job_id, { approved: args.approved });
                return { success: true, result };
            }
            default:
                throw new Error(`Unknown tool name: ${toolName}`);
        }
    }
}

const mcpBridge = new AihawkMcpBridge();
module.exports = {
    AihawkMcpBridge,
    mcpBridge
};
