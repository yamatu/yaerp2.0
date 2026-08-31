'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Clock3, Eye, History, Loader2, RefreshCcw, RotateCcw, Save, ShieldCheck, UserRound, X } from 'lucide-react'
import api from '@/lib/api'
import type { OperationLog, PageData, SheetVersion, SheetVersionDiff } from '@/types'

interface Props {
  sheetId: number
  sheetName: string
  canManage: boolean
  onClose: () => void
  onBeforeMutation: () => Promise<void>
  onRestored: () => Promise<void> | void
}

type HistoryTab = 'versions' | 'audit'

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
  'sheet.update': '更新内容或格式',
  'sheet.rename': '重命名工作表',
  'sheet.column.insert': '新增列',
  'sheet.column.format': '设置列格式',
  'sheet.range.format': '设置区域格式',
  'sheet.state.update': '更新工作表状态',
  'sheet.sync': '同步工作表',
  'sheet.version.checkpoint': '保存检查点',
  'sheet.version.restore': '恢复历史版本',
  'sheet.snapshot.invalidate': '刷新缓存',
  'cell.update': '修改单元格',
  'row.insert': '插入行',
  'row.delete': '删除行',
  'protection.update': '更新保护规则',
  'protection.batch_update': '批量更新保护规则',
}

function formatHistoryTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function displayValue(value: unknown) {
  if (value === undefined) return '空'
  if (value === null) return '空'
  if (typeof value === 'string') return value || '空'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const encoded = JSON.stringify(value)
    return encoded.length > 80 ? `${encoded.slice(0, 77)}...` : encoded
  } catch {
    return String(value)
  }
}

