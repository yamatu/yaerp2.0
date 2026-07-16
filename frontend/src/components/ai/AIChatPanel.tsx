'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import Link from 'next/link'
import { BarChart3, Bot, Check, CheckCircle2, ChevronDown, ChevronRight, Clock3, Download, ExternalLink, FileSpreadsheet, Loader2, Maximize2, Minimize2, MoveDiagonal2, RefreshCw, RotateCcw, Search, Send, Sparkles, Table2, Trash2, Wand2, X } from 'lucide-react'
import AIMessageContent from '@/components/ai/AIMessageContent'
import { useWorkbooks } from '@/hooks/useSheet'
import { isBooleanPreference, isNullablePositiveIntegerPreference, useUserPreference } from '@/hooks/useUserPreference'
import api from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import { notifyDataChanged, prepareDataMutation } from '@/lib/dataEvents'
import type { AIAssistant, AIChatResponse, AIChatToolTrace, AISpreadsheetOperation, Workbook } from '@/types'

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

interface PanelSize {
  width: number
  height: number
}

const DEFAULT_PANEL_SIZE: PanelSize = { width: 576, height: 720 }
const MIN_PANEL_WIDTH = 360
const MIN_PANEL_HEIGHT = 420

type AIIdeaIcon = 'sparkles' | 'table' | 'chart' | 'wand'

interface AIIdea {
  label: string
  icon: AIIdeaIcon
  buildPrompt: (target: string) => string
}

const AI_IDEA_BANK: AIIdea[] = [
  { label: '异常检查', icon: 'sparkles', buildPrompt: (target) => `检查「${target}」中的异常值、重复记录和缺失字段，并按影响程度给出处理建议` },
  { label: '跨表核对', icon: 'table', buildPrompt: (target) => `核对「${target}」与相关工作表中的金额、数量和名称，列出不一致的记录` },
  { label: '趋势洞察', icon: 'chart', buildPrompt: (target) => `分析「${target}」的时间趋势、环比变化和主要波动原因，并给出结论` },
  { label: '自动排版', icon: 'wand', buildPrompt: (target) => `优化「${target}」的表头、数字格式、颜色层级和列宽，先给我预览方案` },
  { label: '经营周报', icon: 'chart', buildPrompt: (target) => `根据「${target}」生成本周经营摘要，突出关键指标、风险和待跟进事项` },
  { label: '回款分析', icon: 'table', buildPrompt: (target) => `从「${target}」识别应收、已收和逾期情况，按客户汇总并标记高风险记录` },
  { label: '库存预警', icon: 'sparkles', buildPrompt: (target) => `检查「${target}」中的库存与出入库变化，找出缺货、积压和异常波动项目` },
  { label: '供应商对比', icon: 'chart', buildPrompt: (target) => `根据「${target}」比较供应商的采购金额、交付和异常情况，给出排序与建议` },
  { label: '任务拆分', icon: 'wand', buildPrompt: (target) => `把「${target}」中的待办事项按负责人、优先级和截止时间整理成可执行清单` },
  { label: '字段清理', icon: 'table', buildPrompt: (target) => `检查「${target}」的字段格式和命名，统一日期、金额、编号并找出脏数据` },
  { label: '客户画像', icon: 'sparkles', buildPrompt: (target) => `基于「${target}」按客户汇总交易、频次和金额，识别重点客户与流失风险` },
  { label: '管理摘要', icon: 'chart', buildPrompt: (target) => `把「${target}」整理成管理层可快速阅读的摘要，包含结论、图表建议和行动项` },
]

type ToolTraceRenderItem =
  | { kind: 'single'; trace: AIChatToolTrace; sourceIndex: number }
  | { kind: 'query-sheet-group'; traces: AIChatToolTrace[]; sourceIndex: number }

function normalizeSearchText(value: string | null | undefined) {
  return (value || '').normalize('NFKC').toLocaleLowerCase('zh-CN').trim()
}

function shuffleIdeas(seed: number) {
  const ideas = [...AI_IDEA_BANK]
  let state = seed || 1
  for (let index = ideas.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    const swapIndex = state % (index + 1)
    ;[ideas[index], ideas[swapIndex]] = [ideas[swapIndex], ideas[index]]
  }
  return ideas
}

function groupToolTraces(traces: AIChatToolTrace[]): ToolTraceRenderItem[] {
  const querySheetTraces = traces.filter((trace) => trace.name === 'query_sheet')
  if (querySheetTraces.length <= 1) {
    return traces.map((trace, sourceIndex) => ({ kind: 'single', trace, sourceIndex }))
  }

  const items: ToolTraceRenderItem[] = []
  let queryGroupAdded = false
  traces.forEach((trace, sourceIndex) => {
    if (trace.name === 'query_sheet') {
      if (!queryGroupAdded) {
        items.push({ kind: 'query-sheet-group', traces: querySheetTraces, sourceIndex })
        queryGroupAdded = true
      }
      return
    }
    items.push({ kind: 'single', trace, sourceIndex })
  })
  return items
}

