// api.js — HTTP client for agent control endpoints.
import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

export const getStatus = () => api.get('/agent/status').then((r) => r.data)
export const startAgent = (goal, maxSteps = 12) =>
  api.post('/agent/start', { goal, maxSteps }).then((r) => r.data)
export const stopAgent = () => api.post('/agent/stop').then((r) => r.data)
export const resetBrowser = () => api.post('/agent/reset-browser').then((r) => r.data)

// noVNC is served by the Docker container; in dev the Vite proxy forwards
// /vnc -> http://localhost:6080. Interactive (mouse + keyboard) mode is on.
export const VNC_URL =
  '/vnc/vnc.html?autoconnect=true&resize=scale&reconnect=true&path=/vnc/websockify'

export default api
