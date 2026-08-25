// BrowserView.jsx — interactive noVNC view of the Dockerized Chromium.
// The actual browser (with mouse movements/clicks) is shown inside an iframe
// pointing at the noVNC web client (proxied in dev by Vite).
import { useState } from 'react'
import useAgent from '../hooks/useAgent'
import { VNC_URL } from '../services/api'

export default function BrowserView() {
  const { status } = useAgent()
  const [loaded, setLoaded] = useState(false)
  const url = status?.url || ''
  const title = status?.title || ''

  return (
    <div className="browser-view">
      <div className="browser-chrome">
        <div className="browser-dots">
          <span />
          <span />
          <span />
        </div>
        <div className="browser-url" title={url}>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer">
              {url}
            </a>
          ) : (
            <span className="muted">about:blank</span>
          )}
        </div>
        <span className="browser-title">{title}</span>
      </div>
      <div className="vnc-frame-wrap">
        {!loaded && <div className="vnc-loading">Connecting to live browser…</div>}
        <iframe
          title="Live browser"
          src={VNC_URL}
          className="vnc-frame"
          onLoad={() => setLoaded(true)}
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </div>
  )
}
