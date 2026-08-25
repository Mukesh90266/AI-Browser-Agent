// StatusBar.jsx — current agent status, step counter, active URL.
import useAgent from '../hooks/useAgent'

export default function StatusBar() {
  const { status, connected, resetView } = useAgent()
  const running = !!status?.running
  const step = status?.step || 0
  const max = status?.maxSteps || 12
  const url = status?.url || ''
  const title = status?.title || ''

  return (
    <div className="status-bar">
      <div className={`status-dot ${running ? 'running' : 'idle'}`} title={connected ? 'socket connected' : 'socket disconnected'} />
      <span className="status-label">{running ? 'Running' : 'Idle'}</span>
      <span className="status-steps">
        Step <strong>{step}</strong>/{max}
      </span>
      <div className="status-url" title={url}>
        {title ? <span className="status-title">{title}</span> : null}
        {url ? <span className="status-href">{url}</span> : <span className="muted">about:blank</span>}
      </div>
      <button className="btn tiny ghost" onClick={resetView} title="Disconnect from the browser (it will relaunch on the next task)">
        ⟳ Reset browser
      </button>
    </div>
  )
}
