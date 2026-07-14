'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, MessageCircle, RefreshCw, Search, Send, Users, X } from 'lucide-react'
import api from '@/lib/api'
import type { WhatsAppChat } from '@/types'

export interface WhatsAppSendResource {
  channelId?: number
  messageId?: number
  attachmentId?: number
  workbookId?: number
  sheetId?: number
  title?: string
  defaultContent?: string
}

interface WhatsAppSendDialogProps {
  open: boolean
  resource: WhatsAppSendResource | null
  onClose: () => void
  onSent?: () => void
}

export function WhatsAppSendDialog({ open, resource, onClose, onSent }: WhatsAppSendDialogProps) {
  const [chats, setChats] = useState<WhatsAppChat[]>([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  const [selectedChatId, setSelectedChatId] = useState('')
  const [content, setContent] = useState('')
  const [error, setError] = useState('')

  const loadChats = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await api.get<WhatsAppChat[]>('/whatsapp/chats')
      if (response.code !== 0 || !response.data) {
        setError(response.message || 'WhatsApp 尚未登录或服务不可用')
        setChats([])
        return
      }
      setChats(response.data)
    } catch {
      setError('无法读取 WhatsApp 会话')
      setChats([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setSearch('')
    setSelectedChatId('')
    setContent(resource?.defaultContent || '')
    setError('')
    void loadChats()
  }, [open, resource])

  const filteredChats = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (!keyword) return chats
    return chats.filter((chat) => chat.name.toLowerCase().includes(keyword) || chat.id.toLowerCase().includes(keyword))
  }, [chats, search])

  if (!open || !resource) return null

  const send = async () => {
    if (sending) return
    if (!selectedChatId && !(resource.channelId && resource.messageId)) {
      setError('请选择接收消息的 WhatsApp 会话')
      return
    }
    setSending(true)
    setError('')
    try {
      const response = await api.post('/whatsapp/send', {
        chat_id: selectedChatId,
        channel_id: resource.channelId || 0,
        message_id: resource.messageId || 0,
        attachment_id: resource.attachmentId,
        workbook_id: resource.workbookId,
        sheet_id: resource.sheetId,
        content: content.trim(),
      })
      if (response.code !== 0) {
        setError(response.message || '发送到 WhatsApp 失败')
        return
      }
      onSent?.()
      onClose()
    } catch {
      setError('发送到 WhatsApp 失败')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-3 sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="flex max-h-[86vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-900"><MessageCircle className="h-5 w-5 text-emerald-600" />发送到 WhatsApp</div>
            <div className="mt-1 truncate text-xs text-slate-400">{resource.title || '选择会话并发送系统内容'}</div>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100" title="关闭"><X className="h-4 w-4" /></button>
        </div>

        <div className="border-b border-slate-100 p-3">
          <div className="flex items-center gap-2">
            <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 focus-within:border-emerald-300 focus-within:bg-white">
              <Search className="h-4 w-4 shrink-0" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索联系人或群组" className="min-w-0 flex-1 bg-transparent outline-none" />
            </label>
            <button type="button" onClick={() => void loadChats()} disabled={loading} className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50" title="刷新会话"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-slate-400"><RefreshCw className="h-4 w-4 animate-spin" />正在读取 WhatsApp 会话...</div>
          ) : filteredChats.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">{error || '没有匹配的会话'}</div>
          ) : filteredChats.map((chat) => (
            <button key={chat.id} type="button" onClick={() => setSelectedChatId(chat.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${selectedChatId === chat.id ? 'bg-emerald-50' : 'hover:bg-slate-50'}`}>
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${selectedChatId === chat.id ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{chat.isGroup ? <Users className="h-4 w-4" /> : <MessageCircle className="h-4 w-4" />}</div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-slate-800">{chat.name}</div>
                <div className="mt-0.5 truncate text-xs text-slate-400">{chat.isGroup ? '群组' : '联系人'} · {chat.id}</div>
              </div>
              {selectedChatId === chat.id && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}
            </button>
          ))}
        </div>

        <div className="border-t border-slate-200 p-4">
          <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="附加说明（可选）" className="min-h-20 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-emerald-300" />
          {error && chats.length > 0 && <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">取消</button>
            <button type="button" onClick={() => void send()} disabled={sending || !selectedChatId} className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"><Send className="h-4 w-4" />{sending ? '发送中...' : '发送'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
