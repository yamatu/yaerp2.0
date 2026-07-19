'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Clock3, FileSpreadsheet, FilterX, Loader2, RefreshCw, Search, ScrollText, UserRound } from 'lucide-react'
import { AdminShell } from '@/components/admin/AdminShell'
import api from '@/lib/api'
import type { OperationLog, PageData } from '@/types'

const PAGE_SIZE = 50

const ACTION_LABELS: Record<string, string> = {
  'workbook.create': '创建工作簿',
  'workbook.duplicate': '复制工作簿',
  'workbook.update': '更新工作簿',
  'workbook.delete': '删除工作簿',
  'workbook.state.update': '更新工作簿状态',
  'workbook.assign': '发放工作簿',
  'sheet.create': '创建工作表',
  'sheet.duplicate': '复制工作表',
  'sheet.delete': '删除工作表',
  'sheet.update': '更新工作表',
  'sheet.rename': '重命名工作表',
  'sheet.column.insert': '新增列',
  'sheet.column.format': '设置列格式',
  'sheet.range.format': '设置区域格式',
  'sheet.state.update': '更新工作表状态',
  'sheet.sync': '同步工作表',
  'sheet.version.checkpoint': '保存检查点',
  'sheet.version.restore': '恢复历史版本',
  'sheet.snapshot.invalidate': '刷新表格缓存',
  'cell.update': '修改单元格',
  'row.insert': '插入行',
  'row.delete': '删除行',
  'protection.update': '更新保护规则',
  'protection.batch_update': '批量更新保护规则',
}

const SOURCE_LABELS: Record<string, string> = {
  web: '手工编辑',
  ai: 'AI 助手',
  import: 'Excel 导入',
  sync: '任务同步',
  restore: '版本恢复',
  checkpoint: '手动检查点',
  baseline: '初始状态',
  system: '系统操作',
}

interface AuditFilters {
  keyword: string
  action: string
  source: string
  from: string
  to: string
}

const EMPTY_FILTERS: AuditFilters = { keyword: '', action: '', source: '', from: '', to: '' }

function toBoundaryISO(value: string, endOfDay: boolean) {
  if (!value) return ''
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function cellLabel(log: OperationLog) {
  if (log.row_index === undefined || !log.column_key) return ''
  return `${log.column_key}${log.row_index + 2}`
}

export default function AuditPage() {
  const [draft, setDraft] = useState<AuditFilters>(EMPTY_FILTERS)
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS)
  const [logs, setLogs] = useState<OperationLog[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])

  const loadLogs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE) })
      if (filters.keyword) query.set('keyword', filters.keyword)
      if (filters.action) query.set('action', filters.action)
      if (filters.source) query.set('source', filters.source)
      const from = toBoundaryISO(filters.from, false)
      const to = toBoundaryISO(filters.to, true)
      if (from) query.set('from', from)
      if (to) query.set('to', to)

      const response = await api.get<PageData<OperationLog>>(`/admin/audit-logs?${query.toString()}`)
      if (response.code !== 0 || !response.data) throw new Error(response.message || '加载操作审计失败')
      setLogs(Array.isArray(response.data.list) ? response.data.list : [])
      setTotal(response.data.total || 0)
    } catch (loadError) {
      setLogs([])
      setTotal(0)
      setError(loadError instanceof Error ? loadError.message : '加载操作审计失败')
    } finally {
      setLoading(false)
    }
  }, [filters, page, reloadToken])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  const submitFilters = (event: FormEvent) => {
    event.preventDefault()
    setPage(1)
    setFilters({ ...draft, keyword: draft.keyword.trim() })
  }

  const clearFilters = () => {
    setDraft(EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
    setPage(1)
  }

  return (
    <AdminShell
      title="操作审计"
      description="追踪工作表内容、结构、保护规则和版本恢复记录"
      summary={(
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm text-slate-500">匹配记录</div>
            <div className="mt-1 text-2xl font-semibold text-slate-950">{total.toLocaleString('zh-CN')}</div>
          </div>
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-sky-50 text-sky-700"><ScrollText className="h-5 w-5" /></div>
        </div>
      )}
    >
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
        <form onSubmit={submitFilters} className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_180px_150px_150px_150px_auto]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={draft.keyword} onChange={(event) => setDraft((current) => ({ ...current, keyword: event.target.value }))} maxLength={200} placeholder="搜索员工、工作簿、工作表或摘要" className="h-10 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100" />
          </label>
          <select value={draft.action} onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300">
            <option value="">全部操作</option>
            {Object.entries(ACTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={draft.source} onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))} className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-sky-300">
            <option value="">全部来源</option>
            {Object.entries(SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <input type="date" value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} aria-label="开始日期" className="h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 outline-none focus:border-sky-300" />
          <input type="date" value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} aria-label="结束日期" className="h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-600 outline-none focus:border-sky-300" />
          <div className="flex gap-2">
            <button type="submit" className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800"><Search className="h-4 w-4" />查询</button>
            <button type="button" onClick={clearFilters} className="ui-tooltip inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50" title="清空筛选"><FilterX className="h-4 w-4" /></button>
            <button type="button" onClick={() => setReloadToken((value) => value + 1)} disabled={loading} className="ui-tooltip inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40" title="刷新记录"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
          </div>
        </form>
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        {error && <div className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
        {loading ? (
          <div className="flex h-52 items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />正在加载审计记录...</div>
        ) : logs.length === 0 ? (
          <div className="flex h-52 flex-col items-center justify-center text-sm text-slate-400"><ScrollText className="mb-3 h-8 w-8 text-slate-300" />未找到匹配记录</div>
        ) : (
          <div className="divide-y divide-slate-200">
            {logs.map((log) => {
              const metadata = log.metadata && Object.keys(log.metadata).length > 0 ? log.metadata : null
              return (
                <article key={log.id} className="px-4 py-4 md:px-5">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600"><ScrollText className="h-4 w-4" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">{ACTION_LABELS[log.action] || log.action}</span>
                        <span className="rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">{SOURCE_LABELS[log.source] || log.source || '未知来源'}</span>
                        {cellLabel(log) && <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">{cellLabel(log)}</span>}
                      </div>
                      <p className="mt-1 text-sm leading-6 text-slate-600">{log.summary || '未提供操作摘要'}</p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                        <span className="inline-flex items-center gap-1"><UserRound className="h-3.5 w-3.5" />{log.username || `用户 #${log.user_id || '-'}`}</span>
                        <span className="inline-flex items-center gap-1"><FileSpreadsheet className="h-3.5 w-3.5" />{[log.workbook_name, log.sheet_name].filter(Boolean).join(' / ') || `${log.resource_type || '资源'} #${log.resource_id || '-'}`}</span>
                        <span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />{formatTime(log.created_at)}</span>
                      </div>
                      {metadata && (
                        <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                          <summary className="cursor-pointer text-xs font-medium text-slate-600">查看结构化详情</summary>
                          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-slate-500">{JSON.stringify(metadata, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}

        <footer className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500 md:px-5">
          <span>第 {page} / {totalPages} 页</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || loading} className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"><ChevronLeft className="h-4 w-4" />上一页</button>
            <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages || loading} className="inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">下一页<ChevronRight className="h-4 w-4" /></button>
          </div>
        </footer>
      </section>
    </AdminShell>
  )
}
