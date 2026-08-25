// useAgent.js — global agent state (status + live action log + cart) via Socket.IO.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import useSocket from './useSocket'
import { getStatus, startAgent, stopAgent, resetBrowser } from '../services/api'

const AgentContext = createContext(null)

const MAX_LOG = 400

// Map a raw backend event into display log lines with icon/kind/tone.
function flatten(evt) {
  const base = {
    id: `${evt.type}-${evt.ts}-${Math.random().toString(36).slice(2, 7)}`,
    ts: evt.timestamp || evt.ts,
    type: evt.type,
    step: evt.step,
  }

  switch (evt.type) {
    case 'thought':
      return [{ ...base, icon: '🧠', text: evt.text || evt.thought || '', kind: 'thought' }]

    case 'action': {
      const raw = evt.raw || {}
      // Map action types to a clean icon + message, like the mockup.
      if (raw.action === 'add_to_cart' || raw.action === 'click') {
        const isAdd = raw.action === 'add_to_cart' || /add/i.test(evt.detail || '')
        return [{
          ...base,
          icon: isAdd ? '🛒' : '🱂',
          glyph: isAdd ? 'cart' : 'click',
          text: evt.detail || (isAdd ? 'Adding to cart' : 'Clicked element'),
          kind: isAdd ? 'action' : 'info',
          _addCart: isAdd,
        }]
      }
      if (raw.action === 'type') {
        return [{ ...base, icon: '🔍', glyph: 'search', text: evt.detail || `Typed "${raw.text || ''}"`, kind: 'info' }]
      }
      if (raw.action === 'navigate') {
        return [{ ...base, icon: '🌐', glyph: 'click', text: evt.detail || `Navigated to ${raw.url || ''}`, kind: 'info' }]
      }
      if (raw.action === 'scroll') {
        return [{ ...base, icon: '⤓', glyph: 'click', text: evt.detail || `Scrolled ${raw.direction || 'down'}`, kind: 'info' }]
      }
      return [{ ...base, icon: '⚡', glyph: 'click', text: evt.detail || raw.action || 'Action', kind: 'info' }]
    }

    case 'result': {
      if (evt.cartVerified && evt.success) {
        return [{ ...base, icon: '✅', glyph: 'success', text: evt.message || 'Added to cart', kind: 'success', _cartVerified: true }]
      }
      if (!evt.success && /retr/i.test(evt.message || '')) {
        return [{ ...base, icon: '⛔', glyph: 'error', text: evt.message || 'Action failed', kind: 'error' }]
      }
      if (!evt.success) {
        return [{ ...base, icon: '⚠️', glyph: 'warn', text: evt.message || 'Action failed', kind: 'warn' }]
      }
      return [{ ...base, icon: '✅', glyph: 'success', text: evt.message || 'Done', kind: 'success' }]
    }

    case 'product':
      return [{ ...base, icon: '🛍️', glyph: 'click', text: `${evt.title || 'Product'}${evt.price ? ` — ${evt.price}` : ''}`, kind: 'info', _product: { title: evt.title, price: evt.price } }]

    case 'step':
      return [] // keep the timeline uncluttered; the header shows Step N

    case 'error':
      return [{ ...base, icon: '⛔', glyph: 'error', text: evt.message || evt.error || 'Error', kind: 'error' }]

    case 'aborted':
      return [{ ...base, icon: '⏹️', glyph: 'warn', text: evt.message || 'Agent aborted', kind: 'warn' }]

    case 'warn':
      return [{ ...base, icon: '⚠️', glyph: 'warn', text: evt.message || '', kind: 'warn' }]

    case 'success':
      return [{ ...base, icon: '✅', glyph: 'success', text: evt.message || '', kind: 'success' }]

    case 'info':
      return [{ ...base, icon: 'ℹ️', glyph: 'click', text: evt.message || '', kind: 'info' }]

    case 'run_started':
      return [{ ...base, icon: '🚀', glyph: 'click', text: `Started: ${evt.goal || ''}`, kind: 'info' }]

    case 'run_finished':
      return [{
        ...base,
        icon: evt.success ? '🎉' : (evt.status === 'stopped' ? '⏹️' : '🛑'),
        glyph: evt.success ? 'success' : 'warn',
        text: evt.result || `Run ${evt.status || 'finished'}`,
        kind: evt.success ? 'success' : 'warn',
      }]

    case 'pageData':
      return []

    default:
      return []
  }
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
  const [cart, setCart] = useState([]) // { title, price, pending }
  const [connected, setConnected] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const lastProductRef = useRef(null)
  const pendingCartRef = useRef(false)

  const pushLogs = useCallback((entries) => {
    if (!entries.length) return
    setLogs((prev) => [...prev, ...entries].slice(-MAX_LOG))

    // Update the "Cart so far" card from product/result events.
    for (const e of entries) {
      if (e._product) {
        lastProductRef.current = { title: e._product.title, price: e._product.price || '' }
      }
      if (e._addCart) {
        pendingCartRef.current = true
      }
      if (e._cartVerified) {
        const p = lastProductRef.current
        if (p?.title) {
          setCart((prev) => {
            if (prev.some((x) => x.title === p.title)) return prev
            return [...prev, { title: p.title, price: p.price || '', pending: false }]
          })
        }
        pendingCartRef.current = false
      }
    }
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
      setLogs([])
      setCart([])
      lastProductRef.current = null
      pendingCartRef.current = false
      try {
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
    setLogs([])
    setCart([])
    await resetBrowser().catch(() => {})
  }, [])

  const value = useMemo(
    () => ({ status, logs, cart, connected, submitError, start, stop, resetView }),
    [status, logs, cart, connected, submitError, start, stop, resetView],
  )

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
}

export default function useAgent() {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent must be used within an AgentProvider')
  return ctx
}
