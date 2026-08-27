// agentService.js — single in-process agent lifecycle for the web UI.
// Keeps one AgentRunner at a time and forwards its structured events through
// an onEvent callback (the server relays them over Socket.IO).

const { AgentRunner } = require('./AgentRunner');
const logger = require('../utils/logger');
const { closeBrowser, resetBrowserState, getPage } = require('../browser/BrowserManager');
const sessionManager = require('../retell/sessionManager');

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
        if (options.source === 'retell') {
            if (evt.type === 'run_started') sessionManager.update({ callId: options.callId || '', command: activeGoal, state: 'running', step: 0, maxSteps: evt.maxSteps });
            if (evt.type === 'step') sessionManager.update({ step: evt.step, maxSteps: evt.maxSteps, url: evt.url || '', title: evt.title || '', state: 'running' });
            if (evt.type === 'thought') sessionManager.update({ lastThought: evt.text || '', currentAction: evt.text || '' });
            if (evt.type === 'action') sessionManager.update({ currentAction: evt.detail || evt.action || '' });
            if (evt.type === 'result') sessionManager.update({ lastResult: evt.message || evt.error || '' });
            if (evt.type === 'page_context') sessionManager.update({ pageContext: evt.context, url: evt.context?.url || '', title: evt.context?.title || '', state: 'running' });
            if (evt.type === 'run_finished') sessionManager.update({ state: evt.status || (evt.success ? 'completed' : 'failed'), step: evt.stepCount || evt.steps || 0, currentAction: '', lastResult: evt.result || '' });
            if (evt.type === 'aborted') sessionManager.update({ state: 'stopped', currentAction: '', lastResult: evt.message || 'Browser agent stopped.' });
        }

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
            status.step = 0;
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
        // Flip the status immediately so the UI returns to Idle right away.
        // The run promise resolves on the next tick and finalizes step/result.
        status.running = false;
        status.lastError = status.lastError || '';
        emit('status', getStatus());
        return true;
    }
    return false;
}

async function resetBrowser() {
    // Close extra tabs and go back to about:blank without killing the
    // container's Chromium. Safe to call between tasks.
    await resetBrowserState().catch(() => {});
    try {
        const p = getPage();
        status.url = p && !p.isClosed() ? p.url() : 'about:blank';
        status.title = '';
        status.step = 0;
        status.running = false;
    } catch {}
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
