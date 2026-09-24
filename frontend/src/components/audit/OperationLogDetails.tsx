'use client'

import { ArrowRight } from 'lucide-react'
import type { OperationLog } from '@/types'

interface CellChange {
  row: number
  column: string
  old_value?: unknown
  new_value?: unknown
  kind?: string
}

interface FieldChange {
  field: string
  old_value?: unknown
  new_value?: unknown
}

const FIELD_LABELS: Record<string, string> = {
  name: '工作表名称',
  sort_order: '排序位置',
  columns: '列结构',
  frozen: '冻结区域',
  config: '格式与保护配置',
}

const META_LABELS: Record<string, string> = {
  workbook_id: '工作簿 ID',
  workbook_name: '工作簿',
  sheet_name: '工作表',
  source_sheet_id: '来源工作表 ID',
  source_workbook_id: '来源工作簿 ID',
  source_workbook_name: '来源工作簿',
  folder_id: '文件夹 ID',
  recipient_user_id: '接收人 ID',
  assigned_by: '分配人 ID',
  assigned_at: '分配时间',
  state_action: '状态操作',
  version_id: '版本 ID',
  version_number: '版本号',
  restored_from_id: '来源版本 ID',
  restored_from_version: '来源版本号',
  before_checksum: '变更前校验',
  after_checksum: '变更后校验',
  duration_ms: '处理耗时',
  changed_cells: '变更单元格',
  added_rows: '新增行',
  removed_rows: '删除行',
  modified_rows: '修改行',
  cell_changes: '单元格变化',
  cell_changes_limited: '变化已截断',
  field_changes: '结构变化',
}

const STAT_KEYS: Array<{ key: string; label: string; tone: string }> = [
  { key: 'changed_cells', label: '变更单元格', tone: 'text-sky-700 bg-sky-50 border-sky-100' },
  { key: 'added_rows', label: '新增行', tone: 'text-emerald-700 bg-emerald-50 border-emerald-100' },
  { key: 'removed_rows', label: '删除行', tone: 'text-rose-700 bg-rose-50 border-rose-100' },
  { key: 'modified_rows', label: '修改行', tone: 'text-amber-700 bg-amber-50 border-amber-100' },
]

const SECTION_KEYS = new Set([
  ...STAT_KEYS.map((item) => item.key),
  'cell_changes',
  'cell_changes_limited',
  'field_changes',
])

const CHECKSUM_KEYS = new Set(['before_checksum', 'after_checksum'])
const VERSION_KEYS = new Set(['version_number', 'restored_from_version'])
const ID_KEYS = new Set([
  'workbook_id',
  'source_sheet_id',
  'source_workbook_id',
  'folder_id',
  'recipient_user_id',
  'assigned_by',
  'version_id',
  'restored_from_id',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCellChange(value: unknown): value is CellChange {
  return isRecord(value) && typeof value.row === 'number' && typeof value.column === 'string'
}

function isFieldChange(value: unknown): value is FieldChange {
  return isRecord(value) && typeof value.field === 'string'
}

export function displayAuditValue(value: unknown): string {
  if (value === undefined || value === null) return '空'
  if (typeof value === 'string') return value || '空'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    const encoded = JSON.stringify(value)
    if (!encoded) return String(value)
    return encoded.length > 120 ? `${encoded.slice(0, 117)}...` : encoded
  } catch {
    return String(value)
  }
}

function formatMetaValue(key: string, value: unknown): { text: string; title?: string; mono?: boolean } {
  if (key === 'duration_ms' && typeof value === 'number') {
    return { text: value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms` }
  }
  if (key === 'cell_changes_limited') {
    return { text: value ? '是（仅保留前 100 条）' : '否' }
  }
  if (VERSION_KEYS.has(key) && typeof value === 'number') {
    return { text: `V${value}` }
  }
  if (ID_KEYS.has(key) && typeof value === 'number') {
    return { text: `#${value}`, mono: true }
  }
  if (CHECKSUM_KEYS.has(key) && typeof value === 'string') {
    return { text: value.slice(0, 12), title: value, mono: true }
  }
  if (key === 'assigned_at' && typeof value === 'string') {
    const date = new Date(value)
    return { text: Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false }) }
  }
  return { text: displayAuditValue(value), mono: isRecord(value) || Array.isArray(value) }
}

export function hasOperationDetails(log: OperationLog): boolean {
  if (log.old_value !== undefined || log.new_value !== undefined) return true
  if (!isRecord(log.metadata)) return false
  return Object.keys(log.metadata).length > 0
}

