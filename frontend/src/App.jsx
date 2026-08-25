// App.jsx — main layout: goal bar on top, live browser on the left,
// agent activity log on the right.
import { AgentProvider } from './hooks/useAgent'
import GoalInput from './components/GoalInput'
import StatusBar from './components/StatusBar'
import BrowserView from './components/BrowserView'
import ActionLog from './components/ActionLog'
import './App.css'

export default function App() {
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

        <main className="workspace">
          <div className="workspace-browser">
            <BrowserView />
          </div>
          <aside className="workspace-log">
            <ActionLog />
          </aside>
        </main>
      </div>
    </AgentProvider>
  )
}
