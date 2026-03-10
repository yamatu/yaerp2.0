import type { WSMessage } from '@/types'
import { getAccessToken } from './auth'

type MessageHandler = (msg: WSMessage) => void

class WSClient {
  private ws: WebSocket | null = null
  private handlers: Map<string, Set<MessageHandler>> = new Map()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private pendingMessages: string[] = []

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
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    const token = getAccessToken()
    if (!token) return

    const wsUrl = this.getWSUrl()
    this.ws = new WebSocket(`${wsUrl}?token=${token}`)

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      console.log('WebSocket connected')
      this.pendingMessages.forEach((message) => this.ws?.send(message))
      this.pendingMessages = []
    }

    this.ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data)
        const typeHandlers = this.handlers.get(msg.type)
        if (typeHandlers) {
          typeHandlers.forEach((handler) => handler(msg))
        }
        // Also notify wildcard handlers
        const allHandlers = this.handlers.get('*')
        if (allHandlers) {
          allHandlers.forEach((handler) => handler(msg))
        }
      } catch (e) {
        console.error('Failed to parse WS message:', e)
      }
    }

    this.ws.onclose = () => {
      console.log('WebSocket disconnected')
      this.attemptReconnect()
    }

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error)
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return
    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  send(msg: WSMessage) {
    const payload = JSON.stringify(msg)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload)
      return
    }

    this.pendingMessages.push(payload)
  }

  joinSheet(sheetId: number) {
    this.send({ type: 'join_sheet', sheetId })
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
      this.handlers.get(type)?.delete(handler)
    }
  }

  off(type: string, handler: MessageHandler) {
    this.handlers.get(type)?.delete(handler)
  }
}

export const wsClient = new WSClient()
