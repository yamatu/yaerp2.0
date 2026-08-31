import type { WSMessage } from '@/types'
import api from './api'
import { getRealtimeClientId } from './realtimeClient'

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
	if (this.reconnectTimer) {
	  clearTimeout(this.reconnectTimer)
	  this.reconnectTimer = null
	}
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
        const pending = this.pendingMessages
        this.pendingMessages = []
        this.pendingBytes = 0
        pending.forEach((message) => socket.send(message))
        const hadPendingJoin = pending.some((message) => this.isJoinMessage(message))
        if (!hadPendingJoin && this.joinedSheetId !== null) {
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
		if (this.ws !== socket) return
		this.ws = null
        console.log('WebSocket disconnected')
		if (this.shouldReconnect) this.attemptReconnect()
      }

      socket.onerror = (error) => {
		if (this.ws === socket) console.error('WebSocket error:', error)
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
	this.pendingMessages = []
	this.pendingBytes = 0
	this.joinedSheetId = null
	const socket = this.ws
	this.ws = null
	if (socket) {
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

	this.enqueue(payload)
	this.connect()
  }

  joinSheet(sheetId: number) {
    if (this.joinedSheetId === sheetId && this.ws?.readyState === WebSocket.OPEN) {
      return
    }
    this.joinedSheetId = sheetId
	this.removePendingJoins()
    this.send({ type: 'join_sheet', sheetId })
  }

  leaveSheet(sheetId?: number) {
    if (sheetId !== undefined && this.joinedSheetId !== sheetId) return
    const currentSheetId = this.joinedSheetId
    this.joinedSheetId = null
	this.removePendingJoins()
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
	  let index = this.pendingMessages.findIndex((message) => !this.isJoinMessage(message))
	  if (index < 0) index = 0
	  const [removed] = this.pendingMessages.splice(index, 1)
	  this.pendingBytes -= removed.length
	}
  }
}

export const wsClient = new WSClient()
