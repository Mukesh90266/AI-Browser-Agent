// ActionLog.jsx — right panel: activity timeline + "Cart so far" result card.
import { useEffect, useRef } from 'react'
import useAgent from '../hooks/useAgent'
import {
  Activity, CheckCircle, XCircle, Alert, MousePointer, Search, Cart, Globe,
} from './Icons'

function formatTime(ts) {
  try {
    if (ts == null) return ''
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  } catch {
    return ''
  }
}

function Glyph({ name, tone }) {
  const color = {
    success: '#4ade80',
    error: '#f87171',
    warn: '#facc15',
  }[tone] || '#999999'
  const props = { width: 14, height: 14, style: { color } }
  switch (name) {
    case 'success': return <CheckCircle {...props} />
    case 'error': return <XCircle {...props} />
    case 'warn': return <Alert {...props} />
    case 'search': return <Search {...props} />
    case 'cart': return <Cart {...props} />
    case 'click': return <MousePointer {...props} />
    default: return <Globe {...props} />
  }
}

export default function ActionLog() {
  const { logs, cart } = useAgent()
  const endRef = useRef(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [logs])

  return (
    <div className="log-panel">
      <div className="log-head">
        <div className="log-head-title">
          <Activity width={13} height={13} />
          <span>Agent activity</span>
        </div>
        <span className="events-badge">{logs.length} events</span>
      </div>

      <div className="log-list">
        {logs.length === 0 && (
          <div className="log-empty">Events yahan aayenge…</div>
        )}

        {logs.map((log) => (
          <div key={log.id} className={`log-item tone-${log.kind || 'info'}`}>
            <span className="log-icon">
              <Glyph name={log.glyph} tone={log.kind} />
            </span>
            <div className="log-body">
              <span className="log-text">{log.text}</span>
            </div>
            <span className="log-time">{formatTime(log.ts)}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {cart.length > 0 && (
        <div className="cart-card">
          <div className="cart-head">
            <Cart width={14} height={14} />
            <span>Cart so far</span>
          </div>
          <div className="cart-rows">
            {cart.map((item, i) => (
              <div key={i} className="cart-row">
                <span className="cart-name">{item.title}</span>
                <span className={item.pending ? 'cart-price pending' : 'cart-price ok'}>
                  {item.pending ? 'pending…' : item.price ? `${item.price} ✅` : 'added ✅'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
