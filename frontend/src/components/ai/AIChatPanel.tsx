'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Send, Loader2, GripVertical } from 'lucide-react'
import api from '@/lib/api'

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

  if (!open) return null

  return (
    <div
      ref={panelRef}
      className="fixed bottom-[5.5rem] right-4 z-50 flex w-80 flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl"
      style={{ height: 400, maxHeight: 'calc(100vh - 120px)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between rounded-t-2xl bg-slate-900 px-4 py-3">
        <div className="flex items-center gap-2">
          <GripVertical className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-white">
            AI 助手
          </h2>
        </div>
        <button
          type="button"
          onClick={() => onClose()}
          className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-800 hover:text-white"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
        {messages.length === 0 && (
          <div className="text-center text-slate-400 text-xs mt-8">
            你好！有什么可以帮助你的吗？
            <div className="mt-2 text-slate-300">
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
              className={`max-w-[85%] px-3 py-2 rounded-xl text-xs leading-relaxed whitespace-pre-wrap ${
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
            <div className="bg-slate-100 text-slate-900 px-3 py-2 rounded-xl rounded-bl-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-200 px-3 py-2.5 rounded-b-2xl">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            placeholder="输入消息，或拖入内容..."
            rows={2}
            className="flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2 text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!inputValue.trim() || loading}
            className="bg-slate-900 text-white p-2 rounded-xl hover:bg-slate-800 transition disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="发送"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
