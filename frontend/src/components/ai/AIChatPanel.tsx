'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Trash2, X, Send, Loader2, GripVertical } from 'lucide-react'
import api from '@/lib/api'
import { getStoredUser } from '@/lib/auth'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface AIChatPanelProps {
  open: boolean
  onClose: () => void
}

export default function AIChatPanel({ open, onClose }: AIChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [inputValue, setInputValue] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const historyReadyRef = useRef(false)
  const userId = getStoredUser()?.id ?? 0
  const storageKey = userId ? `yaerp_ai_chat_history_${userId}` : 'yaerp_ai_chat_history_guest'

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    if (open && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [open])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) {
        setMessages([])
        historyReadyRef.current = true
        return
      }
      const parsed = JSON.parse(raw) as Message[]
      setMessages(Array.isArray(parsed) ? parsed : [])
    } catch {
      setMessages([])
    } finally {
      historyReadyRef.current = true
    }
  }, [storageKey])

  useEffect(() => {
    if (typeof window === 'undefined' || !historyReadyRef.current) return
    localStorage.setItem(storageKey, JSON.stringify(messages))
  }, [messages, storageKey])

  const handleSend = async () => {
    const trimmed = inputValue.trim()
    if (!trimmed || loading) return

    const userMessage: Message = { role: 'user', content: trimmed }
    const updatedMessages = [...messages, userMessage]
    setMessages(updatedMessages)
    setInputValue('')
    setLoading(true)

    try {
      const res = await api.post<{ reply: string }>('/ai/chat', { messages: updatedMessages })
      const assistantMessage: Message = {
        role: 'assistant',
        content: res.data?.reply ?? '',
      }
      setMessages((prev) => [...prev, assistantMessage])
    } catch {
      const errorMessage: Message = {
        role: 'assistant',
        content: '抱歉，请求失败，请稍后重试。',
      }
      setMessages((prev) => [...prev, errorMessage])
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Handle text drop into the input area
  const handleDrop = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    const text = e.dataTransfer.getData('text/plain')
    if (text) {
      setInputValue((prev) => prev ? `${prev}\n${text}` : text)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleClearHistory = () => {
    if (!window.confirm('确定要清空当前账号的 AI 对话记录吗？')) return
    setMessages([])
    if (typeof window !== 'undefined') {
      localStorage.removeItem(storageKey)
    }
  }

  if (!open) return null

  return (
    <div
      ref={panelRef}
      className="fixed bottom-6 right-4 z-50 flex w-[min(34rem,calc(100vw-1.5rem))] flex-col rounded-3xl border border-slate-200 bg-white shadow-2xl"
      style={{ height: 'min(70vh, 640px)', maxHeight: 'calc(100vh - 48px)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between rounded-t-3xl bg-slate-900 px-5 py-4">
        <div className="flex items-center gap-2">
          <GripVertical className="h-4 w-4 text-slate-400" />
          <div>
            <h2 className="text-sm font-semibold text-white">
              AI 助手
            </h2>
            <div className="text-[11px] text-slate-400">当前账号聊天记录自动保存</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleClearHistory}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
            aria-label="清空聊天记录"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onClose()}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
            <div className="mt-10 text-center text-sm text-slate-400">
              你好！有什么可以帮助你的吗？
            <div className="mt-2 text-xs text-slate-300">
              可以拖拽单元格内容到输入框
            </div>
          </div>
        )}
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-7 whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-slate-900 text-white rounded-br-sm'
                  : 'bg-slate-100 text-slate-900 rounded-bl-sm'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-3 text-slate-900">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="rounded-b-3xl border-t border-slate-200 px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            placeholder="输入消息，或拖入内容..."
            rows={4}
            className="flex-1 resize-none rounded-2xl border border-slate-200 px-4 py-3 text-sm leading-7 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!inputValue.trim() || loading}
            className="rounded-2xl bg-slate-900 p-3 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="发送"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
