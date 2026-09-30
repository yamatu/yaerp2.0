'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import api from '@/lib/api'
import { notifyDataChanged } from '@/lib/dataEvents'
import type { AIChatResponse, AIChatToolTrace, AIERPPendingPlan, AISpreadsheetOperation } from '@/types'

export interface CloudChatMessage {
  id: string; role: 'user' | 'assistant'; content: string; createdAt: number
  pendingOperations?: AISpreadsheetOperation[]; pendingERPPlan?: AIERPPendingPlan
  toolTraces?: AIChatToolTrace[]; touchedSheetIds?: number[]
  applyState?: 'idle' | 'applying' | 'applied' | 'failed'; applyError?: string
  erpApplyState?: 'idle' | 'applying' | 'applied' | 'failed'; erpApplyError?: string
}
export interface CloudChatRun { id: number; message_id: string; status: string; activity: string; error?: string; result?: AIChatResponse }
export interface CloudConversation { id: number; title: string; assistant_id: number | null; updated_at: string; messages?: CloudChatMessage[]; last_run?: CloudChatRun; version?: string; unchanged?: boolean }

function readLegacyMessages(userId: number): CloudChatMessage[] {
  try {
    const value = JSON.parse(localStorage.getItem(`yaerp_ai_chat_history_${userId}`) || '[]')
    if (!Array.isArray(value)) return []
    const result: CloudChatMessage[] = []
    let bytes = 0
    for (const item of value.slice(-200).reverse()) {
      if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') continue
      const content = item.content.slice(0, 35000)
      const size = new TextEncoder().encode(content).length
      if (bytes + size > 1500000) break
      bytes += size
      result.push({ id: String(item.id || ''), role: item.role, content, createdAt: Number(item.createdAt) || Date.now() })
    }
    return result.reverse()
  } catch { return [] }
}

