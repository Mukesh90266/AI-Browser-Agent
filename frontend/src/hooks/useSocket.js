// useSocket.js — single Socket.IO connection shared across the app.
import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'

let sharedSocket = null

function getSocket() {
  if (!sharedSocket) {
    sharedSocket = io({
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
    })
  }
  return sharedSocket
}

export default function useSocket() {
  const socketRef = useRef(null)
  if (!socketRef.current) socketRef.current = getSocket()
  useEffect(() => {
    return () => {
      // Keep the shared socket alive between renders; do not disconnect here.
    }
  }, [])
  return socketRef.current
}
