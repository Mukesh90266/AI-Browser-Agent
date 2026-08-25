# browser-vnc Dockerfile
# Runs a real Chromium inside a virtual display (Xvfb), exposed through:
#   - 9222 : Chrome DevTools Protocol (Playwright connects here)
#   - 6080 : noVNC (interactive browser view in the frontend <iframe>)
#   - 5900 : raw VNC (optional)
# Playwright's pinned Chromium build is used so the host's Playwright version
# connects over CDP without version mismatch.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        openbox \
        novnc \
        websockify \
        python3-websockify \
        socat \
    && rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:99 \
    SCREEN_WIDTH=1280 \
    SCREEN_HEIGHT=720

COPY openbox-rc.xml /etc/xdg/openbox/rc.xml
COPY start.sh /opt/start.sh

# Strip any Windows CRLF line endings (in case git checked the script out
# with autocrlf=true) and make it executable. CRLF in the shebang would cause
# "/usr/bin/env bash\r: not found" -> exit 127 restart loop.
RUN sed -i 's/\r$//' /opt/start.sh \
    && chmod +x /opt/start.sh \
    && command -v Xvfb \
    && command -v x11vnc \
    && command -v openbox \
    && command -v websockify \
    && test -d /usr/share/novnc

EXPOSE 6080 9222 5900
CMD ["/opt/start.sh"]
