// api.js — HTTP client for agent control endpoints.
import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

export const getStatus = () => api.get('/agent/status').then((r) => r.data)
export const startAgent = (goal, maxSteps = 12) =>
  api.post('/agent/start', { goal, maxSteps }).then((r) => r.data)
export const stopAgent = () => api.post('/agent/stop').then((r) => r.data)
export const resetBrowser = () => api.post('/agent/reset-browser').then((r) => r.data)
export const createRetellWebCall = () => api.post('/retell/create-web-call').then((r) => r.data)

// noVNC is served directly by the Docker container on port 6080. Point the
// iframe straight at it (instead of proxying websockets through Vite, which can
// hang on the ws handshake). Use the page's hostname so it also works when the
// UI is opened from another device on the LAN. Override with VITE_VNC_URL if
// the browser runs on a different host than Docker (e.g. VITE_VNC_URL=...).
const vncBase =
  import.meta.env.VITE_VNC_URL ||
  `${window.location.protocol}//${window.location.hostname}:6080`

// show_dot=false + no default drag/clip handle keeps the view edge-to-edge.
export const VNC_URL =
  `${vncBase}/vnc.html?autoconnect=true&resize=scale&reconnect=true` +
  `&show_dot=false&view_clip=false&path=websockify`

export default api
