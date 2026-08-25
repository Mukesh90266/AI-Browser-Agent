// BrowserView.jsx — left panel: browser chrome + interactive noVNC viewport.
import { useState } from 'react'
import useAgent from '../hooks/useAgent'
import { VNC_URL } from '../services/api'
import { Monitor } from './Icons'

function shortenUrl(url) {
  if (!url || url === 'about:blank') return ''
  try {
    const u = new URL(url)
    const full = u.host.replace('www.', '') + u.pathname + u.search
    return full.length > 48 ? full.slice(0, 48) + '…' : full
  } catch {
    return url.slice(0, 48)
  }
}

export default function BrowserView() {
  const { status, connected } = useAgent()
  const [loaded, setLoaded] = useState(false)
  const url = status?.url || ''
  const host = shortenUrl(url)

  return (
    <div className="browser-panel">
      <div className="browser-bar">
        <div className="traffic-lights">
          <span className="tl red" />
          <span className="tl yellow" />
          <span className="tl green" />
        </div>
        <div className="url-pill">{host || 'about:blank'}</div>
      </div>

      <div className="browser-viewport">
        {!loaded && (
          <div className="browser-placeholder">
            <Monitor />
            <span>Live browser yahan dikhega</span>
          </div>
        )}
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
