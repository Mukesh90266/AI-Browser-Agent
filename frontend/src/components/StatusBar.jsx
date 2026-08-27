// StatusBar.jsx — top bar: step pill, running/idle status, reset.
import useAgent from '../hooks/useAgent'
import { Refresh } from './Icons'

export default function StatusBar() {
  const { status, resetView } = useAgent()
  const running = !!status?.running
  const step = status?.step || 0
  const max = status?.maxSteps || 12

  return (
    <div className="topbar-right">
      <span className="step-pill">Step {step} / {max}</span>
      <span className={`status-pill ${running ? 'on' : 'off'}`}>
        <span className="status-dot" />
        {running ? 'Running' : 'Idle'}
      </span>
      <button type="button" className="reset-btn" onClick={resetView} title="Reset browser">
        <Refresh width={13} height={13} />
        Reset
      </button>
    </div>
  )
}
