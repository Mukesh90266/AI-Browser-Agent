// sessionManager.js — in-process state shared by Retell status/context calls.
// The browser itself is currently a singleton; callId is retained so this can
// later be replaced with per-call sessions or Redis without changing routes.
let state = {
    callId: '',
    command: '',
    state: 'idle',
    currentAction: '',
    step: 0,
    maxSteps: 0,
    url: '',
    title: '',
    lastThought: '',
    lastResult: '',
    pageContext: null,
    updatedAt: null,
};

function update(patch = {}) {
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    return get();
}

function get() {
    return { ...state, pageContext: state.pageContext ? { ...state.pageContext } : null };
}

function reset() {
    state = {
        callId: '', command: '', state: 'idle', currentAction: '', step: 0,
        maxSteps: 0, url: '', title: '', lastThought: '', lastResult: '',
        pageContext: null, updatedAt: null,
    };
}

module.exports = { update, get, reset };
