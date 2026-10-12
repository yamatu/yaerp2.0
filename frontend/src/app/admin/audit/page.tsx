'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Clock3, FileSpreadsheet, FilterX, RefreshCw, ScrollText, Search, SlidersHorizontal, UserRound } from 'lucide-react'
import { AdminShell } from '@/components/admin/AdminShell'
import { auditHelp } from '@/components/admin/adminHelp'
import { ensureOk, errorText, formatDateTime } from '@/components/admin/adminApi'
import OperationLogDetails, { hasOperationDetails } from '@/components/audit/OperationLogDetails'
import { Button, EmptyState, Field, IconButton, LoadingState, Notice, Pagination, SectionCard, SelectInput, StatusBadge, TextInput, type Tone } from '@/components/admin/ui'
import api from '@/lib/api'
import type { OperationLog, PageData } from '@/types'

const PAGE_SIZE = 50

const ACTION_GROUPS: Array<{ label: string; actions: Record<string, string> }> = [
  {
    label: '数据',
    actions: { 'cell.update': '修改单元格', 'row.insert': '插入行', 'row.delete': '删除行' },
  },
  {
    label: '工作表',
    actions: {
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
      'sheet.snapshot.invalidate': '刷新表格缓存',
    },
  },
  {
    label: '工作簿',
    actions: {
      'workbook.create': '创建工作簿',
      'workbook.duplicate': '复制工作簿',
      'workbook.update': '更新工作簿',
      'workbook.delete': '删除工作簿',
      'workbook.state.update': '更新工作簿状态',
      'workbook.assign': '发放工作簿',
    },
  },
  {
    label: '版本与保护',
    actions: {
      'sheet.version.checkpoint': '保存检查点',
      'sheet.version.restore': '恢复历史版本',
      'protection.update': '更新保护规则',
      'protection.batch_update': '批量更新保护规则',
    },
  },
  {
    label: '自动化',
    actions: {
      'automation.rule.create': '创建自动化规则',
      'automation.rule.update': '修改自动化规则',
      'automation.rule.delete': '删除自动化规则',
      'automation.run.manual': '手动运行自动化',
    },
  },
]

const ACTION_LABELS: Record<string, string> = Object.assign({}, ...ACTION_GROUPS.map((group) => group.actions))