function ValueChange({ label, before, after }: { label: string; before: unknown; after: unknown }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="rounded bg-rose-50 px-1.5 py-0.5 font-medium text-rose-700">{displayAuditValue(before)}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
        <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-700">{displayAuditValue(after)}</span>
      </div>
    </div>
  )
}

export default function OperationLogDetails({
  log,
  className = '',
  maxCellRows = 100,
}: {
  log: OperationLog
  className?: string
  maxCellRows?: number
}) {
  const metadata = isRecord(log.metadata) ? log.metadata : {}
  const cellChanges = Array.isArray(metadata.cell_changes) ? metadata.cell_changes.filter(isCellChange) : []
  const fieldChanges = Array.isArray(metadata.field_changes) ? metadata.field_changes.filter(isFieldChange) : []
  const stats = STAT_KEYS.map((item) => ({ ...item, value: metadata[item.key] })).filter(
    (item) => typeof item.value === 'number' && item.value > 0,
  )
  const entries = Object.entries(metadata).filter(([key]) => !SECTION_KEYS.has(key))
  const hasTopLevel = log.old_value !== undefined || log.new_value !== undefined
  const isEmpty = !hasTopLevel && stats.length === 0 && fieldChanges.length === 0 && cellChanges.length === 0 && entries.length === 0

  if (isEmpty) {
    return (
      <div className={`rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-400 ${className}`}>
        该操作没有可展示的结构化详情
      </div>
    )
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {hasTopLevel && (
        <ValueChange label="值变更" before={log.old_value} after={log.new_value} />
      )}

      {stats.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stats.map((item) => (
            <div key={item.key} className={`rounded-lg border px-2 py-2 text-center ${item.tone}`}>
              <div className="text-sm font-semibold">{String(item.value)}</div>
              <div className="mt-0.5 text-[10px] opacity-80">{item.label}</div>
            </div>
          ))}
        </div>
      )}

      {fieldChanges.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-slate-600">结构变化</div>
          <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {fieldChanges.map((change, index) => (
              <div key={`${change.field}-${index}`} className="px-2.5 py-2">
                <div className="text-xs font-medium text-slate-700">{FIELD_LABELS[change.field] || change.field}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="max-w-[45%] truncate rounded bg-rose-50 px-1.5 py-0.5 text-rose-700" title={displayAuditValue(change.old_value)}>{displayAuditValue(change.old_value)}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                  <span className="max-w-[45%] truncate rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700" title={displayAuditValue(change.new_value)}>{displayAuditValue(change.new_value)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {cellChanges.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-semibold text-slate-600">
            <span>单元格变化</span>
            <span className="font-normal text-slate-400">
              {cellChanges.length > maxCellRows ? `显示前 ${maxCellRows} / ${cellChanges.length} 项` : `共 ${cellChanges.length} 项`}
              {metadata.cell_changes_limited ? ' · 已截断' : ''}
            </span>
          </div>
          <div className="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
            {cellChanges.slice(0, maxCellRows).map((change, index) => {
              const kind = change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '修改'
              const kindTone = change.kind === 'added'
                ? 'bg-emerald-50 text-emerald-700'
                : change.kind === 'removed'
                  ? 'bg-rose-50 text-rose-700'
                  : 'bg-amber-50 text-amber-700'
              return (
                <div key={`${change.row}-${change.column}-${index}`} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                  <span className="w-14 shrink-0 font-semibold text-sky-700">{change.column}{change.row + 2}</span>
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-medium ${kindTone}`}>{kind}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-500" title={`${displayAuditValue(change.old_value)} -> ${displayAuditValue(change.new_value)}`}>
                    {change.kind !== 'added' && <span className="text-rose-600">{displayAuditValue(change.old_value)}</span>}
                    {change.kind === 'modified' && <ArrowRight className="mx-1 inline h-3 w-3 text-slate-300" />}
                    {change.kind !== 'removed' && <span className="text-emerald-600">{displayAuditValue(change.new_value)}</span>}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <dl className="grid gap-x-4 gap-y-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs sm:grid-cols-2">
          {entries.map(([key, value]) => {
            const formatted = formatMetaValue(key, value)
            const isWide = formatted.mono && formatted.text.length > 40
            return (
              <div key={key} className={`flex min-w-0 items-baseline gap-2 ${isWide ? 'sm:col-span-2' : ''}`}>
                <dt className="shrink-0 text-slate-400">{META_LABELS[key] || key}</dt>
                <dd
                  className={`min-w-0 truncate text-slate-700 ${formatted.mono ? 'font-mono' : ''}`}
                  title={formatted.title || formatted.text}
                >
                  {formatted.text}
                </dd>
              </div>
            )
          })}
        </dl>
      )}
    </div>
  )
}
