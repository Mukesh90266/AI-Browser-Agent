// App.jsx — clean SaaS dark dashboard per the mockup.
import { AgentProvider } from './hooks/useAgent'
import StatusBar from './components/StatusBar'
import GoalInput from './components/GoalInput'
import BrowserView from './components/BrowserView'
import ActionLog from './components/ActionLog'
import { Globe } from './components/Icons'
import './App.css'

export default function App() {
  return (
    <AgentProvider>
      <div className="app">
        <nav className="topbar">
          <div className="topbar-left">
            <Globe width={15} height={15} />
            <span className="topbar-title">AI Browser Agent</span>
          </div>
          <div className="topbar-center" />
          <StatusBar />
        </nav>

        <div className="task-wrap">
          <GoalInput />
        </div>

        <main className="content">
          <section className="browser-col">
            <BrowserView />
          </section>
          <aside className="log-col">
            <ActionLog />
          </aside>
        </main>
      </div>
    </AgentProvider>
  )
}
