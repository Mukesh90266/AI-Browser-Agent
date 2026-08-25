# 🌐 AI Browser Agent

Autonomous AI browser agent (Node + Playwright) with a live web UI. Give it a task
in the browser and watch it drive a real Chromium — mouse movements, clicks and
all — through an interactive **noVNC** view, plus a live log of its thoughts/actions.

The original CLI flow still works exactly as before.

## Project layout

```
backend/          Node + Express + Socket.IO server + Playwright agent
  browser/        Playwright wrappers (stealth, DOM, actions, cart, popups)
  agent/          AgentRunner (Task 18/19 loop), LLM client, state
  llm/            LLM provider + action parser
  routes/         REST /api/agent/*
  server.js       HTTP + Socket.IO entry for the web UI
frontend/         React + Vite dashboard (Goal input, noVNC view, action log)
docker/           browser-vnc image (Xvfb + x11vnc + noVNC + Chromium/CDP)
docker-compose.yml
```

## Quick start (web UI with the interactive Docker browser)

Prerequisite: **Docker Desktop** running.

```bash
# 1. Start the virtual-display Chromium (noVNC on :6080, CDP on :9222)
docker compose up -d --build

# 2. Backend
cd backend
npm install
cp ../.env.example ../.env      # add your GROQ_API_KEY, then uncomment:
# BROWSER_CDP_URL=http://localhost:9222
npm run dev                     # http://localhost:3001

# 3. Frontend (another terminal)
cd frontend
npm install
npm run dev                     # http://localhost:5173
```

Open **http://localhost:5173**, type a task and press **Start**. The Dockerized
Chromium is shown live in the left panel (mouse + keyboard work), and the agent's
decisions stream into the right panel.

### What the Docker container exposes

| Port | Purpose |
|------|---------|
| 6080 | noVNC web client (embedded in the UI) |
| 9222 | Chrome DevTools Protocol (Playwright connects here) |
| 5900 | Raw VNC (optional, e.g. RealVNC viewer) |

When `BROWSER_CDP_URL` is set, `BrowserManager` attaches Playwright to that
Chromium via CDP instead of launching its own — so every action the agent takes is
visible (and interactive) in noVNC.

## Local Chrome (without Docker)

Don't set `BROWSER_CDP_URL`. The backend launches local Chromium exactly as before:

```bash
cd backend
npm run dev
```

The CLI is unchanged too:

```bash
node test-llm-agent.js "Find Nike shoes on Flipkart and add one to cart"
```

## REST / Socket API (for the frontend)

- `GET  /api/agent/status`          — `{ running, goal, step, maxSteps, url, ... }`
- `POST /api/agent/start`           — body `{ goal, maxSteps? }`
- `POST /api/agent/stop`            — abort the running task
- `POST /api/agent/reset-browser`   — disconnect/reset the CDP browser

Socket.IO events emitted: `status`, `log` (console lines), `agent_event`
(thought/action/result/product/error), `run_finished`.