function VersionDiffView({ diff }: { diff: SheetVersionDiff }) {
  const fieldLabels: Record<string, string> = {
    name: '工作表名称', sort_order: '排序位置', columns: '列结构', frozen: '冻结区域', config: '格式与保护配置',
  }

  return (
    <div className="space-y-3 border-t border-slate-200 bg-slate-50 px-3 py-3">
      <div className="grid grid-cols-4 gap-2">
        {[
          ['单元格', diff.changed_cells],
          ['新增行', diff.added_rows],
          ['删除行', diff.removed_rows],
          ['修改行', diff.modified_rows],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-center">
            <div className="text-sm font-semibold text-slate-800">{value}</div>
            <div className="mt-0.5 text-[10px] text-slate-400">{label}</div>
          </div>
        ))}
      </div>
      {diff.field_changes.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-600">结构变化</div>
          {diff.field_changes.map((change) => (
            <div key={change.field} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-600">
              {fieldLabels[change.field] || change.field}
            </div>
          ))}
        </div>
      )}
      {diff.cell_changes.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600">
            <span>单元格变化</span>
            {diff.cell_changes_limited && <span className="font-normal text-amber-600">仅显示前 500 项</span>}
          </div>
          <div className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
            {diff.cell_changes.map((change, index) => (
              <div key={`${change.row}-${change.column}-${index}`} className="grid grid-cols-[74px_1fr] gap-2 px-2.5 py-2 text-xs">
                <span className="font-semibold text-sky-700">{change.column}{change.row + 2}</span>
                <span className="min-w-0 truncate text-slate-500" title={`${displayValue(change.old_value)} -> ${displayValue(change.new_value)}`}>
                  {displayValue(change.old_value)} <span className="text-slate-300">→</span> {displayValue(change.new_value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {diff.changed_cells === 0 && diff.field_changes.length === 0 && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">此版本与当前工作表内容一致。</div>
      )}
    </div>
  )
}

export default function SheetHistoryPanel({ sheetId, sheetName, canManage, onClose, onBeforeMutation, onRestored }: Props) {
  const [tab, setTab] = useState<HistoryTab>('versions')
  const [versions, setVersions] = useState<SheetVersion[]>([])
  const [logs, setLogs] = useState<OperationLog[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [checkpointName, setCheckpointName] = useState('')
  const [expandedVersionId, setExpandedVersionId] = useState<number | null>(null)
  const [diff, setDiff] = useState<SheetVersionDiff | null>(null)

  const loadVersions = useCallback(async () => {
    const response = await api.get<PageData<SheetVersion>>(`/sheets/${sheetId}/versions?page=1&size=50`)
    if (response.code !== 0 || !response.data) throw new Error(response.message || '加载版本历史失败')
    setVersions(Array.isArray(response.data.list) ? response.data.list : [])
  }, [sheetId])

  const loadLogs = useCallback(async () => {
    const response = await api.get<PageData<OperationLog>>(`/sheets/${sheetId}/audit-logs?page=1&size=50`)
    if (response.code !== 0 || !response.data) throw new Error(response.message || '加载操作记录失败')
    setLogs(Array.isArray(response.data.list) ? response.data.list : [])
  }, [sheetId])

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      await Promise.all([loadVersions(), loadLogs()])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载历史失败')
    } finally {
      setLoading(false)
    }
  }, [loadLogs, loadVersions])

  useEffect(() => {
    void reload()
  }, [reload])

  const latestVersionNumber = useMemo(() => versions[0]?.version_number || 0, [versions])

  const createCheckpoint = async () => {
    if (!canManage || busy) return
    setBusy('checkpoint')
    setError('')
    try {
      await onBeforeMutation()
      const response = await api.post<SheetVersion>(`/sheets/${sheetId}/versions`, { summary: checkpointName.trim() })
      if (response.code !== 0) throw new Error(response.message || '保存检查点失败')
      setCheckpointName('')
      await reload()
    } catch (checkpointError) {
      setError(checkpointError instanceof Error ? checkpointError.message : '保存检查点失败')
    } finally {
      setBusy('')
    }
  }

  const toggleDiff = async (version: SheetVersion) => {
    if (!version.can_view_details) return
    if (expandedVersionId === version.id) {
      setExpandedVersionId(null)
      setDiff(null)
      return
    }
    setExpandedVersionId(version.id)
    setDiff(null)
    setBusy(`diff:${version.id}`)
    setError('')
    try {
      const response = await api.get<SheetVersionDiff>(`/sheets/${sheetId}/versions/${version.id}/diff`)
      if (response.code !== 0 || !response.data) throw new Error(response.message || '加载版本差异失败')
      setDiff(response.data)
    } catch (diffError) {
      setError(diffError instanceof Error ? diffError.message : '加载版本差异失败')
      setExpandedVersionId(null)
    } finally {
      setBusy('')
    }
  }

  const restoreVersion = async (version: SheetVersion) => {
    if (!version.can_restore || busy) return
    if (!window.confirm(`确定将「${sheetName}」恢复到 V${version.version_number} 吗？系统会先自动保存当前状态。`)) return
    setBusy(`restore:${version.id}`)
    setError('')
    try {
      await onBeforeMutation()
      const response = await api.post<SheetVersion>(`/sheets/${sheetId}/versions/${version.id}/restore`, {
        reason: `从历史面板恢复到 V${version.version_number}`,
      })
      if (response.code !== 0) throw new Error(response.message || '恢复版本失败')
      await onRestored()
      onClose()
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : '恢复版本失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="fixed inset-0 z-[140] flex justify-end bg-slate-950/20" role="dialog" aria-label="工作表历史">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="关闭工作表历史" />
      <aside className="relative flex h-full w-full max-w-[520px] flex-col border-l border-slate-200 bg-white shadow-2xl">
        <header className="border-b border-slate-200 px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-base font-semibold text-slate-900"><History className="h-5 w-5 text-sky-600" />版本与操作历史</div>
              <div className="mt-1 truncate text-xs text-slate-500">{sheetName} · {latestVersionNumber ? `当前 V${latestVersionNumber}` : '尚未建立版本'}</div>
            </div>
            <div className="flex shrink-0 gap-1">
              <button type="button" onClick={() => void reload()} disabled={loading} className="ui-tooltip flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40" title="刷新历史"><RefreshCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
              <button type="button" onClick={onClose} className="ui-tooltip flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="关闭"><X className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 rounded-lg bg-slate-100 p-1">
            <button type="button" onClick={() => setTab('versions')} className={`h-9 rounded-md text-xs font-semibold transition ${tab === 'versions' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>版本历史</button>
            <button type="button" onClick={() => setTab('audit')} className={`h-9 rounded-md text-xs font-semibold transition ${tab === 'audit' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>操作记录</button>
          </div>
        </header>

        {canManage && tab === 'versions' && (
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex gap-2">
              <input value={checkpointName} onChange={(event) => setCheckpointName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createCheckpoint() }} maxLength={256} placeholder="检查点说明（可选）" className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100" />
              <button type="button" onClick={() => void createCheckpoint()} disabled={Boolean(busy)} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"><Save className="h-4 w-4" />保存检查点</button>
            </div>
          </div>
        )}

        {error && <div className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error}</div>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex h-48 items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />正在加载历史...</div>
          ) : tab === 'versions' ? (
            versions.length === 0 ? <div className="px-4 py-12 text-center text-sm text-slate-400">还没有版本记录</div> : (
              <div className="divide-y divide-slate-200">
                {versions.map((version, index) => {
                  const isCurrent = index === 0
                  const isExpanded = expandedVersionId === version.id
                  const diffLoading = busy === `diff:${version.id}`
                  return (
                    <section key={version.id}>
                      <div className="px-4 py-3">
                        <div className="flex items-start gap-3">
                          <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${version.source === 'restore' ? 'bg-amber-50 text-amber-700' : version.source === 'ai' ? 'bg-emerald-50 text-emerald-700' : 'bg-sky-50 text-sky-700'}`}>
                            {version.source === 'restore' ? <RotateCcw className="h-4 w-4" /> : version.source === 'checkpoint' ? <Save className="h-4 w-4" /> : <Clock3 className="h-4 w-4" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-slate-900">V{version.version_number}</span>
                              {isCurrent && <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700"><Check className="h-3 w-3" />当前</span>}
                              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{SOURCE_LABELS[version.source] || version.source}</span>
                              {version.change_count > 1 && <span className="text-[10px] text-slate-400">合并 {version.change_count} 次保存</span>}
                            </div>
                            <div className="mt-1 text-xs leading-5 text-slate-600">{version.summary || '更新工作表'}</div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
                              <span className="inline-flex items-center gap-1"><UserRound className="h-3 w-3" />{version.created_by_name || '系统'}</span>
                              <span>{formatHistoryTime(version.updated_at)}</span>
                              {version.restored_from_version && <span>来源 V{version.restored_from_version}</span>}
                            </div>
                          </div>
                        </div>
                        <div className="mt-3 flex justify-end gap-2">
                          {version.can_view_details && <button type="button" onClick={() => void toggleDiff(version)} disabled={Boolean(busy) && !diffLoading} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40">{diffLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}差异<ChevronDown className={`h-3.5 w-3.5 transition ${isExpanded ? 'rotate-180' : ''}`} /></button>}
                          {version.can_restore && !isCurrent && <button type="button" onClick={() => void restoreVersion(version)} disabled={Boolean(busy)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 text-xs font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-40">{busy === `restore:${version.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}恢复</button>}
                        </div>
                      </div>
                      {isExpanded && diff && diff.version.id === version.id && <VersionDiffView diff={diff} />}
                    </section>
                  )
                })}
              </div>
            )
          ) : logs.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-slate-400">还没有操作记录</div>
          ) : (
            <div className="divide-y divide-slate-200">
              {logs.map((log) => (
                <div key={log.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><ShieldCheck className="h-4 w-4" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-slate-800">{ACTION_LABELS[log.action] || log.action}</span><span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{SOURCE_LABELS[log.source] || log.source}</span></div>
                      <div className="mt-1 text-xs leading-5 text-slate-500">{log.summary || '工作表发生变更'}</div>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-slate-400"><span>{log.username || '系统'}</span><span>{formatHistoryTime(log.created_at)}</span>{log.column_key && typeof log.row_index === 'number' && <span>{log.column_key}{log.row_index + 2}</span>}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