function ideaIcon(icon: AIIdeaIcon) {
  if (icon === 'table') return <Table2 className="h-3 w-3" />
  if (icon === 'chart') return <BarChart3 className="h-3 w-3" />
  if (icon === 'wand') return <Wand2 className="h-3 w-3" />
  return <Sparkles className="h-3 w-3" />
}

function getThinkingProgress(elapsedSeconds: number) {
  if (elapsedSeconds < 3) return { label: '正在理解问题', detail: '分析你的需求和当前对话', progress: 18 + elapsedSeconds * 6 }
  if (elapsedSeconds < 8) return { label: '正在读取上下文', detail: '检查表格范围、权限和相关数据', progress: 38 + (elapsedSeconds - 3) * 5 }
  if (elapsedSeconds < 18) return { label: '正在分析并执行工具', detail: '计算数据或准备表格操作', progress: 63 + (elapsedSeconds - 8) * 2 }
  return { label: '正在整理回答', detail: '生成清晰的结论和操作结果', progress: Math.min(94, 83 + Math.floor((elapsedSeconds - 18) / 4)) }
}

function clampPanelSize(size: PanelSize): PanelSize {
  if (typeof window === 'undefined') return size

  return {
    width: Math.round(Math.min(Math.max(MIN_PANEL_WIDTH, window.innerWidth - 104), Math.max(MIN_PANEL_WIDTH, size.width))),
    height: Math.round(Math.min(Math.max(MIN_PANEL_HEIGHT, window.innerHeight - 40), Math.max(MIN_PANEL_HEIGHT, size.height))),
  }
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function toolTitle(name: string) {
  switch (name) {
    case 'get_user_context':
      return '访问范围'
    case 'query_sheet':
      return '读取工作表'
    case 'search_spreadsheets':
      return '跨表搜索'
    case 'search_sheet_rows':
      return '工作表搜索'
    case 'lookup_sheet_records':
      return '记录查询'
    case 'calculate_sheet_metrics':
      return '表格统计'
    case 'calculate_expression':
      return '数据计算'
    case 'update_cell':
      return '修改单元格'
    case 'insert_row':
      return '新增数据行'
    case 'delete_row':
      return '删除数据行'
    case 'insert_column':
      return '新增列'
    case 'auto_fill_column':
      return '自动填充'
    case 'generate_report':
      return '生成报表文件'
    case 'schedule_daily_report':
      return '定时报表'
    case 'preview_spreadsheet_plan':
      return '预览修改方案'
    case 'apply_spreadsheet_plan':
      return '执行修改方案'
    case 'run_workflow':
      return '执行表格工作流'
    case 'create_workbook':
      return '创建工作簿'
    case 'create_sheet':
      return '创建工作表'
    case 'update_workbook':
      return '更新工作簿'
    case 'update_sheet_name':
      return '重命名工作表'
    case 'set_cell_format':
      return '设置单元格格式'
    case 'format_cell_range':
      return '设计单元格样式'
    case 'create_financial_report':
      return '创建财务分析工作簿'
    case 'list_summary_pages':
      return '查询 AI 总结页面'
    case 'create_summary_page':
      return '创建 AI 总结页面'
    case 'update_summary_page':
      return '更新 AI 总结页面'
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
        Download {String(data.filename || 'report')}
      </a>
    )
  }

  const openUrl = typeof data.open_url === 'string'
    ? data.open_url
    : typeof data.summary_url === 'string'
      ? data.summary_url
      : ''
  if (openUrl) {
    return (
      <Link href={openUrl} className="inline-flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-700 transition hover:bg-sky-100">
        <ExternalLink className="h-3.5 w-3.5" />
        {trace.name === 'create_financial_report' ? '打开财务报表' : '打开总结页面'}
      </Link>
    )
  }

  if (trace.name === 'schedule_daily_report') {
    return (
      <div className="text-xs leading-6 text-slate-500">
        Task #{String(data.schedule_id || '-')} / TZ {String(data.timezone || '-')} / Cron {String(data.cron_expr || '-')}
      </div>
    )
  }

  if (trace.name === 'query_sheet' && Array.isArray(data.rows)) {
    const previewRows = data.rows.slice(0, 3)
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="rounded-lg bg-slate-100 px-2 py-1 font-medium">
            本页 {String(data.returned_rows ?? data.rows.length)} 行 / 共 {String(data.total_rows ?? data.rows.length)} 行
          </span>
          {data.has_more === true && (
            <span className="rounded-lg bg-amber-50 px-2 py-1 font-medium text-amber-700">
              还有后续数据
            </span>
          )}
          {data.profile_included === true && (
            <span className="rounded-lg bg-sky-50 px-2 py-1 font-medium text-sky-700">
              已生成全表概况
            </span>
          )}
        </div>
        {previewRows.length > 0 && (
          <pre className="max-h-48 overflow-auto rounded-lg bg-slate-950 px-3 py-2 text-[11px] leading-5 text-slate-100">
            {JSON.stringify(previewRows, null, 2)}
          </pre>
        )}
      </div>
    )
  }

  if (trace.name === 'search_spreadsheets' && Array.isArray(data.matches)) {
    return <div className="text-xs leading-6 text-slate-600">{data.matches.length} matches found</div>
  }

  if ((trace.name === 'search_sheet_rows' || trace.name === 'lookup_sheet_records') && Array.isArray(data.rows)) {
    return <div className="text-xs leading-6 text-slate-600">{data.rows.length} rows returned</div>
  }

  if (trace.name === 'calculate_sheet_metrics' && typeof data.matched_rows === 'number') {
    return <div className="text-xs leading-6 text-slate-600">{data.matched_rows} rows analyzed</div>
  }

  if (trace.name === 'calculate_expression' && typeof data.formatted_result === 'string') {
    return (
      <div className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
        {String(data.expression || '')} = {data.formatted_result}
      </div>
    )
  }

  return null
}

