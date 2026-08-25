// GoalInput.jsx — task text box + Start/Stop controls.
import { useState } from 'react'
import useAgent from '../hooks/useAgent'

export default function GoalInput() {
  const { status, start, stop, submitError } = useAgent()
  const [goal, setGoal] = useState('')
  const [steps, setSteps] = useState(12)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const running = status?.running || busy

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

  const handleStop = async () => {
    await stop()
  }

  return (
    <form className="goal-input" onSubmit={handleStart}>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="Apna task yahan likho — e.g. Find Nike shoes and a kid tshirt on Flipkart, tell me both prices, add them to cart"
        rows={2}
        disabled={running}
      />
      <div className="goal-controls">
        <label className="steps">
          Max steps
          <input
            type="number"
            min="1"
            max="50"
            value={steps}
            onChange={(e) => setSteps(Number(e.target.value))}
            disabled={running}
          />
        </label>
        <div className="goal-buttons">
          {!running ? (
            <button type="submit" className="btn primary" disabled={!goal.trim()}>
              ▶ Start
            </button>
          ) : (
            <button type="button" className="btn stop" onClick={handleStop}>
              ⏹ Stop
            </button>
          )}
        </div>
      </div>
      {error && <div className="goal-error">{error}</div>}
    </form>
  )
}
