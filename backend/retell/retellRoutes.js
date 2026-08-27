const express = require('express');
const { createSession, getSession, destroySession, activeSession } = require('./RetellSessionManager');
const { executeCommand } = require('./RetellCommandRunner');
const { resetBrowserState } = require('../browser/BrowserManager');
const router = express.Router();

router.post('/create-web-call', async (req, res) => {
    const { RETELL_API_KEY: apiKey, RETELL_AGENT_ID: agentId } = process.env;
    if (!apiKey || !agentId) return res.status(503).json({ success: false, error: 'Retell is not configured' });
    try {
        const response = await fetch('https://api.retellai.com/v2/create-web-call', {
            method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_id: agentId, metadata: { source: 'ai-browser-agent' } }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return res.status(502).json({ success: false, error: data.message || data.error || 'Failed to create Retell web call' });
        return res.json({ success: true, accessToken: data.access_token, callId: data.call_id });
    } catch (err) { return res.status(502).json({ success: false, error: `Retell request failed: ${err.message}` }); }
});

function secret(req, res, next) {
    const expected = process.env.RETELL_WEBHOOK_SECRET;
    if (expected && req.get('x-retell-secret') !== expected) return res.status(401).json({ success: false, message: 'Unauthorized Retell request.' });
    next();
}
function bodyArgs(body = {}) { const args = body.args || body; return { ...args, callId: body.call?.call_id || args.call_id || args.callId, command: String(args.command || args.goal || '').trim() }; }
function eventName(body = {}) { return body.event || body.event_type || body.type || body.call?.event || ''; }

router.post('/webhook', secret, async (req, res) => {
    const event = eventName(req.body);
    const callId = req.body?.call?.call_id || req.body?.call_id;
    if (event === 'call_started' && callId) {
        if (!activeSession()) createSession(callId);
        return res.json({ success: true, event, callId });
    }
    if (event === 'call_ended' && callId) {
        destroySession(callId);
        return res.json({ success: true, event, callId });
    }
    return res.json({ success: true, ignored: true, event });
});

router.post('/command', secret, async (req, res) => {
    const { callId, command, maxSteps } = bodyArgs(req.body);
    if (!callId || !command) return res.status(400).json({ success: false, message: 'call_id and command are required.' });
    const session = getSession(callId);
    if (!session) return res.status(409).json({ success: false, message: 'Browser session is not active. Please start a new call.' });
    const other = activeSession();
    if ((other && other.callId !== callId) || session.running) return res.status(409).json({ success: false, running: true, message: 'Browser is already working. Please wait or say stop.' });
    try {
        const result = await executeCommand(session, command, { maxActions: Math.min(6, Math.max(1, Number(maxSteps) || 6)) });
        session.lastResult = result.result;
        return res.json({ success: true, callId, ...result });
    } catch (err) { return res.status(502).json({ success: false, callId, message: err.message }); }
});

router.get('/status', secret, (req, res) => {
    const session = req.query.call_id ? getSession(req.query.call_id) : activeSession();
    return res.json({ success: true, running: !!session?.running, state: session?.running ? 'running' : 'idle', session: session || null });
});
router.post('/stop', secret, async (req, res) => {
    // The isolated Retell runner currently completes commands synchronously;
    // this endpoint releases the active command/session state for cancellation.
    const session = activeSession();
    if (session) session.running = false;
    return res.json({ success: true, stopped: !!session, message: session ? 'Browser agent stopped.' : 'No running browser agent.' });
});
module.exports = router;
