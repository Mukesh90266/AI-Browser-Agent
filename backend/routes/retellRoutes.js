// retellRoutes.js — Retell voice-agent bridge for the existing browser agent.
// Retell remains the voice/conversation layer; AgentRunner remains the browser
// automation layer. This route intentionally starts commands asynchronously so
// long Playwright tasks do not hold a Retell function request open.
const express = require('express');
const agentService = require('../agent/agentService');

const router = express.Router();
const recentCommands = new Map();
const DUPLICATE_WINDOW_MS = 60_000;

function parseRetellArgs(body = {}) {
    const args = body && typeof body.args === 'object' && body.args !== null
        ? body.args
        : body;
    return {
        ...args,
        command: (args.command || args.goal || '').toString().trim(),
        callId: body.call?.call_id || args.callId || args.call_id || 'unknown',
    };
}

function clampMaxSteps(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(50, Math.max(1, Math.trunc(parsed)));
}

function inferMaxSteps(command) {
    const text = command.toLowerCase();
    if (/\b(open|go to|navigate|visit)\b/.test(text)) return 5;
    if (/\b(search|find|look for|look up)\b/.test(text)) return 8;
    if (/\b(open|click|select)\b.*\b(product|item|first|second|grey|gray|black|white)\b/.test(text)) return 10;
    if (/\b(add|cart|quantity|qty|size|checkout|buy|order)\b/.test(text)) return 25;
    if (/\b(scroll|back|reload|refresh)\b/.test(text)) return 4;

    return clampMaxSteps(process.env.RETELL_DEFAULT_MAX_STEPS) || 8;
}

function buildRetellCommandGoal(command) {
    return [
        'Continue from the current browser page and browser session.',
        'This is a step-by-step voice command, not necessarily the full user task.',
        `User voice command: ${command}`,
        '',
        'Do only this immediate command unless small supporting actions are required.',
        'Use the current page context when the command refers to the current page.',
        'Do not reset the browser unless the user explicitly asks.',
        '',
        'Safety:',
        '- Never place an order.',
        '- Never make payment.',
        '- Never click Pay, Pay Now, Place Order, Confirm Order, Complete Order, or submit OTP.',
        '- Shopping tasks may add items to the cart or open the cart safely, then stop before payment or order placement.',
    ].join('\n');
}

function requireRetellSecret(req, res, next) {
    const expected = process.env.RETELL_WEBHOOK_SECRET;
    if (!expected) return next();

    const provided = req.get('x-retell-secret');
    if (provided !== expected) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized Retell request.',
        });
    }
    return next();
}

function pruneRecentCommands() {
    const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
    for (const [key, timestamp] of recentCommands.entries()) {
        if (timestamp < cutoff) recentCommands.delete(key);
    }
}

router.post('/create-web-call', async (req, res) => {
    const apiKey = process.env.RETELL_API_KEY;
    const agentId = process.env.RETELL_AGENT_ID;

    if (!apiKey || !agentId) {
        return res.status(503).json({ success: false, error: 'Retell is not configured' });
    }

    try {
        const response = await fetch('https://api.retellai.com/v2/create-web-call', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                agent_id: agentId,
                metadata: { source: 'ai-browser-agent' },
            }),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            return res.status(response.status >= 400 && response.status < 500 ? response.status : 502).json({
                success: false,
                error: payload.message || payload.error || 'Failed to create Retell web call',
            });
        }

        return res.json({
            success: true,
            accessToken: payload.access_token,
            callId: payload.call_id,
        });
    } catch (err) {
        return res.status(502).json({ success: false, error: `Retell request failed: ${err.message}` });
    }
});

router.post('/command', requireRetellSecret, async (req, res) => {
    const { command, callId } = parseRetellArgs(req.body);
    if (!command) {
        return res.status(400).json({ success: false, error: 'Command is required.' });
    }

    pruneRecentCommands();
    const commandKey = `${callId}:${command.toLowerCase()}`;
    if (recentCommands.has(commandKey)) {
        return res.json({
            success: true,
            duplicate: true,
            running: agentService.isRunning(),
            message: 'This command is already running or was just started.',
        });
    }

    if (agentService.isRunning()) {
        return res.status(409).json({
            success: false,
            running: true,
            message: 'Browser is already working. Please wait or say stop.',
        });
    }

    const requestedSteps = clampMaxSteps(req.body?.args?.maxSteps ?? req.body?.maxSteps);
    const maxSteps = requestedSteps || inferMaxSteps(command);
    const contextualGoal = buildRetellCommandGoal(command);
    recentCommands.set(commandKey, Date.now());

    try {
        const status = await agentService.start(contextualGoal, {
            maxSteps,
            source: 'retell',
            callId,
            preserveBrowser: true,
        });

        return res.json({
            success: true,
            running: true,
            message: `Started browser command: ${command}`,
            command,
            callId,
            maxSteps,
            status,
        });
    } catch (err) {
        recentCommands.delete(commandKey);
        const code = err.code === 'ALREADY_RUNNING' ? 409 : 400;
        return res.status(code).json({
            success: false,
            running: err.code === 'ALREADY_RUNNING',
            message: err.message,
        });
    }
});

router.get('/status', requireRetellSecret, (req, res) => {
    const status = agentService.getStatus();
    return res.json({
        success: true,
        running: status.running,
        state: status.running ? 'running' : (status.lastError ? 'failed' : 'idle'),
        message: status.lastError || (status.running ? 'Browser is working.' : 'No browser command is running.'),
        status,
    });
});

router.post('/stop', requireRetellSecret, (req, res) => {
    const stopped = agentService.stop();
    return res.json({
        success: true,
        stopped,
        status: agentService.getStatus(),
        message: stopped ? 'Browser agent stopped.' : 'No running browser agent.',
    });
});

module.exports = router;