function renderTraceData(trace: AIChatToolTrace) {
  if (trace.data === undefined) return null

  return (
    <details className="group/data mt-3 rounded-xl border border-slate-200 bg-slate-50">
      <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-slate-600">
        <span className="group-open/data:hidden">查看精简工具数据</span>
        <span className="hidden group-open/data:inline">收起精简工具数据</span>
      </summary>
      <div className="border-t border-slate-200 px-3 py-3">
        <pre className="overflow-x-auto rounded-xl bg-slate-950 px-3 py-2 text-[11px] leading-5 text-slate-100">
          {JSON.stringify(trace.data, null, 2)}
        </pre>
      </div>
    </details>
  )
}

function ToolTraceCard({ trace }: { trace: AIChatToolTrace }) {
  const touchedSheetIds = Array.isArray(trace.touched_sheet_ids) ? trace.touched_sheet_ids : []
  const visibleSheetIds = touchedSheetIds.slice(0, 3)

  return (
    <details className="group/trace overflow-hidden rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${trace.status === 'success' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
            {trace.name === 'schedule_daily_report' ? <Clock3 className="h-4 w-4" /> : trace.name === 'preview_spreadsheet_plan' ? <Wand2 className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">{toolTitle(trace.name)}</div>
            <div className={`line-clamp-2 text-xs ${trace.status === 'success' ? 'text-emerald-600' : 'text-rose-600'}`}>
              {trace.summary || (trace.status === 'success' ? '执行成功' : '执行失败')}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {visibleSheetIds.map((sheetId) => (
            <span key={sheetId} className="hidden rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500 sm:inline-flex">
              Sheet #{sheetId}
            </span>
          ))}
          {touchedSheetIds.length > visibleSheetIds.length && (
            <span className="hidden rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500 sm:inline-flex">
              +{touchedSheetIds.length - visibleSheetIds.length}
            </span>
          )}
          <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-open/trace:rotate-90" />
        </div>
      </summary>
      <div className="border-t border-slate-200 bg-slate-50/60 px-3 py-3">
        {renderTracePreview(trace)}
        {renderTraceData(trace)}
      </div>
    </details>
  )
}

function QuerySheetTraceItem({ trace, index }: { trace: AIChatToolTrace; index: number }) {
  const [open, setOpen] = useState(false)
  const data = trace.data as Record<string, unknown> | undefined
  const sheetName = typeof data?.sheet_name === 'string' && data.sheet_name.trim()
    ? data.sheet_name.trim()
    : typeof data?.sheet_id === 'number'
      ? `Sheet #${data.sheet_id}`
      : `读取记录 ${index + 1}`
  const returned = typeof data?.returned_rows === 'number' ? data.returned_rows : Array.isArray(data?.rows) ? data.rows.length : 0
  const total = typeof data?.total_rows === 'number' ? data.total_rows : Array.isArray(data?.rows) ? data.rows.length : 0

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group/query-item overflow-hidden rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform group-open/query-item:rotate-90" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-slate-800">{sheetName}</div>
          <div className={`mt-0.5 truncate text-[11px] ${trace.status === 'success' ? 'text-emerald-600' : 'text-rose-600'}`}>
            {trace.summary || (trace.status === 'success' ? '读取成功' : '读取失败')}
          </div>
        </div>
        <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-[10px] tabular-nums text-slate-500">
          {returned}/{total} 行
        </span>
      </summary>
      {open && (
        <div className="border-t border-slate-200 bg-slate-50/70 px-3 py-3">
          {renderTracePreview(trace)}
          {renderTraceData(trace)}
        </div>
      )}
    </details>
  )
}

