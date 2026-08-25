// server.js — Express + Socket.IO server for the AI Browser Agent web UI.
//
// REST:   /api/agent/start | /stop | /status | /reset-browser
// Socket: relays logger output + structured agent events to the React UI.
//
// The CLI flow (test-llm-agent.js / runAgent) is completely independent and
// still works exactly as before — this server only wraps AgentRunner for the UI.

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { Server: SocketIOServer } = require('socket.io');
require('dotenv').config();

const logger = require('./utils/logger');
const agentService = require('./agent/agentService');
const agentRoutes = require('./routes/agentRoutes');
const { isBrowserOpen, resetBrowserState } = require('./browser/BrowserManager');

const PORT = parseInt(process.env.PORT, 10) || 3001;

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/api/agent', agentRoutes);

app.get('/api/health', (req, res) => {
    res.json({ ok: true, running: agentService.isRunning() });
});

// Serve the built React frontend in production (npm run build in frontend/).
const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get(/^\/(?!api|socket\.io).*/, (req, res) => {
        res.sendFile(path.join(frontendDist, 'index.html'));
    });
}

const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Broadcast every logger line (info/thought/action/error/success...) to the UI.
logger.subscribe((entry) => {
    io.emit('log', entry);
});

// Broadcast structured agent events + status changes.
agentService.setEventSink((evt) => {
    if (evt.type === 'agent_event') {
        io.emit('agent_event', evt);
    } else if (evt.type === 'status') {
        io.emit('status', evt);
    } else if (evt.type === 'run_finished') {
        io.emit('run_finished', evt);
    }
});

io.on('connection', (socket) => {
    logger.debug(`Socket connected: ${socket.id}`);
    socket.emit('status', agentService.getStatus());

    // If the UI (re)connects while no task is running and we're in Docker/noVNC
    // mode, clear any leftover page so the previous task's screen does not linger.
    if (!agentService.isRunning() && process.env.BROWSER_CDP_URL) {
        if (isBrowserOpen()) {
            resetBrowserState()
                .then(() => io.emit('status', agentService.getStatus()))
                .catch(() => {});
        }
    }

    socket.on('disconnect', () => {});
});

server.listen(PORT, () => {
    logger.info(`🌐 AI Browser Agent web server running on http://localhost:${PORT}`);
    if (process.env.BROWSER_CDP_URL) {
        logger.info(`   Docker/noVNC mode: ${process.env.BROWSER_CDP_URL} (noVNC at http://localhost:6080)`);
    } else {
        logger.info('   Local Chrome mode (set BROWSER_CDP_URL=http://localhost:9222 to use the Docker/noVNC browser)');
    }
});

// Keep the process alive on unhandled rejections (don't crash the whole server).
process.on('unhandledRejection', (reason) => {
    logger.warn(`Unhandled promise rejection: ${reason?.message || reason}`);
});
