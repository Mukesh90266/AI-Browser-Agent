// App.jsx — main layout: goal bar on top, live browser (large) on the left,
// agent activity log on the right (collapsible so the browser can go full-width).
import { useState } from 'react'
import { AgentProvider } from './hooks/useAgent'
import GoalInput from './components/GoalInput'
import StatusBar from './components/StatusBar'
import BrowserView from './components/BrowserView'
import ActionLog from './components/ActionLog'
import './App.css'

export default function App() {
  const [logCollapsed, setLogCollapsed] = useState(false)

  return (
    <AgentProvider>
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <span className="brand-logo">🌐</span>
            <div>
              <h1>AI Browser Agent</h1>
              <p>Task do, live browser chalta hua dekho</p>
            </div>
          </div>
          <StatusBar />
        </header>

        <section className="goal-section">
          <GoalInput />
        </section>

        <main className={`workspace ${logCollapsed ? 'log-collapsed' : ''}`}>
          <div className="workspace-browser">
            <BrowserView />
          </div>
          <aside className={`workspace-log ${logCollapsed ? 'is-collapsed' : ''}`}>
            <ActionLog collapsed={logCollapsed} />
            <button
              type="button"
              className="log-toggle"
              onClick={() => setLogCollapsed((v) => !v)}
              title={logCollapsed ? 'Show activity log' : 'Hide activity log'}
            >
              {logCollapsed ? '▶' : '◀'}
            </button>
          </aside>
        </main>
      </div>
    </AgentProvider>
  )
}