function QuerySheetTraceGroup({ traces }: { traces: AIChatToolTrace[] }) {
  const [open, setOpen] = useState(false)
  const sheetIds = Array.from(new Set(traces.flatMap((trace) => {
    const data = trace.data as Record<string, unknown> | undefined
    const dataSheetId = typeof data?.sheet_id === 'number' ? data.sheet_id : null
    return [...(trace.touched_sheet_ids || []), ...(dataSheetId ? [dataSheetId] : [])]
  })))
  const returnedRows = traces.reduce((sum, trace) => {
    const data = trace.data as Record<string, unknown> | undefined
    return sum + (typeof data?.returned_rows === 'number' ? data.returned_rows : Array.isArray(data?.rows) ? data.rows.length : 0)
  }, 0)
  const totalRowsBySheet = new Map<string, number>()
  traces.forEach((trace, index) => {
    const data = trace.data as Record<string, unknown> | undefined
    const key = typeof data?.sheet_id === 'number'
      ? `id:${data.sheet_id}`
      : typeof data?.sheet_name === 'string'
        ? `name:${data.sheet_name}`
        : `trace:${index}`
    const total = typeof data?.total_rows === 'number' ? data.total_rows : Array.isArray(data?.rows) ? data.rows.length : 0
    totalRowsBySheet.set(key, Math.max(totalRowsBySheet.get(key) || 0, total))
  })
  const totalRows = Array.from(totalRowsBySheet.values()).reduce((sum, total) => sum + total, 0)
  const hasMoreCount = traces.filter((trace) => (trace.data as Record<string, unknown> | undefined)?.has_more === true).length
  const failedCount = traces.filter((trace) => trace.status !== 'success').length
  const visibleSheetIds = sheetIds.slice(0, 3)

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group/query-traces overflow-hidden rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${failedCount === 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
            <Bot className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">读取工作表</div>
            <div className={`line-clamp-2 text-xs ${failedCount === 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
              已合并 {traces.length} 次读取 · {totalRowsBySheet.size} 张工作表 · 返回 {returnedRows}/{totalRows} 行{hasMoreCount > 0 ? ` · ${hasMoreCount} 张仍有后续数据` : ''}{failedCount > 0 ? ` · ${failedCount} 次失败` : ''}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {visibleSheetIds.map((sheetId) => (
            <span key={sheetId} className="hidden rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500 sm:inline-flex">
              Sheet #{sheetId}
            </span>
          ))}
          {sheetIds.length > visibleSheetIds.length && (
            <span className="hidden rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500 sm:inline-flex">
              +{sheetIds.length - visibleSheetIds.length}
            </span>
          )}
          <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-open/query-traces:rotate-90" />
        </div>
      </summary>
      {open && (
        <div className="space-y-2 border-t border-slate-200 bg-slate-50/60 p-2.5">
          {traces.map((trace, index) => <QuerySheetTraceItem key={`${trace.name}-${index}`} trace={trace} index={index} />)}
        </div>
      )}
    </details>
  )
}

export default function AIChatPanel({ open, onClose }: AIChatPanelProps) {
  const userId = getStoredUser()?.id ?? 0
  const [messages, setMessages] = useState<PersistedMessage[]>([])
  const [inputValue, setInputValue] = useState('')
  const [loading, setLoading] = useState(false)
  const [thinkingElapsed, setThinkingElapsed] = useState(0)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const [assistants, setAssistants] = useState<AIAssistant[]>([])
  const [assistantId, setAssistantId] = useUserPreference<number | null>(
    userId,
    'ai.assistant-id',
    null,
    isNullablePositiveIntegerPreference
  )
  const [panelSize, setPanelSize] = useState<PanelSize>(DEFAULT_PANEL_SIZE)
  const [resizing, setResizing] = useState(false)
  const [contextPickerOpen, setContextPickerOpen] = useState(false)
  const [contextWorkbookSearch, setContextWorkbookSearch] = useState('')
  const [contextOnlyMine, setContextOnlyMine] = useUserPreference(
    userId,
    'ai.context-only-mine',
    false,
    isBooleanPreference
  )
  const [composerExpanded, setComposerExpanded] = useUserPreference(
    userId,
    'ai.composer-expanded',
    false,
    isBooleanPreference
  )
  const [contextWorkbook, setContextWorkbook] = useState<Workbook | null>(null)
  const [contextSheetIds, setContextSheetIds] = useState<number[]>([])
  const [loadingContextWorkbookId, setLoadingContextWorkbookId] = useState<number | null>(null)
  const [suggestionSeed, setSuggestionSeed] = useState(0)
  const { workbooks } = useWorkbooks()
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const historyReadyRef = useRef(false)
  const storageKey = userId ? `yaerp_ai_chat_history_${userId}` : 'yaerp_ai_chat_history_guest'
  const panelSizeStorageKey = userId ? `yaerp_ai_panel_size_${userId}` : 'yaerp_ai_panel_size_guest'

  const requestMessages = useMemo(
    () => messages.map((item) => ({ role: item.role, content: item.content })),
    [messages]
  )

  const filteredContextWorkbooks = useMemo(() => {
    const keyword = normalizeSearchText(contextWorkbookSearch)
    return [...workbooks]
      .filter((workbook) => !contextOnlyMine || workbook.owner_id === userId)
      .filter((workbook) => {
        if (!keyword) return true
        return [workbook.name, workbook.description, workbook.owner_name, ...(workbook.sheets || []).map((sheet) => sheet.name)]
          .some((value) => normalizeSearchText(value).includes(keyword))
      })
      .sort((left, right) => {
        const ownerOrder = Number(right.owner_id === userId) - Number(left.owner_id === userId)
        return ownerOrder || right.updated_at.localeCompare(left.updated_at) || left.name.localeCompare(right.name, 'zh-CN')
      })
  }, [contextOnlyMine, contextWorkbookSearch, userId, workbooks])

  const filteredContextSheets = useMemo(() => {
    if (!contextWorkbook) return []
    const keyword = normalizeSearchText(contextWorkbookSearch)
    const workbookMatches = [contextWorkbook.name, contextWorkbook.description, contextWorkbook.owner_name]
      .some((value) => normalizeSearchText(value).includes(keyword))
    if (!keyword || workbookMatches) return contextWorkbook.sheets || []
    return (contextWorkbook.sheets || []).filter((sheet) => normalizeSearchText(sheet.name).includes(keyword))
  }, [contextWorkbook, contextWorkbookSearch])

  const suggestionTarget = useMemo(() => {
    if (contextWorkbook) {
      const selectedSheets = (contextWorkbook.sheets || [])
        .filter((sheet) => contextSheetIds.includes(sheet.id))
        .map((sheet) => sheet.name)
      return selectedSheets.length > 0
        ? `${contextWorkbook.name} / ${selectedSheets.slice(0, 2).join('、')}${selectedSheets.length > 2 ? `等 ${selectedSheets.length} 张工作表` : ''}`
        : contextWorkbook.name
    }
    return workbooks.find((workbook) => workbook.owner_id === userId)?.name || workbooks[0]?.name || '当前可访问的表格'
  }, [contextSheetIds, contextWorkbook, userId, workbooks])

  const dynamicSuggestions = useMemo(() => shuffleIdeas(suggestionSeed).slice(0, 3).map((idea) => ({
    ...idea,
    prompt: idea.buildPrompt(suggestionTarget),
  })), [suggestionSeed, suggestionTarget])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [])

  const resizeComposer = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const minimumHeight = composerExpanded ? Math.min(220, Math.max(140, panelSize.height * 0.28)) : 46
    const maximumHeight = composerExpanded ? Math.min(380, panelSize.height * 0.48) : Math.min(168, panelSize.height * 0.26)
    textarea.style.height = 'auto'
    const nextHeight = Math.min(maximumHeight, Math.max(minimumHeight, textarea.scrollHeight))
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? 'auto' : 'hidden'
  }, [composerExpanded, panelSize.height])

  useEffect(() => {
    resizeComposer()
  }, [inputValue, open, resizeComposer])

  useEffect(() => {
    scrollToBottom('smooth')
  }, [messages, scrollToBottom])

  useEffect(() => {
    if (open && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
    if (open) {
      setSuggestionSeed(Date.now())
      setTimeout(() => scrollToBottom('auto'), 80)
    }
  }, [open, scrollToBottom])

  useEffect(() => {
    if (!contextOnlyMine || !contextWorkbook || contextWorkbook.owner_id === userId) return
    setContextWorkbook(null)
    setContextSheetIds([])
  }, [contextOnlyMine, contextWorkbook, userId])

  useEffect(() => {
    if (!open || assistants.length > 0) return
    let active = true
    ;(async () => {
      try {
        const res = await api.get<AIAssistant[]>('/ai/assistants')
        if (!active || res.code !== 0 || !Array.isArray(res.data)) return
        setAssistants(res.data)
        setAssistantId((current) => {
          if (current !== null && res.data?.some((item) => item.id === current)) return current
          return res.data?.find((item) => item.is_default)?.id ?? res.data?.[0]?.id ?? null
        })
      } catch {
        // The chat request will surface configuration errors when needed.
      }
    })()
    return () => { active = false }
  }, [assistants.length, open])

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
      requestAnimationFrame(() => scrollToBottom('auto'))
    }
  }, [scrollToBottom, storageKey])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const saved = JSON.parse(localStorage.getItem(panelSizeStorageKey) || '') as Partial<PanelSize>
      if (typeof saved.width === 'number' && typeof saved.height === 'number') {
        setPanelSize(clampPanelSize({ width: saved.width, height: saved.height }))
      }
    } catch {
      setPanelSize(clampPanelSize(DEFAULT_PANEL_SIZE))
    }

    const handleViewportResize = () => setPanelSize((current) => clampPanelSize(current))
    window.addEventListener('resize', handleViewportResize)
    return () => window.removeEventListener('resize', handleViewportResize)
  }, [panelSizeStorageKey])

  useEffect(() => () => resizeCleanupRef.current?.(), [])

  useEffect(() => {
    const el = messagesScrollRef.current
    if (!el) return

    const handleScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollToBottom(distance > 80)
    }

    handleScroll()
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [open, messages.length])

  useEffect(() => {
    if (!loading) {
      setThinkingElapsed(0)
      return
    }
    const startedAt = Date.now()
    const update = () => setThinkingElapsed(Math.floor((Date.now() - startedAt) / 1000))
    update()
    const timer = window.setInterval(update, 700)
    return () => window.clearInterval(timer)
  }, [loading])

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
      await prepareDataMutation()
      const res = await api.post<AIChatResponse>('/ai/chat', {
        assistant_id: assistantId,
        messages: [...requestMessages, { role: 'user', content: trimmed }],
        context: contextWorkbook ? {
          workbook_id: contextWorkbook.id,
          sheet_ids: contextSheetIds,
        } : undefined,
      })
	  if (res.code !== 0 || !res.data) {
		throw new Error(res.message || 'AI 请求失败')
	  }

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

      if (res.data.resources_changed || (res.data.changed_sheet_ids?.length ?? 0) > 0) {
        notifyDataChanged({
          source: 'ai',
          sheetIds: res.data.changed_sheet_ids || [],
          resourcesChanged: Boolean(res.data.resources_changed),
        })
      }
	} catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: makeId(),
          role: 'assistant',
		  content: error instanceof Error ? error.message : '请求失败，请稍后重试。',
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
      await prepareDataMutation()
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
      notifyDataChanged({
        source: 'ai',
        sheetIds: Array.from(new Set(operations.map((operation) => operation.sheet_id).filter((sheetId) => sheetId > 0))),
        resourcesChanged: false,
      })
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

  const handleResizeStart = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!window.matchMedia('(min-width: 768px)').matches) return

    event.preventDefault()
    event.stopPropagation()
    resizeCleanupRef.current?.()

    const startX = event.clientX
    const startY = event.clientY
    const startSize = panelSize
    setResizing(true)
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: PointerEvent) => {
      setPanelSize(clampPanelSize({
        width: startSize.width + startX - moveEvent.clientX,
        height: startSize.height + startY - moveEvent.clientY,
      }))
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.userSelect = ''
      resizeCleanupRef.current = null
      setResizing(false)
    }

    const handlePointerUp = () => {
      setPanelSize((current) => {
        const nextSize = clampPanelSize(current)
        localStorage.setItem(panelSizeStorageKey, JSON.stringify(nextSize))
        return nextSize
      })
      cleanup()
    }

    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', cleanup)
  }, [panelSize, panelSizeStorageKey])

  const resetPanelSize = useCallback(() => {
    const nextSize = clampPanelSize(DEFAULT_PANEL_SIZE)
    setPanelSize(nextSize)
    localStorage.setItem(panelSizeStorageKey, JSON.stringify(nextSize))
  }, [panelSizeStorageKey])

  const selectContextWorkbook = useCallback(async (workbook: Workbook) => {
    setLoadingContextWorkbookId(workbook.id)
    try {
      const res = await api.get<Workbook>(`/workbooks/${workbook.id}`)
      if (res.code !== 0 || !res.data) return
      setContextWorkbook(res.data)
      setContextSheetIds([])
    } finally {
      setLoadingContextWorkbookId(null)
    }
  }, [])

  const toggleContextSheet = useCallback((sheetId: number) => {
    setContextSheetIds((current) => current.includes(sheetId)
      ? current.filter((id) => id !== sheetId)
      : [...current, sheetId])
  }, [])

  if (!open) return null

  const thinkingProgress = getThinkingProgress(thinkingElapsed)

  return (
    <div
      ref={panelRef}
      className={`fixed inset-x-2 bottom-2 z-50 flex h-[min(82vh,720px)] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl md:inset-x-auto md:bottom-5 md:right-[76px] md:h-[var(--ai-panel-height)] md:max-h-[calc(100vh-40px)] md:w-[var(--ai-panel-width)] ${resizing ? 'select-none' : ''}`}
      style={{
        '--ai-panel-width': `${panelSize.width}px`,
        '--ai-panel-height': `${panelSize.height}px`,
      } as React.CSSProperties}
    >
      <button
        type="button"
        onPointerDown={handleResizeStart}
        className="absolute left-0 top-0 z-10 hidden h-8 w-8 cursor-nwse-resize items-center justify-center text-slate-400 transition hover:text-white md:flex"
        aria-label="拖动调整 AI 对话框大小"
        title="拖动调整大小"
      >
        <MoveDiagonal2 className="h-3.5 w-3.5" />
      </button>
      <div className="flex items-center justify-between bg-slate-900 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3 md:pl-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white">AI 工作助手</h2>
            <select value={assistantId ?? ''} onChange={(event) => setAssistantId(Number(event.target.value) || null)} className="mt-0.5 max-w-[220px] bg-transparent text-[11px] text-slate-300 outline-none">
              {assistants.length === 0 && <option value="">默认助手</option>}
              {assistants.map((assistant) => <option key={assistant.id} value={assistant.id} className="text-slate-900">{assistant.name} · {assistant.model}</option>)}
            </select>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={resetPanelSize}
            className="hidden rounded-lg p-2 text-slate-400 transition hover:bg-slate-800 hover:text-white md:inline-flex"
            aria-label="恢复默认对话框大小"
            title="恢复默认大小"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
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

      <div ref={messagesScrollRef} className="relative flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="mt-6 border-y border-slate-200 bg-slate-50 px-5 py-7 text-center">
            <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Sparkles className="h-6 w-6" />
            </div>
            <div className="text-sm font-semibold text-slate-900">你可以直接这样说</div>
            <div className="mt-3 grid gap-2 text-left text-xs leading-5 text-slate-500 sm:grid-cols-2">
              <div>“查询今天销售表里金额大于 10000 的记录”</div>
              <div>“根据销售和成本表创建财务分析工作簿”</div>
              <div>“把库存表数量加 50，先给我确认方案”</div>
              <div>“用多个工作簿生成经营总结网页”</div>
            </div>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[94%] ${message.role === 'user' ? 'items-end' : 'items-start'} flex flex-col gap-3`}>
              <div
                className={`min-w-0 max-w-full rounded-2xl px-4 py-3 text-sm leading-7 ${
                  message.role === 'user'
                    ? 'whitespace-pre-wrap rounded-br-sm bg-slate-900 text-white'
                    : 'rounded-bl-sm bg-slate-100 text-slate-900'
                }`}
              >
                {message.role === 'assistant'
                  ? <AIMessageContent content={message.content} />
                  : message.content}
              </div>

              {message.role === 'assistant' && Array.isArray(message.toolTraces) && message.toolTraces.length > 0 && (
                <div className="w-full space-y-2">
                  {groupToolTraces(message.toolTraces).map((item) => item.kind === 'query-sheet-group'
                    ? <QuerySheetTraceGroup key={`${message.id}-query-sheet-group-${item.sourceIndex}`} traces={item.traces} />
                    : <ToolTraceCard key={`${message.id}-trace-${item.sourceIndex}`} trace={item.trace} />)}
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
            <div className="w-[min(90%,360px)] rounded-2xl rounded-bl-sm border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 shadow-sm">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-600" />
                <div className="min-w-0 flex-1"><div className="text-xs font-semibold text-slate-800">{thinkingProgress.label}</div><div className="mt-0.5 truncate text-[11px] text-slate-500">{thinkingProgress.detail}</div></div>
                <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{thinkingElapsed}s</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-sky-500 transition-[width] duration-700" style={{ width: `${thinkingProgress.progress}%` }} /></div>
              <div className="mt-1.5 text-[10px] text-slate-400">估算进度 {Math.round(thinkingProgress.progress)}%</div>
            </div>
          </div>
        )}
        {showScrollToBottom && (
          <button
            type="button"
            onClick={() => scrollToBottom('smooth')}
            className="sticky bottom-2 ml-auto flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50"
            title="跳到最新对话"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-slate-200 px-3 py-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {dynamicSuggestions.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => setInputValue(item.prompt)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:bg-white"
              title={item.prompt}
            >
              {ideaIcon(item.icon)}
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setSuggestionSeed(Date.now())}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="换一批 AI 建议"
            title="换一批建议"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <Link href="/ai/summaries" className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-sky-700 hover:bg-sky-50"><BarChart3 className="h-3 w-3" />总结中心</Link>
        </div>
        <div className="relative mb-2">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={() => setContextPickerOpen((current) => !current)} className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition ${contextWorkbook ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`} title="选择 AI 需要读取的工作簿或工作表">
              <Table2 className="h-3.5 w-3.5" />
              {contextWorkbook ? '已选择表格' : '选择表格'}
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {contextWorkbook && (
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                <span className="min-w-0 flex-1 truncate font-medium">{contextWorkbook.name}{contextSheetIds.length > 0 ? ` · ${contextSheetIds.length} 张工作表` : ' · 整个工作簿'}</span>
                <button type="button" onClick={() => { setContextWorkbook(null); setContextSheetIds([]); setContextPickerOpen(false) }} className="shrink-0 text-slate-400 hover:text-slate-700" title="清除表格上下文"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}
          </div>
          {contextPickerOpen && (
            <div className="absolute bottom-full left-0 z-30 mb-2 flex max-h-[min(25rem,calc(100vh-180px))] w-[min(560px,calc(100vw-40px))] flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-2">
                <div className="flex h-9 min-w-[180px] flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs text-slate-500 focus-within:border-amber-300 focus-within:bg-white">
                  <Search className="h-3.5 w-3.5 shrink-0" />
                  <input
                    type="text"
                    value={contextWorkbookSearch}
                    onChange={(event) => setContextWorkbookSearch(event.target.value)}
                    placeholder="搜索工作簿或工作表"
                    aria-label="搜索工作簿或工作表"
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent outline-none"
                  />
                  {contextWorkbookSearch && (
                    <button type="button" onClick={() => setContextWorkbookSearch('')} className="text-slate-400 hover:text-slate-700" title="清除搜索">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setContextOnlyMine((current) => !current)}
                  aria-pressed={contextOnlyMine}
                  className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs font-medium transition ${contextOnlyMine ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}
                >
                  <span className={`flex h-4 w-4 items-center justify-center rounded border ${contextOnlyMine ? 'border-amber-400 bg-amber-400 text-white' : 'border-slate-300'}`}>
                    {contextOnlyMine && <Check className="h-3 w-3" />}
                  </span>
                  仅看自己的工作簿
                </button>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-[minmax(150px,0.9fr)_minmax(170px,1.1fr)] overflow-hidden">
                <div className="min-h-0 overflow-y-auto border-r border-slate-200 p-1.5">
                  <div className="flex items-center justify-between px-2 py-1.5 text-[11px] font-semibold text-slate-400"><span>工作簿</span><span className="font-normal">{filteredContextWorkbooks.length}</span></div>
                  {filteredContextWorkbooks.length === 0 ? (
                    <div className="px-3 py-10 text-center text-xs text-slate-400">没有匹配的工作簿</div>
                  ) : filteredContextWorkbooks.map((workbook) => (
                    <button key={workbook.id} type="button" onClick={() => void selectContextWorkbook(workbook)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition ${contextWorkbook?.id === workbook.id ? 'bg-amber-50 text-amber-900' : 'text-slate-600 hover:bg-slate-50'}`}>
                      {loadingContextWorkbookId === workbook.id ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" />}
                      <span className="min-w-0 flex-1"><span className="block truncate">{workbook.name}</span>{!contextOnlyMine && workbook.owner_id !== userId && <span className="mt-0.5 block truncate text-[10px] text-slate-400">{workbook.owner_name || '其他成员'}</span>}</span>
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                    </button>
                  ))}
                </div>
                <div className="min-h-0 overflow-y-auto p-1.5">
                  <div className="flex items-center justify-between px-2 py-1.5 text-[11px] font-semibold text-slate-400"><span>工作表</span>{contextWorkbook && <button type="button" onClick={() => setContextSheetIds([])} className="font-medium text-amber-700">选择整个工作簿</button>}</div>
                  {!contextWorkbook ? (
                    <div className="px-2 py-8 text-center text-xs text-slate-400">先选择工作簿</div>
                  ) : filteredContextSheets.length === 0 ? (
                    <div className="px-2 py-8 text-center text-xs text-slate-400">没有匹配的工作表</div>
                  ) : filteredContextSheets.map((sheet) => {
                    const selected = contextSheetIds.includes(sheet.id)
                    return <button key={sheet.id} type="button" onClick={() => toggleContextSheet(sheet.id)} className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition ${selected ? 'bg-amber-50 text-amber-900' : 'text-slate-600 hover:bg-slate-50'}`}><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${selected ? 'border-amber-400 bg-amber-400 text-white' : 'border-slate-200'}`}>{selected && <Check className="h-3 w-3" />}</span><span className="min-w-0 flex-1 truncate">{sheet.name}</span></button>
                  })}
                </div>
              </div>
            </div>
          )}
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
            rows={1}
            className="min-h-[46px] flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2.5 text-sm leading-6 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-100"
          />
          <button
            type="button"
            onClick={() => setComposerExpanded((current) => !current)}
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition ${composerExpanded ? 'border-sky-200 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
            aria-label={composerExpanded ? '收起消息输入框' : '放大消息输入框'}
            title={composerExpanded ? '收起输入框' : '放大输入框'}
          >
            {composerExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!inputValue.trim() || loading}
            className="rounded-lg bg-slate-900 p-3 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="发送"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
