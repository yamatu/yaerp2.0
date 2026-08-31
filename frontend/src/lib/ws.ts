import type { WSMessage } from '@/types'
import { getAccessToken } from './auth'

type MessageHandler = (msg: WSMessage) => void

const MAX_PENDING_MESSAGES = 100
const MAX_PENDING_BYTES = 4 * 1024 * 1024

class WSClient {
  private ws: WebSocket | null = null
  private handlers: Map<string, Set<MessageHandler>> = new Map()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private pendingMessages: string[] = []
  private pendingBytes = 0
  private joinedSheetId: number | null = null
  private shouldReconnect = true

  private getWSUrl() {
    if (typeof window === 'undefined') {
      return process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost/ws'
    }

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const configuredUrl = process.env.NEXT_PUBLIC_WS_URL

    if (!configuredUrl) {
      return `${wsProtocol}//${window.location.host}/ws`
    }

    if (configuredUrl.startsWith('ws://') || configuredUrl.startsWith('wss://')) {
      return configuredUrl
    }

    return `${wsProtocol}//${window.location.host}${configuredUrl}`
  }

  connect() {
    this.shouldReconnect = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    const token = getAccessToken()
    if (!token) return

    const socket = new WebSocket(`${this.getWSUrl()}?token=${token}`)
    this.ws = socket

    socket.onopen = () => {
      // A stale socket can finish opening after a newer connection replaced
      // it. Ignore that event so it cannot drain messages into the wrong
      // connection.
      if (this.ws !== socket) return
      this.reconnectAttempts = 0
      console.log('WebSocket connected')

      const pending = this.pendingMessages
      this.pendingMessages = []
      this.pendingBytes = 0
      for (const message of pending) {
        if (socket.readyState !== WebSocket.OPEN) {
          this.enqueue(message)
          break
        }
        socket.send(message)
      }

      const hadPendingJoin = pending.some((message) => this.isJoinMessage(message))
      if (!hadPendingJoin && this.joinedSheetId !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'join_sheet', sheetId: this.joinedSheetId }))
      }
    }

    socket.onmessage = (event) => {
      if (this.ws !== socket) return
      try {
        const msg: WSMessage = JSON.parse(event.data)
        const typeHandlers = this.handlers.get(msg.type)
        if (typeHandlers) {
          typeHandlers.forEach((handler) => handler(msg))
        }
        const allHandlers = this.handlers.get('*')
        if (allHandlers) {
          allHandlers.forEach((handler) => handler(msg))
        }
      } catch (e) {
        console.error('Failed to parse WS message:', e)
      }
    }

    socket.onclose = () => {
      if (this.ws !== socket) return
      this.ws = null
      console.log('WebSocket disconnected')
      if (this.shouldReconnect) this.attemptReconnect()
    }

    socket.onerror = (error) => {
      if (this.ws === socket) console.error('WebSocket error:', error)
    }
  }

  private attemptReconnect() {
    if (!this.shouldReconnect || !getAccessToken()) return
    if (this.reconnectTimer || this.reconnectAttempts >= this.maxReconnectAttempts) return
    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  disconnect() {
    this.shouldReconnect = false
    this.reconnectAttempts = 0
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.pendingMessages = []
    this.pendingBytes = 0
    this.joinedSheetId = null

    const socket = this.ws
    this.ws = null
    if (socket) {
      // Clearing callbacks prevents an intentional close from scheduling a
      // reconnect and releases closures captured by the old WebSocket.
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close()
    }
  }

  send(msg: WSMessage) {
    const payload = JSON.stringify(msg)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload)
      return
    }

    if (!getAccessToken()) return
    this.enqueue(payload)
    this.connect()
  }

  joinSheet(sheetId: number) {
    if (!sheetId) return
    if (this.joinedSheetId === sheetId && this.ws?.readyState === WebSocket.OPEN) {
      return
    }
    this.joinedSheetId = sheetId
    this.removePendingJoins()
    this.send({ type: 'join_sheet', sheetId })
  }

  leaveSheet(sheetId: number) {
    if (this.joinedSheetId !== sheetId) return
    this.joinedSheetId = null
    this.removePendingJoins()
  }

  sendCellUpdate(sheetId: number, row: number, col: string, value: unknown) {
    this.send({ type: 'cell_update', sheetId, row, col, value })
  }

  sendBatchUpdate(changes: WSMessage['changes']) {
    this.send({ type: 'batch_update', sheetId: changes?.[0]?.sheet_id, changes })
  }

  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)
    return () => {
      const handlers = this.handlers.get(type)
      handlers?.delete(handler)
      if (handlers && handlers.size === 0) this.handlers.delete(type)
    }
  }

  off(type: string, handler: MessageHandler) {
    const handlers = this.handlers.get(type)
    handlers?.delete(handler)
    if (handlers && handlers.size === 0) this.handlers.delete(type)
  }

  private isJoinMessage(message: string) {
    return message.includes('"type":"join_sheet"')
  }

  private removePendingJoins() {
    if (this.pendingMessages.length === 0) return
    this.pendingMessages = this.pendingMessages.filter((message) => !this.isJoinMessage(message))
    this.pendingBytes = this.pendingMessages.reduce((total, message) => total + message.length, 0)
  }

  private enqueue(payload: string) {
    if (payload.length > MAX_PENDING_BYTES) return
    this.pendingMessages.push(payload)
    this.pendingBytes += payload.length

    while (this.pendingMessages.length > MAX_PENDING_MESSAGES || this.pendingBytes > MAX_PENDING_BYTES) {
      // Preserve the most recent join request; discard the oldest data update
      // first so an outage cannot grow the queue without bound.
      let index = this.pendingMessages.findIndex((message) => !this.isJoinMessage(message))
      if (index < 0) index = 0
      const [removed] = this.pendingMessages.splice(index, 1)
      this.pendingBytes -= removed.length
    }
  }
}

export const wsClient = new WSClient()
