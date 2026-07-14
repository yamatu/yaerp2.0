'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  BarChart3,
  Bot,
  Check,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Share2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { AuthGuard } from '@/components/auth/AuthGuard'
import api from '@/lib/api'
import { getAccessToken, getStoredUser, isAdmin } from '@/lib/auth'
import type {
  AIAssistant,
  AISummaryContent,
  AISummaryMetric,
  AISummaryPage,
  AISummarySection,
  Channel,
  Workbook,
} from '@/types'

const emptyContent: AISummaryContent = {
  headline: '',
  overview: '',
  metrics: [],
  sections: [],
  sources: [],
}

export default function AISummariesPage() {
  const router = useRouter()
  const [pages, setPages] = useState<AISummaryPage[]>([])
  const [assistants, setAssistants] = useState<AIAssistant[]>([])
  const [workbooks, setWorkbooks] = useState<Workbook[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState<AISummaryContent>(emptyContent)
  const [editing, setEditing] = useState(false)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [generateTitle, setGenerateTitle] = useState('经营数据总结')
  const [generatePrompt, setGeneratePrompt] = useState('总结关键指标、异常、趋势和下一步建议，并标明信息来源。')
  const [generateAssistantId, setGenerateAssistantId] = useState<number | null>(null)
  const [selectedWorkbookIds, setSelectedWorkbookIds] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shareChannelId, setShareChannelId] = useState('')

  const selectedPage = useMemo(
    () => pages.find((page) => page.id === selectedId) || null,
    [pages, selectedId]
  )

  const loadData = useCallback(async (preferredId?: number) => {
    setLoading(true)
    setError('')
    try {
      const [pagesRes, assistantsRes, workbooksRes, channelsRes] = await Promise.all([
        api.get<AISummaryPage[]>('/ai/summaries'),
        api.get<AIAssistant[]>('/ai/assistants'),
        api.get<Workbook[]>('/workbooks'),
        api.get<Channel[]>('/channels'),
      ])
      const nextPages = pagesRes.code === 0 && Array.isArray(pagesRes.data) ? pagesRes.data : []
      const nextAssistants = assistantsRes.code === 0 && Array.isArray(assistantsRes.data) ? assistantsRes.data : []
      const nextWorkbooks = workbooksRes.code === 0 && Array.isArray(workbooksRes.data) ? workbooksRes.data : []
      const nextChannels = channelsRes.code === 0 && Array.isArray(channelsRes.data) ? channelsRes.data : []
      setPages(nextPages)
      setAssistants(nextAssistants)
      setWorkbooks(nextWorkbooks)
      setChannels(nextChannels)
      setGenerateAssistantId((current) => current ?? nextAssistants.find((item) => item.is_default)?.id ?? nextAssistants[0]?.id ?? null)

      const queryId = typeof window !== 'undefined'
        ? Number(new URLSearchParams(window.location.search).get('selected')) || undefined
        : undefined
      const nextId = preferredId || queryId || selectedId || nextPages[0]?.id || null
      setSelectedId(nextPages.some((page) => page.id === nextId) ? nextId : nextPages[0]?.id || null)
    } catch {
      setError('加载 AI 汇总页面失败')
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  useEffect(() => {
    void loadData()
    // Initial load only. Further refreshes are explicit to avoid resetting edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedPage || editing) return
    setDraftTitle(selectedPage.title)
    setDraftContent(structuredClone(selectedPage.content))
  }, [editing, selectedPage])

  const selectPage = (page: AISummaryPage) => {
    setSelectedId(page.id)
    setEditing(false)
    setSaved(false)
    setError('')
    window.history.replaceState(null, '', `/ai/summaries?selected=${page.id}`)
  }

  const toggleWorkbook = (workbookId: number) => {
    setSelectedWorkbookIds((current) => current.includes(workbookId)
      ? current.filter((id) => id !== workbookId)
      : [...current, workbookId])
  }

  const generateSummary = async () => {
    if (!generateTitle.trim() || selectedWorkbookIds.length === 0) {
      setError('请输入标题并至少选择一个工作簿')
      return
    }
    setWorking(true)
    setError('')
    try {
      const res = await api.post<AISummaryPage>('/ai/summaries/generate', {
        title: generateTitle.trim(),
        workbook_ids: selectedWorkbookIds,
        assistant_id: generateAssistantId,
        prompt: generatePrompt.trim(),
      })
      if (res.code !== 0 || !res.data) {
        setError(res.message || '生成汇总失败')
        return
      }
      setGeneratorOpen(false)
      setSelectedWorkbookIds([])
      await loadData(res.data.id)
      window.history.replaceState(null, '', `/ai/summaries?selected=${res.data.id}`)
    } catch {
      setError('生成汇总失败，请检查 AI 助手配置和工作簿权限')
    } finally {
      setWorking(false)
    }
  }

  const saveSummary = async () => {
    if (!selectedPage || !draftTitle.trim()) return
    setWorking(true)
    setSaved(false)
    setError('')
    try {
      const res = await api.put<AISummaryPage>(`/ai/summaries/${selectedPage.id}`, {
        title: draftTitle.trim(),
        content: draftContent,
      })
      if (res.code !== 0 || !res.data) {
        setError(res.message || '保存失败')
        return
      }
      setPages((current) => current.map((page) => page.id === res.data?.id ? res.data : page))
      setEditing(false)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1800)
    } catch {
      setError('保存失败')
    } finally {
      setWorking(false)
    }
  }

  const deleteSummary = async () => {
    if (!selectedPage || !window.confirm(`确定删除“${selectedPage.title}”吗？`)) return
    setWorking(true)
    try {
      const res = await api.delete(`/ai/summaries/${selectedPage.id}`)
      if (res.code !== 0) {
        setError(res.message || '删除失败')
        return
      }
      window.history.replaceState(null, '', '/ai/summaries')
      setEditing(false)
      await loadData()
    } catch {
      setError('删除失败')
    } finally {
      setWorking(false)
    }
  }

  const shareSummary = async () => {
    if (!selectedPage || !shareChannelId) return
    setWorking(true)
    setError('')
    try {
      const formData = new FormData()
      formData.append('linked_summary_id', String(selectedPage.id))
      formData.append('content', `分享 AI 总结：${selectedPage.title}`)
      const token = getAccessToken()
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || '/api'}/channels/${shareChannelId}/messages`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      const result = await response.json()
      if (!response.ok || result.code !== 0) throw new Error(result.message || '发送失败')
      setShareOpen(false)
      setShareChannelId('')
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1800)
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : '发送到频道失败')
    } finally {
      setWorking(false)
    }
  }

  const updateMetric = (index: number, patch: Partial<AISummaryMetric>) => {
    setDraftContent((current) => ({
      ...current,
      metrics: current.metrics.map((metric, metricIndex) => metricIndex === index ? { ...metric, ...patch } : metric),
    }))
  }

  const updateSection = (index: number, patch: Partial<AISummarySection>) => {
    setDraftContent((current) => ({
      ...current,
      sections: current.sections.map((section, sectionIndex) => sectionIndex === index ? { ...section, ...patch } : section),
    }))
  }

  const currentUser = getStoredUser()
  const canManageSelectedPage = Boolean(selectedPage && currentUser && (selectedPage.owner_id === currentUser.id || isAdmin(currentUser)))

  return (
    <AuthGuard>
      <div className="h-screen overflow-hidden bg-slate-100 p-2 md:p-4">
        <div className="mx-auto flex h-full max-w-[1500px] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-3 py-3 md:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <button type="button" onClick={() => router.push('/')} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-slate-900" title="返回工作台">
                <ArrowLeft className="h-4 w-4" />
              </button>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white"><BarChart3 className="h-4 w-4" /></span>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold text-slate-950">AI 数据总结</h1>
                <p className="truncate text-xs text-slate-500">跨工作簿生成经营页面，并由智能助手持续编辑</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => void loadData(selectedId || undefined)} disabled={loading || working} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50 disabled:opacity-40" title="刷新">
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button type="button" onClick={() => { setGeneratorOpen(true); setError('') }} className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white transition hover:bg-slate-800">
                <Plus className="h-4 w-4" />
                新建总结
              </button>
            </div>
          </header>

          {error && <div className="flex items-center justify-between border-b border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => setError('')}><X className="h-4 w-4" /></button></div>}

          <div className="grid min-h-0 flex-1 md:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col border-b border-slate-200 bg-slate-50 md:border-b-0 md:border-r">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <span className="text-sm font-semibold text-slate-800">总结记录</span>
                <span className="text-xs text-slate-400">{pages.length}</span>
              </div>
              <div className="max-h-44 overflow-y-auto p-2 md:max-h-none md:flex-1">
                {loading ? (
                  <div className="flex justify-center py-10 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
                ) : pages.length === 0 ? (
                  <button type="button" onClick={() => setGeneratorOpen(true)} className="w-full rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-sm text-slate-500">创建第一份总结</button>
                ) : (
                  <div className="space-y-1">
                    {pages.map((page) => (
                      <button key={page.id} type="button" onClick={() => selectPage(page)} className={`w-full rounded-lg px-3 py-3 text-left transition ${selectedId === page.id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-white'}`}>
                        <span className="block truncate text-sm font-semibold">{page.title}</span>
                        <span className={`mt-1 flex items-center justify-between gap-2 text-[11px] ${selectedId === page.id ? 'text-slate-300' : 'text-slate-400'}`}>
                          <span className="truncate">{page.assistant_name || '本地权限汇总'}</span>
                          <span className="shrink-0">{new Date(page.updated_at).toLocaleDateString('zh-CN')}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </aside>

            <main className="min-h-0 overflow-y-auto">
              {!selectedPage ? (
                <div className="flex min-h-full items-center justify-center px-6 py-20 text-center">
                  <div>
                    <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><FileText className="h-5 w-5" /></span>
                    <h2 className="mt-4 text-base font-semibold text-slate-900">暂无 AI 总结页面</h2>
                    <p className="mt-1 text-sm text-slate-500">选择多个工作簿生成第一份经营总结。</p>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur md:px-6">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900">{selectedPage.title}</div>
                      <div className="mt-0.5 text-xs text-slate-400">更新于 {new Date(selectedPage.updated_at).toLocaleString('zh-CN')}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {saved && <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"><Check className="h-3.5 w-3.5" />已保存</span>}
                      {editing ? (
                        <>
                          <button type="button" onClick={() => { setEditing(false); setDraftTitle(selectedPage.title); setDraftContent(structuredClone(selectedPage.content)) }} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-600"><X className="h-4 w-4" />取消</button>
                          <button type="button" onClick={() => void saveSummary()} disabled={working} className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white disabled:opacity-50">{working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}保存</button>
                        </>
                      ) : (
                        <>
                          <button type="button" onClick={() => { setShareOpen(true); setShareChannelId(channels[0]?.id ? String(channels[0].id) : '') }} className="inline-flex h-9 items-center gap-2 rounded-lg border border-violet-200 px-3 text-sm font-medium text-violet-700 transition hover:bg-violet-50"><Share2 className="h-4 w-4" />发送到频道</button>
                          {canManageSelectedPage && <button type="button" onClick={() => setEditing(true)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50"><Pencil className="h-4 w-4" />编辑</button>}
                          {canManageSelectedPage && <button type="button" onClick={() => void deleteSummary()} disabled={working} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-rose-200 text-rose-600 transition hover:bg-rose-50" title="删除"><Trash2 className="h-4 w-4" /></button>}
                        </>
                      )}
                    </div>
                  </div>

                  <article className="mx-auto max-w-6xl px-4 py-7 md:px-8 md:py-10">
                    {editing ? (
                      <div className="space-y-3">
                        <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm font-semibold outline-none focus:border-slate-400" />
                        <input value={draftContent.headline} onChange={(event) => setDraftContent((current) => ({ ...current, headline: event.target.value }))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-2xl font-semibold text-slate-950 outline-none focus:border-slate-400" />
                        <textarea value={draftContent.overview} onChange={(event) => setDraftContent((current) => ({ ...current, overview: event.target.value }))} rows={4} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-7 text-slate-600 outline-none focus:border-slate-400" />
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-2 text-xs font-semibold uppercase text-sky-700"><Sparkles className="h-3.5 w-3.5" />AI Summary</div>
                        <h2 className="mt-3 text-3xl font-semibold text-slate-950">{draftContent.headline || selectedPage.title}</h2>
                        <p className="mt-4 max-w-4xl text-sm leading-7 text-slate-600">{draftContent.overview}</p>
                      </div>
                    )}

                    <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {draftContent.metrics.map((metric, index) => (
                        <div key={`${metric.label}-${index}`} className="rounded-lg border border-slate-200 border-t-2 border-t-sky-500 bg-white p-4">
                          {editing ? (
                            <div className="space-y-2">
                              <input value={metric.label} onChange={(event) => updateMetric(index, { label: event.target.value })} className="h-8 w-full rounded-md border border-slate-200 px-2 text-xs" />
                              <input value={metric.value} onChange={(event) => updateMetric(index, { value: event.target.value })} className="h-9 w-full rounded-md border border-slate-200 px-2 text-lg font-semibold" />
                              <input value={metric.hint || ''} onChange={(event) => updateMetric(index, { hint: event.target.value })} className="h-8 w-full rounded-md border border-slate-200 px-2 text-xs" />
                            </div>
                          ) : (
                            <>
                              <div className="truncate text-xs font-medium text-slate-500">{metric.label}</div>
                              <div className="mt-2 break-words text-2xl font-semibold text-slate-950">{metric.value}</div>
                              {metric.hint && <div className="mt-2 text-xs leading-5 text-slate-400">{metric.hint}</div>}
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="mt-10 divide-y divide-slate-200 border-y border-slate-200">
                      {draftContent.sections.map((section, index) => (
                        <section key={`${section.title}-${index}`} className="py-7">
                          {editing ? (
                            <div className="space-y-3">
                              <input value={section.title} onChange={(event) => updateSection(index, { title: event.target.value })} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-base font-semibold" />
                              <textarea value={section.body} onChange={(event) => updateSection(index, { body: event.target.value })} rows={3} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-7" />
                              <textarea value={(section.bullets || []).join('\n')} onChange={(event) => updateSection(index, { bullets: event.target.value.split('\n').filter(Boolean) })} rows={4} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-7" placeholder="每行一个要点" />
                            </div>
                          ) : (
                            <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
                              <h3 className="text-base font-semibold text-slate-950">{section.title}</h3>
                              <div>
                                <p className="text-sm leading-7 text-slate-600">{section.body}</p>
                                {section.bullets && section.bullets.length > 0 && <ul className="mt-3 space-y-2 text-sm text-slate-600">{section.bullets.map((bullet, bulletIndex) => <li key={bulletIndex} className="flex gap-2"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" /><span className="leading-6">{bullet}</span></li>)}</ul>}
                              </div>
                            </div>
                          )}
                        </section>
                      ))}
                    </div>

                    <div className="mt-8">
                      <div className="text-xs font-semibold text-slate-500">数据来源</div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {draftContent.sources.map((source) => (
                          <span key={source.workbook_id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                            <strong className="font-semibold text-slate-800">{source.workbook_name}</strong> · {source.sheet_names.length} 张工作表
                          </span>
                        ))}
                      </div>
                    </div>
                  </article>
                </div>
              )}
            </main>
          </div>
        </div>

        {shareOpen && selectedPage && (
          <div className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-950/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) setShareOpen(false) }}>
            <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3"><div><div className="text-sm font-semibold text-slate-900">发送 AI 总结到频道</div><div className="mt-0.5 text-xs text-slate-500">频道成员可以直接打开“{selectedPage.title}”</div></div><button type="button" onClick={() => setShareOpen(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>
              <div className="p-4"><label className="block space-y-1.5"><span className="text-sm font-medium text-slate-700">目标频道</span><select value={shareChannelId} onChange={(event) => setShareChannelId(event.target.value)} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-violet-300"><option value="">请选择频道</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>{channels.length === 0 && <div className="mt-3 text-xs text-amber-700">当前账号还没有可用频道。</div>}</div>
              <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3"><button type="button" onClick={() => setShareOpen(false)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600">取消</button><button type="button" onClick={() => void shareSummary()} disabled={working || !shareChannelId} className="inline-flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white disabled:opacity-50">{working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}发送</button></div>
            </div>
          </div>
        )}

        {generatorOpen && (
          <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/35 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) setGeneratorOpen(false) }}>
            <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-lg border border-slate-200 bg-white shadow-2xl sm:rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-white"><Bot className="h-4 w-4" /></span><div><div className="text-sm font-semibold text-slate-900">生成跨工作簿总结</div><div className="text-xs text-slate-500">仅会读取当前账号有权查看的单元格</div></div></div>
                <button type="button" onClick={() => !working && setGeneratorOpen(false)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button>
              </div>
              <div className="space-y-4 overflow-y-auto p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="space-y-1.5"><span className="text-sm font-medium text-slate-700">页面标题</span><input value={generateTitle} onChange={(event) => setGenerateTitle(event.target.value)} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-slate-400" /></label>
                  <label className="space-y-1.5"><span className="text-sm font-medium text-slate-700">AI 助手</span><select value={generateAssistantId ?? ''} onChange={(event) => setGenerateAssistantId(Number(event.target.value) || null)} className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400"><option value="">本地权限汇总</option>{assistants.map((assistant) => <option key={assistant.id} value={assistant.id}>{assistant.name} · {assistant.model}</option>)}</select></label>
                </div>
                <label className="block space-y-1.5"><span className="text-sm font-medium text-slate-700">分析要求</span><textarea value={generatePrompt} onChange={(event) => setGeneratePrompt(event.target.value)} rows={3} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm leading-6 outline-none focus:border-slate-400" /></label>
                <div>
                  <div className="mb-2 flex items-center justify-between"><span className="text-sm font-medium text-slate-700">工作簿范围</span><span className="text-xs text-slate-400">已选 {selectedWorkbookIds.length}</span></div>
                  <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                    {workbooks.map((workbook) => { const checked = selectedWorkbookIds.includes(workbook.id); return <label key={workbook.id} className={`flex cursor-pointer items-center gap-3 px-3 py-3 transition ${checked ? 'bg-sky-50' : 'hover:bg-slate-50'}`}><input type="checkbox" checked={checked} onChange={() => toggleWorkbook(workbook.id)} className="h-4 w-4 rounded border-slate-300 text-sky-600" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-800">{workbook.name}</span><span className="block truncate text-xs text-slate-400">{workbook.owner_name || `用户 #${workbook.owner_id}`}</span></span></label> })}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3"><button type="button" onClick={() => setGeneratorOpen(false)} disabled={working} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600">取消</button><button type="button" onClick={() => void generateSummary()} disabled={working || selectedWorkbookIds.length === 0} className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50">{working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{working ? '正在分析...' : '生成页面'}</button></div>
            </div>
          </div>
        )}
      </div>
    </AuthGuard>
  )
}