// Polling observes backend-owned runs. Unmount/close only detaches the observer;
// it never sends cancellation. Only stop() explicitly cancels an owned run.
export function useAIConversations(userId: number, open: boolean) {
  const [conversations, setConversations] = useState<CloudConversation[]>([])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [messages, setMessages] = useState<CloudChatMessage[]>([])
  const [run, setRun] = useState<CloudChatRun | null>(null)
  const [starting, setStarting] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const idRef = useRef<number | null>(null)
  const accountRef = useRef(userId)
  const startRef = useRef(false)
  const actionClaims = useRef(new Map<string, { conversationId: number; claimId: string }>())
  const generation = useRef(0)
  const versions = useRef(new Map<number, string>())
  const notified = useRef(new Set<number>())
  const pendingRequest = useRef<{ prompt: string; id: string; conversationId: number; approvalKey: string } | null>(null)
  const active = run?.status === 'running' || run?.status === 'queued'
  const pointerKey = `yaerp_ai_active_conversation_${userId}`

  useEffect(() => {
    if (accountRef.current === userId) return
    accountRef.current = userId; generation.current++; idRef.current = null
    versions.current.clear(); notified.current.clear(); actionClaims.current.clear()
    pendingRequest.current = null
    setMessages([]); setConversations([]); setConversationId(null); setRun(null); setReady(false); setError('')
  }, [userId])

  const list = useCallback(async () => {
    const account = accountRef.current
    const res = await api.get<CloudConversation[]>('/ai/conversations')
    if (account !== accountRef.current) return []
    if (res.code !== 0) throw new Error(res.message || '读取对话列表失败')
    setConversations(res.data || [])
    return res.data || []
  }, [])

  const load = useCallback(async (id: number) => {
    const version = generation.current
    const lastVersion = versions.current.get(id)
    const res = await api.get<CloudConversation>(`/ai/conversations/${id}${lastVersion ? `?version=${encodeURIComponent(lastVersion)}` : ''}`)
    if (version !== generation.current || idRef.current !== id) return
    if (res.code !== 0 || !res.data) throw new Error(res.message || '读取对话失败')
    if (res.data.unchanged) { setError(''); return }
    if (res.data.version) versions.current.set(id, res.data.version)
    const last = res.data.last_run
    const loaded = res.data.messages || []
    if (last?.status === 'interrupted' && last.error) {
      const message = loaded.find((item) => item.id === last.message_id)
      if (message && !message.content.includes(last.error)) message.content += `\n\n${last.error}`
    }
    setMessages((current) => JSON.stringify(current) === JSON.stringify(loaded) ? current : loaded)
    setRun(last || null)
    setError('')
    if (last && !['queued', 'running'].includes(last.status) && !notified.current.has(last.id)) {
      notified.current.add(last.id)
      if (last.result?.resources_changed || last.result?.changed_sheet_ids?.length) notifyDataChanged({ source: 'ai', sheetIds: last.result.changed_sheet_ids || [], resourcesChanged: Boolean(last.result.resources_changed) })
    }
  }, [])

  const select = useCallback(async (id: number) => {
    generation.current++
    versions.current.delete(id)
    idRef.current = id
    setConversationId(id); setMessages([]); setRun(null); setError('')
    try { localStorage.setItem(pointerKey, String(id)) } catch { /* pointer cache only */ }
    await load(id)
  }, [load, pointerKey])

  const create = useCallback(async (assistantId: number | null = null, seed?: CloudChatMessage[]) => {
    const account = accountRef.current
    const res = await api.post<CloudConversation>('/ai/conversations', { account_id: account, assistant_id: assistantId, title: seed?.length ? '本机历史对话' : '新对话', messages: seed || [] })
    if (account !== accountRef.current) throw new Error('登录账号已经切换')
    if (res.code !== 0 || !res.data) throw new Error(res.message || '新建对话失败')
    await list(); await select(res.data.id)
    return res.data.id
  }, [list, select])

  useEffect(() => {
    if (!userId || !open || ready) return
    let cancelled = false
    const initialize = async () => {
      try {
        const items = await list()
        if (cancelled) return
        let savedId = 0
        try { savedId = Number(localStorage.getItem(pointerKey)) } catch { /* no local storage */ }
        const id = items.find((item) => item.id === savedId)?.id || items[0]?.id
        if (id) await select(id)
        else {
          // One-time text-only migration. Old pending plans are stripped by the
          // server; importing history must not resurrect executable writes.
          await create(null, readLegacyMessages(userId))
        }
        if (!cancelled) setReady(true)
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : '连接历史对话失败') }
    }
    void initialize()
    return () => { cancelled = true }
  }, [userId, open, ready, list, select, create, pointerKey])

  useEffect(() => {
    if (!open || !ready || !conversationId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try { await load(conversationId) } catch (err) { if (!cancelled) setError(`${err instanceof Error ? err.message : '连接中断'}；后台任务仍会继续，正在重连`) }
      if (!cancelled) timer = setTimeout(refresh, active ? 1000 : 4000)
    }
    const onVisible = () => { if (document.visibilityState === 'visible') { void load(conversationId).catch(() => {}); void list().catch(() => {}) } }
    timer = setTimeout(refresh, 500)
    const listTimer = setInterval(() => { void list().catch(() => {}) }, 10000)
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearTimeout(timer); clearInterval(listTimer); document.removeEventListener('visibilitychange', onVisible) }
  }, [open, ready, conversationId, active, load, list])

  const start = useCallback(async (prompt: string, assistantId: number | null, context?: unknown, approval?: { message_id: string; kind: 'apply' | 'erp'; continue_task: boolean }) => {
    if (startRef.current) return
    startRef.current = true; setStarting(true); setError('')
    try {
      const id = idRef.current || await create(assistantId)
      const saved = pendingRequest.current
      const approvalKey = JSON.stringify(approval || null)
      const requestId = saved?.prompt === prompt && saved.conversationId === id && saved.approvalKey === approvalKey ? saved.id : globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
      pendingRequest.current = { prompt, id: requestId, conversationId: id, approvalKey }
      const res = await api.post<CloudChatRun>(`/ai/conversations/${id}/turns`, { prompt, request_id: requestId, assistant_id: assistantId, context, approval })
      if (res.code !== 0 || !res.data) { await load(id); throw new Error(res.message || '发起任务失败') }
      pendingRequest.current = null
      if (idRef.current === id) setRun(res.data)
      await load(id); await list()
    } catch (err) { setError(err instanceof Error ? err.message : '发起任务失败'); throw err }
    finally { startRef.current = false; setStarting(false) }
  }, [create, list, load])

  const startAction = useCallback((messageId: string, kind: 'apply' | 'erp', continueTask: boolean, assistantId: number | null, context?: unknown) =>
    start(kind === 'apply' ? '已确认执行表格方案。' : '已确认执行 ERP 方案。', assistantId, context, { message_id: messageId, kind, continue_task: continueTask }), [start])

  const stop = useCallback(async () => {
    if (!conversationId || !run || !active) return
    const res = await api.post(`/ai/conversations/${conversationId}/runs/${run.id}/stop`, {})
    if (res.code !== 0) throw new Error(res.message || '停止任务失败')
    await load(conversationId)
  }, [conversationId, run, active, load])

  const remove = useCallback(async () => {
    if (!conversationId) return
    const res = await api.delete(`/ai/conversations/${conversationId}`)
    if (res.code !== 0) throw new Error(res.message || '删除失败，请先停止正在运行的任务')
    const items = await list()
    if (items[0]) await select(items[0].id)
    else await create()
  }, [conversationId, list, select, create])

  const patchAction = useCallback(async (messageId: string, kind: 'apply' | 'erp', state: 'applying' | 'applied' | 'failed', detail = '') => {
    const key = `${messageId}:${kind}`
    const existing = actionClaims.current.get(key)
    const claim = state === 'applying' ? { conversationId: idRef.current || 0, claimId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}` } : existing
    if (!claim?.conversationId) throw new Error('没有此操作的领取标识，请刷新对话')
    const res = await api.put(`/ai/conversations/${claim.conversationId}/messages/${messageId}/action`, { kind, state, error: detail, claim_id: claim.claimId })
    if (res.code !== 0) throw new Error(res.message || '此方案已在另一设备执行或正在执行，请刷新')
    if (state === 'applying') actionClaims.current.set(key, claim)
    else actionClaims.current.delete(key)
  }, [])

  const sameAccount = accountRef.current === userId
  return { conversations: sameAccount ? conversations : [], conversationId: sameAccount ? conversationId : null, messages: sameAccount ? messages : [], setMessages, run: sameAccount ? run : null, ready: sameAccount && ready, error, loading: sameAccount && (starting || active),
    liveActivity: sameAccount && active ? { label: run?.status === 'queued' ? '已提交后台，等待执行' : run?.activity || '智能体正在后台运行', detail: '关闭浏览器不会停止，手机/电脑可继续查看' } : null,
    select, create, start, startAction, stop, remove, patchAction, isCurrent: (id: number | null) => idRef.current === id }
}
