const EventEmitter = require('events');

class AihawkLogger extends EventEmitter {
    constructor() {
        super();
        this.memoryLogs = [];
        this.maxMemoryLogs = 200;
        this.dbSaver = null;
        this.activeStatus = {
            state: 'idle', // 'idle', 'initializing_browser', 'loading_profile', 'searching_jobs', 'extracting_job', 'evaluating_job', 'waiting_for_approval', 'preparing_application', 'applying', 'application_submitted', 'completed', 'failed'
            currentAction: 'System ready',
            jobId: null,
            company: null,
            timestamp: new Date().toISOString()
        };
    }

    setDbSaver(fn) {
        this.dbSaver = fn;
    }

    sanitize(data) {
        if (!data) return data;
        if (typeof data === 'string') {
            return data
                .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1[MASKED]')
                .replace(/(key=|apiKey=|token=|password=|secret=)[^\s&]+/gi, '$1[MASKED]');
        }
        if (typeof data === 'object') {
            try {
                const str = JSON.stringify(data, (key, value) => {
                    const lowerKey = key.toLowerCase();
                    if (lowerKey.includes('password') || lowerKey.includes('secret') || lowerKey.includes('token') || lowerKey.includes('cookie') || lowerKey.includes('apikey')) {
                        return '[MASKED]';
                    }
                    return value;
                });
                return JSON.parse(str);
            } catch (e) {
                return '[Unserializable Object]';
            }
        }
        return data;
    }

    setStatus(state, currentAction, extra = {}) {
        this.activeStatus = {
            state,
            currentAction,
            jobId: extra.jobId || null,
            company: extra.company || null,
            timestamp: new Date().toISOString()
        };
        this.emit('status_change', this.activeStatus);
    }

    log(eventType, message, details = {}, applicationId = null, jobId = null) {
        const sanitizedDetails = this.sanitize(details);
        const logEntry = {
            id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            eventType,
            message: this.sanitize(message),
            details: sanitizedDetails,
            applicationId,
            jobId,
            timestamp: new Date().toISOString()
        };

        this.memoryLogs.unshift(logEntry);
        if (this.memoryLogs.length > this.maxMemoryLogs) {
            this.memoryLogs.pop();
        }

        console.log(`[AIHawk:${eventType.toUpperCase()}] ${logEntry.message}`);

        this.emit('log', logEntry);

        if (this.dbSaver) {
            this.dbSaver(logEntry).catch(err => {
                console.warn('[AIHawk Logs] Could not persist log to DB:', err.message);
            });
        }

        return logEntry;
    }

    getRecentLogs(limit = 50) {
        return this.memoryLogs.slice(0, limit);
    }

    getStatus() {
        return this.activeStatus;
    }
}

const logger = new AihawkLogger();
module.exports = {
    AihawkLogger,
    logger
};
