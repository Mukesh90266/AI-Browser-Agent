// useAgent.js — global agent state (status + live action log) via Socket.IO.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import useSocket from './useSocket'
import { getStatus, startAgent, stopAgent, resetBrowser } from '../services/api'

const AgentContext = createContext(null)

const MAX_LOG = 400

function iconFor(log) {
  if (log.type === 'error') return '❌'
  if (log.type === 'success') return '✅'
  if (log.type === 'warn') return '⚠️'
  if (log.type === 'thought') return '🧠'
  if (log.type === 'action') return '⚡'
  if (log.type === 'step') return '🔹'
  if (log.type === 'pageData') return '📋'
  return 'ℹ️'
}

function flatten(evt) {
  // Turn a backend event into one or more simple log lines.
  const lines = []
  const base = { id: `${evt.type}-${evt.ts}-${Math.random().toString(36).slice(2, 7)}`, ts: evt.ts, type: evt.type, step: evt.step }

  switch (evt.type) {
    case 'thought':
      lines.push({ ...base, icon: '🧠', text: evt.text || evt.thought || '', kind: 'thought' })
      break
    case 'action':
      lines.push({ ...base, icon: '⚡', text: evt.detail || JSON.stringify(evt.raw || evt.action || ''), kind: 'action' })
      break
    case 'result':
      lines.push({
        ...base,
        icon: evt.success ? '✅' : '❌',
        text: evt.message || (evt.success ? 'Action completed' : 'Action failed'),
        kind: evt.success ? 'success' : 'error',
      })
      break
    case 'product':
      lines.push({ ...base, icon: '🛒', text: `${evt.title || 'Product'}${evt.price ? ` — ${evt.price}` : ''}`, kind: 'info' })
      break
    case 'step':
      lines.push({ ...base, icon: '🔹', text: evt.url || evt.title || `Step ${evt.step}`, kind: 'step' })
      break
    case 'error':
      lines.push({ ...base, icon: '❌', text: evt.message || evt.error || 'Error', kind: 'error' })
      break
    case 'aborted':
      lines.push({ ...base, icon: '⏹️', text: evt.message || 'Agent aborted', kind: 'warn' })
      break
    case 'info':
    case 'warn':
    case 'success':
      lines.push({ ...base, icon: iconFor(evt), text: evt.message || '', kind: evt.type })
      break
    case 'run_started':
      lines.push({ ...base, icon: '🚀', text: `Starting: ${evt.goal || ''}`, kind: 'info' })
      break
    case 'run_finished':
      lines.push({
        ...base,
        icon: evt.success ? '🎉' : (evt.status === 'stopped' ? '⏹️' : '🛑'),
        text: evt.result || `Run ${evt.status || 'finished'}`,
        kind: evt.success ? 'success' : 'warn',
      })
      break
    case 'pageData':
      // keep the live-data block compact in the UI log
      if (Array.isArray(evt.snippets)) {
        lines.push({
          ...base,
          icon: '📋',
          text: `Extracted ${evt.snippets.length} item(s) from ${evt.url ? new URL(evt.url).hostname : 'page'}`,
          kind: 'info',
        })
      }
      break
    default:
      break
  }
  return lines
}

export function AgentProvider({ children }) {
  const socket = useSocket()
  const [status, setStatus] = useState({
    running: false,
    goal: '',
    step: 0,
    maxSteps: 12,
    url: '',
    title: '',
    lastError: '',
  })
  const [logs, setLogs] = useState([])
  const [connected, setConnected] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const logsRef = useRef(logs)
  logsRef.current = logs

  const pushLogs = useCallback((entries) => {
    setLogs((prev) => [...prev, ...entries].slice(-MAX_LOG))
  }, [])

  useEffect(() => {
    const onConnect = () => setConnected(true)
    const onDisconnect = () => setConnected(false)
    const onStatus = (s) => setStatus((prev) => ({ ...prev, ...s }))
    const onLog = (entry) => pushLogs(flatten(entry))
    const onAgentEvent = (entry) => pushLogs(flatten(entry))
    const onRunFinished = (entry) => pushLogs(flatten({ type: 'run_finished', ...entry }))

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('status', onStatus)
    socket.on('log', onLog)
    socket.on('agent_event', onAgentEvent)
    socket.on('run_finished', onRunFinished)

    getStatus()
      .then((s) => setStatus((prev) => ({ ...prev, ...s })))
      .catch(() => {})

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('status', onStatus)
      socket.off('log', onLog)
      socket.off('agent_event', onAgentEvent)
      socket.off('run_finished', onRunFinished)
    }
  }, [socket, pushLogs])

  const start = useCallback(
    async (goal, maxSteps = 12) => {
      setSubmitError('')
      try {
        setLogs([])
        await startAgent(goal, maxSteps)
      } catch (err) {
        const msg = err?.response?.data?.error || err.message || 'Failed to start'
        setSubmitError(msg)
        throw err
      }
    },
    [],
  )

  const stop = useCallback(async () => {
    await stopAgent().catch(() => {})
  }, [])

  const resetView = useCallback(async () => {
    await resetBrowser().catch(() => {})
  }, [])

  const value = useMemo(
    () => ({ status, logs, connected, submitError, start, stop, resetView }),
    [status, logs, connected, submitError, start, stop, resetView],
  )

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export default function useAgent() {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent must be used within an AgentProvider')
  return ctx
}
