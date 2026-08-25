// GoalInput.jsx — task textarea with label, max steps, char counter, clear/start.
import { useState } from 'react'
import useAgent from '../hooks/useAgent'
import { Terminal, Play } from './Icons'

const MAX_CHARS = 300

export default function GoalInput() {
  const { status, start, stop, submitError } = useAgent()
  const [goal, setGoal] = useState('')
  const [steps, setSteps] = useState(12)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const running = status?.running || busy
  const step = status?.step || 0
  const max = status?.maxSteps || steps
  const progress = running ? Math.min(100, (step / max) * 100) : 0

  const handleStart = async (e) => {
    e.preventDefault()
    if (!goal.trim() || running) return
    setBusy(true)
    setError('')
    try {
      await start(goal.trim(), steps)
    } catch (err) {
      setError(submitError || err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleClear = () => {
    setGoal('')
    setError('')
  }

  return (
    <form className="task-box" onSubmit={handleStart}>
      <div className="task-label">
        <Terminal width={13} height={13} />
        <span>Task</span>
      </div>

      <textarea
        value={goal}
        maxLength={MAX_CHARS}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="e.g. Find Nike shoes and a football on Flipkart, tell me both prices, add both to cart"
        rows={3}
        disabled={running}
      />

      <div className="task-bottom">
        <div className="task-bottom-left">
          <span className="field-label">Max steps</span>
          <input
            type="number"
            min="1"
            max="50"
            value={steps}
            onChange={(e) => setSteps(Number(e.target.value))}
            disabled={running}
          />
          <span className="divider" />
          <span className="char-count">
            {goal.length} / {MAX_CHARS}
          </span>
        </div>

        <div className="task-bottom-right">
          <button type="button" className="btn-text" onClick={handleClear} disabled={running}>
            Clear
          </button>
          {running ? (
            <button type="button" className="btn-stop" onClick={stop}>
              ■ Stop
            </button>
          ) : (
            <button type="submit" className="btn-start" disabled={!goal.trim()}>
              <Play width={12} height={12} />
              Start
            </button>
          )}
        </div>
      </div>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>

      {error && <div className="task-error">{error}</div>}
    </form>
  )
}
