'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Bot, CheckCircle2, Clock3, Download, GripVertical, Loader2, Send, Sparkles, Trash2, Wand2, X } from 'lucide-react'
import api from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import type { AIChatResponse, AIChatToolTrace, AISpreadsheetOperation } from '@/types'

interface PersistedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  pendingOperations?: AISpreadsheetOperation[]
  toolTraces?: AIChatToolTrace[]
  touchedSheetIds?: number[]
  applyState?: 'idle' | 'applying' | 'applied' | 'failed'
  applyError?: string
}

interface AIChatPanelProps {
  open: boolean
  onClose: () => void
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function toolTitle(name: string) {
  switch (name) {
    case 'query_sheet':
      return '表格查询'
    case 'update_cell':
      return '单元格修改'
    case 'insert_row':
      return '新增行'
    case 'delete_row':
      return '删除行'
    case 'insert_column':
      return '新增列'
    case 'auto_fill_column':
      return '批量填充'
    case 'generate_report':
      return '生成报表'
    case 'schedule_daily_report':
      return '定时报表'
    case 'preview_spreadsheet_plan':
      return '待确认修改方案'
    case 'apply_spreadsheet_plan':
      return '执行修改'
    case 'run_workflow':
      return '工作流执行'
    default:
      return name
  }
}

function operationTitle(operation: AISpreadsheetOperation) {
  switch (operation.kind) {
    case 'insert_row':
      return `新增第 ${(operation.row ?? 0) + 1} 行`
    case 'delete_row':
      return `删除第 ${(operation.row ?? 0) + 1} 行`
    case 'insert_column':
      return `新增列 ${operation.column_name || operation.column_key || '未命名列'}`
    case 'fill_formula':
      return `填充公式到 ${operation.column_name || operation.column_key || '目标列'}`
    default:
      return `修改 ${operation.sheet_name} / 第 ${(operation.row ?? 0) + 1} 行 / ${operation.column_name || operation.column_key || '单元格'}`
  }
}

function operationDetail(operation: AISpreadsheetOperation) {
  switch (operation.kind) {
    case 'insert_row':
      return JSON.stringify(operation.row_values || {}, null, 0)
    case 'delete_row':
      return '删除该数据行'
    case 'insert_column':
      return `列 key：${operation.column_key || '-'} / 类型：${operation.column_type || 'text'}`
    case 'fill_formula':
      return `范围：${(operation.start_row ?? 0) + 1}-${(operation.end_row ?? operation.start_row ?? 0) + 1} 行 / 模板：${operation.formula_template || ''}`
    default:
      return `当前值：${String(operation.current_value ?? '空')} -> 新值：${String(operation.value ?? '空')}`
  }
}

function renderTracePreview(trace: AIChatToolTrace) {
  const data = trace.data as Record<string, unknown> | undefined
  if (!data) return null

  if (trace.name === 'generate_report' && typeof data.download_url === 'string') {
    return (
      <a
        href={data.download_url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-700 transition hover:bg-sky-100"
      >
        <Download className="h-3.5 w-3.5" />
        下载 {String(data.filename || '报表')}
      </a>
    )
  }

  if (trace.name === 'schedule_daily_report') {
    return (
      <div className="text-xs leading-6 text-slate-500">
        任务 #{String(data.schedule_id || '-')} / 时区 {String(data.timezone || '-')} / Cron {String(data.cron_expr || '-')}
      </div>
    )
  }

  if (trace.name === 'query_sheet' && Array.isArray(data.rows)) {
    const previewRows = data.rows.slice(0, 3)
    return (
      <pre className="overflow-x-auto rounded-xl bg-slate-950 px-3 py-2 text-[11px] leading-5 text-slate-100">
        {JSON.stringify(previewRows, null, 2)}
      </pre>
    )
  }

  return null
}

export default function AIChatPanel({ open, onClose }: AIChatPanelProps) {
  const [messages, setMessages] = useState<PersistedMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const historyReadyRef = useRef(false)
  const userId = getStoredUser()?.id ?? 0
  const storageKey = userId ? `yaerp_ai_chat_history_${userId}` : 'yaerp_ai_chat_history_guest'

  const requestMessages = useMemo(
    () => messages.map((item) => ({ role: item.role, content: item.content })),
    [messages]
  )

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
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
      const parsed = JSON.parse(raw) as PersistedMessage[]
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

    const userMessage: PersistedMessage = {
      id: makeId(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    }

    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setInputValue('')
    setLoading(true)

    try {
      const res = await api.post<AIChatResponse>('/ai/chat', {
        messages: [...requestMessages, { role: 'user', content: trimmed }],
      })

      const assistantMessage: PersistedMessage = {
        id: makeId(),
        role: 'assistant',
        content: res.data?.reply ?? '',
        createdAt: Date.now(),
        pendingOperations: res.data?.pending_operations,
        toolTraces: res.data?.tool_traces,
        touchedSheetIds: res.data?.touched_sheet_ids,
        applyState: 'idle',
      }
      setMessages((prev) => [...prev, assistantMessage])
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: 'assistant',
          content: '抱歉，请求失败，请稍后重试。',
          createdAt: Date.now(),
        },
      ])
    } finally {
      setLoading(false)
    }
  }

  const handleApplyPending = useCallback(async (messageId: string, operations: AISpreadsheetOperation[]) => {
    setMessages((prev) => prev.map((message) => (
      message.id === messageId
        ? { ...message, applyState: 'applying', applyError: '' }
        : message
    )))

    try {
      const res = await api.post('/ai/spreadsheet/apply', { operations })
      if (res.code !== 0) {
        setMessages((prev) => prev.map((message) => (
          message.id === messageId
            ? { ...message, applyState: 'failed', applyError: res.message || '写入失败，请稍后重试。' }
            : message
        )))
        return
      }

      setMessages((prev) => prev.map((message) => (
        message.id === messageId
          ? { ...message, applyState: 'applied', applyError: '' }
          : message
      )))
    } catch {
      setMessages((prev) => prev.map((message) => (
        message.id === messageId
          ? { ...message, applyState: 'failed', applyError: '写入失败，请稍后重试。' }
          : message
      )))
    }
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  const handleDrop = useCallback((event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault()
	const text = event.dataTransfer.getData('text/plain')
	if (text) {
		setInputValue((prev) => (prev ? `${prev}\n${text}` : text))
	}
  }, [])

  const handleDragOver = useCallback((event: React.DragEvent<HTMLTextAreaElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
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
      className="fixed bottom-6 right-4 z-50 flex w-[min(40rem,calc(100vw-1.5rem))] flex-col rounded-3xl border border-slate-200 bg-white shadow-2xl"
      style={{ height: 'min(78vh, 760px)', maxHeight: 'calc(100vh - 48px)' }}
    >
      <div className="flex items-center justify-between rounded-t-3xl bg-slate-900 px-5 py-4">
        <div className="flex items-center gap-3">
          <GripVertical className="h-4 w-4 text-slate-400" />
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/10 text-white">
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">AI 表格助手</h2>
            <div className="text-[11px] text-slate-400">支持查询、报表、定时任务、待确认修改方案</div>
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
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 && (
          <div className="mt-10 rounded-[28px] border border-dashed border-slate-300 bg-slate-50/80 px-5 py-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-900 text-white">
              <Sparkles className="h-6 w-6" />
            </div>
            <div className="text-sm font-semibold text-slate-900">你可以直接这样说</div>
            <div className="mt-3 space-y-2 text-xs leading-6 text-slate-500">
              <div>“查询今天销售表里金额大于 10000 的记录”</div>
              <div>“帮我生成这张表的 Excel 报表”</div>
              <div>“把库存表里 iPhone 数量加 50，先给我确认方案”</div>
              <div>“每天 09:00 自动导出这张表的日报”</div>
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[94%] ${message.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-3`}>
              <div
                className={`rounded-2xl px-4 py-3 text-sm leading-7 whitespace-pre-wrap ${
                  message.role === 'user'
                    ? 'rounded-br-sm bg-slate-900 text-white'
                    : 'rounded-bl-sm bg-slate-100 text-slate-900'
                }`}
              >
                {message.content}
              </div>

              {message.role === 'assistant' && Array.isArray(message.toolTraces) && message.toolTraces.length > 0 && (
                <div className="w-full space-y-2">
                  {message.toolTraces.map((trace, index) => (
                    <div key={`${message.id}-trace-${index}`} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <div className={`flex h-8 w-8 items-center justify-center rounded-xl ${trace.status === 'success' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                            {trace.name === 'schedule_daily_report' ? <Clock3 className="h-4 w-4" /> : trace.name === 'preview_spreadsheet_plan' ? <Wand2 className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-slate-900">{toolTitle(trace.name)}</div>
                            <div className={`text-xs ${trace.status === 'success' ? 'text-emerald-600' : 'text-rose-600'}`}>{trace.summary || (trace.status === 'success' ? '执行成功' : '执行失败')}</div>
                          </div>
                        </div>
                        {trace.touched_sheet_ids && trace.touched_sheet_ids.length > 0 && (
                          <div className="flex flex-wrap justify-end gap-1">
                            {trace.touched_sheet_ids.map((sheetId) => (
                              <span key={sheetId} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500">
                                Sheet #{sheetId}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="mt-3">
                        {renderTracePreview(trace)}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {message.role === 'assistant' && Array.isArray(message.pendingOperations) && message.pendingOperations.length > 0 && (
                <div className="w-full rounded-[24px] border border-amber-200 bg-amber-50/80 p-4 shadow-sm">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-800">
                    <Wand2 className="h-4 w-4" />
                    待确认表格修改方案
                  </div>
                  <div className="space-y-2">
                    {message.pendingOperations.map((operation, index) => (
                      <div key={`${message.id}-op-${index}`} className="rounded-2xl border border-amber-200 bg-white/90 px-3 py-3">
                        <div className="text-sm font-semibold text-slate-900">{operationTitle(operation)}</div>
                        <div className="mt-1 text-xs leading-6 text-slate-500">{operationDetail(operation)}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-amber-700">确认后会直接写入数据库，并自动刷新当前在线表格。</div>
                    <div className="flex gap-2">
                      {message.applyState === 'applied' ? (
                        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-700">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          已写入表格
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleApplyPending(message.id, message.pendingOperations || [])}
                          disabled={message.applyState === 'applying'}
                          className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {message.applyState === 'applying' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                          {message.applyState === 'applying' ? '写入中...' : '确认写入表格'}
                        </button>
                      )}
                    </div>
                  </div>
                  {message.applyState === 'failed' && message.applyError && (
                    <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                      {message.applyError}
                    </div>
                  )}
                </div>
              )}
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

      <div className="rounded-b-3xl border-t border-slate-200 px-4 py-3">
        <div className="mb-3 flex flex-wrap gap-2">
          {['帮我查询当前可访问的工作簿', '帮我生成一张表格日报', '帮我先生成一个待确认修改方案', '帮我创建每天 09:00 的自动报表任务'].map((tip) => (
            <button
              key={tip}
              type="button"
              onClick={() => setInputValue(tip)}
              className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:bg-white"
            >
              {tip}
            </button>
          ))}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={handleKeyDown}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            placeholder="输入消息，或拖入单元格内容..."
            rows={4}
            className="flex-1 resize-none rounded-2xl border border-slate-200 px-4 py-3 text-sm leading-7 focus:border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
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
