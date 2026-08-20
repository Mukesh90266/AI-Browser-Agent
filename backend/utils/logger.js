// logger.js — Utility logger for backend operations, live element inspection, and data extraction tracking

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

let currentLevel = LOG_LEVELS.INFO;
const subscribers = [];

function setLogLevel(level) {
    if (typeof level === 'string') {
        currentLevel = LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.INFO;
    } else if (typeof level === 'number') {
        currentLevel = level;
    }
}

function subscribe(callback) {
    if (typeof callback === 'function') {
        subscribers.push(callback);
    }
}

function broadcast(type, data) {
    subscribers.forEach((cb) => {
        try {
            cb({ type, ...data, timestamp: new Date().toISOString() });
        } catch (e) {}
    });
}

function formatPrefix(step = null) {
    return step !== null ? `[Step ${step}]` : '[Agent]';
}

const logger = {
    info(msg, step = null) {
        if (currentLevel <= LOG_LEVELS.INFO) {
            console.log(`ℹ️  ${formatPrefix(step)} ${msg}`);
            broadcast('info', { message: msg, step });
        }
    },

    step(stepNum, maxSteps, title) {
        const header = `═`.repeat(60);
        console.log(`\n${header}\n  STEP ${stepNum}/${maxSteps}: ${title || ''}\n${header}`);
        broadcast('step', { step: stepNum, maxSteps, title });
    },

    thought(thoughtMsg, step = null) {
        if (thoughtMsg) {
            console.log(`🧠 ${formatPrefix(step)} Plan: "${thoughtMsg}"`);
            broadcast('thought', { thought: thoughtMsg, step });
        }
    },

    pageData(snippets, url = '', step = null) {
        if (!snippets || snippets.length === 0) return;
        const count = Math.min(snippets.length, 6);
        console.log(`\n📋 ${formatPrefix(step)} Live Data Extracted from Page (${url ? url.slice(0, 65) : 'Current View'}):`);
        for (let i = 0; i < count; i++) {
            console.log(`   ${i + 1}. ${snippets[i]}`);
        }
        if (snippets.length > count) {
            console.log(`   ... (+${snippets.length - count} more items extracted)`);
        }
        console.log('');
        broadcast('pageData', { snippets, url, step });
    },

    action(action, step = null) {
        console.log(`⚡ ${formatPrefix(step)} Executing Action: ${JSON.stringify(action)}`);
        broadcast('action', { action, step });
    },

    elementTarget(actionType, elementId, elementSummary, detail = '', step = null) {
        const icon = actionType === 'type' ? '⌨️' : (actionType === 'click' ? '🖱️' : '⚡');
        console.log(`${icon}  ${formatPrefix(step)} Target #${elementId}: ${elementSummary} ${detail ? `-> ${detail}` : ''}`);
    },

    success(msg, step = null) {
        console.log(`✅ ${formatPrefix(step)} ${msg}`);
        broadcast('success', { message: msg, step });
    },

    warn(msg, step = null) {
        if (currentLevel <= LOG_LEVELS.WARN) {
            console.log(`⚠️  ${formatPrefix(step)} ${msg}`);
            broadcast('warn', { message: msg, step });
        }
    },

    error(msg, error = null, step = null) {
        if (currentLevel <= LOG_LEVELS.ERROR) {
            console.error(`❌ ${formatPrefix(step)} ${msg}`, error ? `\n   ${error.stack || error}` : '');
            broadcast('error', { message: msg, error: error?.message, step });
        }
    },

    debug(msg, data = null) {
        if (currentLevel <= LOG_LEVELS.DEBUG) {
            console.log(`🔍 [Debug] ${msg}`, data ? JSON.stringify(data, null, 2) : '');
        }
    },

    setLogLevel,
    subscribe,
};

module.exports = logger;
