// agentRoutes.js — REST API for controlling the agent from the web UI.
const express = require('express');
const agentService = require('../agent/agentService');

const router = express.Router();

router.get('/status', (req, res) => {
    res.json(agentService.getStatus());
});

router.post('/start', async (req, res) => {
    try {
        const goal = (req.body?.goal || '').toString();
        const maxSteps = parseInt(req.body?.maxSteps, 10);
        const status = await agentService.start(goal, {
            maxSteps: Number.isInteger(maxSteps) && maxSteps > 0 ? maxSteps : undefined,
        });
        res.json({ success: true, status });
    } catch (err) {
        const code = err.code === 'ALREADY_RUNNING' ? 409 : 400;
        res.status(code).json({ success: false, error: err.message });
    }
});

router.post('/stop', (req, res) => {
    const stopped = agentService.stop();
    res.json({ success: true, stopped, status: agentService.getStatus() });
});

router.post('/reset-browser', async (req, res) => {
    await agentService.resetBrowser();
    res.json({ success: true, status: agentService.getStatus() });
});

module.exports = router;
