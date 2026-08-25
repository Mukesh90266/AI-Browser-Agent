// ActionLog.jsx — live, auto-scrolling timeline of the agent's thoughts/actions.
import { useEffect, useRef } from 'react'
import useAgent from '../hooks/useAgent'

function formatTime(ts) {
  try {
    if (ts == null) return ''
    // Backend logger sends ISO timestamp; agent events send epoch ms.
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

export default function ActionLog({ collapsed = false }) {
  const { logs } = useAgent()
  const endRef = useRef(null)

  useEffect(() => {
    if (collapsed) return
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [logs, collapsed])

  return (
    <div className={`action-log ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="action-log-head">
        <span>Agent activity</span>
        <span className="muted">{logs.length} events</span>
      </div>
      <div className="action-log-body">
        {logs.length === 0 && (
          <div className="action-log-empty muted">
            Task start karo — yahan agent ki soch aur actions live dikhenge.
          </div>
        )}
        {logs.map((log) => (
          <div key={log.id} className={`log-line ${log.kind || ''}`}>
            <span className="log-icon">{log.icon || '•'}</span>
            <div className="log-content">
              <span className="log-text">{log.text}</span>
              <span className="log-time">{formatTime(log.ts)}</span>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}
