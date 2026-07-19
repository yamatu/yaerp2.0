import type { WSMessage } from '@/types'
import api from './api'
import { getRealtimeClientId } from './realtimeClient'

type MessageHandler = (msg: WSMessage) => void

class WSClient {
  private ws: WebSocket | null = null
  private handlers: Map<string, Set<MessageHandler>> = new Map()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private pendingMessages: string[] = []
  private joinedSheetId: number | null = null
  private connecting = false
  private shouldReconnect = false
  private connectionGeneration = 0

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
    void this.openConnection(this.connectionGeneration)
  }

  private async openConnection(generation: number) {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    if (this.connecting || !this.shouldReconnect || generation !== this.connectionGeneration) {
      return
    }

    this.connecting = true
    try {
      const ticketResponse = await api.post<{ ticket: string; expires_in: number }>('/auth/ws-ticket')
      const ticket = ticketResponse.code === 0 ? ticketResponse.data?.ticket : null
      if (!ticket) {
        throw new Error(ticketResponse.message || 'Failed to obtain WebSocket ticket')
      }
      if (!this.shouldReconnect || generation !== this.connectionGeneration) {
        return
      }

      const wsUrl = this.getWSUrl()
      const params = new URLSearchParams({ ticket })
      const clientId = getRealtimeClientId()
      if (clientId) {
        params.set('client_id', clientId)
      }

      const socket = new WebSocket(`${wsUrl}?${params.toString()}`)
      this.ws = socket

      socket.onopen = () => {
        if (this.ws !== socket) return
        this.reconnectAttempts = 0
        console.log('WebSocket connected')
        this.pendingMessages.forEach((message) => socket.send(message))
        const hadPendingMessages = this.pendingMessages.length > 0
        this.pendingMessages = []
        if (!hadPendingMessages && this.joinedSheetId !== null) {
          socket.send(JSON.stringify({ type: 'join_sheet', sheetId: this.joinedSheetId }))
        }
      }

      socket.onmessage = (event) => {
        String(event.data).split('\n').filter(Boolean).forEach((payload) => {
          try {
            const msg: WSMessage = JSON.parse(payload)
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
        })
      }

      socket.onclose = () => {
        if (this.ws === socket) {
          this.ws = null
        }
        console.log('WebSocket disconnected')
        this.attemptReconnect()
      }

      socket.onerror = (error) => {
        console.error('WebSocket error:', error)
      }
    } catch (error) {
      console.error('Failed to connect WebSocket:', error)
      this.attemptReconnect()
    } finally {
      this.connecting = false
      if (this.shouldReconnect && generation !== this.connectionGeneration) {
        void this.openConnection(this.connectionGeneration)
      }
    }
  }

  private attemptReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer || this.reconnectAttempts >= this.maxReconnectAttempts) return
    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.openConnection(this.connectionGeneration)
    }, delay)
  }

  disconnect() {
    this.shouldReconnect = false
    this.connectionGeneration++
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
    if (this.joinedSheetId === sheetId && this.ws?.readyState === WebSocket.OPEN) {
      return
    }
    this.joinedSheetId = sheetId
    this.pendingMessages = this.pendingMessages.filter((message) => !message.includes('"type":"join_sheet"'))
    this.send({ type: 'join_sheet', sheetId })
  }

  leaveSheet(sheetId?: number) {
    if (sheetId !== undefined && this.joinedSheetId !== sheetId) return
    const currentSheetId = this.joinedSheetId
    this.joinedSheetId = null
    this.pendingMessages = this.pendingMessages.filter((message) => !message.includes('"type":"join_sheet"'))
    if (currentSheetId !== null) {
      this.send({ type: 'leave_sheet', sheetId: currentSheetId })
    }
  }

  sendCellPresence(sheetId: number, state: 'viewing' | 'selected' | 'editing', row?: number, col?: string) {
    this.send({ type: 'cell_presence', sheetId, state, row, col })
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
