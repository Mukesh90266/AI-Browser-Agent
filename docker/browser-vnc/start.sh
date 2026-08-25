#!/usr/bin/env bash
# start.sh — boots the virtual display, window manager, VNC + noVNC, then
# launches Chromium (Playwright's pinned build) with the CDP port open.

SCREEN_WIDTH="${SCREEN_WIDTH:-1280}"
SCREEN_HEIGHT="${SCREEN_HEIGHT:-720}"

log() { echo "[browser-vnc] $*"; }
need() {
    if ! command -v "$1" >/dev/null 2>&1; then
        log "ERROR: required binary '$1' not found in PATH"
        exit 127
    fi
}

need Xvfb
need x11vnc
need openbox

# Locate the Chromium bundled with this Playwright image version.
CHROME_BIN="$(find /ms-playwright -type f \( -name chrome -o -name chromium \) 2>/dev/null | head -n1)"
if [ -z "$CHROME_BIN" ]; then
    log "ERROR: Chromium binary not found under /ms-playwright"
    log "Contents of /ms-playwright:"
    ls -la /ms-playwright 2>/dev/null || true
    exit 1
fi
log "Using Chromium: $CHROME_BIN"

# 1. Virtual framebuffer
log "Starting Xvfb on $DISPLAY (${SCREEN_WIDTH}x${SCREEN_HEIGHT})"
Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -ac +extension GLX +render -noreset &
sleep 1.5

# 2. Window manager (maximizes Chrome via openbox-rc.xml)
log "Starting openbox"
openbox --sm-disable &
sleep 0.8

# 3. x11vnc (raw VNC on 5900, no password — local Docker only)
log "Starting x11vnc on :5900"
x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -bg -o /tmp/x11vnc.log
sleep 0.8

# 4. noVNC (web client on 6080)
if command -v websockify >/dev/null 2>&1 && [ -d /usr/share/novnc ]; then
    cp -n /usr/share/novnc/vnc.html /usr/share/novnc/index.html 2>/dev/null || true
    log "Starting noVNC/websockify on :6080"
    websockify --web=/usr/share/novnc 6080 localhost:5900 &
else
    log "WARNING: websockify or /usr/share/novnc missing; noVNC web client unavailable"
fi
sleep 0.8

# 5. Chromium with the DevTools endpoint Playwright connects to.
#    --no-sandbox is required when running as root inside the container.
log "Launching Chromium with CDP on 0.0.0.0:9222"
exec "$CHROME_BIN" \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --disable-blink-features=AutomationControlled \
    --remote-debugging-address=0.0.0.0 \
    --remote-debugging-port=9222 \
    --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}" \
    --start-maximized \
    --no-first-run \
    --no-default-browser-check \
    --lang=en-US \
    "about:blank"
