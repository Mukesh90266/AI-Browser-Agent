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
need socat

# CDP: newer Chromium builds ignore --remote-debugging-address and only bind
# 127.0.0.1, which Docker's port mapping cannot reach. Run Chrome on an
# internal 127.0.0.1:9223 and use socat to expose it on 0.0.0.0:9222.
CDP_INTERNAL_PORT=9223
CDP_PUBLIC_PORT=9222

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
# A previous Chromium/Xvfb child can survive briefly while Docker restarts the
# container. Remove only stale display bookkeeping; never start Chromium before
# a working X server is confirmed.
export DISPLAY
DISPLAY_NUM="${DISPLAY#:}"
LOCK_FILE="/tmp/.X${DISPLAY_NUM}-lock"
X_RUNNING=0
if [ -f "$LOCK_FILE" ]; then
    LOCK_PID="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [ -z "$LOCK_PID" ] || ! kill -0 "$LOCK_PID" 2>/dev/null; then
        log "Removing stale X lock: $LOCK_FILE"
        rm -f "$LOCK_FILE" "/tmp/.X11-unix/X${DISPLAY_NUM}"
    else
        log "Xvfb already running on $DISPLAY (pid $LOCK_PID); reusing it"
        X_RUNNING=1
    fi
fi

if [ "$X_RUNNING" -eq 0 ]; then
    log "Starting Xvfb on $DISPLAY (${SCREEN_WIDTH}x${SCREEN_HEIGHT})"
    Xvfb "$DISPLAY" -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24" -ac +extension GLX +render -noreset &
fi

# Wait until the display socket exists before starting openbox/Chrome.
for _ in $(seq 1 30); do
    if [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then break; fi
    sleep 0.2
done
if [ ! -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
    log "ERROR: Xvfb did not become ready on $DISPLAY"
    exit 1
fi
sleep 0.5

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

# 5. Socat: expose Chrome's loopback CDP on all interfaces so the host can
#    reach it through Docker's 9222 port mapping.
log "Forwarding 0.0.0.0:${CDP_PUBLIC_PORT} -> 127.0.0.1:${CDP_INTERNAL_PORT} for CDP"
socat TCP-LISTEN:${CDP_PUBLIC_PORT},fork,bind=0.0.0.0,reuseaddr TCP:127.0.0.1:${CDP_INTERNAL_PORT} &
sleep 0.5

# 6. Chromium with the DevTools endpoint on the internal loopback port.
#    --no-sandbox is required when running as root inside the container.
log "Launching Chromium with CDP on 127.0.0.1:${CDP_INTERNAL_PORT}"
exec "$CHROME_BIN" \
    --no-sandbox \
    --disable-setuid-sandbox \
    --disable-dev-shm-usage \
    --disable-blink-features=AutomationControlled \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=${CDP_INTERNAL_PORT} \
    --window-size="${SCREEN_WIDTH},${SCREEN_HEIGHT}" \
    --start-maximized \
    --no-first-run \
    --no-default-browser-check \
    --lang=en-US \
    "about:blank"
