#!/usr/bin/env bash
# start.sh — boots the virtual display, window manager, VNC + noVNC, then
# launches Chromium (Playwright's pinned build) with the CDP port open.
set -e

SCREEN_WIDTH="${SCREEN_WIDTH:-1280}"
SCREEN_HEIGHT="${SCREEN_HEIGHT:-720}"

# Locate the Chromium bundled with this Playwright image version.
CHROME_BIN="$(find /ms-playwright -maxdepth 3 -type f \( -name chrome -o -name chromium \) 2>/dev/null | head -n1)"
if [ -z "$CHROME_BIN" ]; then
    echo "ERROR: Chromium binary not found under /ms-playwright" >&2
    exit 1
fi
echo "Using Chromium: $CHROME_BIN"

# 1. Virtual framebuffer
Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -ac +extension GLX +render -noreset &
sleep 1

# 2. Window manager (maximizes Chrome via openbox-rc.xml)
openbox &
sleep 0.5

# 3. x11vnc (raw VNC on 5900, no password — local Docker only)
x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -bg -o /tmp/x11vnc.log
sleep 0.5

# 4. noVNC (web client on 6080)
WEBSOCKIFY_OPTS=""
if [ -d /usr/share/novnc ]; then
    cp -n /usr/share/novnc/vnc.html /usr/share/novnc/index.html 2>/dev/null || true
    websockify --web=/usr/share/novnc 6080 localhost:5900 &
else
    echo "WARNING: /usr/share/novnc not found; noVNC web client unavailable" >&2
fi

# 5. Chromium with the DevTools endpoint Playwright connects to.
#    --no-sandbox is required when running as root inside the container.
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
