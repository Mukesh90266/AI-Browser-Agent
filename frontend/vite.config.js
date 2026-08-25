import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: proxy API + Socket.IO to the Node backend, and noVNC to the Docker
// container so the browser can embed it in an <iframe> without CORS issues.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
      '/vnc': {
        target: 'http://localhost:6080',
        ws: true,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/vnc/, ''),
      },
    },
  },
})
