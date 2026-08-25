// agentService.js — single in-process agent lifecycle for the web UI.
// Keeps one AgentRunner at a time and forwards its structured events through
// an onEvent callback (the server relays them over Socket.IO).

const { AgentRunner } = require('./AgentRunner');
const logger = require('../utils/logger');
const { closeBrowser } = require('../browser/BrowserManager');

let activeRunner = null;
let activeGoal = '';
let runPromise = null;
let eventSink = null;
let status = {
    running: false,
    goal: '',
    step: 0,
    maxSteps: 12,
    url: '',
    title: '',
    lastError: '',
};

function setEventSink(fn) {
    eventSink = typeof fn === 'function' ? fn : null;
}

function emit(type, payload = {}) {
    if (eventSink) {
        try {
            eventSink({ type, ts: Date.now(), ...payload });
        } catch (e) {
            // never let a UI sink break the agent
        }
    }
}

function getStatus() {
    return { ...status, goal: activeGoal };
}

function isRunning() {
    return !!activeRunner && status.running;
}

async function start(goal, options = {}) {
    if (isRunning()) {
        const err = new Error('An agent task is already running');
        err.code = 'ALREADY_RUNNING';
        throw err;
    }

    if (!goal || !goal.trim()) {
        throw new Error('Goal cannot be empty');
    }

    activeGoal = goal.trim();
    status = {
        running: true,
        goal: activeGoal,
        step: 0,
        maxSteps: options.maxSteps || 12,
        url: '',
        title: '',
        lastError: '',
    };

    activeRunner = new AgentRunner({ maxSteps: options.maxSteps });

    // Relay structured agent events.
    const onEvent = (evt) => {
        switch (evt.type) {
            case 'run_started':
                status.maxSteps = evt.maxSteps;
                break;
            case 'step':
                status.step = evt.step;
                status.url = evt.url || '';
                status.title = evt.title || '';
                break;
            case 'thought':
                status.step = evt.step || status.step;
                break;
            case 'error':
                status.lastError = evt.message || '';
                break;
            case 'run_finished':
                status.running = false;
                status.step = evt.stepCount;
                break;
            default:
                break;
        }
        emit('agent_event', evt);
        emit('status', getStatus());
    };

    emit('status', getStatus());

    runPromise = (async () => {
        try {
            const result = await activeRunner.run(activeGoal, {
                ...options,
                onEvent,
            });
            status.running = false;
            emit('run_finished', {
                success: result.status === 'completed',
                status: result.status,
                result: result.result || result.error || '',
                steps: result.stepCount,
            });
            return result;
        } catch (err) {
            status.running = false;
            status.lastError = err.message;
            emit('run_finished', { success: false, status: 'failed', result: err.message });
            throw err;
        } finally {
            activeRunner = null;
            emit('status', getStatus());
        }
    })();

    return getStatus();
}

function stop() {
    if (activeRunner) {
        try {
            activeRunner.abort();
        } catch (e) {
            logger.warn(`Could not abort agent cleanly: ${e.message}`);
        }
        return true;
    }
    return false;
}

async function resetBrowser() {
    await closeBrowser().catch(() => {});
    emit('status', getStatus());
}

module.exports = {
    start,
    stop,
    isRunning,
    getStatus,
    setEventSink,
    resetBrowser,
};