const SOURCE_META: Record<string, { label: string; tone: Tone }> = {
  web: { label: '手工编辑', tone: 'slate' },
  ai: { label: 'AI 助手', tone: 'violet' },
  import: { label: 'Excel 导入', tone: 'sky' },
  sync: { label: '任务同步', tone: 'sky' },
  restore: { label: '版本恢复', tone: 'amber' },
  checkpoint: { label: '手动检查点', tone: 'slate' },
  baseline: { label: '初始状态', tone: 'slate' },
  automation: { label: '自动化', tone: 'emerald' },
  approval: { label: '审批写入', tone: 'emerald' },
  system: { label: '系统操作', tone: 'slate' },
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

function cellLabel(log: OperationLog) {
  if (log.row_index === undefined || log.row_index === null || !log.column_key) return ''
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
  const [filtersOpen, setFiltersOpen] = useState(false)

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / PAGE_SIZE)), [total])
  const activeFilterCount = Object.values(filters).filter(Boolean).length

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
      ensureOk(response, '加载操作审计失败')
      setLogs(Array.isArray(response.data?.list) ? response.data!.list : [])
      setTotal(response.data?.total || 0)
    } catch (loadError) {
      setLogs([])
      setTotal(0)
      setError(errorText(loadError, '加载操作审计失败'))
    } finally {
      setLoading(false)
    }
    // reloadToken forces a refetch with identical filters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page, reloadToken])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  const submitFilters = (event: FormEvent) => {
    event.preventDefault()
    if (draft.from && draft.to && draft.from > draft.to) {
      setError('开始日期不能晚于结束日期')
      return
    }
    setPage(1)
    setFilters({ ...draft, keyword: draft.keyword.trim() })
    setFiltersOpen(false)
  }

  const clearFilters = () => {
    setDraft(EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
    setPage(1)
  }

  return (
    <AdminShell
      title="操作审计"
      description="表格修改、版本恢复与自动化规则变更记录"
      help={auditHelp}
      actions={<IconButton icon={RefreshCw} label="刷新记录" spin={loading} onClick={() => setReloadToken((value) => value + 1)} />}
    >
      <SectionCard
        title="筛选"
        description={activeFilterCount ? `已启用 ${activeFilterCount} 个筛选条件 · 匹配 ${total.toLocaleString('zh-CN')} 条` : `共 ${total.toLocaleString('zh-CN')} 条记录`}
        icon={SlidersHorizontal}
        bodyClassName={filtersOpen ? '' : 'hidden md:block'}
        actions={
          <Button size="sm" className="md:hidden" icon={SlidersHorizontal} onClick={() => setFiltersOpen((value) => !value)}>
            {filtersOpen ? '收起' : activeFilterCount ? `筛选（${activeFilterCount}）` : '展开筛选'}
          </Button>
        }
      >
        <form onSubmit={submitFilters} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(200px,1fr)_170px_140px_150px_150px_auto] lg:items-end">
          <Field label="关键词" className="sm:col-span-2 lg:col-span-1">
            <TextInput value={draft.keyword} onChange={(event) => setDraft((current) => ({ ...current, keyword: event.target.value }))} maxLength={200} placeholder="员工、工作簿、工作表或摘要" />
          </Field>
          <Field label="操作类型">
            <SelectInput value={draft.action} onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))}>
              <option value="">全部操作</option>
              {ACTION_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {Object.entries(group.actions).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </SelectInput>
          </Field>
          <Field label="来源">
            <SelectInput value={draft.source} onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))}>
              <option value="">全部来源</option>
              {Object.entries(SOURCE_META).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </SelectInput>
          </Field>
          <Field label="开始日期">
            <TextInput type="date" value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} />
          </Field>
          <Field label="结束日期">
            <TextInput type="date" value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} />
          </Field>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
            <Button type="submit" variant="primary" icon={Search} className="flex-1">
              查询
            </Button>
            <IconButton icon={FilterX} label="清空筛选" onClick={clearFilters} disabled={!activeFilterCount && !Object.values(draft).some(Boolean)} />
          </div>
        </form>
      </SectionCard>

      {error && <Notice tone="danger" onClose={() => setError('')}>{error}</Notice>}

      <SectionCard title="审计记录" description="按时间倒序，最新的在最前" icon={ScrollText} flush>
        {loading && logs.length === 0 ? (
          <LoadingState label="正在加载审计记录…" />
        ) : logs.length === 0 ? (
          <EmptyState icon={ScrollText} title="未找到匹配记录" description={activeFilterCount ? '试试放宽筛选条件。' : '还没有任何记录。'} action={activeFilterCount ? <Button icon={FilterX} onClick={clearFilters}>清空筛选</Button> : undefined} />
        ) : (
          <ul className={`divide-y divide-slate-100 ${loading ? 'opacity-60' : ''}`}>
            {logs.map((log) => {
              const source = SOURCE_META[log.source] || { label: log.source || '未知来源', tone: 'slate' as Tone }
              return (
                <li key={log.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-slate-900">{ACTION_LABELS[log.action] || log.action}</span>
                    <StatusBadge tone={source.tone}>{source.label}</StatusBadge>
                    {cellLabel(log) && <StatusBadge tone="amber">{cellLabel(log)}</StatusBadge>}
                  </div>
                  <p className="mt-1 break-words text-sm leading-6 text-slate-600">{log.summary || '未提供操作摘要'}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1">
                      <UserRound className="h-3.5 w-3.5" />
                      {log.username || `用户 #${log.user_id || '-'}`}
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{[log.workbook_name, log.sheet_name].filter(Boolean).join(' / ') || `${log.resource_type || '资源'} #${log.resource_id || '-'}`}</span>
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 className="h-3.5 w-3.5" />
                      {formatDateTime(log.created_at)}
                    </span>
                  </div>
                  {hasOperationDetails(log) && (
                    <details className="group mt-2 rounded-lg border border-slate-200 bg-slate-50">
                      <summary className="flex min-h-10 cursor-pointer items-center px-3 text-xs font-medium text-slate-600 md:min-h-9">查看详情（修改前后对比）</summary>
                      <div className="border-t border-slate-200 px-3 py-2">
                        <OperationLogDetails log={log} />
                      </div>
                    </details>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <Pagination page={page} totalPages={totalPages} total={total} disabled={loading} onChange={setPage} />
      </SectionCard>
    </AdminShell>
  )
}
