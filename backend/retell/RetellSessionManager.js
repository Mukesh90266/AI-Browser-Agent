// RetellSessionManager — Approach 1: one global browser, one active Retell call.
const sessions = new Map();
const MAX_IDLE_MS = 30 * 60 * 1000;

function createSession(callId) {
    if (!callId) throw new Error('call_id is required');
    const session = { callId, startedAt: Date.now(), lastActivity: Date.now(), active: true, running: false, currentCommand: '', lastResult: '' };
    sessions.set(callId, session);
    return session;
}
function getSession(callId) {
    const session = sessions.get(callId);
    if (!session || !session.active) return null;
    session.lastActivity = Date.now();
    return session;
}
function destroySession(callId) { if (callId) sessions.delete(callId); }
function cleanupStale() {
    const cutoff = Date.now() - MAX_IDLE_MS;
    for (const [id, session] of sessions) if (session.lastActivity < cutoff && !session.running) sessions.delete(id);
}
function hasActiveSession() { return [...sessions.values()].some((session) => session.active); }
function activeSession() { return [...sessions.values()].find((session) => session.active) || null; }
setInterval(cleanupStale, 5 * 60 * 1000).unref();
module.exports = { createSession, getSession, destroySession, cleanupStale, hasActiveSession, activeSession };
