'use client'

import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, AlertTriangle, BadgeCheck, Bot, Building2, Check, CheckSquare2, ChevronDown, ChevronUp, ClipboardCheck, Columns3, Download, Eye, EyeOff, FileOutput, FileSpreadsheet, Files, Filter, FilterX, Hash, ImagePlus, ListChecks, LocateFixed, Lock, Plus, Printer, RemoveFormatting, Rows3, Save, Search, Shield, Sigma, Square, Trash2, Unlock, UserRoundCheck, Users, Wrench, X } from 'lucide-react'
import { RANGE_TYPE, CommandType, VerticalAlign, type ICellData, type ILanguagePack, type IWorkbookData, type IWorksheetData } from '@univerjs/core'
import { createUniver, defaultTheme, LocaleType } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import UniverPresetSheetsFilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort'
import UniverPresetSheetsSortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN'
import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link'
import UniverPresetSheetsHyperLinkZhCN from '@univerjs/preset-sheets-hyper-link/locales/zh-CN'
import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation'
import UniverPresetSheetsDataValidationZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN'
import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting'
import UniverPresetSheetsConditionalFormattingZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN'
import UniverSheetsDrawingZhCN from '@univerjs/sheets-drawing-ui/locale/zh-CN'
import { ScrollCommand, SetScrollRelativeCommand, SetZoomRatioCommand, SheetPasteCommand, SheetPasteShortKeyCommand } from '@univerjs/sheets-ui'
import { BEFORE_CELL_EDIT, ClearSelectionContentCommand, SheetInterceptorService } from '@univerjs/sheets'
import api from '@/lib/api'
import { usePermission, resolveCellPermission } from '@/hooks/usePermission'
import { useFloatingDrag } from '@/hooks/useFloatingDrag'
import { isBooleanPreference, useUserPreference } from '@/hooks/useUserPreference'
import { getStoredUser, isAdmin } from '@/lib/auth'
import { imageThumbnailUrl } from '@/lib/imageTransform'
import { buildUniverWorkbookData, deriveColumnsFromUniverSheet, ensureWorksheetVerticalAlign, normalizeUniverNumberFormatPattern, normalizeUniverStyleMap } from '@/lib/univer-sheet'
import { installCellEditorAlignmentRecalculation, registerEditorComposedStyleInterceptor } from '@/lib/univer-editor-alignment'
import { registerCellShiftFormulaRepair } from '@/lib/univer-formula-alignment'
import { registerPasteNotifier, registerPlainTextPaste, registerQuotedClipboardFixes } from '@/lib/univer-clipboard-text'
import { skipEditorTextRepaints } from '@/lib/univer-render-dirty'
import { describeFormulaError, registerFormulaErrorHint, type FormulaErrorHint } from '@/lib/univer-formula-error-hint'
import FormulaErrorTooltip from '@/components/spreadsheet/FormulaErrorTooltip'
import FormulaConsistencyBanner from '@/components/spreadsheet/FormulaConsistencyBanner'
import {
  addPlainTextBadge,
  collectNonPlainTextMarkers,
  convertMarkerToPlainText,
  createWorksheetCellReader,
  PLAIN_TEXT_BADGE_COMPONENT_KEY,
  registerPlainTextConvertMenu,
  resolveScanArea,
  resolveSelectionScanAreas,
  type NonPlainTextMarker,
  type PlainRect,
  type PlainTextBadgeData,
} from '@/lib/univer-plain-text'
import {
  collectSharedFormulaCells,
  createSharedFormulaResolver,
  registerSharedFormulaEditorInterceptor,
  type SharedFormulaResolver,
} from '@/lib/univer-shared-formula'
import { wsClient } from '@/lib/ws'
import { createMarkLayer, watchMarkShapeWipes, type MarkLayer, type MarkShape } from '@/lib/univer-mark-layer'
import {
  describeProtectionArea,
  findProtectionBlockingRemoval,
  findProtectionInRects,
  protectionAreas,
  rangeToRect,
  remapProtectionSnapshot,
  structureOpFromMutation,
  UNBOUNDED_INDEX,
  type StructureOp,
  type WorksheetRect,
} from '@/lib/univer-protection-guard'
import { getRealtimeClientId } from '@/lib/realtimeClient'
import { subscribeDataChanged, subscribePrepareDataMutation } from '@/lib/dataEvents'
import { columnIndexToLetter, parseSheetConfig } from '@/lib/spreadsheet'
import SheetMobileControls, { mobileCellValue, type SheetSearchCell } from '@/components/spreadsheet/SheetMobileControls'
import ImportXlsxButton, { ensureExcelDownloadFilename, EXCEL_IMPORT_FORMATS_LABEL, isSupportedExcelImportFile, uploadWorkbookXlsx } from '@/components/spreadsheet/ImportXlsxButton'
import type { AuthUser, AutomationApprovalStep, AutomationRule, CellApprovalState, CellUpdate, CellUpdateResult, ColumnDef, Department, ProtectionInfo, ProtectionSnapshot, Row, Sheet, SheetPresenceEntry, User } from '@/types'

interface Props {
  workbookId: string | number
  workbookName?: string
  workbookSheets?: Array<Pick<Sheet, 'id' | 'name'>>
  sheet: Sheet
  reloadToken?: string
  permissionToken?: number
  onExternalReload?: () => Promise<void> | void
  optimisticCanEdit?: boolean
  canImportWorkbook?: boolean
}

interface GalleryImage {
  id: number
  filename: string
  url: string
  thumbnail_url?: string
  size: number
}

interface PDFPreviewState {
  url: string
  filename: string
  blob: Blob
}

type PDFExportScope = 'current' | 'selected' | 'workbook'
type PDFPaperSize = 'a4' | 'a3' | 'letter' | 'legal'
type PDFOrientation = 'portrait' | 'landscape'
type NumberFormatScope = 'selection' | 'row' | 'column' | 'sheet'
type FieldControlType = 'select' | 'checkbox' | 'none'

interface ApprovalStepDraft extends AutomationApprovalStep {
  id: string
}

interface SearchableOptionPickerTarget {
  row: number
  column: number
  columnKey: string
  columnName: string
  options: string[]
  optionColors?: ColumnDef['optionColors']
  currentValue: string
}

const OPTION_COLOR_PALETTE = [
  { backgroundColor: '#FEF3C7', textColor: '#92400E' },
  { backgroundColor: '#DCFCE7', textColor: '#166534' },
  { backgroundColor: '#F1F5F9', textColor: '#475569' },
  { backgroundColor: '#DBEAFE', textColor: '#1D4ED8' },
  { backgroundColor: '#FCE7F3', textColor: '#BE185D' },
  { backgroundColor: '#EDE9FE', textColor: '#6D28D9' },
]

const COMMON_OPTION_COLORS: Record<string, { backgroundColor: string; textColor: string }> = {
  '待处理': OPTION_COLOR_PALETTE[0],
  '进行中': OPTION_COLOR_PALETTE[3],
  '已完成': OPTION_COLOR_PALETTE[1],
  '已取消': OPTION_COLOR_PALETTE[2],
  '是': OPTION_COLOR_PALETTE[1],
  '否': { backgroundColor: '#FEE2E2', textColor: '#B91C1C' },
}

function mergeLocaleBundles(...bundles: Array<Record<string, unknown>>): ILanguagePack {
  const mergeInto = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    Object.entries(source).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const existing = target[key]
        const child = existing && typeof existing === 'object' && !Array.isArray(existing)
          ? existing as Record<string, unknown>
          : {}
        target[key] = mergeInto({ ...child }, value as Record<string, unknown>)
      } else {
        target[key] = value
      }
    })
    return target
  }
  return bundles.reduce((result, bundle) => mergeInto(result, bundle), {} as Record<string, unknown>) as ILanguagePack
}

function formatApprovalValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '空'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function optionColorFor(column: ColumnDef, option: string, index: number): { backgroundColor: string; textColor: string } {
  const fallback = COMMON_OPTION_COLORS[option] || OPTION_COLOR_PALETTE[index % OPTION_COLOR_PALETTE.length]
  const configured = column.optionColors?.[option]
  return {
    backgroundColor: configured?.backgroundColor || fallback.backgroundColor,
    textColor: configured?.textColor || fallback.textColor,
  }
}

function newApprovalStep(index = 0): ApprovalStepDraft {
  return {
    id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    name: index === 0 ? '负责人审批' : `审批步骤 ${index + 1}`,
    user_ids: [],
    department_ids: [],
    required_approvals: 1,
  }
}

function applyColumnDataControls(
  univerAPI: ReturnType<typeof createUniver>['univerAPI'],
  worksheet: any,
  columns: ColumnDef[],
  forceColumnKeys: Set<string> = new Set()
) {
  const maxRows = Math.max(worksheet.getMaxRows?.() || 200, 2)
  columns.forEach((column, columnIndex) => {
    const force = forceColumnKeys.has(column.key)
    const range = worksheet.getRange(1, columnIndex, Math.max(maxRows - 1, 1), 1)
    const isControlled = column.type === 'select' || column.type === 'checkbox'

    if (!isControlled) {
      if (force) {
        range.setDataValidation?.(null)
        range.clearConditionalFormatRules?.()
      }
      return
    }

    const options = column.type === 'checkbox'
      ? (column.options?.length ? column.options.slice(0, 2) : ['是', '否'])
      : (column.options || []).filter(Boolean)
    if (options.length === 0) return

    const existingValidations = range.getDataValidations?.() || []
    if (force || existingValidations.length === 0) {
      const builder = univerAPI.newDataValidation()
      const validation = column.type === 'checkbox'
        ? builder.requireCheckbox(options[0] || '是', options[1] || '否')
        : builder.requireValueInList(options, false, true)
      range.setDataValidation(validation.setOptions({
        showErrorMessage: true,
        error: `请选择：${options.join('、')}`,
      }).build())
    }

    const existingConditionalRules = range.getConditionalFormattingRules?.() || []
    if (force) range.clearConditionalFormatRules?.()
    if (!force && existingConditionalRules.length > 0) return
    options.forEach((option, optionIndex) => {
      const color = optionColorFor(column, option, optionIndex)
      const rule = range.createConditionalFormattingRule()
        .whenTextEqualTo(option)
        .setBackground(color.backgroundColor)
        .setFontColor(color.textColor)
        .setBold(true)
        .build()
      worksheet.addConditionalFormattingRule(rule)
    })
  })
}

const NUMBER_FORMAT_PRESETS = [
  { id: 'general', label: '常规', pattern: 'General', sample: '431.7' },
  { id: 'text', label: '文本', pattern: '@', sample: '00123' },
  { id: 'integer', label: '整数', pattern: '0', sample: '432' },
  { id: 'decimal', label: '两位小数', pattern: '0.00', sample: '431.70' },
  { id: 'thousands', label: '千分位', pattern: '#,##0.00', sample: '12,431.70' },
  { id: 'cny', label: '人民币', pattern: '¥#,##0.00;-¥#,##0.00', sample: '¥431.70' },
  { id: 'usd', label: '美元', pattern: '$#,##0.00;-$#,##0.00', sample: '$431.70' },
  { id: 'percentage', label: '百分比', pattern: '0.00%', sample: '43.17%' },
  { id: 'date', label: '日期', pattern: 'yyyy-MM-dd', sample: '2026-07-16' },
  { id: 'datetime', label: '日期时间', pattern: 'yyyy-MM-dd hh:mm', sample: '2026-07-16 14:30' },
  { id: 'time', label: '时间', pattern: 'hh:mm:ss', sample: '14:30:00' },
  { id: 'scientific', label: '科学计数', pattern: '0.00E+00', sample: '4.32E+02' },
] as const

// Shows its label to the left of the wrapped button as soon as the pointer is
// over it. Rendered in a portal with fixed positioning: the expanded tool list
// scrolls, and an absolutely positioned hint inside it is clipped.
function FloatingToolHint({ label, children }: { label: string; children: ReactNode }) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null)
  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ right: window.innerWidth - rect.left + 8, top: rect.top + rect.height / 2 })
  }
  const hide = () => setAnchor(null)
  useEffect(() => {
    if (!anchor) return
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [anchor])
  return (
    <div ref={anchorRef} className="relative" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {anchor && createPortal(
        <span role="tooltip" className="pointer-events-none fixed z-[1200] max-w-[16rem] -translate-y-1/2 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium leading-snug text-white shadow-lg" style={{ right: anchor.right, top: anchor.top }}>
          {label}
        </span>,
        document.body,
      )}
    </div>
  )
}

interface SelectionState {
  rowIndex: number
  displayRowIndex: number
  columnKey: string
  rowLabel: string
  columnLabel: string
  endRowIndex: number
  endDisplayRowIndex: number
  endColumnKey: string
  rangeLabel: string
  includesHeaderRow: boolean
  isEntireColumnSelection: boolean
  isEntireRowSelection: boolean
}

interface IncomingCellChange {
  row: number
  col: string
  value: unknown
}

interface EditingCell {
  row: number
  col: string
}

interface SheetViewMemory {
  version: 2
  selectionRow: number
  selectionColumn: number
  selectionEndRow: number
  selectionEndColumn: number
  viewRow: number
  viewColumn: number
  offsetX: number
  offsetY: number
  updatedAt: number
}

function selectionStatesEqual(left: SelectionState | null, right: SelectionState | null) {
  if (left === right) return true
  if (!left || !right) return false
  return left.rowIndex === right.rowIndex
    && left.displayRowIndex === right.displayRowIndex
    && left.columnKey === right.columnKey
    && left.rowLabel === right.rowLabel
    && left.columnLabel === right.columnLabel
    && left.endRowIndex === right.endRowIndex
    && left.endDisplayRowIndex === right.endDisplayRowIndex
    && left.endColumnKey === right.endColumnKey
    && left.rangeLabel === right.rangeLabel
    && left.includesHeaderRow === right.includesHeaderRow
    && left.isEntireColumnSelection === right.isEntireColumnSelection
    && left.isEntireRowSelection === right.isEntireRowSelection
}

type ProtectionScope = 'row' | 'column' | 'cell'
type ProtectionWhitelistAccess = 'readonly' | 'edit' | 'view_hidden'

interface ProtectionMutationPayload {
  scope: ProtectionScope
  action: 'lock' | 'unlock'
  row_index?: number
  column_key?: string
  readonly_user_ids?: number[]
  readonly_department_ids?: number[]
  editable_user_ids?: number[]
  editable_department_ids?: number[]
  view_hidden_user_ids?: number[]
  view_hidden_department_ids?: number[]
  lock_editing?: boolean
  hidden?: boolean
}

interface PrintableColumn {
  index: number
  key: string
  name: string
  width: number
}

interface PrintableRow {
  sourceRowNumber: number
  cells: string[]
}

interface UniverViewportWorksheet {
  getZoom?: () => number
  zoom?: (zoomRatio: number) => unknown
  getSheetId?: () => string
}

interface UniverViewportWorkbook {
  getId?: () => string
  getActiveSheet?: () => UniverViewportWorksheet | null
}

interface UniverViewportApi {
  getActiveWorkbook?: () => UniverViewportWorkbook | null
  executeCommand?: <P extends object = object>(id: string, params?: P) => Promise<unknown>
}

interface UniverDisposable {
  dispose: () => void
}

interface ProtectionVisual {
  stroke: string
  fill: string
  soft: string
}

interface ProtectionHighlightBlock {
  scope: ProtectionInfo['scope']
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
  ownerId: number
  hidden: boolean
}

const MIN_UNIVER_ZOOM = 0.1
const MAX_UNIVER_ZOOM = 4
const PROTECTION_HIGHLIGHT_PREFERENCE_KEY = 'yaerp:show-protection-highlights'
const SHEET_VIEW_MEMORY_VERSION = 2
const UNIVER_PROTECTION_CONTEXT_MENU_CONFIG = {
  'sheet.contextMenu.permission': { title: '选区权限' },
  'sheet.command.add-range-protection-from-context-menu': { title: '配置选区白名单' },
  'sheet.command.set-range-protection-from-context-menu': { title: '编辑选区白名单' },
  'sheet.command.delete-range-protection-from-context-menu': { title: '解除当前保护' },
  'sheet.command.view-sheet-permission-from-context-menu': { title: '显示保护区域与记录' },
} as const
const YAERP_PROTECTION_CONTEXT_MENU_LABELS = [
  '保护当前选择',
  '保护或隐藏当前选择',
  '配置选区白名单',
  '编辑当前保护',
  '编辑保护与隐藏设置',
  '编辑选区白名单',
  '解除当前保护',
  '显示保护区域与记录',
]
const PROTECTION_HIGHLIGHT_LAYOUT_COMMANDS = new Set([
  'sheet.command.append-row',
  'sheet.command.delta-column-width',
  'sheet.command.delta-row-height',
  'sheet.command.insert-col',
  'sheet.command.insert-row',
  'sheet.command.move-cols',
  'sheet.command.move-rows',
  'sheet.command.remove-col',
  'sheet.command.remove-row',
  'sheet.command.set-col-data',
  'sheet.command.set-row-data',
  'sheet.command.set-row-height',
  'sheet.command.set-worksheet-col-width',
  'sheet.command.set-worksheet-column-count',
  'sheet.command.set-worksheet-row-count',
])

const PROTECTION_VISUALS: ProtectionVisual[] = [
  { stroke: '#0284c7', fill: 'rgba(14, 165, 233, 0.08)', soft: '#e0f2fe' },
  { stroke: '#059669', fill: 'rgba(16, 185, 129, 0.08)', soft: '#d1fae5' },
  { stroke: '#d97706', fill: 'rgba(245, 158, 11, 0.08)', soft: '#fef3c7' },
  { stroke: '#dc2626', fill: 'rgba(239, 68, 68, 0.07)', soft: '#fee2e2' },
  { stroke: '#7c3aed', fill: 'rgba(139, 92, 246, 0.07)', soft: '#ede9fe' },
  { stroke: '#0f766e', fill: 'rgba(20, 184, 166, 0.08)', soft: '#ccfbf1' },
  { stroke: '#c026d3', fill: 'rgba(217, 70, 239, 0.07)', soft: '#fae8ff' },
  { stroke: '#4f46e5', fill: 'rgba(99, 102, 241, 0.07)', soft: '#e0e7ff' },
]
const HIDDEN_PROTECTION_VISUAL: ProtectionVisual = {
  stroke: '#475569',
  fill: 'rgba(71, 85, 105, 0.055)',
  soft: '#e2e8f0',
}

function visualForUser(userId: number) {
  const safeId = Number.isFinite(userId) ? Math.abs(userId) : 0
  return PROTECTION_VISUALS[safeId % PROTECTION_VISUALS.length]
}

function sheetViewMemoryStorageKey(userId: number, sheetId: number) {
  return `yaerp:sheet-view:${userId}:${sheetId}`
}

function readSheetViewMemory(userId: number | undefined, sheetId: number): SheetViewMemory | null {
  if (!userId) return null
  try {
    const raw = window.localStorage.getItem(sheetViewMemoryStorageKey(userId, sheetId))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<Omit<SheetViewMemory, 'version'>> & { version?: number }
    if (value.version !== 1 && value.version !== SHEET_VIEW_MEMORY_VERSION) return null
    const coordinates = [value.selectionRow, value.selectionColumn, value.viewRow, value.viewColumn]
    if (!coordinates.every((coordinate) => Number.isInteger(coordinate) && Number(coordinate) >= 0)) return null
    const selectionRow = Number(value.selectionRow)
    const selectionColumn = Number(value.selectionColumn)
    return {
      version: SHEET_VIEW_MEMORY_VERSION,
      selectionRow,
      selectionColumn,
      selectionEndRow: Number.isInteger(value.selectionEndRow) && Number(value.selectionEndRow) >= selectionRow
        ? Number(value.selectionEndRow)
        : selectionRow,
      selectionEndColumn: Number.isInteger(value.selectionEndColumn) && Number(value.selectionEndColumn) >= selectionColumn
        ? Number(value.selectionEndColumn)
        : selectionColumn,
      viewRow: Number(value.viewRow),
      viewColumn: Number(value.viewColumn),
      offsetX: Number.isFinite(value.offsetX) ? Math.max(0, Number(value.offsetX)) : 0,
      offsetY: Number.isFinite(value.offsetY) ? Math.max(0, Number(value.offsetY)) : 0,
      updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : Date.now(),
    }
  } catch {
    return null
  }
}

function writeSheetViewMemory(userId: number | undefined, sheetId: number, memory: SheetViewMemory) {
  if (!userId) return
  try {
    window.localStorage.setItem(sheetViewMemoryStorageKey(userId, sheetId), JSON.stringify(memory))
  } catch {
    // Position memory is optional when browser storage is unavailable.
  }
}

function protectionVisualKey(item: Pick<ProtectionInfo, 'owner_id' | 'hidden'>) {
  return item.hidden ? 'hidden' : `owner:${item.owner_id}`
}

function formatProtectionMode(item: Pick<ProtectionInfo, 'hidden' | 'lock_editing' | 'hide_formula'>) {
  const modes = [
    item.hidden ? '数据遮罩' : '',
    item.hide_formula ? '隐藏公式' : '',
    item.lock_editing ? '锁定编辑' : '',
  ].filter(Boolean)
  return modes.length > 0 ? modes.join(' + ') : '访问规则'
}

function compactLinearProtectionBlocks(
  items: ProtectionInfo[],
  scope: 'row' | 'column',
  resolveIndex: (item: ProtectionInfo) => number,
  maxRows: number,
  maxColumns: number
) {
  const groups = new Map<string, { ownerId: number; hidden: boolean; indexes: Set<number> }>()
  items.forEach((item) => {
    const index = resolveIndex(item)
    const limit = scope === 'row' ? maxRows : maxColumns
    if (!Number.isInteger(index) || index < 0 || index >= limit) return
    const key = protectionVisualKey(item)
    const group = groups.get(key) || { ownerId: item.owner_id, hidden: Boolean(item.hidden), indexes: new Set<number>() }
    group.indexes.add(index)
    groups.set(key, group)
  })

  const blocks: ProtectionHighlightBlock[] = []
  groups.forEach((group) => {
    const indexes = Array.from(group.indexes).sort((left, right) => left - right)
    let start = indexes[0]
    let end = start
    const flush = () => {
      if (start === undefined || end === undefined) return
      blocks.push(scope === 'row'
        ? { scope, startRow: start, endRow: end, startColumn: 0, endColumn: maxColumns - 1, ownerId: group.ownerId, hidden: group.hidden }
        : { scope, startRow: 1, endRow: maxRows - 1, startColumn: start, endColumn: end, ownerId: group.ownerId, hidden: group.hidden })
    }
    indexes.slice(1).forEach((index) => {
      if (index === end + 1) {
        end = index
        return
      }
      flush()
      start = index
      end = index
    })
    flush()
  })
  return blocks
}

function compactCellProtectionBlocks(items: ProtectionInfo[], columnIndexes: Map<string, number>, maxRows: number, maxColumns: number) {
  const groups = new Map<string, {
    ownerId: number
    hidden: boolean
    rows: Map<number, Set<number>>
  }>()

  items.forEach((item) => {
    if (typeof item.row_index !== 'number') return
    const row = item.row_index + 1
    const column = columnIndexes.get(item.column_key || item.key)
    if (row < 0 || row >= maxRows || column === undefined || column < 0 || column >= maxColumns) return
    const key = protectionVisualKey(item)
    const group = groups.get(key) || { ownerId: item.owner_id, hidden: Boolean(item.hidden), rows: new Map<number, Set<number>>() }
    const columns = group.rows.get(row) || new Set<number>()
    columns.add(column)
    group.rows.set(row, columns)
    groups.set(key, group)
  })

  const blocks: ProtectionHighlightBlock[] = []
  groups.forEach((group) => {
    const verticalRuns = new Map<string, Array<{ row: number; startColumn: number; endColumn: number }>>()
    Array.from(group.rows.entries())
      .sort(([left], [right]) => left - right)
      .forEach(([row, columnSet]) => {
        const columns = Array.from(columnSet).sort((left, right) => left - right)
        let startColumn = columns[0]
        let endColumn = startColumn
        const flush = () => {
          if (startColumn === undefined || endColumn === undefined) return
          const key = `${startColumn}:${endColumn}`
          const runs = verticalRuns.get(key) || []
          runs.push({ row, startColumn, endColumn })
          verticalRuns.set(key, runs)
        }
        columns.slice(1).forEach((column) => {
          if (column === endColumn + 1) {
            endColumn = column
            return
          }
          flush()
          startColumn = column
          endColumn = column
        })
        flush()
      })

    verticalRuns.forEach((runs) => {
      let startRow = runs[0]?.row
      let endRow = startRow
      let startColumn = runs[0]?.startColumn
      let endColumn = runs[0]?.endColumn
      const flush = () => {
        if (startRow === undefined || endRow === undefined || startColumn === undefined || endColumn === undefined) return
        blocks.push({
          scope: 'cell',
          startRow,
          endRow,
          startColumn,
          endColumn,
          ownerId: group.ownerId,
          hidden: group.hidden,
        })
      }
      runs.slice(1).forEach((run) => {
        if (run.row === endRow + 1) {
          endRow = run.row
          return
        }
        flush()
        startRow = run.row
        endRow = run.row
        startColumn = run.startColumn
        endColumn = run.endColumn
      })
      flush()
    })
  })
  return blocks
}

function buildProtectionHighlightBlocks(snapshot: ProtectionSnapshot, columns: ColumnDef[], maxRows: number, maxColumns: number) {
  const safeMaxRows = Math.max(maxRows, 2)
  const safeMaxColumns = Math.max(maxColumns, 1)
  const columnIndexes = new Map(columns.map((column, index) => [column.key, index]))
  return [
    ...compactLinearProtectionBlocks(snapshot.rows, 'row', (item) => (item.row_index ?? -2) + 1, safeMaxRows, safeMaxColumns),
    ...compactLinearProtectionBlocks(snapshot.columns, 'column', (item) => columnIndexes.get(item.column_key || item.key) ?? -1, safeMaxRows, safeMaxColumns),
    ...compactCellProtectionBlocks(snapshot.cells, columnIndexes, safeMaxRows, safeMaxColumns),
  ]
}

function clipProtectionHighlightBlocks(
  blocks: ProtectionHighlightBlock[],
  visibleRange: { startRow: number; endRow: number; startColumn: number; endColumn: number } | null,
  maxRows: number,
  maxColumns: number
) {
  if (!visibleRange) return blocks
  const rowStart = Math.max(0, visibleRange.startRow - 60)
  const rowEnd = Math.min(maxRows - 1, visibleRange.endRow + 60)
  const columnStart = Math.max(0, visibleRange.startColumn - 8)
  const columnEnd = Math.min(maxColumns - 1, visibleRange.endColumn + 8)
  return blocks.flatMap((block) => {
    const startRow = Math.max(block.startRow, rowStart)
    const endRow = Math.min(block.endRow, rowEnd)
    const startColumn = Math.max(block.startColumn, columnStart)
    const endColumn = Math.min(block.endColumn, columnEnd)
    if (startRow > endRow || startColumn > endColumn) return []
    return [{ ...block, startRow, endRow, startColumn, endColumn }]
  })
}

function commandChangesProtectionHighlightLayout(commandId: string) {
  return PROTECTION_HIGHLIGHT_LAYOUT_COMMANDS.has(commandId) ||
    commandId.startsWith('sheet.command.insert-multi-') ||
    commandId.endsWith('-row-by-range') ||
    commandId.endsWith('-col-by-range')
}

const PLAIN_TEXT_PASTE_COMMANDS = new Set<string>([SheetPasteCommand.id, SheetPasteShortKeyCommand.id])
// Commands after which fill-down formula columns are checked for cells that
// reference another row (see FormulaConsistencyBanner).
const FORMULA_SCAN_COMMAND_PATTERN = /insert|remove|delete|move|auto-fill|refill|paste|sort/
// Commands/mutations that move rows, columns or cell ranges. A save that
// carries one of them is sent as a structural save (see the persist pipeline):
// index based merging on the server is only valid while the layout is stable.
const STRUCTURAL_COMMAND_PATTERN = /(insert|remove)-(multi-)?(row|col)|(insert|delete)-range|move-(rows|cols|range)|reorder-range|sort-range/
const STRUCTURE_CONFLICT_ERROR_CODE = 'sheet_structure_conflict'

function readStructureRevision(config: unknown): number {
  const revision = Number((parseSheetConfig(config) as { structureRevision?: unknown }).structureRevision)
  return Number.isInteger(revision) && revision > 0 ? revision : 0
}
/** Width of the hover card, used to decide which side of the badge it opens on. */
const PLAIN_TEXT_TOOLTIP_WIDTH = 256
/** Grace period that lets the pointer travel from the badge into the hover card. */
const PLAIN_TEXT_TOOLTIP_DELAY = 220

/**
 * The corner badge itself. Univer keeps this DOM anchored to its cell, so the
 * component only renders the marker and reports hover, while the tooltip is
 * drawn by the editor because the float DOM layer clips its own overflow.
 */
function PlainTextBadgeComponent({ data }: { data?: PlainTextBadgeData }) {
  if (!data) return null
  return (
    <button
      type="button"
      data-plain-text-badge={`${data.row}:${data.column}`}
      title="数据不是纯文本结构"
      aria-label="数据不是纯文本结构"
      className="yaerp-plain-text-badge block h-full w-full cursor-help border-0 bg-transparent p-0 outline-none"
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        data.onConvert?.()
      }}
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        data.onHover?.({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      }}
      onMouseLeave={() => data.onHover?.(null)}
      onFocus={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        data.onHover?.({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      }}
      onBlur={() => data.onHover?.(null)}
    >
      <span className="block h-0 w-0 border-r-[11px] border-t-[11px] border-r-transparent border-t-amber-500" />
    </button>
  )
}

function clampUniverZoom(zoomRatio: number) {
  return Math.min(MAX_UNIVER_ZOOM, Math.max(MIN_UNIVER_ZOOM, zoomRatio))
}

function roundUniverZoom(zoomRatio: number) {
  return Math.round(zoomRatio * 10) / 10
}

function getLargestVisibleElement(root: HTMLElement, selector: string) {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(selector))
  let selected: HTMLElement | null = null
  let selectedArea = 0

  for (const element of candidates) {
    const rect = element.getBoundingClientRect()
    const area = rect.width * rect.height
    if (rect.width <= 0 || rect.height <= 0 || area <= selectedArea) continue
    selected = element
    selectedArea = area
  }

  return selected
}

function getWheelPointerOffset(root: HTMLElement, event: WheelEvent) {
  const viewport =
    getLargestVisibleElement(root, UNIVER_RENDER_CANVAS) ||
    getLargestVisibleElement(root, '[data-u-comp="workbench-layout"]') ||
    root
  const rect = viewport.getBoundingClientRect()
  const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left))
  const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top))

  return { x, y }
}

/**
 * Univer 0.6 only pans the sheet viewport through `wheel` events and tags its
 * render canvas with `touch-action: none`. Phones and tablets never fire a
 * wheel, so a one-finger drag fell through to Univer's selection-drag handler
 * and the sheet could not be moved at all ("单元格划不动").
 *
 * This helper turns a one-finger drag into the synthetic wheel events Univer
 * already understands. Before panning it also ends the in-flight pointer
 * interaction so the same gesture is not simultaneously treated as a range
 * selection. It returns a disposer that removes every listener it added.
 */
function attachUniverTouchPanning(root: HTMLElement) {
  // Distance the finger must travel before the touch counts as a pan instead of a tap.
  const PAN_THRESHOLD_PX = 6
  // Momentum after the finger lifts, so the sheet keeps gliding like a native scroller.
  const MOMENTUM_DECAY = 0.94
  const MOMENTUM_MIN_PX_PER_MS = 0.05
  const MOMENTUM_MAX_FRAMES = 90

  let pointerId: number | null = null
  let tracking = false
  let panning = false
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastY = 0
  let lastMoveAt = 0
  let velocityX = 0
  let velocityY = 0
  let momentumFrame = 0

  const getCanvas = () => getLargestVisibleElement(root, UNIVER_RENDER_CANVAS)

  const cancelMomentum = () => {
    if (momentumFrame) {
      cancelAnimationFrame(momentumFrame)
      momentumFrame = 0
    }
  }

  const emitWheel = (
    canvas: HTMLElement,
    deltaX: number,
    deltaY: number,
    clientX: number,
    clientY: number
  ) => {
    if (!deltaX && !deltaY) return
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX,
        deltaY,
        deltaMode: 0,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      })
    )
  }

  const endPointerInteraction = () => {
    const canvas = getCanvas()
    if (!canvas) return
    // Univer subscribes its selection-drag handler on pointermove and tears it
    // down on pointerup. A synthetic pointerup makes it stop extending the
    // selection while the finger keeps moving, without cancelling the gesture.
    canvas.dispatchEvent(
      new PointerEvent('pointerup', {
        pointerId: pointerId ?? 1,
        pointerType: 'touch',
        button: 0,
        buttons: 0,
        clientX: lastX,
        clientY: lastY,
        bubbles: true,
        cancelable: true,
      })
    )
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
    pointerId = event.pointerId
  }

  const onTouchStart = (event: TouchEvent) => {
    cancelMomentum()
    // Never turn toolbar, menu or editor-input gestures into canvas scrolling.
    if (!(event.target instanceof Element) || !event.target.closest(UNIVER_RENDER_CANVAS)) {
      tracking = false
      return
    }
    if (event.touches.length !== 1) {
      tracking = false
      return
    }
    const touch = event.touches[0]
    tracking = true
    panning = false
    startX = lastX = touch.clientX
    startY = lastY = touch.clientY
    lastMoveAt = performance.now()
    velocityX = 0
    velocityY = 0
  }

  const onTouchMove = (event: TouchEvent) => {
    if (!tracking || event.touches.length !== 1) return
    // If any ancestor has already captured this pointer (e.g. a draggable
    // widget with touch-action:none), let the capture owner handle the move
    // and do not call preventDefault — the browser would ignore it anyway
    // and Chrome logs an intervention warning.
    if (event.cancelable === false) return
    const touch = event.touches[0]
    const x = touch.clientX
    const y = touch.clientY

    if (!panning) {
      if (
        Math.abs(x - startX) < PAN_THRESHOLD_PX &&
        Math.abs(y - startY) < PAN_THRESHOLD_PX
      ) {
        return
      }
      panning = true
      // Stop Univer from growing the selection before the first pan step.
      endPointerInteraction()
    }

    // Keep the browser from also scrolling the page or triggering overscroll.
    event.preventDefault()

    const deltaX = lastX - x
    const deltaY = lastY - y
    const now = performance.now()
    const elapsed = Math.max(1, now - lastMoveAt)
    // Exponential smoothing keeps the fling velocity from spiking on one sample.
    velocityX = velocityX * 0.6 + (deltaX / elapsed) * 0.4
    velocityY = velocityY * 0.6 + (deltaY / elapsed) * 0.4
    lastMoveAt = now
    lastX = x
    lastY = y

    const canvas = getCanvas()
    if (canvas) emitWheel(canvas, deltaX, deltaY, x, y)
  }

  const onTouchEnd = () => {
    if (!tracking) return
    tracking = false
    if (!panning) return
    panning = false

    const canvas = getCanvas()
    if (!canvas) return

    let frameVelocityX = velocityX
    let frameVelocityY = velocityY
    let frames = 0
    if (
      Math.abs(frameVelocityX) < MOMENTUM_MIN_PX_PER_MS &&
      Math.abs(frameVelocityY) < MOMENTUM_MIN_PX_PER_MS
    ) {
      return
    }

    const step = () => {
      frameVelocityX *= MOMENTUM_DECAY
      frameVelocityY *= MOMENTUM_DECAY
      frames += 1
      if (
        frames > MOMENTUM_MAX_FRAMES ||
        (Math.abs(frameVelocityX) < MOMENTUM_MIN_PX_PER_MS &&
          Math.abs(frameVelocityY) < MOMENTUM_MIN_PX_PER_MS)
      ) {
        momentumFrame = 0
        return
      }
      emitWheel(canvas, frameVelocityX * 16, frameVelocityY * 16, lastX, lastY)
      momentumFrame = requestAnimationFrame(step)
    }
    momentumFrame = requestAnimationFrame(step)
  }

  const onTouchCancel = () => {
    tracking = false
    panning = false
    cancelMomentum()
  }

  // Capture-phase pointerdown records the pointer id used by the synthetic pointerup.
  const stopPanning = () => { tracking = false; panning = false; cancelMomentum() }
  root.addEventListener('yaerp-stop-touch-pan', stopPanning)
  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('touchstart', onTouchStart, { passive: true })
  root.addEventListener('touchmove', onTouchMove, { passive: false })
  root.addEventListener('touchend', onTouchEnd)
  root.addEventListener('touchcancel', onTouchCancel)

  return () => {
    cancelMomentum()
    root.removeEventListener('yaerp-stop-touch-pan', stopPanning)
    root.removeEventListener('pointerdown', onPointerDown, true)
    root.removeEventListener('touchstart', onTouchStart)
    root.removeEventListener('touchmove', onTouchMove)
    root.removeEventListener('touchend', onTouchEnd)
    root.removeEventListener('touchcancel', onTouchCancel)
  }
}

/**
 * Brings a cell into view without jumping when it already is visible. Univer's
 * `scrollToCell` always puts the cell in the top-left corner, which made the
 * phone's arrow pad yank the sheet around on every step.
 */
function revealCell(
  worksheet: { getVisibleRange?: () => { startRow: number; endRow: number; startColumn: number; endColumn: number } | null; scrollToCell: (row: number, column: number) => unknown } | null | undefined,
  row: number,
  column: number
) {
  if (!worksheet) return
  try {
    const visible = worksheet.getVisibleRange?.()
    // The last visible row/column is usually cut off, so keep one cell margin.
    if (
      visible &&
      row >= visible.startRow &&
      row < visible.endRow &&
      column >= visible.startColumn &&
      column < visible.endColumn
    ) return
  } catch {
    // Fall back to scrolling.
  }
  worksheet.scrollToCell(row, column)
}

/**
 * Scrolls a search hit into view with some context around it. Plain
 * `scrollToCell` pins the hit to the top-left corner, under the toolbar edge,
 * and the bottom rows sit behind the docked search bar, so both edges keep a
 * margin.
 */
function revealSearchHit(
  worksheet: Parameters<typeof revealCell>[0],
  row: number,
  column: number
) {
  if (!worksheet) return
  try {
    const visible = worksheet.getVisibleRange?.()
    if (
      visible &&
      row > visible.startRow &&
      row < visible.endRow - 4 &&
      column >= visible.startColumn &&
      column < visible.endColumn
    ) return
  } catch {
    // Fall back to scrolling.
  }
  worksheet.scrollToCell(Math.max(0, row - 3), Math.max(0, column - 1))
}

// Cells written by the server (AI agent, cell API, older imports) may carry a
// number or boolean value without its type. Univer then renders it as text:
// left aligned and ignoring number formats. Fills in the missing type.
function inferMissingCellTypes(snapshot: Partial<IWorksheetData>): Partial<IWorksheetData> {
  const cellData = snapshot.cellData as Record<string, Record<string, ICellData | null>> | undefined
  if (!cellData) return snapshot
  for (const row of Object.values(cellData)) {
    if (!row) continue
    for (const cell of Object.values(row)) {
      if (!cell || cell.t != null || cell.f || cell.si) continue
      if (typeof cell.v === 'number') cell.t = 2
      else if (typeof cell.v === 'boolean') cell.t = 3
    }
  }
  return snapshot
}

function cloneJsonSnapshot<T>(value: T): T {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(value)
    }
  } catch {
    // Fall back to JSON cloning below.
  }

  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return value
  }
}

function wrapWorksheetData(
  workbookId: string | number,
  sheet: Sheet,
  worksheetData: Partial<IWorksheetData>,
  locale: IWorkbookData['locale'],
  savedStyles?: Record<string, unknown>
): IWorkbookData {
  const worksheetSnapshot = cloneJsonSnapshot(worksheetData)
  const snapshotCells = worksheetSnapshot.cellData as Record<string, Record<string, { f?: unknown; s?: unknown } | undefined> | undefined> | undefined
  Object.values(snapshotCells || {}).forEach((row) => {
    Object.values(row || {}).forEach((cell) => {
      if (!cell) return
      if (typeof cell.f === 'string' && cell.f.trim() && !cell.f.trim().startsWith('=')) {
        cell.f = `=${cell.f.trim()}`
      }
      if (cell.s && typeof cell.s === 'object') {
        const style = cell.s as Record<string, unknown>
        if (style.n && typeof style.n === 'object') {
          const numberFormat = style.n as Record<string, unknown>
          numberFormat.pattern = normalizeUniverNumberFormatPattern(String(numberFormat.pattern || ''))
        }
      }
    })
  })
  const sheetKey = worksheetSnapshot.id || `sheet-${sheet.id}`
  return {
    id: `workbook-${workbookId}-sheet-${sheet.id}`,
    name: sheet.name || 'Workbook',
    appVersion: '0.5.0',
    locale,
    styles: cloneJsonSnapshot(normalizeUniverStyleMap(savedStyles) as IWorkbookData['styles']),
    sheetOrder: [sheetKey],
    sheets: {
      [sheetKey]: ensureWorksheetVerticalAlign({
        ...worksheetSnapshot,
        id: sheetKey,
        name: sheet.name || worksheetSnapshot.name || 'Sheet1',
      }),
    },
  }
}

function getWorksheetCellText(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return ''
  const data = cell as { f?: unknown; v?: unknown }
  if (typeof data.v === 'string' || typeof data.v === 'number' || typeof data.v === 'boolean') {
    return String(data.v)
  }
  if (typeof data.f === 'string' && data.f.trim()) return data.f
  return ''
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sanitizeDownloadFilename(value: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  return cleaned || 'sheet'
}

function parseFilenameFromDisposition(disposition: string | null, fallback: string) {
  if (!disposition) return fallback

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }

  const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
  return plainMatch?.[1] || fallback
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(url)
}

function hasPrintableCellContent(cell: unknown) {
  return getWorksheetCellText(cell).trim() !== ''
}

function estimatePrintableColumnWidth(name: string, values: string[]) {
  const longest = values.reduce((max, value) => Math.max(max, value.trim().length), name.trim().length)
  if (longest <= 4) return 76
  if (longest <= 8) return 100
  if (longest <= 12) return 128
  if (longest <= 18) return 156
  return 188
}

function isGenericPrintableHeader(value: string, columnIndex: number) {
  const normalized = value.trim().toUpperCase()
  if (!normalized) return true
  if (normalized === columnIndexToLetter(columnIndex)) return true
  return /^COL[_ -]?\d+$/.test(normalized)
}

function buildPrintableSheetData(savedSheet: Partial<IWorksheetData>, fallbackColumns: ColumnDef[]) {
  const cellData = savedSheet.cellData || {}
  const usedColumnIndexes = new Set<number>()

  const dataRows = Object.entries(cellData)
    .map(([key, row]) => ({
      rowIndex: Number(key),
      row: (row as Record<number, unknown> | undefined) || {},
    }))
    .filter(({ rowIndex }) => Number.isFinite(rowIndex) && rowIndex > 0)
    .sort((left, right) => left.rowIndex - right.rowIndex)

  dataRows.forEach(({ row }) => {
    Object.entries(row).forEach(([key, cell]) => {
      const index = Number(key)
      if (Number.isFinite(index) && index >= 0 && hasPrintableCellContent(cell)) {
        usedColumnIndexes.add(index)
      }
    })
  })

  if (usedColumnIndexes.size === 0) {
    fallbackColumns.forEach((_, index) => usedColumnIndexes.add(index))
  }

  if (usedColumnIndexes.size === 0) {
    usedColumnIndexes.add(0)
  }

  const printableColumns = Array.from(usedColumnIndexes)
    .sort((left, right) => left - right)
    .map((index) => {
      const fallback = fallbackColumns[index]
      const headerText = fallback?.name?.trim() || ''
      return {
        index,
        key: fallback?.key || `col_${index + 1}`,
        name: headerText || columnIndexToLetter(index),
        width: 0,
      }
    })

  const visibleRows = dataRows
    .map(({ rowIndex, row }) => ({
      sourceRowNumber: rowIndex + 1,
      cells: printableColumns.map((column) => getWorksheetCellText(row[column.index])),
    }))

  let startIndex = 0
  while (startIndex < visibleRows.length && visibleRows[startIndex].cells.every((value) => value.trim() === '')) {
    startIndex += 1
  }

  let endIndex = visibleRows.length - 1
  while (endIndex >= startIndex && visibleRows[endIndex].cells.every((value) => value.trim() === '')) {
    endIndex -= 1
  }

  const printableRows = startIndex <= endIndex ? visibleRows.slice(startIndex, endIndex + 1) : []

  const sizedColumns = printableColumns.map((column, index) => ({
    ...column,
    width: estimatePrintableColumnWidth(column.name, printableRows.map((row) => row.cells[index] || '')),
  }))

  const totalWidth = sizedColumns.reduce((sum, column) => sum + column.width, 56)
  const landscape = sizedColumns.length > 6 || totalWidth > 720
  const meaningfulHeaderCount = sizedColumns.filter((column) => !isGenericPrintableHeader(column.name, column.index)).length
  const showHeader = meaningfulHeaderCount > 0 && meaningfulHeaderCount >= Math.ceil(sizedColumns.length / 2)

  return {
    columns: sizedColumns,
    rows: printableRows,
    landscape,
    showHeader,
  }
}

function buildSheetPrintHtml(savedSheet: Partial<IWorksheetData>, sheetName: string, fallbackColumns: ColumnDef[], mode: 'print' | 'pdf') {
  const printable = buildPrintableSheetData(savedSheet, fallbackColumns)
  const fontSize = printable.columns.length >= 10 ? 10 : 11
  const pageSize = printable.landscape ? 'A4 landscape' : 'A4 portrait'
  const colGroupHtml = printable.columns
    .map((column) => `<col style="width:${column.width}px" />`)
    .join('')
  const rowsHtml = printable.rows.length > 0
    ? printable.rows.map((row) => {
        const rowCells = row.cells
          .map((value) => `<td>${escapeHtml(value) || '&nbsp;'}</td>`)
          .join('')
        return `<tr><th>${row.sourceRowNumber}</th>${rowCells}</tr>`
      }).join('')
    : `<tr><td colspan="${printable.columns.length + 1}" class="empty-state">当前工作表暂无可导出的数据</td></tr>`

  const headerHtml = printable.showHeader
    ? `<thead><tr><th>行号</th>${printable.columns.map((column) => `<th>${escapeHtml(column.name || column.key)}</th>`).join('')}</tr></thead>`
    : ''
  const title = `${sheetName || '工作表'} - ${mode === 'pdf' ? '导出 PDF' : '打印'}`

  return `
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>
          @page { size: ${pageSize}; margin: 10mm; }
          * { box-sizing: border-box; }
          html, body { margin: 0; padding: 0; background: #fff; }
          body {
            font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
            color: #0f172a;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            padding: 0;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            table-layout: auto;
          }
          thead { display: table-header-group; }
          tr { break-inside: avoid; page-break-inside: avoid; }
          th, td {
            border: 1px solid #cbd5e1;
            padding: 6px 8px;
            font-size: ${fontSize}px;
            line-height: 1.5;
            vertical-align: top;
            text-align: left;
            white-space: pre-wrap;
            word-break: break-word;
            overflow-wrap: anywhere;
            writing-mode: horizontal-tb;
          }
          thead th {
            background: #e2e8f0;
            font-weight: 700;
          }
          tbody th {
            width: 56px;
            min-width: 56px;
            background: #f8fafc;
            text-align: center;
            white-space: nowrap;
            font-weight: 600;
          }
          tbody tr:nth-child(even) td {
            background: #fafcff;
          }
          .empty-state {
            padding: 20px 12px;
            text-align: center;
            color: #64748b;
          }
          @media print {
            body { padding: 0; }
          }
        </style>
      </head>
      <body>
        <table>
          <colgroup><col style="width:56px" />${colGroupHtml}</colgroup>
          ${headerHtml}
          <tbody>${rowsHtml}</tbody>
        </table>
      </body>
    </html>
  `
}

function printHtmlWithHiddenFrame(html: string) {
  return new Promise<void>((resolve, reject) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    iframe.style.opacity = '0'
    iframe.style.pointerEvents = 'none'
    document.body.appendChild(iframe)

    const frameWindow = iframe.contentWindow
    const frameDocument = frameWindow?.document
    if (!frameWindow || !frameDocument) {
      iframe.remove()
      reject(new Error('当前浏览器不支持内嵌打印，请更换浏览器后重试。'))
      return
    }

    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      window.setTimeout(() => iframe.remove(), 300)
    }

    frameWindow.addEventListener('afterprint', cleanup, { once: true })

    try {
      frameDocument.open()
      frameDocument.write(html)
      frameDocument.close()

      window.setTimeout(() => {
        try {
          frameWindow.focus()
          frameWindow.print()
          window.setTimeout(cleanup, 60000)
          resolve()
        } catch (error) {
          cleanup()
          reject(error instanceof Error ? error : new Error('打开打印对话框失败，请稍后重试。'))
        }
      }, 80)
    } catch (error) {
      cleanup()
      reject(error instanceof Error ? error : new Error('生成打印预览失败，请稍后重试。'))
    }
  })
}

async function toImageFile(img: GalleryImage): Promise<File> {
  const response = await fetch(img.url)
  if (!response.ok) {
    throw new Error('读取图库图片失败，请确认图片仍可访问。')
  }

  const blob = await response.blob()
  const extension = blob.type.split('/')[1] || 'png'
  const normalizedName = img.filename || `gallery-image.${extension}`
  return new File([blob], normalizedName, { type: blob.type || 'image/png' })
}

function mergeUniverStyleMap(base: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined) {
  if (!next || Object.keys(next).length === 0) {
    return normalizeUniverStyleMap(base)
  }

  return normalizeUniverStyleMap({
    ...(base || {}),
    ...next,
  })
}

function jsonSnapshot(value: unknown) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return ''
  }
}

function areJsonSnapshotsEqual(left: unknown, right: unknown) {
  return jsonSnapshot(left) === jsonSnapshot(right)
}

function getUniverPatchCellValue(cell: unknown): unknown {
  if (!cell || typeof cell !== 'object') return ''
  const data = cell as { f?: unknown; v?: unknown }
  if (typeof data.f === 'string' && data.f.trim()) return data.f
  if (typeof data.v === 'string' || typeof data.v === 'number' || typeof data.v === 'boolean') return data.v
  return ''
}

// A formula cell stores both the formula text and the cached result. Structural
// edits (insert/delete of a row, a cell or a column) move a formula to a new row
// while the formula text often stays identical, so only the cached result marks
// the changed sheet. Comparing the whole value payload keeps such cells inside
// the change set; otherwise the server still holds the previous snapshot value
// for that coordinate and restores it, which is what makes a formula show the
// result of the row that used to live there.
function getUniverPatchCellSignature(cell: unknown): string {
  if (!cell || typeof cell !== 'object') return ''
  const data = cell as { f?: unknown; v?: unknown }
  const formula = typeof data.f === 'string' && data.f.trim() ? data.f : ''
  const value = typeof data.v === 'string' || typeof data.v === 'number' || typeof data.v === 'boolean' ? data.v : ''
  return JSON.stringify([formula, value])
}

function getWorksheetCell(sheetData: Partial<IWorksheetData> | undefined, worksheetRow: number, columnIndex: number) {
  const cellData = sheetData?.cellData as Record<string, Record<string, unknown> | undefined> | undefined
  return cellData?.[String(worksheetRow)]?.[String(columnIndex)]
}

function collectWorksheetCellPositions(sheetData: Partial<IWorksheetData> | undefined) {
  const positions = new Set<string>()
  const cellData = sheetData?.cellData as Record<string, Record<string, unknown> | undefined> | undefined
  if (!cellData) return positions

  Object.entries(cellData).forEach(([rowKey, row]) => {
    const worksheetRow = Number(rowKey)
    if (!Number.isInteger(worksheetRow) || worksheetRow <= 0 || !row || typeof row !== 'object') return

    Object.keys(row).forEach((columnKey) => {
      const columnIndex = Number(columnKey)
      if (!Number.isInteger(columnIndex) || columnIndex < 0) return
      positions.add(`${worksheetRow}:${columnIndex}`)
    })
  })

  return positions
}

function buildRealtimeCellChanges(
  sheetId: number,
  previousSheet: Partial<IWorksheetData> | undefined,
  nextSheet: Partial<IWorksheetData>,
  columns: ColumnDef[]
): CellUpdate[] {
  const positions = collectWorksheetCellPositions(previousSheet)
  collectWorksheetCellPositions(nextSheet).forEach((position) => positions.add(position))

  const changes: CellUpdate[] = []
  positions.forEach((position) => {
    const [rowPart, columnPart] = position.split(':')
    const worksheetRow = Number(rowPart)
    const columnIndex = Number(columnPart)
    const column = columns[columnIndex]
    if (!Number.isInteger(worksheetRow) || !Number.isInteger(columnIndex) || !column?.key) return

    const previousCell = getWorksheetCell(previousSheet, worksheetRow, columnIndex)
    const nextCell = getWorksheetCell(nextSheet, worksheetRow, columnIndex)
    if (getUniverPatchCellSignature(previousCell) === getUniverPatchCellSignature(nextCell)) return

    const nextValue = getUniverPatchCellValue(nextCell)

    changes.push({
      sheet_id: sheetId,
      row: worksheetRow - 1,
      col: column.key,
      value: nextValue ?? '',
    })
  })

  return changes
}

function getRealtimeCellData(value: unknown) {
  if (typeof value === 'string' && value.startsWith('=')) return { f: value }
  return { v: value ?? '' }
}

function applyRealtimeCellChangesToWorksheetSnapshot(
  sheetData: Partial<IWorksheetData> | null,
  changes: Array<{ row: number; col: string; value: unknown }>,
  columns: ColumnDef[]
) {
  const nextSheet = cloneJsonSnapshot(sheetData || {})
  const cellData = ((nextSheet.cellData || {}) as Record<string, Record<string, unknown>>)
  nextSheet.cellData = cellData as IWorksheetData['cellData']

  changes.forEach((change) => {
    const columnIndex = columns.findIndex((column) => column.key === change.col)
    if (columnIndex < 0 || change.row < 0) return

    const rowKey = String(change.row + 1)
    cellData[rowKey] = cellData[rowKey] || {}
    cellData[rowKey][String(columnIndex)] = getRealtimeCellData(change.value)
  })

  return nextSheet
}

function getWorksheetSyncCell(cell: unknown): ICellData {
  if (!cell || typeof cell !== 'object') return { v: '' }
  const data = cell as { f?: unknown; v?: unknown }
  if (typeof data.f === 'string' && data.f.trim()) return { f: data.f }
  if (typeof data.v === 'string' || typeof data.v === 'number' || typeof data.v === 'boolean') return { v: data.v }
  return { v: '' }
}

function getWorksheetSnapshotExtent(...snapshots: Array<Partial<IWorksheetData> | null | undefined>) {
  let rowCount = 1
  let columnCount = 1

  snapshots.forEach((snapshot) => {
    const cellData = snapshot?.cellData as Record<string, Record<string, unknown> | undefined> | undefined
    if (!cellData) return
    Object.entries(cellData).forEach(([rowKey, row]) => {
      const rowIndex = Number(rowKey)
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || !row) return
      rowCount = Math.max(rowCount, rowIndex + 1)
      Object.keys(row).forEach((columnKey) => {
        const columnIndex = Number(columnKey)
        if (Number.isInteger(columnIndex) && columnIndex >= 0) {
          columnCount = Math.max(columnCount, columnIndex + 1)
        }
      })
    })
  })

  return { rowCount, columnCount }
}

function buildWorksheetSyncMatrix(snapshot: Partial<IWorksheetData>, rowCount: number, columnCount: number) {
  const matrix: ICellData[][] = Array.from(
    { length: rowCount },
    () => Array.from({ length: columnCount }, () => ({ v: '' }))
  )
  const cellData = snapshot.cellData as Record<string, Record<string, unknown> | undefined> | undefined

  Object.entries(cellData || {}).forEach(([rowKey, row]) => {
    const rowIndex = Number(rowKey)
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= rowCount || !row) return
    Object.entries(row).forEach(([columnKey, cell]) => {
      const columnIndex = Number(columnKey)
      if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= columnCount) return
      matrix[rowIndex][columnIndex] = getWorksheetSyncCell(cell)
    })
  })

  return matrix
}

function resolveSnapshotCellStyle(rawStyle: unknown, styles: Record<string, unknown> | undefined) {
  if (rawStyle && typeof rawStyle === 'object') return rawStyle as Record<string, unknown>
  if (typeof rawStyle === 'string' && styles?.[rawStyle] && typeof styles[rawStyle] === 'object') {
    return styles[rawStyle] as Record<string, unknown>
  }
  return null
}

function applyWorksheetSnapshotPresentation(
  worksheet: unknown,
  snapshot: Partial<IWorksheetData>,
  styles: Record<string, unknown> | undefined,
  previousSnapshot?: Partial<IWorksheetData> | null
) {
  const sheetFacade = worksheet as {
    getRange: (row: number, column: number, rowCount: number, columnCount: number) => { setValue: (value: ICellData) => unknown }
    setRowHeight: (row: number, height: number) => unknown
    setRowDefaultStyle?: (row: number, style: Record<string, unknown> | string | null) => unknown
    setColumnDefaultStyle?: (column: number, style: Record<string, unknown> | string | null) => unknown
  }
  const cellData = snapshot.cellData as Record<string, Record<string, unknown> | undefined> | undefined
  const previousCellData = previousSnapshot?.cellData as Record<string, Record<string, unknown> | undefined> | undefined
  let applied = 0
  Object.entries(cellData || {}).forEach(([rowKey, row]) => {
    const rowIndex = Number(rowKey)
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || !row) return
    Object.entries(row).forEach(([columnKey, rawCell]) => {
      if (applied >= 20000 || !rawCell || typeof rawCell !== 'object') return
      const columnIndex = Number(columnKey)
      if (!Number.isInteger(columnIndex) || columnIndex < 0) return
      const style = resolveSnapshotCellStyle((rawCell as { s?: unknown }).s, styles)
      const previousCell = previousCellData?.[rowKey]?.[columnKey]
      const rawStyle = (rawCell as { s?: unknown }).s
      const previousRawStyle = previousCell && typeof previousCell === 'object' ? (previousCell as { s?: unknown }).s : undefined
      if (areJsonSnapshotsEqual(rawStyle, previousRawStyle)) return
      const hadPreviousStyle = Boolean(previousCell && typeof previousCell === 'object' && (previousCell as { s?: unknown }).s)
      if (!style && !hadPreviousStyle) return
      const nextCell = cloneJsonSnapshot(rawCell as ICellData)
      if (style) nextCell.s = style
      else delete nextCell.s
      sheetFacade.getRange(rowIndex, columnIndex, 1, 1).setValue(nextCell)
      applied += 1
    })
  })

  const rowData = snapshot.rowData as Record<string, { h?: unknown; s?: unknown } | undefined> | undefined
  const previousRowData = previousSnapshot?.rowData as Record<string, { h?: unknown; s?: unknown } | undefined> | undefined
  Object.entries(rowData || {}).forEach(([rowKey, row]) => {
    const rowIndex = Number(rowKey)
    if (Number.isInteger(rowIndex) && rowIndex >= 0 && typeof row?.h === 'number' && row.h !== previousRowData?.[rowKey]?.h) {
      sheetFacade.setRowHeight(rowIndex, row.h)
    }
    if (Number.isInteger(rowIndex) && rowIndex >= 0 && row?.s !== undefined && !areJsonSnapshotsEqual(row.s, previousRowData?.[rowKey]?.s)) {
      sheetFacade.setRowDefaultStyle?.(rowIndex, resolveSnapshotCellStyle(row.s, styles) || null)
    }
  })

  const columnData = snapshot.columnData as Record<string, { s?: unknown } | undefined> | undefined
  const previousColumnData = previousSnapshot?.columnData as Record<string, { s?: unknown } | undefined> | undefined
  Object.entries(columnData || {}).forEach(([columnKey, column]) => {
    const columnIndex = Number(columnKey)
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || column?.s === undefined || areJsonSnapshotsEqual(column.s, previousColumnData?.[columnKey]?.s)) return
    sheetFacade.setColumnDefaultStyle?.(columnIndex, resolveSnapshotCellStyle(column.s, styles) || null)
  })
}

function getYaerpProtectionContextMenuItem(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return null

  const menuItem = target.closest<HTMLElement>('[role="menuitem"], .univer-menu-item')
  if (!menuItem) return null
  if (!String(menuItem.className || '').includes('univer') && !menuItem.closest('[class*="univer"]')) return null

  const text = (menuItem.textContent || '').replace(/\s+/g, '')
  return YAERP_PROTECTION_CONTEXT_MENU_LABELS.some((label) => text.includes(label)) ? menuItem : null
}

// Univer 1.x marks its components with data-u-comp instead of class names.
const UNIVER_RENDER_CANVAS = '[data-u-comp="render-canvas"]'
const UNIVER_EDITOR = '[data-u-comp="editor"]'

function getVisibleUniverCellEditor(root: HTMLElement | null) {
  // The formula bar and hidden editors share the marker; the cell editor is
  // the one with a real size.
  const editor = [...(root?.querySelectorAll<HTMLElement>(UNIVER_EDITOR) ?? [])].find((element) => {
    const box = element.getBoundingClientRect()
    return box.width > 4 && box.height > 4 && !element.closest('[data-u-comp="formula-bar"]')
  })
  if (!editor) return null

  const rect = editor.getBoundingClientRect()
  if (rect.width <= 4 || rect.height <= 4) return null
  if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return null

  return editor
}

export default function UniverSheetEditor({ workbookId, workbookName, workbookSheets = [], sheet, reloadToken, permissionToken = 0, onExternalReload, optimisticCanEdit = false, canImportWorkbook = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistInFlightRef = useRef<Promise<void> | null>(null)
  const persistQueuedRef = useRef(false)
  const latestSheetRef = useRef(sheet)
  const univerApiRef = useRef<ReturnType<typeof createUniver> | null>(null)
  const workbookApiRef = useRef<{ setEditable: (editable: boolean) => void } | null>(null)
  // Resolves formulas Univer collapsed into a shared formula group (see
  // src/lib/univer-shared-formula.ts).
  const sharedFormulaResolverRef = useRef<SharedFormulaResolver | null>(null)
  const persistRef = useRef<(() => Promise<void>) | null>(null)
  const reloadTokenRef = useRef(reloadToken)
  const pdfPreviewUrlRef = useRef<string | null>(null)
  const applyingRemotePatchRef = useRef(false)
  const remotePatchResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const silentSyncInFlightRef = useRef<Promise<void> | null>(null)
  const silentSyncQueuedRef = useRef(false)
  const sheetEditorActiveRef = useRef(false)
  const imeComposingRef = useRef(false)
  const activeEditCellRef = useRef<EditingCell | null>(null)
  const completedEditCellRef = useRef<EditingCell | null>(null)
  const pendingLocalPersistRef = useRef(false)
  const deferredIncomingChangesRef = useRef<IncomingCellChange[]>([])
  const deferredSilentSyncRef = useRef(false)
  const deferredRealtimeFlushFrameRef = useRef<number | null>(null)
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushDeferredRealtimeUpdatesRef = useRef<() => void>(() => undefined)
  const schedulePersistRef = useRef<() => void>(() => undefined)
  const persistedWorksheetDataRef = useRef<Partial<IWorksheetData> | null>(null)
  const protectionHighlightDisposablesRef = useRef<UniverDisposable[]>([])
  const approvalHighlightDisposablesRef = useRef<UniverDisposable[]>([])
  // Batched highlight layers; Univer wipes all highlights on edit/copy, so they
  // are redrawn whenever that happens (see src/lib/univer-mark-layer.ts).
  const protectionMarkLayerRef = useRef<MarkLayer | null>(null)
  const approvalMarkLayerRef = useRef<MarkLayer | null>(null)
  const approvalHighlightRendererRef = useRef<() => void>(() => undefined)
  const overlayRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [presenceRedrawToken, setPresenceRedrawToken] = useState(0)
  const presenceDisposablesRef = useRef<UniverDisposable[]>([])
  const protectionFocusDisposableRef = useRef<UniverDisposable | null>(null)
  const protectionFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const protectionHighlightRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const protectionHighlightRenderFrameRef = useRef<number | null>(null)
  const sheetViewMemorySaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sheetViewRestoreFrameRef = useRef<number | null>(null)
  const sheetViewRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sheetViewMemoryRestoringRef = useRef(false)
  const protectionHighlightRenderGenerationRef = useRef(0)
  const protectionHighlightRendererRef = useRef<() => void>(() => undefined)
  const protectionSnapshotRef = useRef<ProtectionSnapshot>({ rows: [], columns: [], cells: [] })
  const approvalStatesRef = useRef<CellApprovalState[]>([])
  const showProtectionHighlightsRef = useRef(false)
  const protectionHighlightsLoadingRef = useRef(true)
  const protectionHighlightBlocksCacheRef = useRef<{
    snapshot: ProtectionSnapshot
    columnsSignature: string
    maxRows: number
    maxColumns: number
    blocks: ProtectionHighlightBlock[]
  } | null>(null)
  const sheetPresenceRef = useRef<SheetPresenceEntry[]>([])
  const presenceSendRef = useRef<{ signature: string; sentAt: number }>({ signature: '', sentAt: 0 })
  const pendingPresenceRef = useRef<SheetPresenceEntry[] | null>(null)
  const presenceFrameRef = useRef<number | null>(null)
  // Cells that are not plain text (rich text or an embedded line break) get a
  // corner badge; the marker list is kept in a ref so the scan stays cheap.
  const plainTextOverlayRef = useRef<HTMLDivElement>(null)
  const plainTextMarkersRef = useRef<NonPlainTextMarker[]>([])
  const plainTextBadgeHandlesRef = useRef<Map<string, { id: string; dispose: () => void; signature: string }>>(new Map())
  const plainTextRefreshFrameRef = useRef<number | null>(null)
  const plainTextRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const plainTextRetryCountRef = useRef(0)
  const plainTextTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshPlainTextBadgesRef = useRef<(options?: { scan?: boolean; notify?: boolean }) => void>(() => {})
  const convertPlainTextSelectionRef = useRef<() => void>(() => {})
  const pendingPlainTextScanRef = useRef(false)
  const pendingPlainTextNotifyRef = useRef(false)
  const [plainTextActionNotice, setPlainTextActionNotice] = useState('')
  const [plainTextNotice, setPlainTextNotice] = useState<{ markers: NonPlainTextMarker[]; total: number; truncated: boolean } | null>(null)
  const [plainTextTooltip, setPlainTextTooltip] = useState<{
    signature: string
    row: number
    column: number
    kind: NonPlainTextMarker['kind']
    preview: string
    left: number
    top: number
    flip: boolean
  } | null>(null)
  // Formula error explanation (replaces Univer's grid-covering popup) and the
  // trigger for the fill-down formula consistency check.
  const [formulaErrorHint, setFormulaErrorHint] = useState<(FormulaErrorHint & { value?: string; detail?: string }) | null>(null)
  const [formulaScanToken, setFormulaScanToken] = useState(0)
  const pastePlainRef = useRef<(() => Promise<void>) | null>(null)
  const latestEditableRef = useRef(false)
  // Row/column layout version shared with the server, and whether the unsaved
  // local edits changed that layout.
  const structureRevisionRef = useRef(0)
  const structuralChangePendingRef = useRef(false)
  // Row/column operations behind the unsaved layout, sent so protections follow them.
  const pendingStructureOpsRef = useRef<StructureOp[]>([])
  const refreshProtectionSnapshotRef = useRef<() => Promise<void>>(async () => undefined)
  // True while a structural save is on its way, and for a moment afterwards:
  // cell updates collaborators sent against the old layout may still arrive.
  const structuralSaveInFlightRef = useRef(false)
  const structuralGraceUntilRef = useRef(0)
  const resyncAfterPersistRef = useRef(false)
  const syncSheetSilentlyRef = useRef<() => Promise<void> | void>(() => undefined)
  const localReloadNonceRef = useRef(0)
  const appliedReloadNonceRef = useRef(0)
  const [localReloadNonce, setLocalReloadNonce] = useState(0)
  const [clipboardNotice, setClipboardNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showImagePicker, setShowImagePicker] = useState(false)
  const [lockInsertedImageCell, setLockInsertedImageCell] = useState(true)
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([])
  const [loadingGallery, setLoadingGallery] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [univerHasOverlay, setUniverHasOverlay] = useState(false)
  const [univerSidebarOpen, setUniverSidebarOpen] = useState(false)
  const [toolbarExpanded, setToolbarExpanded] = useUserPreference(
    getStoredUser()?.id,
    'sheet.toolbar-expanded',
    false,
    isBooleanPreference
  )
  const [hasFilter, setHasFilter] = useState(false)
  const [actionError, setActionError] = useState('')
  useEffect(() => {
    if (!actionError) return
    const timer = window.setTimeout(() => setActionError(''), 6000)
    return () => window.clearTimeout(timer)
  }, [actionError])
  const [showNumberFormatPanel, setShowNumberFormatPanel] = useState(false)
  const [numberFormatScope, setNumberFormatScope] = useState<NumberFormatScope>('selection')
  const [numberFormatPreset, setNumberFormatPreset] = useState('general')
  const [customNumberFormat, setCustomNumberFormat] = useState('General')
  const [applyingNumberFormat, setApplyingNumberFormat] = useState(false)
  const [dragImportActive, setDragImportActive] = useState(false)
  const [dragImportUploading, setDragImportUploading] = useState(false)
  const [dragImportProgress, setDragImportProgress] = useState(0)
  const dragDepthRef = useRef(0)
  const [showProtectionPanel, setShowProtectionPanel] = useState(false)
  const [showApprovalPanel, setShowApprovalPanel] = useState(false)
  const [approvalStates, setApprovalStates] = useState<CellApprovalState[]>([])
  const [approvalRules, setApprovalRules] = useState<AutomationRule[]>([])
  const [approvalLoading, setApprovalLoading] = useState(false)
  const [approvalAction, setApprovalAction] = useState('')
  const [approvalName, setApprovalName] = useState('选区数据审批')
  const [approvalDescription, setApprovalDescription] = useState('审批通过后才将待审内容写入正式单元格。')
  const [approvalSteps, setApprovalSteps] = useState<ApprovalStepDraft[]>([newApprovalStep()])
  const [approvalUserSearch, setApprovalUserSearch] = useState('')
  const [approvalNotice, setApprovalNotice] = useState('')
  const [showFieldControlPanel, setShowFieldControlPanel] = useState(false)
  const [fieldControlType, setFieldControlType] = useState<FieldControlType>('select')
  const [fieldControlOptions, setFieldControlOptions] = useState<string[]>(['待处理', '已完成', '已取消'])
  const [fieldControlColors, setFieldControlColors] = useState<Record<string, { backgroundColor: string; textColor: string }>>({})
  const [fieldControlSearchable, setFieldControlSearchable] = useState(false)
  const [fieldControlApplying, setFieldControlApplying] = useState(false)
  const [optionPickerTarget, setOptionPickerTarget] = useState<SearchableOptionPickerTarget | null>(null)
  const [optionPickerSearch, setOptionPickerSearch] = useState('')
  const [showAllProtections, setShowAllProtections] = useState(false)
  const [selectionState, setSelectionState] = useState<SelectionState | null>(null)
  const [protectionSnapshot, setProtectionSnapshot] = useState<ProtectionSnapshot>({ rows: [], columns: [], cells: [] })
  // Derived once per snapshot: every selection change re-renders this component.
  const allProtectionItems = useMemo(
    () => [...protectionSnapshot.rows, ...protectionSnapshot.columns, ...protectionSnapshot.cells],
    [protectionSnapshot],
  )
  const protectionOwnerGroups = useMemo(() => Array.from(allProtectionItems.reduce((groups, item) => {
    const current = groups.get(item.owner_id) || { ownerId: item.owner_id, ownerName: item.owner_name, items: [] as ProtectionInfo[] }
    current.items.push(item)
    groups.set(item.owner_id, current)
    return groups
  }, new Map<number, { ownerId: number; ownerName: string; items: ProtectionInfo[] }>()).values())
    .sort((left, right) => left.ownerName.localeCompare(right.ownerName, 'zh-CN')), [allProtectionItems])
  const protectionIndex = useMemo(() => ({
    rows: new Map(protectionSnapshot.rows.map((item) => [item.row_index, item])),
    columns: new Map(protectionSnapshot.columns.map((item) => [item.column_key || item.key, item])),
    cells: new Map(protectionSnapshot.cells.map((item) => [`${item.row_index}:${item.column_key}`, item])),
  }), [protectionSnapshot])
  const [protectionLoading, setProtectionLoading] = useState(false)
  const [protectionAction, setProtectionAction] = useState('')
  const [protectionUsers, setProtectionUsers] = useState<User[]>([])
  const [protectionDepartments, setProtectionDepartments] = useState<Department[]>([])
  const [protectionUsersLoading, setProtectionUsersLoading] = useState(false)
  const [protectionDirectoryLoaded, setProtectionDirectoryLoaded] = useState(false)
  const [protectionUsersError, setProtectionUsersError] = useState('')
  const [protectionUsersLoadToken, setProtectionUsersLoadToken] = useState(0)
  const [protectionUserSearch, setProtectionUserSearch] = useState('')
  const [protectionScope, setProtectionScope] = useState<ProtectionScope>('cell')
  const [selectedProtectionLockEditing, setSelectedProtectionLockEditing] = useState(true)
  const [selectedProtectionHidden, setSelectedProtectionHidden] = useState(false)
  const [selectedProtectionHideFormula, setSelectedProtectionHideFormula] = useState(false)
  const [protectionPanelTab, setProtectionPanelTab] = useState<'settings' | 'records'>('settings')
  const [protectionWhitelistFilter, setProtectionWhitelistFilter] = useState<'all' | 'department' | 'user'>('all')
  const [protectionRecordFilter, setProtectionRecordFilter] = useState<'all' | 'hidden' | 'formula' | 'lock'>('all')
  const [selectedProtectionReadonlyUserIds, setSelectedProtectionReadonlyUserIds] = useState<number[]>([])
  const [selectedProtectionReadonlyDepartmentIds, setSelectedProtectionReadonlyDepartmentIds] = useState<number[]>([])
  const [selectedProtectionEditableUserIds, setSelectedProtectionEditableUserIds] = useState<number[]>([])
  const [selectedProtectionEditableDepartmentIds, setSelectedProtectionEditableDepartmentIds] = useState<number[]>([])
  const [selectedProtectionViewHiddenUserIds, setSelectedProtectionViewHiddenUserIds] = useState<number[]>([])
  const [selectedProtectionViewHiddenDepartmentIds, setSelectedProtectionViewHiddenDepartmentIds] = useState<number[]>([])
  const [showProtectionHighlights, setShowProtectionHighlights] = useState(true)
  const [protectionHighlightPreferenceReady, setProtectionHighlightPreferenceReady] = useState(false)
  const [protectionFocusNotice, setProtectionFocusNotice] = useState('')
  const [sheetPresence, setSheetPresence] = useState<SheetPresenceEntry[]>([])
  const [presenceExpanded, setPresenceExpanded] = useState(false)
  const presenceWidgetRef = useRef<HTMLDivElement>(null)
  const presenceDrag = useFloatingDrag({ elementRef: presenceWidgetRef, containerRef, ignoreInteractive: false })
  const [exportAction, setExportAction] = useState<'' | 'download' | 'workbook' | 'print' | 'pdf' | 'source'>('')
  const [pdfPreview, setPdfPreview] = useState<PDFPreviewState | null>(null)
  const [showPdfExportPanel, setShowPdfExportPanel] = useState(false)
  const [pdfExportScope, setPdfExportScope] = useState<PDFExportScope>('current')
  const [selectedPdfSheetIds, setSelectedPdfSheetIds] = useState<number[]>([])
  const [pdfPaperSize, setPdfPaperSize] = useState<PDFPaperSize>('a4')
  const [pdfOrientation, setPdfOrientation] = useState<PDFOrientation>('portrait')
  const [pdfFitToWidth, setPdfFitToWidth] = useState(true)
  const [profile] = useState<AuthUser | null>(getStoredUser())
  const adminMode = isAdmin(profile)
  const sheetId = sheet.id
  const { permissions, loading: permissionLoading, canEditCell, refreshPermissions } = usePermission(sheetId)
  useEffect(() => {
    if (permissionToken > 0) refreshPermissions()
  }, [permissionToken, refreshPermissions])
  const searchAccessToken = useMemo(() => JSON.stringify([permissions, protectionSnapshot]), [permissions, protectionSnapshot])
  const canViewSheet = permissions?.sheet.canView ?? false
  const canEditSheet = permissions?.sheet.canEdit ?? false
  const canExportSheet = permissions?.sheet.canExport ?? false
  const hasPermissionSnapshot = permissions !== null
  const effectiveCanViewSheet = hasPermissionSnapshot ? canViewSheet : true
  const effectiveCanEditSheet = hasPermissionSnapshot ? canEditSheet : optimisticCanEdit
  const effectiveCanExportSheet = hasPermissionSnapshot ? canExportSheet : optimisticCanEdit
  const canInitializeEditor = hasPermissionSnapshot || optimisticCanEdit || !permissionLoading
  const editLocked = !effectiveCanEditSheet
  latestEditableRef.current = !editLocked
  const activeSheetConfig = parseSheetConfig(sheet.config)
  const importSource = activeSheetConfig.importSource
  const originalWorkbookXlsxAvailable = Boolean(importSource?.attachment_id)
  const originalWorkbookXlsxFilename = typeof importSource?.filename === 'string' ? importSource.filename : ''
  const workbookSheetOptions = workbookSheets.length > 0 ? workbookSheets : [{ id: sheet.id, name: sheet.name }]
  const workbookExportName = workbookName || '工作簿'

  const persistSheetViewMemory = useCallback(() => {
    if (sheetViewMemoryRestoringRef.current) return
    try {
      const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      const range = worksheet?.getActiveRange?.() || worksheet?.getSelection?.()?.getActiveRange?.()
      if (!worksheet || !range) return
      const scrollState = worksheet.getScrollState()
      const selectionRow = Math.max(0, Math.trunc(range.getRow()))
      const selectionColumn = Math.max(0, Math.trunc(range.getColumn()))
      writeSheetViewMemory(profile?.id, sheetId, {
        version: SHEET_VIEW_MEMORY_VERSION,
        selectionRow,
        selectionColumn,
        selectionEndRow: Math.max(selectionRow, Math.trunc(range.getLastRow())),
        selectionEndColumn: Math.max(selectionColumn, Math.trunc(range.getLastColumn())),
        viewRow: Math.max(0, Math.trunc(scrollState.sheetViewStartRow)),
        viewColumn: Math.max(0, Math.trunc(scrollState.sheetViewStartColumn)),
        offsetX: Math.max(0, Number(scrollState.offsetX) || 0),
        offsetY: Math.max(0, Number(scrollState.offsetY) || 0),
        updatedAt: Date.now(),
      })
    } catch {
      // The editor may be between mount and disposal.
    }
  }, [profile?.id, sheetId])

  const scheduleSheetViewMemoryPersist = useCallback(() => {
    if (sheetViewMemoryRestoringRef.current) return
    if (sheetViewMemorySaveTimerRef.current) clearTimeout(sheetViewMemorySaveTimerRef.current)
    sheetViewMemorySaveTimerRef.current = setTimeout(() => {
      sheetViewMemorySaveTimerRef.current = null
      persistSheetViewMemory()
    }, 180)
  }, [persistSheetViewMemory])

  useEffect(() => {
    const handlePageHide = () => persistSheetViewMemory()
    window.addEventListener('pagehide', handlePageHide)
    return () => window.removeEventListener('pagehide', handlePageHide)
  }, [persistSheetViewMemory])

  useEffect(() => {
    if (!optionPickerTarget) return

    const hiddenHosts = new Map<HTMLElement, {
      visibility: string
      pointerEvents: string
      ariaHidden: string | null
    }>()
    const hideNativeDropdowns = () => {
      document.querySelectorAll<HTMLElement>('[data-u-comp="sheets-dropdown-list"]').forEach((dropdown) => {
        const host = dropdown.closest<HTMLElement>('section') || dropdown
        if (!hiddenHosts.has(host)) {
          hiddenHosts.set(host, {
            visibility: host.style.visibility,
            pointerEvents: host.style.pointerEvents,
            ariaHidden: host.getAttribute('aria-hidden'),
          })
        }
        host.style.visibility = 'hidden'
        host.style.pointerEvents = 'none'
        host.setAttribute('aria-hidden', 'true')
      })
    }

    hideNativeDropdowns()
    const frame = window.requestAnimationFrame(hideNativeDropdowns)
    const observer = new MutationObserver(hideNativeDropdowns)
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      window.setTimeout(() => {
        hiddenHosts.forEach((previous, host) => {
          host.style.visibility = previous.visibility
          host.style.pointerEvents = previous.pointerEvents
          if (previous.ariaHidden === null) host.removeAttribute('aria-hidden')
          else host.setAttribute('aria-hidden', previous.ariaHidden)
        })
      }, 0)
    }
  }, [optionPickerTarget])

  const commitActiveCellEditor = useCallback(() => {
    const root = containerRef.current
    if (!getVisibleUniverCellEditor(root)) return false

    // Formula bar actions are: cancel, confirm, fx.
    const confirmButton = root?.querySelector<HTMLElement>('[data-u-comp="formula-bar-actions"] > span:nth-child(2)')
    confirmButton?.click()
    return Boolean(confirmButton)
  }, [])

  const syncFilterState = useCallback(() => {
    try {
      const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      setHasFilter(Boolean(worksheet?.getFilter?.()))
    } catch {
      setHasFilter(false)
    }
  }, [])

  const syncSelectionState = useCallback(() => {
    try {
      const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      const range = worksheet?.getActiveRange?.() || worksheet?.getSelection?.()?.getActiveRange?.()
      const columns = latestSheetRef.current.columns || []

      if (!range || columns.length === 0) {
        setSelectionState((current) => current === null ? current : null)
        return null
      }

      const maxColumnIndex = Math.max(columns.length - 1, 0)
      const rawStartColumn = range.getColumn()
      const rawEndColumn = range.getLastColumn()
      const startColumnIndex = Math.min(maxColumnIndex, Math.max(0, rawStartColumn))
      const endColumnIndex = Math.min(maxColumnIndex, Math.max(0, rawEndColumn))
      const column = columns[startColumnIndex]
      const endColumn = columns[endColumnIndex] || column
      if (!column) {
        setSelectionState((current) => current === null ? current : null)
        return null
      }

      const rawStartRow = Math.max(range.getRow(), 0)
      const rawEndRow = Math.max(range.getLastRow(), 0)
      const rangeType = range.getRange().rangeType
      const includesHeaderRow = rawStartRow === 0 || rawEndRow === 0
      const isEntireColumnSelection = rangeType === RANGE_TYPE.COLUMN
      const isEntireRowSelection = rangeType === RANGE_TYPE.ROW
      const startRow = rawStartRow - 1
      const endRow = rawEndRow - 1
      const displayStartRow = rawStartRow + 1
      const displayEndRow = rawEndRow + 1
      const rowLabel = `第 ${displayStartRow} 行`
      const rangeLabel =
        startRow === endRow && startColumnIndex === endColumnIndex
          ? `${column.name || column.key} / 第 ${displayStartRow} 行`
          : `第 ${displayStartRow}-${displayEndRow} 行 / ${column.name || column.key} 到 ${endColumn?.name || endColumn?.key || column.key}`
      const nextSelection = {
        rowIndex: startRow,
        displayRowIndex: displayStartRow,
        columnKey: column.key,
        rowLabel,
        columnLabel: column.name || column.key,
        endRowIndex: endRow,
        endDisplayRowIndex: displayEndRow,
        endColumnKey: endColumn?.key || column.key,
        rangeLabel,
        includesHeaderRow,
        isEntireColumnSelection,
        isEntireRowSelection,
      }

      setSelectionState((current) => selectionStatesEqual(current, nextSelection) ? current : nextSelection)
      return nextSelection
    } catch {
      setSelectionState((current) => current === null ? current : null)
      return null
    }
  }, [])

  const refreshProtectionSnapshot = useCallback(async () => {
    if (!sheetId) return

    setProtectionLoading(true)
    try {
      const res = await api.get<ProtectionSnapshot>(`/sheets/${sheetId}/protections`)
      if (res.code === 0 && res.data) {
        setProtectionSnapshot(res.data)
      } else {
        setProtectionSnapshot({ rows: [], columns: [], cells: [] })
      }
    } catch (err) {
      console.error('Failed to load protections:', err)
      setProtectionSnapshot({ rows: [], columns: [], cells: [] })
    } finally {
      setProtectionLoading(false)
    }
  }, [sheetId])

  refreshProtectionSnapshotRef.current = refreshProtectionSnapshot

  const refreshApprovalStates = useCallback(async () => {
    if (!sheetId) return
    try {
      const res = await api.get<CellApprovalState[]>(`/sheets/${sheetId}/approval-states`)
      setApprovalStates(res.code === 0 && Array.isArray(res.data) ? res.data : [])
    } catch (err) {
      console.error('Failed to load cell approval states:', err)
      setApprovalStates([])
    }
  }, [sheetId])

  const refreshApprovalRules = useCallback(async () => {
    try {
      const res = await api.get<{ list: AutomationRule[] }>('/automation/rules?page=1&size=100')
      const rules = res.code === 0 && Array.isArray(res.data?.list) ? res.data.list : []
      setApprovalRules(rules.filter((rule) => rule.sheet_id === sheetId && rule.hold_changes))
    } catch (err) {
      console.error('Failed to load approval rules:', err)
      setApprovalRules([])
    }
  }, [sheetId])

  const clearApprovalHighlights = useCallback(() => {
    approvalHighlightDisposablesRef.current.forEach((item) => item.dispose())
    approvalHighlightDisposablesRef.current = []
    approvalMarkLayerRef.current?.clear()
  }, [])

  const renderApprovalHighlights = useCallback(() => {
    clearApprovalHighlights()
    const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()
    if (!worksheet) return
    const columns = latestSheetRef.current.columns || []
    let visibleRange: { startRow: number; endRow: number; startColumn: number; endColumn: number } | null = null
    try {
      const range = worksheet.getVisibleRange?.()
      if (range) visibleRange = range
    } catch {
      visibleRange = null
    }
    const columnIndexes = new Map(columns.map((column, index) => [column.key, index]))
    const style = { stroke: '#D97706', strokeWidth: 2, strokeDash: 4, isAnimationDash: false, fill: 'rgba(251, 191, 36, 0.10)' }
    const shapes: MarkShape[] = []
    approvalStatesRef.current
      .filter((item) => item.status === 'pending')
      .slice(0, 1000)
      .forEach((item) => {
        const columnIndex = columnIndexes.get(item.col) ?? -1
        const worksheetRow = item.row + 1
        if (columnIndex < 0 || worksheetRow < 1) return
        if (visibleRange && (
          worksheetRow < visibleRange.startRow - 40 || worksheetRow > visibleRange.endRow + 40 ||
          columnIndex < visibleRange.startColumn - 6 || columnIndex > visibleRange.endColumn + 6
        )) return
        shapes.push({ range: { startRow: worksheetRow, endRow: worksheetRow, startColumn: columnIndex, endColumn: columnIndex }, style })
      })
    const layer = approvalMarkLayerRef.current
    if (layer) {
      layer.replace(shapes)
      return
    }
    shapes.forEach((shape) => {
      try {
        approvalHighlightDisposablesRef.current.push(worksheet.getRange(shape.range.startRow, shape.range.startColumn, 1, 1).highlight(shape.style))
      } catch {
        // Ignore a stale coordinate while rows or columns are being rebuilt.
      }
    })
  }, [clearApprovalHighlights])
  approvalHighlightRendererRef.current = renderApprovalHighlights

  const clearProtectionHighlights = useCallback(() => {
    protectionHighlightRenderGenerationRef.current += 1
    if (protectionHighlightRenderFrameRef.current !== null) {
      window.cancelAnimationFrame(protectionHighlightRenderFrameRef.current)
      protectionHighlightRenderFrameRef.current = null
    }
    protectionHighlightDisposablesRef.current.forEach((item) => item.dispose())
    protectionHighlightDisposablesRef.current = []
    protectionMarkLayerRef.current?.clear()
  }, [])

  const requestProtectionHighlightRefresh = useCallback(() => {
    if (!showProtectionHighlightsRef.current) return
    if (protectionHighlightRefreshTimerRef.current) {
      clearTimeout(protectionHighlightRefreshTimerRef.current)
    }
    protectionHighlightRefreshTimerRef.current = setTimeout(() => {
      protectionHighlightRefreshTimerRef.current = null
      protectionHighlightRendererRef.current()
    }, 120)
  }, [])

  const clearPresenceVisuals = useCallback(() => {
    presenceDisposablesRef.current.forEach((item) => item.dispose())
    presenceDisposablesRef.current = []
  }, [])

  const hidePlainTextTooltip = useCallback((immediately?: boolean) => {
    if (plainTextTooltipTimerRef.current) {
      clearTimeout(plainTextTooltipTimerRef.current)
      plainTextTooltipTimerRef.current = null
    }
    if (immediately) {
      setPlainTextTooltip(null)
      return
    }
    // The pointer has to cross the gap between the badge and the card.
    plainTextTooltipTimerRef.current = setTimeout(() => {
      plainTextTooltipTimerRef.current = null
      setPlainTextTooltip(null)
    }, PLAIN_TEXT_TOOLTIP_DELAY)
  }, [])

  const showPlainTextTooltip = useCallback((row: number, column: number, rect: PlainRect) => {
    const marker = plainTextMarkersRef.current.find((item) => item.row === row && item.column === column)
    if (!marker) return
    const overlayRect = plainTextOverlayRef.current?.getBoundingClientRect()
    if (!overlayRect) return
    if (plainTextTooltipTimerRef.current) {
      clearTimeout(plainTextTooltipTimerRef.current)
      plainTextTooltipTimerRef.current = null
    }
    const flip = rect.x + rect.width + PLAIN_TEXT_TOOLTIP_WIDTH > window.innerWidth
    setPlainTextTooltip({
      signature: marker.signature,
      row: marker.row,
      column: marker.column,
      kind: marker.kind,
      preview: marker.preview,
      left: rect.x - overlayRect.left + (flip ? -PLAIN_TEXT_TOOLTIP_WIDTH - 4 : rect.width + 4),
      top: rect.y - overlayRect.top - 4,
      flip,
    })
  }, [])

  const clearPlainTextBadges = useCallback(() => {
    plainTextMarkersRef.current = []
    plainTextBadgeHandlesRef.current.forEach((handle) => handle.dispose())
    plainTextBadgeHandlesRef.current.clear()
    if (plainTextRetryTimerRef.current) {
      clearTimeout(plainTextRetryTimerRef.current)
      plainTextRetryTimerRef.current = null
    }
    if (plainTextTooltipTimerRef.current) {
      clearTimeout(plainTextTooltipTimerRef.current)
      plainTextTooltipTimerRef.current = null
    }
    plainTextRetryCountRef.current = 0
    pendingPlainTextScanRef.current = false
    pendingPlainTextNotifyRef.current = false
    setPlainTextNotice(null)
    setPlainTextTooltip(null)
  }, [])

  const convertPlainTextMarkers = useCallback(
    (markers: NonPlainTextMarker[]) => {
      /* eslint-disable-next-line no-use-before-define */
      const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()
      if (!worksheet || markers.length === 0) return 0
      let converted = 0
      markers.forEach((marker) => {
        if (convertMarkerToPlainText(worksheet, marker)) converted += 1
      })
      if (converted > 0) {
        setPlainTextNotice(null)
        hidePlainTextTooltip(true)
        refreshPlainTextBadgesRef.current({ scan: true })
      }
      return converted
    },
    [hidePlainTextTooltip]
  )

  const convertPlainTextCell = useCallback(
    (row: number, column: number) => {
      const marker = plainTextMarkersRef.current.find((item) => item.row === row && item.column === column)
      if (marker) convertPlainTextMarkers([marker])
    },
    [convertPlainTextMarkers]
  )

  /**
   * Flattens every flagged cell of the current selection, which is how a whole
   * row or a pasted block is cleaned up in one go. Hyperlinks are skipped by the
   * scan itself, so a batch conversion can never throw a link away.
   */
  const convertPlainTextSelection = useCallback(() => {
    /* eslint-disable-next-line no-use-before-define */
    const univerResult = univerApiRef.current
    const workbook = univerResult?.univerAPI.getActiveWorkbook?.()
    const worksheet = workbook?.getActiveSheet?.()
    const reader =
      univerResult && workbook && worksheet
        ? createWorksheetCellReader(univerResult.univer, workbook.getId(), worksheet.getSheetId())
        : null
    if (!reader || !worksheet) return
    const areas = resolveSelectionScanAreas(
      worksheet as Parameters<typeof resolveSelectionScanAreas>[0],
      worksheet.getSelection?.() as Parameters<typeof resolveSelectionScanAreas>[1]
    )
    const markers: NonPlainTextMarker[] = []
    const seen = new Set<string>()
    areas.forEach((area) => {
      collectNonPlainTextMarkers(reader, area).forEach((marker) => {
        const key = `${marker.row}:${marker.column}`
        if (seen.has(key)) return
        seen.add(key)
        markers.push(marker)
      })
    })
    const converted = convertPlainTextMarkers(markers)
    setPlainTextActionNotice(
      converted > 0 ? `已把所选区域中的 ${converted} 个单元格转为纯文本。` : '所选区域没有需要转换的单元格。'
    )
    window.setTimeout(() => setPlainTextActionNotice(''), 3200)
  }, [convertPlainTextMarkers])

  /**
   * Creates, keeps or drops the floating badges of the marked cells. Univer owns
   * the positioning, so only the marker set matters here, and a marker whose
   * content changed is rebuilt while untouched ones are left alone.
   */
  const syncPlainTextBadges = useCallback(
    (worksheet: unknown, markers: NonPlainTextMarker[]) => {
      const handles = plainTextBadgeHandlesRef.current
      const wanted = new Map<string, NonPlainTextMarker>()
      markers.forEach((marker) => wanted.set(`${marker.row}:${marker.column}`, marker))
      handles.forEach((handle, key) => {
        const marker = wanted.get(key)
        if (!marker || handle.signature !== marker.signature) {
          handle.dispose()
          handles.delete(key)
        }
      })
      if (!worksheet) return
      wanted.forEach((marker, key) => {
        if (handles.has(key)) return
        const handle = addPlainTextBadge(worksheet as Parameters<typeof addPlainTextBadge>[0], marker, {
          row: marker.row,
          column: marker.column,
          kind: marker.kind,
          preview: marker.preview,
          onConvert: () => convertPlainTextCell(marker.row, marker.column),
          onHover: (rect) => {
            if (rect) showPlainTextTooltip(marker.row, marker.column, rect)
            else hidePlainTextTooltip()
          },
        })
        if (handle) handles.set(key, { ...handle, signature: marker.signature })
      })
    },
    [convertPlainTextCell, hidePlainTextTooltip, showPlainTextTooltip]
  )

  /**
   * Finds the cells that are not plain text and gives each one a corner badge.
   * Scanning is the expensive half, so it runs once per animation frame at most
   * and only when the sheet content actually changed: Univer keeps the badge DOM
   * anchored while the sheet scrolls or zooms.
   */
  const refreshPlainTextBadges = useCallback(
    (options?: { scan?: boolean; notify?: boolean }) => {
      if (options?.scan) pendingPlainTextScanRef.current = true
      if (options?.notify) pendingPlainTextNotifyRef.current = true
      if (plainTextRefreshFrameRef.current !== null) return
      plainTextRefreshFrameRef.current = window.requestAnimationFrame(() => {
        plainTextRefreshFrameRef.current = null
        const shouldScan = pendingPlainTextScanRef.current
        const shouldNotify = pendingPlainTextNotifyRef.current
        pendingPlainTextScanRef.current = false
        pendingPlainTextNotifyRef.current = false
        if (!shouldScan) return

        const retryLater = () => {
          if (plainTextRetryTimerRef.current || plainTextRetryCountRef.current >= 25) return
          plainTextRetryCountRef.current += 1
          plainTextRetryTimerRef.current = setTimeout(() => {
            plainTextRetryTimerRef.current = null
            refreshPlainTextBadgesRef.current({ scan: true })
          }, 120)
        }

        // The workbook is created asynchronously, so the first attempts may not
        // be able to read the worksheet yet: retry shortly.
        const univerResult = univerApiRef.current
        const workbook = univerResult?.univerAPI.getActiveWorkbook?.()
        const worksheet = workbook?.getActiveSheet?.()
        if (!univerResult || !workbook || !worksheet) {
          retryLater()
          return
        }
        const reader = createWorksheetCellReader(univerResult.univer, workbook.getId(), worksheet.getSheetId())
        if (!reader) {
          retryLater()
          return
        }
        const area = resolveScanArea(worksheet, {
          rowCount: Math.max(worksheet.getMaxRows?.() || 1, 1),
          columnCount: Math.max(worksheet.getMaxColumns?.() || 1, 1),
        })
        const markers = collectNonPlainTextMarkers(reader, area.range)
        const previousKeys = new Set(plainTextMarkersRef.current.map((marker) => `${marker.row}:${marker.column}`))
        plainTextMarkersRef.current = markers
        plainTextRetryCountRef.current = 0
        syncPlainTextBadges(worksheet, markers)
        if (shouldNotify) {
          const fresh = markers.filter((marker) => !previousKeys.has(`${marker.row}:${marker.column}`))
          if (fresh.length > 0) setPlainTextNotice({ markers: fresh, total: markers.length, truncated: area.truncated })
        }
      })
    },
    [syncPlainTextBadges]
  )

  // The scan, the conversion and the paste notifier run from long lived
  // subscriptions, so they go through refs to always see the latest callbacks.
  useEffect(() => {
    refreshPlainTextBadgesRef.current = refreshPlainTextBadges
    convertPlainTextSelectionRef.current = convertPlainTextSelection
  }, [convertPlainTextSelection, refreshPlainTextBadges])

  const getProtectionRange = useCallback((item: ProtectionInfo) => {
    const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
    const worksheet = workbook?.getActiveSheet?.()
    if (!worksheet) return null
    const columns = latestSheetRef.current.columns || []
    const columnKey = item.column_key || item.key
    const columnIndex = columns.findIndex((column) => column.key === columnKey)
    const maxRows = Math.max(worksheet.getMaxRows?.() || 1, 1)
    const maxColumns = Math.max(worksheet.getMaxColumns?.() || columns.length || 1, 1)

    if (item.scope === 'row' && typeof item.row_index === 'number') {
      const row = Math.max(0, item.row_index + 1)
      return { worksheet, range: worksheet.getRange(row, 0, 1, maxColumns), row, column: 0 }
    }
    if (item.scope === 'column' && columnIndex >= 0) {
      return { worksheet, range: worksheet.getRange(1, columnIndex, Math.max(maxRows - 1, 1), 1), row: 1, column: columnIndex }
    }
    if (item.scope === 'cell' && typeof item.row_index === 'number' && columnIndex >= 0) {
      const row = Math.max(0, item.row_index + 1)
      return { worksheet, range: worksheet.getRange(row, columnIndex, 1, 1), row, column: columnIndex }
    }
    return null
  }, [])

  const focusProtection = useCallback((item: ProtectionInfo) => {
    const target = getProtectionRange(item)
    if (!target) return
    setShowProtectionHighlights(true)
    const targetLabel = item.scope === 'row' ? `第 ${(item.row_index ?? 0) + 2} 行` : item.scope === 'column' ? `列 ${item.column_key || item.key}` : `${item.column_key || item.key}${(item.row_index ?? 0) + 2}`
    setProtectionFocusNotice(`${item.owner_name}已为 ${targetLabel} 设置${formatProtectionMode(item)}`)
    target.range.activate?.()
    target.worksheet.scrollToCell?.(target.row, target.column)
    protectionFocusDisposableRef.current?.dispose()
    protectionFocusDisposableRef.current = target.range.highlight({
      stroke: (item.hidden ? HIDDEN_PROTECTION_VISUAL : visualForUser(item.owner_id)).stroke,
      strokeWidth: 3,
      strokeDash: 6,
      isAnimationDash: true,
      fill: 'rgba(255, 255, 255, 0.01)',
    })
    if (protectionFocusTimerRef.current) clearTimeout(protectionFocusTimerRef.current)
    protectionFocusTimerRef.current = setTimeout(() => {
      protectionFocusDisposableRef.current?.dispose()
      protectionFocusDisposableRef.current = null
      protectionFocusTimerRef.current = null
    }, 3200)
    window.setTimeout(() => syncSelectionState(), 0)
  }, [getProtectionRange, syncSelectionState])

  const renderProtectionHighlights = useCallback(() => {
    clearProtectionHighlights()
    if (!showProtectionHighlightsRef.current || protectionHighlightsLoadingRef.current) return

    const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
    const worksheet = workbook?.getActiveSheet?.()
    if (!worksheet) return
    const columns = latestSheetRef.current.columns || []
    const maxRows = Math.max(worksheet.getMaxRows?.() || 2, 2)
    const maxColumns = Math.max(worksheet.getMaxColumns?.() || columns.length || 1, 1)
    const columnsSignature = columns.map((column) => column.key).join('\u001f')
    const snapshot = protectionSnapshotRef.current
    const cached = protectionHighlightBlocksCacheRef.current
    const blocks = cached && cached.snapshot === snapshot && cached.columnsSignature === columnsSignature && cached.maxRows === maxRows && cached.maxColumns === maxColumns
      ? cached.blocks
      : buildProtectionHighlightBlocks(snapshot, columns, maxRows, maxColumns)
    protectionHighlightBlocksCacheRef.current = { snapshot, columnsSignature, maxRows, maxColumns, blocks }
    let visibleRange: { startRow: number; endRow: number; startColumn: number; endColumn: number } | null = null
    try {
      const range = worksheet.getVisibleRange?.()
      if (range) {
        visibleRange = {
          startRow: range.startRow,
          endRow: range.endRow,
          startColumn: range.startColumn,
          endColumn: range.endColumn,
        }
      }
    } catch {
      visibleRange = null
    }
    const renderBlocks = clipProtectionHighlightBlocks(blocks, visibleRange, maxRows, maxColumns)
    const shapes: MarkShape[] = renderBlocks.map((block) => {
      const visual = block.hidden ? HIDDEN_PROTECTION_VISUAL : visualForUser(block.ownerId)
      return {
        range: { startRow: block.startRow, endRow: block.endRow, startColumn: block.startColumn, endColumn: block.endColumn },
        style: {
          stroke: 'rgba(0, 0, 0, 0)',
          strokeWidth: 0,
          fill: visual.fill,
          rowHeaderFill: block.scope === 'row' ? visual.fill : undefined,
          columnHeaderFill: block.scope === 'column' ? visual.fill : undefined,
        },
      }
    })
    const layer = protectionMarkLayerRef.current
    if (layer) {
      try {
        layer.replace(shapes)
      } catch (highlightError) {
        console.error('Failed to highlight protected ranges:', highlightError)
      }
      return
    }

    const generation = protectionHighlightRenderGenerationRef.current
    let blockIndex = 0
    const renderChunk = () => {
      if (generation !== protectionHighlightRenderGenerationRef.current || !showProtectionHighlightsRef.current) return
      protectionHighlightRenderFrameRef.current = null
      const frameStartedAt = performance.now()
      while (blockIndex < shapes.length && performance.now() - frameStartedAt < 8) {
        const shape = shapes[blockIndex]
        blockIndex += 1
        try {
          const range = worksheet.getRange(shape.range.startRow, shape.range.startColumn, shape.range.endRow - shape.range.startRow + 1, shape.range.endColumn - shape.range.startColumn + 1)
          protectionHighlightDisposablesRef.current.push(range.highlight(shape.style))
        } catch (highlightError) {
          console.error('Failed to highlight protected range:', highlightError)
        }
      }
      if (blockIndex < shapes.length) {
        protectionHighlightRenderFrameRef.current = window.requestAnimationFrame(renderChunk)
      }
    }
    renderChunk()
  }, [clearProtectionHighlights])
  protectionHighlightRendererRef.current = renderProtectionHighlights

  useEffect(() => {
    protectionSnapshotRef.current = protectionSnapshot
    showProtectionHighlightsRef.current = protectionHighlightPreferenceReady && showProtectionHighlights
    protectionHighlightsLoadingRef.current = loading
    if (!protectionHighlightPreferenceReady || !showProtectionHighlights || loading) {
      if (protectionHighlightRefreshTimerRef.current) {
        clearTimeout(protectionHighlightRefreshTimerRef.current)
        protectionHighlightRefreshTimerRef.current = null
      }
      clearProtectionHighlights()
      return
    }
    requestProtectionHighlightRefresh()
  }, [clearProtectionHighlights, loading, protectionHighlightPreferenceReady, protectionSnapshot, requestProtectionHighlightRefresh, showProtectionHighlights])

  useEffect(() => {
    if (!protectionHighlightPreferenceReady || !showProtectionHighlights) return
    const root = containerRef.current
    const refresh = () => requestProtectionHighlightRefresh()
    const resizeObserver = root && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refresh) : null
    if (root) resizeObserver?.observe(root)
    root?.addEventListener('scroll', refresh, true)
    window.addEventListener('resize', refresh)
    return () => {
      resizeObserver?.disconnect()
      root?.removeEventListener('scroll', refresh, true)
      window.removeEventListener('resize', refresh)
    }
  }, [protectionHighlightPreferenceReady, requestProtectionHighlightRefresh, showProtectionHighlights])

  useEffect(() => {
    clearPresenceVisuals()
    if (loading) return
    const currentClientId = getRealtimeClientId()
    const columns = latestSheetRef.current.columns || []
    const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
    const worksheet = workbook?.getActiveSheet?.()
    if (!worksheet) return

    sheetPresence.forEach((entry) => {
      if (entry.state === 'viewing' || typeof entry.row !== 'number' || !entry.col) return
      // Sessions that belong to the same account (or to this very tab) are never
      // rendered as somebody else's presence: opening the same sheet twice must
      // not make you look like a second person editing your own cells.
      if (entry.clientId === currentClientId || (profile?.id != null && entry.userId === profile.id)) return
      const columnIndex = columns.findIndex((column) => column.key === entry.col)
      if (columnIndex < 0) return
      const visual = visualForUser(entry.userId)
      try {
        const range = worksheet.getRange(entry.row + 1, columnIndex, 1, 1)
        // A plain highlight only — the previous alert popup was a fixed 260x88
        // box painted on top of the cell, which covered the value and swallowed
        // clicks, so collaborator activity is surfaced through the presence
        // widget instead of covering the cell itself.
        presenceDisposablesRef.current.push(range.highlight({
          stroke: visual.stroke,
          strokeWidth: entry.state === 'editing' ? 3 : 2,
          strokeDash: entry.state === 'editing' ? 0 : 5,
          isAnimationDash: entry.state !== 'editing',
          fill: entry.state === 'editing' ? visual.fill : 'rgba(255, 255, 255, 0.01)',
        }))
      } catch (presenceError) {
        console.error('Failed to render collaborator presence:', presenceError)
      }
    })
    return clearPresenceVisuals
  }, [clearPresenceVisuals, loading, presenceRedrawToken, profile?.id, sheetId, sheetPresence])

  useEffect(() => () => {
    clearProtectionHighlights()
    clearApprovalHighlights()
    clearPresenceVisuals()
    protectionFocusDisposableRef.current?.dispose()
    protectionFocusDisposableRef.current = null
    if (protectionFocusTimerRef.current) clearTimeout(protectionFocusTimerRef.current)
    if (protectionHighlightRefreshTimerRef.current) clearTimeout(protectionHighlightRefreshTimerRef.current)
  }, [clearApprovalHighlights, clearPresenceVisuals, clearProtectionHighlights])

  // Hide global FABs when image picker or blocking Univer dialogs are open
  useEffect(() => {
    if (showImagePicker || univerHasOverlay || showProtectionPanel || showApprovalPanel || showFieldControlPanel || optionPickerTarget) {
      document.body.classList.add('fab-hidden')
    } else {
      document.body.classList.remove('fab-hidden')
    }
    return () => { document.body.classList.remove('fab-hidden') }
  }, [optionPickerTarget, showApprovalPanel, showFieldControlPanel, showImagePicker, showProtectionPanel, univerHasOverlay])

  // Watch Univer blocking dialogs and side panels separately.
  useEffect(() => {
    const check = () => {
      const overlays = document.querySelectorAll('[role="dialog"][class*="univer-"]')
      // Univer keeps its sidebar elements mounted with zero width while closed.
      const sidebars = document.querySelectorAll('[data-u-comp="sidebar"], [data-u-comp="right-sidebar"]')
      let hasVisible = false
      overlays.forEach((el) => {
        if ((el as HTMLElement).offsetParent !== null) hasVisible = true
      })
      let hasVisibleSidebar = false
      sidebars.forEach((el) => {
        if (el.getBoundingClientRect().width > 0) hasVisibleSidebar = true
      })
      setUniverHasOverlay(hasVisible)
      setUniverSidebarOpen(hasVisibleSidebar)
    }

    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    check()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const current = latestSheetRef.current
    if (!sheet.config_omitted || current.id !== sheet.id || current.config_omitted) {
      latestSheetRef.current = sheet
      return
    }
    // A workbook summary refresh carries the sheet's rules but not its cells:
    // keep the cells and styles this editor already holds.
    const currentConfig = parseSheetConfig(current.config) as Record<string, unknown>
    latestSheetRef.current = {
      ...sheet,
      frozen: sheet.frozen ?? current.frozen,
      config_omitted: false,
      config: {
        ...parseSheetConfig(sheet.config),
        univerSheetData: currentConfig.univerSheetData,
        univerStyles: currentConfig.univerStyles,
      },
    }
  }, [sheet])

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PROTECTION_HIGHLIGHT_PREFERENCE_KEY)
      if (stored !== null) setShowProtectionHighlights(stored === 'true')
    } catch (storageError) {
      console.warn('Failed to load protection highlight preference:', storageError)
    } finally {
      setProtectionHighlightPreferenceReady(true)
    }
  }, [])

  useEffect(() => {
    if (!protectionHighlightPreferenceReady) return
    try {
      window.localStorage.setItem(PROTECTION_HIGHLIGHT_PREFERENCE_KEY, String(showProtectionHighlights))
    } catch (storageError) {
      console.warn('Failed to save protection highlight preference:', storageError)
    }
  }, [protectionHighlightPreferenceReady, showProtectionHighlights])

  useEffect(() => {
    sheetPresenceRef.current = sheetPresence
  }, [sheetPresence])

  useEffect(() => {
    approvalStatesRef.current = approvalStates
    if (loading) {
      clearApprovalHighlights()
      return
    }
    window.requestAnimationFrame(renderApprovalHighlights)
  }, [approvalStates, clearApprovalHighlights, loading, renderApprovalHighlights])

  useEffect(() => {
    setLoading(true)
    setError('')
    setActionError('')
    setSelectionState(null)
    setProtectionSnapshot({ rows: [], columns: [], cells: [] })
    setShowProtectionPanel(false)
    setShowApprovalPanel(false)
    setShowFieldControlPanel(false)
    setShowAllProtections(false)
    setProtectionFocusNotice('')
    setProtectionUserSearch('')
    setProtectionScope('cell')
    setSelectedProtectionLockEditing(true)
    setSelectedProtectionHidden(false)
    setSelectedProtectionHideFormula(false)
    setSelectedProtectionReadonlyUserIds([])
    setSelectedProtectionReadonlyDepartmentIds([])
    setSelectedProtectionEditableUserIds([])
    setSelectedProtectionEditableDepartmentIds([])
    setSelectedProtectionViewHiddenUserIds([])
    setSelectedProtectionViewHiddenDepartmentIds([])
    setSheetPresence([])
    setApprovalStates([])
    setApprovalRules([])
    setApprovalNotice('')
    setPresenceExpanded(false)
    setHasFilter(false)
  }, [sheetId])

  useEffect(() => {
    void refreshProtectionSnapshot()
  }, [refreshProtectionSnapshot])

  useEffect(() => {
    void refreshApprovalStates()
  }, [refreshApprovalStates])

  useEffect(() => {
    if ((!showProtectionPanel && !showApprovalPanel) || protectionDirectoryLoaded) return

    let active = true
    setProtectionUsersLoading(true)
    setProtectionUsersError('')
    Promise.all([api.get<User[]>('/users/shareable'), api.get<Department[]>('/departments')])
      .then(([res, departmentRes]) => {
        if (!active) return
        setProtectionUsers(res.code === 0 && Array.isArray(res.data) ? res.data : [])
        setProtectionDepartments(departmentRes.code === 0 && Array.isArray(departmentRes.data) ? departmentRes.data : [])
      })
      .catch((err) => {
        console.error('Failed to load protection users:', err)
        if (active) {
          setProtectionUsers([])
          setProtectionUsersError('员工列表加载失败，请检查网络后重试。')
        }
      })
      .finally(() => {
        if (active) {
          setProtectionUsersLoading(false)
          setProtectionDirectoryLoaded(true)
        }
      })

    return () => {
      active = false
    }
  }, [protectionDirectoryLoaded, protectionUsersLoadToken, showApprovalPanel, showProtectionPanel])

  // Manual save handler — triggers immediate persist
  const persistCurrentSheet = useCallback(async () => {
    if (editLocked) {
      const message = '当前账号只有查看权限，不能保存表格。'
      setActionError(message)
      throw new Error(message)
    }
    if (!persistRef.current) {
      throw new Error('当前工作表还未加载完成。')
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    setSaveStatus('saving')
    try {
      await persistRef.current()
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 1500)
    } catch (e) {
      console.error('Manual save failed:', e)
      const message = e instanceof Error ? e.message : '保存失败，请稍后再试。'
      setActionError(message)
      setSaveStatus('idle')
      throw (e instanceof Error ? e : new Error(message))
    }
  }, [editLocked])

  const handleManualSave = useCallback(async () => {
    try {
      await persistCurrentSheet()
    } catch {
      // Errors are already surfaced through the action toast.
    }
  }, [persistCurrentSheet])

  const handleDroppedXlsxImport = useCallback(async (file: File) => {
    if (!canImportWorkbook) {
      setActionError('当前账号没有导入 Excel 的权限。')
      return
    }

    setActionError('')
    setDragImportUploading(true)
    setDragImportProgress(0)

    try {
      const result = await uploadWorkbookXlsx(workbookId, file, {
        onProgress: setDragImportProgress,
      })
      await onExternalReload?.()
      window.location.href = `/sheets/${workbookId}/${result.sheet_id}`
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Import failed. Please try again later.')
    } finally {
      setDragImportUploading(false)
      setDragImportActive(false)
      dragDepthRef.current = 0
      window.setTimeout(() => setDragImportProgress(0), 400)
    }
  }, [canImportWorkbook, onExternalReload, workbookId])

  const handleContainerDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canImportWorkbook || dragImportUploading) return
    const hasFile = Array.from(event.dataTransfer.types || []).includes('Files')
    if (!hasFile) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragImportActive(true)
  }, [canImportWorkbook, dragImportUploading])

  const handleContainerDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canImportWorkbook || dragImportUploading) return
    const hasFile = Array.from(event.dataTransfer.types || []).includes('Files')
    if (!hasFile) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [canImportWorkbook, dragImportUploading])

  const handleContainerDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canImportWorkbook || dragImportUploading) return
    const hasFile = Array.from(event.dataTransfer.types || []).includes('Files')
    if (!hasFile) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setDragImportActive(false)
    }
  }, [canImportWorkbook, dragImportUploading])

  const handleContainerDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!canImportWorkbook || dragImportUploading) return
    const files = Array.from(event.dataTransfer.files || [])
    if (files.length === 0) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragImportActive(false)
    const excelFile = files.find(isSupportedExcelImportFile)
    if (!excelFile) {
      setActionError(`请拖入 ${EXCEL_IMPORT_FORMATS_LABEL} 格式的文件。`)
      return
    }
    void handleDroppedXlsxImport(excelFile)
  }, [canImportWorkbook, dragImportUploading, handleDroppedXlsxImport])

  const openCustomProtectionPanel = useCallback((options?: { showAll?: boolean }) => {
    syncSelectionState()
    setShowAllProtections(Boolean(options?.showAll))
    setProtectionPanelTab(options?.showAll ? 'records' : 'settings')
    setShowProtectionPanel(true)
  }, [syncSelectionState])

  const handleSheetContextMenu = useCallback(() => {
    window.setTimeout(() => {
      syncSelectionState()
    }, 0)
  }, [syncSelectionState])

  useEffect(() => {
    const handleProtectionMenuClick = (event: Event) => {
      const menuItem = getYaerpProtectionContextMenuItem(event.target)
      if (!menuItem) return

      event.preventDefault()
      event.stopPropagation()
      if (typeof (event as { stopImmediatePropagation?: () => void }).stopImmediatePropagation === 'function') {
        ;(event as { stopImmediatePropagation: () => void }).stopImmediatePropagation()
      }

      const menuText = (menuItem.textContent || '').replace(/\s+/g, '')
      const showAll = menuText.includes('显示保护区域与记录')
      if (showAll) setShowProtectionHighlights(true)
      openCustomProtectionPanel({ showAll })
      window.setTimeout(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      }, 0)
    }

    document.addEventListener('pointerdown', handleProtectionMenuClick, true)
    document.addEventListener('click', handleProtectionMenuClick, true)
    return () => {
      document.removeEventListener('pointerdown', handleProtectionMenuClick, true)
      document.removeEventListener('click', handleProtectionMenuClick, true)
    }
  }, [openCustomProtectionPanel])

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const syncAfterPointerAction = () => {
      window.setTimeout(() => {
        if (sheetEditorActiveRef.current || imeComposingRef.current) return
        syncSelectionState()
      }, 0)
    }

    root.addEventListener('pointerup', syncAfterPointerAction, true)
    return () => {
      root.removeEventListener('pointerup', syncAfterPointerAction, true)
    }
  }, [sheetId, syncSelectionState])

  const handleEnableFilter = useCallback(async () => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能修改筛选。')
      return
    }
    setActionError('')

    try {
      const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      const dataRange = worksheet?.getDataRange?.()
      if (!worksheet || !dataRange) {
        throw new Error('当前工作表暂无可筛选的数据范围')
      }

      let filter = worksheet.getFilter?.()
      if (!filter) {
        filter = dataRange.createFilter?.() || null
      }

      if (!filter) {
        throw new Error('未能启用筛选，请先确认工作表中已有表头数据')
      }

      syncFilterState()
      await persistCurrentSheet()
    } catch (err) {
      console.error('Failed to enable filter:', err)
      setActionError(err instanceof Error ? err.message : '启用筛选失败，请稍后再试。')
    }
  }, [editLocked, persistCurrentSheet, syncFilterState])

  const handleClearFilter = useCallback(async () => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能修改筛选。')
      return
    }
    setActionError('')

    try {
      const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      const filter = worksheet?.getFilter?.()
      if (!filter) return

      filter.remove()
      syncFilterState()
      await persistCurrentSheet()
    } catch (err) {
      console.error('Failed to clear filter:', err)
      setActionError(err instanceof Error ? err.message : '清除筛选失败，请稍后再试。')
    }
  }, [editLocked, persistCurrentSheet, syncFilterState])

  const openNumberFormatPanel = useCallback(() => {
    const selection = syncSelectionState()
    const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()
    const activeRange = worksheet?.getActiveRange?.() || worksheet?.getSelection?.()?.getActiveRange?.()
    const currentPattern = normalizeUniverNumberFormatPattern(activeRange?.getNumberFormat?.() || 'General') || 'General'
    const matchedPreset = NUMBER_FORMAT_PRESETS.find((preset) => preset.pattern === currentPattern)
    setNumberFormatPreset(matchedPreset?.id || 'custom')
    setCustomNumberFormat(currentPattern)
    setNumberFormatScope(selection?.isEntireColumnSelection ? 'column' : selection?.isEntireRowSelection ? 'row' : 'selection')
    setShowNumberFormatPanel(true)
  }, [syncSelectionState])

  const handleApplyNumberFormat = useCallback(async () => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能修改单元格格式。')
      return
    }
    const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
    const worksheet = workbook?.getActiveSheet?.()
    const activeRange = worksheet?.getActiveRange?.() || worksheet?.getSelection?.()?.getActiveRange?.()
    if (!worksheet || !activeRange) {
      setActionError('请先选择需要设置格式的单元格、行或列。')
      return
    }

    const pattern = normalizeUniverNumberFormatPattern(customNumberFormat) || 'General'
    const selectionRange = activeRange.getRange()
    const dataRange = worksheet.getDataRange?.()
    const usedRange = dataRange?.getRange?.() || selectionRange
    const mergeDefaultStyle = (current: unknown) => {
      const style = current && typeof current === 'object'
        ? cloneJsonSnapshot(current as Record<string, unknown>)
        : {}
      if (pattern === 'General') delete style.n
      else style.n = { pattern }
      return Object.keys(style).length > 0 ? style : null
    }

    setApplyingNumberFormat(true)
    setActionError('')
    try {
      if (numberFormatScope === 'selection') {
        activeRange.setNumberFormat(pattern)
      } else if (numberFormatScope === 'row') {
        const startRow = selectionRange.startRow
        const endRow = selectionRange.endRow
        for (let row = startRow; row <= endRow; row += 1) {
          worksheet.setRowDefaultStyle(row, mergeDefaultStyle(worksheet.getRowDefaultStyle(row)))
        }
        worksheet.getRange(startRow, usedRange.startColumn, endRow - startRow + 1, usedRange.endColumn - usedRange.startColumn + 1).setNumberFormat(pattern)
      } else if (numberFormatScope === 'column') {
        const startColumn = selectionRange.startColumn
        const endColumn = selectionRange.endColumn
        for (let column = startColumn; column <= endColumn; column += 1) {
          worksheet.setColumnDefaultStyle(column, mergeDefaultStyle(worksheet.getColumnDefaultStyle(column)))
        }
        worksheet.getRange(usedRange.startRow, startColumn, usedRange.endRow - usedRange.startRow + 1, endColumn - startColumn + 1).setNumberFormat(pattern)
      } else {
        worksheet.setDefaultStyle(mergeDefaultStyle(worksheet.getDefaultStyle()))
        dataRange?.setNumberFormat(pattern)
      }

      await persistCurrentSheet()
      setCustomNumberFormat(pattern)
      setShowNumberFormatPanel(false)
    } catch (formatError) {
      console.error('Failed to apply number format:', formatError)
      setActionError(formatError instanceof Error ? formatError.message : '设置单元格格式失败，请稍后再试。')
    } finally {
      setApplyingNumberFormat(false)
    }
  }, [customNumberFormat, editLocked, numberFormatScope, persistCurrentSheet])

  const handleProtectionRangeChange = useCallback(async (scope: ProtectionScope, action: 'lock' | 'unlock', hidden?: boolean) => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能修改保护状态。')
      return
    }
    const selection = syncSelectionState()
    if (!selection) {
      setActionError('请先在工作表中框选需要保护的范围。')
      return
    }
    const effectiveScope: ProtectionScope = selection.isEntireColumnSelection
      ? 'column'
      : selection.isEntireRowSelection
        ? 'row'
        : scope
    const columns = latestSheetRef.current.columns || []
    const startColumnIndex = columns.findIndex((column) => column.key === selection.columnKey)
    const endColumnIndex = columns.findIndex((column) => column.key === selection.endColumnKey)
    if (effectiveScope !== 'row' && (startColumnIndex < 0 || endColumnIndex < 0)) {
      setActionError('当前选择的列信息无效，请重新选择。')
      return
    }

    const requests: Array<Omit<ProtectionMutationPayload, 'action'>> = []
    if (effectiveScope === 'row') {
      for (let row = selection.rowIndex; row <= selection.endRowIndex; row += 1) {
        requests.push({ scope: 'row', row_index: row })
      }
    } else if (effectiveScope === 'column') {
      const start = Math.min(startColumnIndex, endColumnIndex)
      const end = Math.max(startColumnIndex, endColumnIndex)
      for (let index = start; index <= end; index += 1) {
        requests.push({ scope: 'column', column_key: columns[index]?.key })
      }
    } else {
      const start = Math.min(startColumnIndex, endColumnIndex)
      const end = Math.max(startColumnIndex, endColumnIndex)
      for (let row = selection.rowIndex; row <= selection.endRowIndex; row += 1) {
        for (let index = start; index <= end; index += 1) {
          if (columns[index]?.key) {
            requests.push({ scope: 'cell', row_index: row, column_key: columns[index].key })
          }
        }
      }
    }

    if (requests.length === 0) return

    setActionError('')
    setProtectionAction(`${scope}:bulk:${action}`)

    try {
      const res = await api.post<{ sheet?: Sheet; protections?: ProtectionSnapshot }>(`/sheets/${sheetId}/protections/batch`, {
        items: requests.map((request) => ({
          ...request,
          action,
          ...(action === 'lock' ? { readonly_user_ids: selectedProtectionReadonlyUserIds } : {}),
          ...(action === 'lock' ? { readonly_department_ids: selectedProtectionReadonlyDepartmentIds } : {}),
          ...(action === 'lock' ? { editable_user_ids: selectedProtectionEditableUserIds } : {}),
          ...(action === 'lock' ? { editable_department_ids: selectedProtectionEditableDepartmentIds } : {}),
          ...(action === 'lock' ? { view_hidden_user_ids: selectedProtectionViewHiddenUserIds } : {}),
          ...(action === 'lock' ? { view_hidden_department_ids: selectedProtectionViewHiddenDepartmentIds } : {}),
          ...(action === 'lock' ? { lock_editing: selectedProtectionLockEditing } : {}),
          ...(action === 'lock' && typeof hidden === 'boolean' ? { hidden } : {}),
          ...(action === 'lock' ? { hide_formula: selectedProtectionHideFormula } : {}),
        })),
      })
      if (res.code !== 0) {
        throw new Error(res.message || '批量保护失败')
      }
      if (res.data?.sheet) {
        latestSheetRef.current = res.data.sheet
      }
      if (res.data?.protections) {
        setProtectionSnapshot(res.data.protections)
      } else {
        await refreshProtectionSnapshot()
      }
      refreshPermissions()
    } catch (err) {
      console.error('Failed to update protection range:', err)
      setActionError(err instanceof Error ? err.message : '批量保护失败，请稍后再试。')
    } finally {
      setProtectionAction('')
    }
  }, [editLocked, refreshPermissions, refreshProtectionSnapshot, selectedProtectionEditableDepartmentIds, selectedProtectionEditableUserIds, selectedProtectionHideFormula, selectedProtectionLockEditing, selectedProtectionReadonlyDepartmentIds, selectedProtectionReadonlyUserIds, selectedProtectionViewHiddenDepartmentIds, selectedProtectionViewHiddenUserIds, sheetId, syncSelectionState])

  const selectedColumnKeys = useCallback((selection: SelectionState) => {
    const columns = latestSheetRef.current.columns || []
    const start = columns.findIndex((column) => column.key === selection.columnKey)
    const end = columns.findIndex((column) => column.key === selection.endColumnKey)
    if (start < 0 || end < 0) return []
    return columns.slice(Math.min(start, end), Math.max(start, end) + 1).map((column) => column.key)
  }, [])

  const collectSelectedColumnOptions = useCallback(() => {
    const selection = syncSelectionState()
    const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
    const worksheet = workbook?.getActiveSheet?.()
    const columns = latestSheetRef.current.columns || []
    const columnIndex = selection ? columns.findIndex((column) => column.key === selection.columnKey) : -1
    if (!worksheet || columnIndex < 0) return []
    try {
      const maxRows = Math.max(worksheet.getMaxRows?.() || 2, 2)
      const values = worksheet.getRange(1, columnIndex, Math.max(maxRows - 1, 1), 1).getValues?.() || []
      return Array.from(new Set(values.flat().map((value: unknown) => String(value ?? '').trim()).filter(Boolean))).slice(0, 500)
    } catch {
      return []
    }
  }, [syncSelectionState])

  const applySupplierFieldTemplate = useCallback(() => {
    const selection = syncSelectionState()
    const configured = selection
      ? latestSheetRef.current.columns?.find((column) => column.key === selection.columnKey)?.options || []
      : []
    const observed = collectSelectedColumnOptions()
    const existing = Array.from(new Set([...configured, ...observed].map((option) => String(option).trim()).filter(Boolean)))
    const options = existing.length > 0 ? existing : ['供应商 A', '供应商 B', '供应商 C']
    setFieldControlType('select')
    setFieldControlSearchable(true)
    setFieldControlOptions(options)
    setFieldControlColors(Object.fromEntries(options.map((option, index) => [option, OPTION_COLOR_PALETTE[index % OPTION_COLOR_PALETTE.length]])))
  }, [collectSelectedColumnOptions, syncSelectionState])

  const openFieldControls = useCallback(() => {
    const selection = syncSelectionState()
    if (!selection) {
      setActionError('请先选择需要设置字段控件的列或单元格范围。')
      return
    }
    const column = latestSheetRef.current.columns?.find((item) => item.key === selection.columnKey)
    if (column?.type === 'checkbox') {
      setFieldControlType('checkbox')
      setFieldControlOptions(column.options?.slice(0, 2) || ['是', '否'])
      setFieldControlSearchable(false)
    } else if (column?.type === 'select') {
      setFieldControlType('select')
      setFieldControlOptions(column.options?.length ? column.options : ['待处理', '已完成', '已取消'])
      setFieldControlSearchable(Boolean(column.searchable))
    } else {
      setFieldControlType('select')
      setFieldControlOptions(['待处理', '已完成', '已取消'])
      setFieldControlSearchable(false)
    }
    const options = column?.options?.length ? column.options : ['待处理', '已完成', '已取消']
    setFieldControlColors(Object.fromEntries(options.map((option, index) => [option, optionColorFor(column || { key: '', name: '', type: 'text' }, option, index)])))
    setShowFieldControlPanel(true)
  }, [syncSelectionState])

  const handleApplyFieldControl = useCallback(async () => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能配置字段控件。')
      return
    }
    const selection = syncSelectionState()
    const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
    const worksheet = workbook?.getActiveSheet?.()
    const univerAPI = univerApiRef.current?.univerAPI
    if (!selection || !worksheet || !univerAPI) {
      setActionError('请先选择需要设置的列。')
      return
    }
    const keys = selectedColumnKeys(selection)
    if (keys.length === 0) {
      setActionError('当前选区没有有效列。')
      return
    }
    const normalizedOptions = Array.from(new Set(fieldControlOptions.map((item) => item.trim()).filter(Boolean)))
    if (fieldControlType === 'select' && normalizedOptions.length < 2) {
      setActionError('下拉列表至少需要两个选项。')
      return
    }
    if (fieldControlType === 'checkbox' && normalizedOptions.length < 2) {
      setActionError('复选框需要“选中”和“未选中”两个值。')
      return
    }

    const nextColumns = (latestSheetRef.current.columns || []).map((column) => {
      if (!keys.includes(column.key)) return column
      if (fieldControlType === 'none') {
        const next = { ...column, type: 'text' as const }
        delete next.options
        delete next.optionColors
        delete next.searchable
        return next
      }
      const options = fieldControlType === 'checkbox' ? normalizedOptions.slice(0, 2) : normalizedOptions
      const optionColors = Object.fromEntries(options.map((option, index) => [option, fieldControlColors[option] || optionColorFor(column, option, index)]))
      return { ...column, type: fieldControlType, options, optionColors, searchable: fieldControlType === 'select' && fieldControlSearchable }
    })

    setFieldControlApplying(true)
    setActionError('')
    try {
      latestSheetRef.current = { ...latestSheetRef.current, columns: nextColumns }
      applyingRemotePatchRef.current = true
      applyColumnDataControls(univerAPI, worksheet, nextColumns, new Set(keys))
      applyingRemotePatchRef.current = false
      await persistCurrentSheet()
      setShowFieldControlPanel(false)
      setApprovalNotice(`已为 ${keys.length} 列应用${fieldControlType === 'checkbox' ? '复选框' : fieldControlType === 'select' ? '下拉列表与状态颜色' : '普通文本'}。`)
      window.setTimeout(() => setApprovalNotice(''), 3200)
    } catch (err) {
      applyingRemotePatchRef.current = false
      setActionError(err instanceof Error ? err.message : '字段控件保存失败，请稍后再试。')
    } finally {
      setFieldControlApplying(false)
    }
  }, [editLocked, fieldControlColors, fieldControlOptions, fieldControlSearchable, fieldControlType, persistCurrentSheet, selectedColumnKeys, syncSelectionState])

  const handleSearchableOptionSelect = useCallback((value: string | null) => {
    const target = optionPickerTarget
    if (!target) return
    if (editLocked || !canEditCell(target.columnKey, target.row - 1)) {
      setActionError('当前账号不能修改这个单元格。')
      return
    }
    try {
      const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      if (!worksheet) throw new Error('工作表尚未加载完成')
      worksheet.getRange(target.row, target.column, 1, 1).setValue(value ?? '')
      setOptionPickerTarget(null)
      setOptionPickerSearch('')
      schedulePersistRef.current()
      setApprovalNotice(`已将${target.columnName}设置为${value ? `“${value}”` : '空值'}。`)
      window.setTimeout(() => setApprovalNotice(''), 2400)
    } catch (pickerError) {
      setActionError(pickerError instanceof Error ? pickerError.message : '下拉选项写入失败。')
    }
  }, [canEditCell, editLocked, optionPickerTarget])

  const openApprovalFlowPanel = useCallback(() => {
    const selection = syncSelectionState()
    if (!selection) {
      setActionError('请先框选需要审批的单元格、行或列。')
      return
    }
    setApprovalName(`${selection.columnLabel}审批`)
    setApprovalDescription(`范围：${selection.rangeLabel}。审批通过后才写入正式数据。`)
    setShowApprovalPanel(true)
    setApprovalLoading(true)
    Promise.all([refreshApprovalRules(), refreshApprovalStates()]).finally(() => setApprovalLoading(false))
  }, [refreshApprovalRules, refreshApprovalStates, syncSelectionState])

  const handleCreateApprovalFlow = useCallback(async () => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能创建审批流程。')
      return
    }
    const selection = syncSelectionState()
    if (!selection) {
      setActionError('请先框选审批范围。')
      return
    }
    const columns = selectedColumnKeys(selection)
    if (columns.length === 0) {
      setActionError('审批范围没有有效列。')
      return
    }
    const steps = approvalSteps.map(({ id: _id, ...step }) => ({
      ...step,
      required_approvals: Math.max(1, step.required_approvals || 1),
    }))
    if (steps.some((step) => step.user_ids.length + step.department_ids.length === 0)) {
      setActionError('每个审批步骤至少选择一名员工或一个部门。')
      return
    }
    const allRows = selection.isEntireColumnSelection || (selection.includesHeaderRow && selection.endRowIndex < 0)
    const startRow = allRows ? undefined : Math.max(0, selection.rowIndex)
    const endRow = allRows ? undefined : Math.max(startRow || 0, selection.endRowIndex)
    setApprovalAction('create')
    setActionError('')
    try {
      const res = await api.post<AutomationRule>('/automation/rules', {
        name: approvalName.trim() || '选区数据审批',
        description: approvalDescription.trim(),
        sheet_id: sheetId,
        trigger_type: 'cell_change',
        watched_columns: columns,
        cron_expr: '',
        timezone: 'Asia/Shanghai',
        condition_logic: 'all',
        conditions: [],
        approval_steps: steps,
        approval_ranges: [{ start_row: startRow, end_row: endRow, columns }],
        actions: [{
          type: 'notify',
          recipient_type: 'trigger_user',
          title_template: '审批通过：{{rule.name}}',
          message_template: '{{sheet.name}} 第 {{row.number}} 行的待审内容已正式写入。',
        }],
        hold_changes: true,
        enabled: true,
      })
      if (res.code !== 0) throw new Error(res.message || '创建审批流程失败')
      await refreshApprovalRules()
      setApprovalNotice('审批流程已生效，后续修改会先进入待审批状态。')
      window.setTimeout(() => setApprovalNotice(''), 4200)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '创建审批流程失败，请稍后再试。')
    } finally {
      setApprovalAction('')
    }
  }, [approvalDescription, approvalName, approvalSteps, editLocked, refreshApprovalRules, selectedColumnKeys, sheetId, syncSelectionState])

  const handleDeleteApprovalRule = useCallback(async (rule: AutomationRule) => {
    if (!window.confirm(`确定删除审批流程“${rule.name}”吗？`)) return
    setApprovalAction(`delete:${rule.id}`)
    try {
      const res = await api.delete(`/automation/rules/${rule.id}`)
      if (res.code !== 0) throw new Error(res.message || '删除审批流程失败')
      await refreshApprovalRules()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '删除审批流程失败，请稍后再试。')
    } finally {
      setApprovalAction('')
    }
  }, [refreshApprovalRules])

  const focusApprovalState = useCallback((item: CellApprovalState) => {
    const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook?.()?.getActiveSheet?.()
    const columnIndex = latestSheetRef.current.columns?.findIndex((column) => column.key === item.col) ?? -1
    if (!worksheet || columnIndex < 0) return
    worksheet.getRange(item.row + 1, columnIndex, 1, 1).activate()
    worksheet.scrollToCell?.(item.row + 1, columnIndex)
    window.setTimeout(() => syncSelectionState(), 0)
  }, [syncSelectionState])

  const handApprovalSelectionToAI = useCallback(() => {
    const selection = syncSelectionState()
    if (!selection) return
    const columns = selectedColumnKeys(selection)
    const allRows = selection.isEntireColumnSelection || (selection.includesHeaderRow && selection.endRowIndex < 0)
    window.dispatchEvent(new CustomEvent('yaerp:ai-compose', {
      detail: {
        prompt: `请为当前选区设计并创建一个 ERP 审批流程。先确认审批人和步骤；待审值只有审批通过后才写入，驳回保持原值。`,
        workbookId: Number(workbookId),
        sheetId,
        selection: {
          sheet_id: sheetId,
          start_row: allRows ? undefined : Math.max(0, selection.rowIndex),
          end_row: allRows ? undefined : Math.max(0, selection.endRowIndex),
          column_keys: columns,
          range_label: selection.rangeLabel,
        },
      },
    }))
    setShowApprovalPanel(false)
  }, [selectedColumnKeys, sheetId, syncSelectionState, workbookId])

  const applyIncomingChanges = useCallback((changes: IncomingCellChange[]) => {
    if (changes.length === 0) return
    if (structuralChangePendingRef.current || structuralSaveInFlightRef.current) {
      // Rows moved locally and that is not saved yet: the incoming row indexes
      // describe the old layout. Resync from the server once the save is done.
      resyncAfterPersistRef.current = true
      return
    }
    if (Date.now() < structuralGraceUntilRef.current) {
      // Sent by a collaborator just before our structural save reached the
      // server, so still addressed in the old layout: take the server state.
      void syncSheetSilentlyRef.current()
      return
    }
    if (sheetEditorActiveRef.current || imeComposingRef.current) {
      const queuedByCell = new Map<string, IncomingCellChange>()
      deferredIncomingChangesRef.current.forEach((change) => {
        queuedByCell.set(`${change.row}:${change.col}`, change)
      })
      changes.forEach((change) => {
        queuedByCell.set(`${change.row}:${change.col}`, change)
      })
      deferredIncomingChangesRef.current = Array.from(queuedByCell.values())
      return
    }

    try {
      const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      const columns = latestSheetRef.current.columns || []
      if (!worksheet) return

      if (remotePatchResetTimerRef.current) {
        clearTimeout(remotePatchResetTimerRef.current)
        remotePatchResetTimerRef.current = null
      }
      applyingRemotePatchRef.current = true

      changes.forEach((change) => {
        const columnIndex = columns.findIndex((column) => column.key === change.col)
        if (columnIndex < 0) return

        const range = worksheet.getRange(change.row + 1, columnIndex, 1, 1)
        if (typeof change.value === 'string' && change.value.startsWith('=')) {
          range.setValue({ f: change.value })
        } else {
          range.setValue((change.value ?? '') as string | number | boolean)
        }
      })

      persistedWorksheetDataRef.current = applyRealtimeCellChangesToWorksheetSnapshot(
        persistedWorksheetDataRef.current,
        changes,
        columns
      )
      syncSelectionState()
    } catch (err) {
      console.error('Failed to apply incoming sheet updates:', err)
    } finally {
      remotePatchResetTimerRef.current = setTimeout(() => {
        applyingRemotePatchRef.current = false
        remotePatchResetTimerRef.current = null
      }, 200)
    }
  }, [syncSelectionState])

  const syncSheetSilently = useCallback(async () => {
    if (sheetEditorActiveRef.current || imeComposingRef.current) {
      deferredSilentSyncRef.current = true
      return
    }
    if (silentSyncInFlightRef.current) {
      silentSyncQueuedRef.current = true
      return silentSyncInFlightRef.current
    }

    const runSync = async () => {
      do {
        silentSyncQueuedRef.current = false
        if (sheetEditorActiveRef.current || imeComposingRef.current) {
          deferredSilentSyncRef.current = true
          return
        }

        const hadPendingSave = Boolean(saveTimerRef.current) || structuralChangePendingRef.current
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        await persistInFlightRef.current
        if (hadPendingSave) {
          // Save local edits before merging the server state: once rows were
          // inserted or deleted locally they cannot be replayed by index.
          const reloadNonce = localReloadNonceRef.current
          try {
            await persistRef.current?.()
          } catch (persistError) {
            console.warn('Failed to save pending edits before syncing:', persistError)
          }
          // A structure conflict reloads the editor; nothing left to sync here.
          if (reloadNonce !== localReloadNonceRef.current) return
        }

        const result = univerApiRef.current
        const workbook = result?.univerAPI.getActiveWorkbook?.()
        const worksheet = workbook?.getActiveSheet?.()
        if (!workbook || !worksheet) return

        const previousSheet = latestSheetRef.current
        const previousColumns = previousSheet.columns || []
        const savedWorkbook = workbook.save()
        const savedSheetId = savedWorkbook.sheetOrder[0]
        const localSnapshot = cloneJsonSnapshot(savedWorkbook.sheets[savedSheetId] as Partial<IWorksheetData>)
        const baselineSnapshot = persistedWorksheetDataRef.current
          ? cloneJsonSnapshot(persistedWorksheetDataRef.current)
          : cloneJsonSnapshot(localSnapshot)
        const localChanges = buildRealtimeCellChanges(sheetId, baselineSnapshot, localSnapshot, previousColumns)

        const sheetResponse = await api.get<Sheet>(`/sheets/${sheetId}`)
        if (sheetResponse.code !== 0 || !sheetResponse.data) {
          throw new Error(sheetResponse.message || '同步工作表信息失败')
        }
        if (sheetEditorActiveRef.current || imeComposingRef.current) {
          deferredSilentSyncRef.current = true
          return
        }

        const nextSheet = sheetResponse.data
        const nextColumns = nextSheet.columns || []
        const nextConfig = parseSheetConfig(nextSheet.config)
        let serverSnapshot: Partial<IWorksheetData>
        if (nextConfig.univerSheetData && typeof nextConfig.univerSheetData === 'object') {
          // Snapshots are the source of truth; only fall back to the legacy row
          // API for worksheets that have not been migrated yet.
          serverSnapshot = inferMissingCellTypes(cloneJsonSnapshot(nextConfig.univerSheetData as Partial<IWorksheetData>))
        } else {
          const rowsResponse = await api.get<Row[]>(`/sheets/${sheetId}/data`)
          if (rowsResponse.code !== 0) {
            throw new Error(rowsResponse.message || '同步工作表数据失败')
          }
          if (sheetEditorActiveRef.current || imeComposingRef.current) {
            deferredSilentSyncRef.current = true
            return
          }
          const nextWorkbook = buildUniverWorkbookData(
            workbookId,
            nextSheet,
            Array.isArray(rowsResponse.data) ? rowsResponse.data : [],
            'zh-CN' as IWorkbookData['locale']
          )
          serverSnapshot = cloneJsonSnapshot(nextWorkbook.sheets[nextWorkbook.sheetOrder[0]] as Partial<IWorksheetData>)
        }

        if (remotePatchResetTimerRef.current) {
          clearTimeout(remotePatchResetTimerRef.current)
          remotePatchResetTimerRef.current = null
        }
        applyingRemotePatchRef.current = true

        const sameColumnLayout = previousColumns.length === nextColumns.length && previousColumns.every(
          (column, index) => column.key === nextColumns[index]?.key
        )
        const serverChanges = sameColumnLayout
          ? buildRealtimeCellChanges(sheetId, baselineSnapshot, serverSnapshot, nextColumns)
          : []

        if (sameColumnLayout && serverChanges.length <= 100) {
          serverChanges.forEach((change) => {
            const columnIndex = nextColumns.findIndex((column) => column.key === change.col)
            if (columnIndex < 0) return
            worksheet.getRange(change.row + 1, columnIndex, 1, 1).setValue(
              typeof change.value === 'string' && change.value.startsWith('=')
                ? { f: change.value }
                : (change.value ?? '') as string | number | boolean
            )
          })
        } else {
          const extent = getWorksheetSnapshotExtent(baselineSnapshot, serverSnapshot)
          const targetColumnCount = Math.max(extent.columnCount, previousColumns.length, nextColumns.length, 1)
          const targetRowCount = Math.max(extent.rowCount, 1)
          if (worksheet.getMaxRows() < targetRowCount) worksheet.setRowCount(targetRowCount)
          if (worksheet.getMaxColumns() < targetColumnCount) worksheet.setColumnCount(targetColumnCount)
          worksheet.getRange(0, 0, targetRowCount, targetColumnCount).setValues(
            buildWorksheetSyncMatrix(serverSnapshot, targetRowCount, targetColumnCount)
          )
        }

        applyWorksheetSnapshotPresentation(
          worksheet,
          serverSnapshot,
          normalizeUniverStyleMap(nextConfig.univerStyles as Record<string, unknown> | undefined),
          baselineSnapshot
        )

        nextColumns.forEach((column, index) => {
          if (column.width && worksheet.getColumnWidth(index) !== column.width) {
            worksheet.setColumnWidth(index, column.width)
          }
        })
        if (nextSheet.name && nextSheet.name !== previousSheet.name) {
          worksheet.setName(nextSheet.name)
        }

        localChanges.forEach((change) => {
          const columnIndex = nextColumns.findIndex((column) => column.key === change.col)
          if (columnIndex < 0) return
          worksheet.getRange(change.row + 1, columnIndex, 1, 1).setValue(
            typeof change.value === 'string' && change.value.startsWith('=')
              ? { f: change.value }
              : (change.value ?? '') as string | number | boolean
          )
        })

        latestSheetRef.current = nextSheet
        structureRevisionRef.current = readStructureRevision(nextSheet.config)
        persistedWorksheetDataRef.current = cloneJsonSnapshot(serverSnapshot)
        syncSelectionState()
        requestProtectionHighlightRefresh()
        await onExternalReload?.()

        remotePatchResetTimerRef.current = setTimeout(() => {
          applyingRemotePatchRef.current = false
          remotePatchResetTimerRef.current = null
          if (localChanges.length > 0) {
            void persistRef.current?.().catch((syncError) => {
              console.error('Failed to preserve local changes after AI sync:', syncError)
            })
          }
        }, 200)
      } while (silentSyncQueuedRef.current)
    }

    const request = runSync()
      .catch((syncError) => {
        if (remotePatchResetTimerRef.current) {
          clearTimeout(remotePatchResetTimerRef.current)
          remotePatchResetTimerRef.current = null
        }
        applyingRemotePatchRef.current = false
        console.error('Failed to sync AI sheet updates:', syncError)
        setActionError(syncError instanceof Error ? syncError.message : '同步 AI 表格修改失败，请稍后重试。')
      })
      .finally(() => {
        silentSyncInFlightRef.current = null
      })
    silentSyncInFlightRef.current = request
    return request
  }, [onExternalReload, requestProtectionHighlightRefresh, sheetId, syncSelectionState, workbookId])

  const flushDeferredRealtimeUpdates = useCallback(() => {
    if (sheetEditorActiveRef.current || imeComposingRef.current) return
    if (deferredRealtimeFlushFrameRef.current !== null) return

    deferredRealtimeFlushFrameRef.current = window.requestAnimationFrame(() => {
      deferredRealtimeFlushFrameRef.current = null
      if (sheetEditorActiveRef.current || imeComposingRef.current) return

      const completedCell = completedEditCellRef.current
      completedEditCellRef.current = null
      const queuedChanges = deferredIncomingChangesRef.current
      deferredIncomingChangesRef.current = []
      const applicableChanges = completedCell
        ? queuedChanges.filter((change) => change.row !== completedCell.row || change.col !== completedCell.col)
        : queuedChanges

      if (applicableChanges.length > 0) {
        applyIncomingChanges(applicableChanges)
      }
      if (applicableChanges.length !== queuedChanges.length) {
        deferredSilentSyncRef.current = true
      }
      if (deferredSilentSyncRef.current) {
        deferredSilentSyncRef.current = false
        void syncSheetSilently()
      }
    })
  }, [applyIncomingChanges, syncSheetSilently])
  flushDeferredRealtimeUpdatesRef.current = flushDeferredRealtimeUpdates
  syncSheetSilentlyRef.current = syncSheetSilently

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const isUniverEditorTarget = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false
      if (root.contains(target)) return true
      return target instanceof Element && Boolean(target.closest(UNIVER_EDITOR))
    }

    const handleCompositionStart = (event: CompositionEvent) => {
      if (!isUniverEditorTarget(event.target)) return
      if (compositionEndTimerRef.current) {
        clearTimeout(compositionEndTimerRef.current)
        compositionEndTimerRef.current = null
      }
      imeComposingRef.current = true
      pendingLocalPersistRef.current = true
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
    const handleCompositionEnd = (event: CompositionEvent) => {
      if (!isUniverEditorTarget(event.target)) return
      compositionEndTimerRef.current = setTimeout(() => {
        compositionEndTimerRef.current = null
        imeComposingRef.current = false
        if (!sheetEditorActiveRef.current) {
          if (pendingLocalPersistRef.current) schedulePersistRef.current()
          flushDeferredRealtimeUpdatesRef.current()
        }
      }, 0)
    }

    document.addEventListener('compositionstart', handleCompositionStart, true)
    document.addEventListener('compositionend', handleCompositionEnd, true)
    return () => {
      document.removeEventListener('compositionstart', handleCompositionStart, true)
      document.removeEventListener('compositionend', handleCompositionEnd, true)
      if (compositionEndTimerRef.current) {
        clearTimeout(compositionEndTimerRef.current)
        compositionEndTimerRef.current = null
      }
      imeComposingRef.current = false
    }
  }, [sheetId])

  useEffect(() => {
    wsClient.connect()
    wsClient.joinSheet(sheetId)

    const unsubscribeBatch = wsClient.on('batch_update', (msg) => {
      if (msg.sheetId !== sheetId || !Array.isArray(msg.changes)) return
      const changes = msg.changes
        .map((change) => ({
          row: change.row,
          col: change.col,
          value: change.value,
        }))
        .filter((change): change is { row: number; col: string; value: unknown } => typeof change.row === 'number' && typeof change.col === 'string')

      applyIncomingChanges(changes)
    })

    const unsubscribePresence = wsClient.on('sheet_presence', (msg) => {
      if (msg.sheetId !== sheetId || !Array.isArray(msg.presence)) return
      // Coalesce bursts of presence updates into a single render per frame so a
      // busy collaboration session does not re-render the whole editor repeatedly.
      pendingPresenceRef.current = msg.presence
      if (presenceFrameRef.current !== null) return
      presenceFrameRef.current = window.requestAnimationFrame(() => {
        presenceFrameRef.current = null
        if (pendingPresenceRef.current) setSheetPresence(pendingPresenceRef.current)
        pendingPresenceRef.current = null
      })
    })

    const unsubscribeProtection = wsClient.on('protection_updated', (msg) => {
      if (msg.sheetId !== sheetId) return
      refreshPermissions()
      void refreshProtectionSnapshot()
    })

    const unsubscribeApproval = wsClient.on('approval_updated', (msg) => {
      if (msg.sheetId !== sheetId) return
      void refreshApprovalStates()
    })

    const unsubscribeSheetSync = wsClient.on('sheet_sync', (msg) => {
      if (msg.sheetId !== sheetId) return
      void syncSheetSilently()
    })

    return () => {
      unsubscribeBatch()
      unsubscribePresence()
      unsubscribeProtection()
      unsubscribeApproval()
      unsubscribeSheetSync()
      if (presenceFrameRef.current !== null) {
        window.cancelAnimationFrame(presenceFrameRef.current)
        presenceFrameRef.current = null
      }
      pendingPresenceRef.current = null
      wsClient.leaveSheet(sheetId)
      setSheetPresence([])
    }
  }, [applyIncomingChanges, refreshApprovalStates, refreshPermissions, refreshProtectionSnapshot, sheetId, syncSheetSilently])

  useEffect(() => subscribeDataChanged((detail) => {
    if (!detail.sheetIds.includes(sheetId)) return
    void syncSheetSilently()
  }), [sheetId, syncSheetSilently])

  useEffect(() => subscribePrepareDataMutation(async () => {
    if (sheetEditorActiveRef.current || imeComposingRef.current) {
      pendingLocalPersistRef.current = true
      return
    }
    if (!editLocked && commitActiveCellEditor()) {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    }
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    await persistRef.current?.()
  }), [commitActiveCellEditor, editLocked])

  // Ctrl+S shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        e.stopPropagation()
        handleManualSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [handleManualSave])

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    const handlePointerCenteredZoom = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      if (imeComposingRef.current) return

      const result = univerApiRef.current
      const univerAPI = result?.univerAPI as UniverViewportApi | undefined
      const workbook = univerAPI?.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      const currentZoom = worksheet?.getZoom?.() || 1
      if (!univerAPI || !workbook || !worksheet || !Number.isFinite(currentZoom) || currentZoom <= 0) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      const direction = event.deltaY > 0 ? -1 : 1
      const step = Math.abs(event.deltaY) < 40 ? 0.05 : 0.1
      const nextZoom = clampUniverZoom(roundUniverZoom(currentZoom + direction * step))
      if (nextZoom === currentZoom) return

      const pointer = getWheelPointerOffset(root, event)
      const scaleChange = nextZoom / currentZoom - 1
      const scrollOffsetX = pointer.x * scaleChange
      const scrollOffsetY = pointer.y * scaleChange

      if (commitActiveCellEditor() && !editLocked) {
        window.setTimeout(() => {
          persistRef.current?.().catch((err) => {
            console.error('Failed to persist Univer editor before zoom:', err)
            setActionError(err instanceof Error ? err.message : '保存失败，请稍后再试。')
          })
        }, 0)
      }

      const zoomResult = typeof worksheet.zoom === 'function'
        ? worksheet.zoom(nextZoom)
        : univerAPI.executeCommand?.(SetZoomRatioCommand.id, {
          unitId: workbook.getId?.() || '',
          subUnitId: worksheet.getSheetId?.() || '',
          zoomRatio: nextZoom,
        })

      Promise.resolve(zoomResult).finally(() => {
        window.requestAnimationFrame(() => {
          void univerAPI.executeCommand?.(SetScrollRelativeCommand.id, {
            offsetX: scrollOffsetX,
            offsetY: scrollOffsetY,
          })
        })
      })
    }

    root.addEventListener('wheel', handlePointerCenteredZoom, { capture: true, passive: false })
    return () => root.removeEventListener('wheel', handlePointerCenteredZoom, true)
  }, [commitActiveCellEditor, editLocked])

  useEffect(() => {
    const root = containerRef.current
    if (!root) return

    let lastCommitAt = 0

    const commitBeforeScroll = (event?: Event) => {
      if (event instanceof WheelEvent && (event.ctrlKey || event.metaKey)) return
      if (event?.type === 'scroll') {
        // Only a scroll that moves the sheet itself (the page or a container
        // of the sheet) detaches the editor from its cell. The cell editor's
        // own scroller fires right after an IME commit, and other panels (the
        // AI chat auto-scrolling) scroll too; committing on those ended the
        // edit between two pinyin words, so the next word replaced the first.
        const target = event.target
        const movesSheet = target === document || target === document.documentElement ||
          (target instanceof Element && !root.contains(target) && target.contains(root))
        if (!movesSheet) return
      }
      if (imeComposingRef.current) return
      if (!getVisibleUniverCellEditor(root)) return

      const now = Date.now()
      if (now - lastCommitAt < 120) return
      lastCommitAt = now

      if (!commitActiveCellEditor() || editLocked) return

      window.setTimeout(() => {
        persistRef.current?.().catch((err) => {
          console.error('Failed to persist Univer editor before scroll:', err)
          setActionError(err instanceof Error ? err.message : '保存失败，请稍后再试。')
        })
      }, 0)
    }

    root.addEventListener('wheel', commitBeforeScroll, { capture: true, passive: true })
    window.addEventListener('scroll', commitBeforeScroll, true)

    return () => {
      root.removeEventListener('wheel', commitBeforeScroll, true)
      window.removeEventListener('scroll', commitBeforeScroll, true)
    }
  }, [commitActiveCellEditor, editLocked])

  // Touch devices have no wheel, so Univer's wheel-driven viewport cannot move.
  // Translate one-finger drags into the wheel events Univer expects.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    if (typeof window === 'undefined' || !('ontouchstart' in window)) return

    return attachUniverTouchPanning(root)
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (!canInitializeEditor) {
      setLoading(true)
      return
    }

    let disposed = false
    let cleanup: (() => void) | null = null
	let createdUniver: ReturnType<typeof createUniver> | null = null
	let cancelHeightWait: (() => void) | null = null
	// Each Univer instance renders into its own host element. Univer unmounts
	// its React UI asynchronously after dispose(); clearing a shared container
	// right away made that unmount throw (removeChild of a node that was already
	// gone), which also broke the instance mounted for the reload, so a version
	// restore left the sheet blank. A detached host keeps the old nodes intact
	// until Univer is done with them.
	let mountHost: HTMLDivElement | null = null

	// Univer unmounts its own React roots synchronously while disposing. Doing
	// that inside this effect's cleanup (React's commit phase) races React, so
	// the old instance is hidden now and disposed right after the commit.
	const disposeCreatedUniver = () => {
	  const instance = createdUniver
	  const host = mountHost
	  createdUniver = null
	  mountHost = null
	  if (host) host.style.display = 'none'
	  window.setTimeout(() => {
		if (instance) {
		  try {
			;(instance.univer as { dispose?: () => void }).dispose?.()
		  } catch (disposeError) {
			console.error('Failed to dispose Univer instance:', disposeError)
		  }
		}
		host?.remove()
	  }, 0)
	}

    const mount = async () => {
      setLoading(true)
      setError('')
      try {
        // On reload (triggered by WebSocket sheet_reload), refresh sheet
        // metadata first, then prefer the latest Univer snapshot in config.
        const isLocalReload = appliedReloadNonceRef.current !== localReloadNonce
        const isReload = reloadTokenRef.current !== reloadToken || isLocalReload
        reloadTokenRef.current = reloadToken
        appliedReloadNonceRef.current = localReloadNonce

        // If this is a reload, re-fetch the sheet metadata first
        let currentSheet = latestSheetRef.current
        if (isReload || currentSheet.config_omitted) {
          try {
            const sheetRes = await api.get<Sheet>(`/sheets/${currentSheet.id}`)
            if (sheetRes.code === 0 && sheetRes.data) {
              currentSheet = sheetRes.data
              latestSheetRef.current = currentSheet
            } else if (currentSheet.config_omitted) {
              throw new Error(sheetRes.message || '加载工作表数据失败')
            }
          } catch (loadError) {
            // A reload falls through with the sheet data it already has; a
            // summary has no cells to fall back on.
            if (currentSheet.config_omitted) throw loadError
          }
        }
        if (disposed) return

        // A reload after a structure conflict keeps the explanation on screen.
        if (!isLocalReload) setActionError('')
        const config = parseSheetConfig(currentSheet.config)
        structureRevisionRef.current = readStructureRevision(currentSheet.config)
        structuralChangePendingRef.current = false
        pendingStructureOpsRef.current = []
        resyncAfterPersistRef.current = false
        const localeCode = 'zh-CN' as IWorkbookData['locale']
        let workbookData: IWorkbookData

        if (config.univerSheetData && typeof config.univerSheetData === 'object') {
          const worksheetSnapshot = inferMissingCellTypes(cloneJsonSnapshot(config.univerSheetData as Partial<IWorksheetData>))
          workbookData = wrapWorksheetData(
            workbookId, currentSheet,
            worksheetSnapshot,
            localeCode,
            config.univerStyles as Record<string, unknown> | undefined
          )
        } else {
          const rowsRes = await api.get<Row[]>(`/sheets/${currentSheet.id}/data`)
          if (rowsRes.code !== 0) {
            throw new Error(rowsRes.message || '加载工作表数据失败')
          }

          const rows = Array.isArray(rowsRes.data) ? rowsRes.data : []
          workbookData = buildUniverWorkbookData(workbookId, currentSheet, rows, localeCode)
        }
        const initialSheetId = workbookData.sheetOrder[0]
        persistedWorksheetDataRef.current = cloneJsonSnapshot(workbookData.sheets[initialSheetId] as Partial<IWorksheetData>)

        if (disposed || !containerRef.current) return

        // CRITICAL: Ensure the container has actual pixel dimensions before
        // Univer tries to read offsetHeight. If flex layout hasn't resolved
        // yet (e.g. 0px), wait one frame.
		const ensureHeight = () => new Promise<boolean>((resolve) => {
		  let frame: number | null = null
		  let settled = false
		  const deadline = performance.now() + 5000
		  const finish = (ready: boolean) => {
			if (settled) return
			settled = true
			if (frame !== null) window.cancelAnimationFrame(frame)
			cancelHeightWait = null
			resolve(ready)
		  }
		  const check = () => {
			if (disposed) return finish(false)
			if (containerRef.current && containerRef.current.offsetHeight > 0) return finish(true)
			if (performance.now() >= deadline) return finish(false)
			frame = window.requestAnimationFrame(check)
		  }
		  cancelHeightWait = () => finish(false)
		  check()
		})

		const hasHeight = await ensureHeight()
		if (!hasHeight) {
		  if (disposed) return
		  throw new Error('工作表容器未能在限定时间内完成布局')
		}
        if (disposed || !containerRef.current) return

        mountHost = document.createElement('div')
        mountHost.style.cssText = 'width:100%;height:100%;position:relative'
        containerRef.current.appendChild(mountHost)

        const localeKey = LocaleType.ZH_CN
        const univerResult = createUniver({
          locale: localeKey,
          theme: defaultTheme,
          locales: {
            [localeKey]: mergeLocaleBundles(
              UniverPresetSheetsCoreZhCN,
              UniverPresetSheetsSortZhCN,
              UniverPresetSheetsHyperLinkZhCN,
              UniverPresetSheetsFilterZhCN,
              UniverSheetsDrawingZhCN,
              UniverPresetSheetsDataValidationZhCN,
              UniverPresetSheetsConditionalFormattingZhCN,
            ),
          },
          presets: [
            UniverSheetsCorePreset({
              container: mountHost,
              header: true,
              toolbar: true,
              formulaBar: true,
              contextMenu: true,
              menu: UNIVER_PROTECTION_CONTEXT_MENU_CONFIG,
              footer: false,
            }),
            UniverSheetsDrawingPreset(),
            UniverSheetsFilterPreset(),
            UniverSheetsSortPreset(),
            UniverSheetsHyperLinkPreset(),
            UniverSheetsDataValidationPreset({ showEditOnDropdown: true }),
            UniverSheetsConditionalFormattingPreset(),
          ],
        })
		createdUniver = univerResult
		if (disposed) {
		  disposeCreatedUniver()
		  return
		}

		const { univerAPI } = univerResult
        // The corner badges of non plain text cells are float DOMs: register the
        // component once, then anchor one per marked cell.
        univerAPI.registerComponent(PLAIN_TEXT_BADGE_COMPONENT_KEY, PlainTextBadgeComponent)
        univerApiRef.current = univerResult

        const workbookApi = univerAPI.createWorkbook(workbookData)
        if (process.env.NODE_ENV !== 'production') {
          // Development only: lets browser automation drive the live sheet.
          ;(window as unknown as { __yaerpSheetDebug?: unknown }).__yaerpSheetDebug = { univerAPI, workbookApi, univer: univerResult.univer }
        }
        // The sheets plugin (which owns SheetInterceptorService) and the cell
        // editor services are only instantiated while the first unit is
        // created, so wire up the alignment fixes once the workbook exists.
        const editorRepaintFilter = skipEditorTextRepaints(univerResult.univer, workbookApi.getId())
        protectionMarkLayerRef.current = createMarkLayer(univerResult.univer)
        approvalMarkLayerRef.current = createMarkLayer(univerResult.univer)
        // Univer drops every highlight when a cell editor opens or closes and on
        // copy/cut: draw ours again right after.
        let overlayRedrawFrame: number | null = null
        const stopWatchingMarkWipes = watchMarkShapeWipes(univerResult.univer, () => {
          if (overlayRedrawFrame !== null) return
          overlayRedrawFrame = window.requestAnimationFrame(() => {
            overlayRedrawFrame = null
            if (disposed) return
            if (showProtectionHighlightsRef.current) protectionHighlightRendererRef.current()
            approvalHighlightRendererRef.current()
            setPresenceRedrawToken((token) => token + 1)
          })
        })
        registerEditorComposedStyleInterceptor(univerResult.univer)
        installCellEditorAlignmentRecalculation(univerResult.univer)
        registerSharedFormulaEditorInterceptor(univerResult.univer)
        const resolveSharedFormula = createSharedFormulaResolver(univerResult.univer)
        sharedFormulaResolverRef.current = resolveSharedFormula
        // `下移` / `右移` move selected cells only; for uniform formula columns the
        // moved formula must keep computing its own row (see the module docs).
        const cellShiftRepair = registerCellShiftFormulaRepair(
          univerResult.univer,
          () => workbookApi.getActiveSheet(),
          (count) => {
            console.info(`[sheet] realigned ${count} formula cell(s) after shifting cells`)
            schedulePersistRef.current?.()
            setFormulaScanToken((token) => token + 1)
          }
        )
        // Formula errors are explained by a click-through tooltip instead of
        // Univer's popup, which covered (and blocked) the cells around it.
        const formulaErrorHintDisposable = registerFormulaErrorHint(univerResult.univer, (hint) => {
          if (!hint) {
            setFormulaErrorHint(null)
            return
          }
          let value = ''
          try {
            value = String(workbookApi.getActiveSheet().getRange(hint.row, hint.column, 1, 1).getDisplayValue() ?? '')
          } catch {
            value = ''
          }
          setFormulaErrorHint({ ...hint, value, detail: describeFormulaError(hint.message, value) })
        })
        // `粘贴为纯文本（仅值）` in the context menu, and Ctrl+Shift+V.
        const plainTextPaste = registerPlainTextPaste(univerResult.univer, () => workbookApi.getActiveSheet(), {
          canEdit: () => Boolean(latestEditableRef.current),
          onPasted: (cells) => {
            setClipboardNotice(`已按纯文本粘贴 ${cells} 个单元格`)
            window.setTimeout(() => setClipboardNotice(''), 2600)
          },
          onNeedsKeyboardPaste: () => {
            setClipboardNotice('浏览器不允许直接读取剪贴板，请现在按 Ctrl+V（手机长按选“粘贴”）完成纯文本粘贴')
            window.setTimeout(() => setClipboardNotice(''), 6000)
          },
        })
        pastePlainRef.current = plainTextPaste?.pastePlain ?? null
        // Quoted clipboard text (Excel style) may carry line breaks inside a
        // cell; handled by Univer's own paste path, that turns one row into two.
        const quotedClipboardFix = registerQuotedClipboardFixes(univerResult.univer, () => workbookApi.getActiveSheet())
        // A paste is the moment a non plain text cell usually appears, and the
        // paste command never reaches the facade callback, so it is reported
        // separately: rescan and tell the user what just landed in the sheet.
        const pasteNotifier = registerPasteNotifier(univerResult.univer, () => {
          // The paste already queued a scan of its own mutations, so flagging the
          // notice here (instead of only on the follow up scan) makes the notice
          // describe exactly the cells this paste added.
          pendingPlainTextNotifyRef.current = true
          window.setTimeout(() => refreshPlainTextBadgesRef.current({ scan: true, notify: true }), 250)
          setFormulaScanToken((token) => token + 1)
        })
        // Flattening a whole row or a pasted block in one step: the context menu
        // entry works on the selection and shares the scan of the badges, so a
        // hyperlink inside the selection is left alone as well.
        const plainTextConvertMenu = registerPlainTextConvertMenu(univerResult.univer, () => {
          convertPlainTextSelectionRef.current()
        })
        workbookApiRef.current = workbookApi as { setEditable: (editable: boolean) => void }
        workbookApi.setEditable(effectiveCanEditSheet)
        applyColumnDataControls(univerAPI, workbookApi.getActiveSheet(), currentSheet.columns || [])
        if (containerRef.current.offsetWidth <= 600) {
          try {
            const activeWorksheet = workbookApi.getActiveSheet()
            const currentZoom = activeWorksheet.getZoom?.() || 1
            if (currentZoom > 0.8) activeWorksheet.zoom?.(0.8)
          } catch (zoomError) {
            console.warn('Failed to apply mobile sheet zoom:', zoomError)
          }
        }
        syncFilterState()
        const rememberedView = readSheetViewMemory(profile?.id, sheetId)
        if (rememberedView) {
          sheetViewMemoryRestoringRef.current = true
          let readinessChecks = 0

          const applyRememberedView = async () => {
            if (disposed) return
            try {
              const worksheet = workbookApi.getActiveSheet()
              const maxRow = Math.max(0, worksheet.getMaxRows() - 1)
              const maxColumn = Math.max(0, worksheet.getMaxColumns() - 1)
              const selectionRow = Math.min(maxRow, rememberedView.selectionRow)
              const selectionColumn = Math.min(maxColumn, rememberedView.selectionColumn)
              const selectionEndRow = Math.min(maxRow, Math.max(selectionRow, rememberedView.selectionEndRow))
              const selectionEndColumn = Math.min(maxColumn, Math.max(selectionColumn, rememberedView.selectionEndColumn))
              const viewRow = Math.min(maxRow, rememberedView.viewRow)
              const viewColumn = Math.min(maxColumn, rememberedView.viewColumn)
              worksheet.getRange(
                selectionRow,
                selectionColumn,
                selectionEndRow - selectionRow + 1,
                selectionEndColumn - selectionColumn + 1
              ).activate()
              const restored = await univerAPI.executeCommand(ScrollCommand.id, {
                sheetViewStartRow: viewRow,
                sheetViewStartColumn: viewColumn,
                offsetX: rememberedView.offsetX,
                offsetY: rememberedView.offsetY,
              })
              if (!restored) worksheet.scrollToCell(viewRow, viewColumn)
            } catch (restoreError) {
              console.warn('Failed to restore sheet view position:', restoreError)
            }
          }

          const finishRestore = () => {
            sheetViewRestoreTimerRef.current = null
            void applyRememberedView().finally(() => {
              if (disposed) return
              sheetViewMemoryRestoringRef.current = false
              syncSelectionState()
              setLoading(false)
            })
          }

          const restoreWhenReady = () => {
            sheetViewRestoreFrameRef.current = null
            if (disposed) return
            const worksheet = workbookApi.getActiveSheet()
            let lifecycleReady = false
            let viewportReady = false
            try {
              lifecycleReady = univerAPI.getCurrentLifecycleStage() >= univerAPI.Enum.LifecycleStages.Steady
              viewportReady = Boolean(worksheet.getSkeleton())
            } catch {
              lifecycleReady = false
              viewportReady = false
            }
            if ((!lifecycleReady || !viewportReady) && readinessChecks < 120) {
              readinessChecks += 1
              sheetViewRestoreFrameRef.current = window.requestAnimationFrame(restoreWhenReady)
              return
            }

            void applyRememberedView()
            sheetViewRestoreTimerRef.current = setTimeout(finishRestore, 120)
          }

          sheetViewRestoreFrameRef.current = window.requestAnimationFrame(restoreWhenReady)
        } else {
          sheetViewMemoryRestoringRef.current = false
          syncSelectionState()
          if (!disposed) setLoading(false)
        }

        /**
         * Univer collapses runs of similar formulas into a shared formula group:
         * only the group owner keeps `f`, the other members carry the shared id
         * (`si`). The engine still calculates them, but the inline editor,
         * copy/paste and every export read the raw cell, so those members would
         * behave like plain values. Restore the resolved formula on the live sheet
         * (the next save then persists a self contained snapshot too).
         */
        const restoreSharedFormulaCells = (sheet: Partial<IWorksheetData>, sheetId: string) => {
          if (!sheet.cellData || disposed) return
          const { cells, ranges } = collectSharedFormulaCells(
            sheet.cellData as Record<string, Record<string, ICellData> | undefined>,
            sharedFormulaResolverRef.current,
            sheetId,
            workbookApi.getId?.()
          )
          if (cells.length === 0) return
          try {
            const worksheet = workbookApi.getActiveSheet()
            ranges.forEach((range) => {
              worksheet.getRange(range.startRow, range.column, range.cells.length, 1).setValues(
                range.cells.map((cell) => [cell])
              )
            })
          } catch (error) {
            console.warn('Failed to restore shared formulas on the sheet:', error)
          }
          cells.forEach((item) => {
            const columns = sheet.cellData?.[item.row]
            if (columns) columns[item.column] = item.cell
          })
        }

        const persistSnapshot = async () => {
		  if (disposed) return
          persistQueuedRef.current = true
          if (persistInFlightRef.current) {
            await persistInFlightRef.current
            return
          }

          const runPersist = async () => {
			while (persistQueuedRef.current && !disposed) {
              persistQueuedRef.current = false
              const snap = latestSheetRef.current
              const saved = workbookApi.save()
              const savedSheetId = saved.sheetOrder[0]
              // Workbook.save() already returns a deep clone of the live sheet, so
              // the snapshot is used directly instead of being cloned a second time.
              let savedSheet = saved.sheets[savedSheetId] as Partial<IWorksheetData> | undefined
              if (!savedSheet) continue

              restoreSharedFormulaCells(savedSheet, savedSheetId)

              const nextColumns = deriveColumnsFromUniverSheet(savedSheet, snap.columns || [], saved.styles as Record<string, unknown> | undefined)
              const currentConfig = parseSheetConfig(snap.config)
              const previousSheet = persistedWorksheetDataRef.current ||
                (currentConfig.univerSheetData && typeof currentConfig.univerSheetData === 'object'
                  ? cloneJsonSnapshot(currentConfig.univerSheetData as Partial<IWorksheetData>)
                  : undefined)
              const cellChanges = buildRealtimeCellChanges(snap.id, previousSheet, savedSheet, nextColumns)
              // Undo/redo of a row or column insert is not reported as a
              // structural command, but it changes the grid size.
              const gridResized = Boolean(previousSheet) && (
                (typeof previousSheet?.rowCount === 'number' && typeof savedSheet.rowCount === 'number' && previousSheet.rowCount !== savedSheet.rowCount) ||
                (typeof previousSheet?.columnCount === 'number' && typeof savedSheet.columnCount === 'number' && previousSheet.columnCount !== savedSheet.columnCount)
              )
              const structureChanged = structuralChangePendingRef.current || gridResized || pendingStructureOpsRef.current.length > 0
              structuralChangePendingRef.current = false
              const baseStructureRevision = structureRevisionRef.current
              const nextConfig: typeof currentConfig & { structureRevision?: number } = {
                ...currentConfig,
                univerSheetData: savedSheet,
                univerStyles: mergeUniverStyleMap(
                  currentConfig.univerStyles as Record<string, unknown> | undefined,
                  saved.styles as Record<string, unknown> | undefined
                ),
              }
              const nextSheetName = snap.name || savedSheet.name || 'Sheet1'
              const nextFrozen = snap.frozen || { row: 0, col: 0 }
              // Cell changes already imply a change, so the expensive whole-config
              // comparison only runs for saves that carry no tracked cell edits.
              const hasSnapshotChanged =
                cellChanges.length > 0 ||
                nextSheetName !== snap.name ||
                !areJsonSnapshotsEqual(nextColumns, snap.columns || []) ||
                !areJsonSnapshotsEqual(nextFrozen, snap.frozen || { row: 0, col: 0 }) ||
                !areJsonSnapshotsEqual(nextConfig, currentConfig)

              if (!hasSnapshotChanged) {
                latestSheetRef.current = {
                  ...snap,
                  name: nextSheetName,
                  columns: nextColumns,
                  frozen: nextFrozen,
                  config: nextConfig,
                }
                persistedWorksheetDataRef.current = savedSheet
                continue
              }

              let res: Awaited<ReturnType<typeof api.put<CellUpdateResult>>>
              structuralSaveInFlightRef.current = structureChanged
              const sentStructureOps = pendingStructureOpsRef.current.splice(0)
              const restoreStructureOps = () => {
                if (sentStructureOps.length > 0) pendingStructureOpsRef.current = [...sentStructureOps, ...pendingStructureOpsRef.current]
              }
              try {
                res = await api.put<CellUpdateResult>(`/sheets/${snap.id}`, {
                  name: nextSheetName,
                  sort_order: snap.sort_order,
                  columns: nextColumns,
                  frozen: nextFrozen,
                  config: nextConfig,
                  cell_changes: cellChanges,
                  structure_changed: structureChanged,
                  base_structure_revision: baseStructureRevision,
                  ...(sentStructureOps.length > 0 ? { structure_ops: sentStructureOps } : {}),
                })
              } catch (requestError) {
                if (structureChanged) structuralChangePendingRef.current = true
                restoreStructureOps()
                throw requestError
              } finally {
                structuralSaveInFlightRef.current = false
              }
			  if (disposed) return

              if (res.code !== 0) {
                if ((res as { error_code?: string }).error_code === STRUCTURE_CONFLICT_ERROR_CODE) {
                  // Someone else moved rows/columns since this client loaded the
                  // sheet: these edits address rows that no longer exist at
                  // those indexes. Drop them and reload the current layout
                  // instead of writing values into the wrong rows.
                  persistQueuedRef.current = false
                  setActionError(res.message || '表格的行列结构已被其他协作者修改，已为你同步最新内容，请重新操作。')
                  localReloadNonceRef.current += 1
                  setLocalReloadNonce(localReloadNonceRef.current)
                  return
                }
                if (structureChanged && res.code === 403) {
                  // The server refused the new layout (protected rows): go back
                  // to the saved one instead of keeping a sheet that cannot save.
                  persistQueuedRef.current = false
                  setActionError(res.message || '本次行列调整涉及受保护区域，已恢复为保存前的内容。')
                  localReloadNonceRef.current += 1
                  setLocalReloadNonce(localReloadNonceRef.current)
                  return
                }
                if (structureChanged) structuralChangePendingRef.current = true
                restoreStructureOps()
                throw new Error(res.message || '保存工作表失败')
              }
              if (sentStructureOps.length > 0) {
                const rules = protectionSnapshotRef.current
                if (rules.rows.length + rules.columns.length + rules.cells.length > 0) void refreshProtectionSnapshotRef.current()
              }
              if (structureChanged) {
                structureRevisionRef.current = baseStructureRevision + 1
                nextConfig.structureRevision = structureRevisionRef.current
                structuralGraceUntilRef.current = Date.now() + 1500
              }

              const revertedChanges = Array.isArray(res.data?.reverted_changes) ? res.data.reverted_changes : []
              if (revertedChanges.length > 0) {
                applyingRemotePatchRef.current = true
                revertedChanges.forEach((change) => {
                  const columnIndex = nextColumns.findIndex((column) => column.key === change.col)
                  if (columnIndex < 0 || change.row < 0) return
                  workbookApi.getActiveSheet().getRange(change.row + 1, columnIndex, 1, 1).setValue(
                    typeof change.value === 'string' && change.value.startsWith('=')
                      ? { f: change.value }
                      : (change.value ?? '') as string | number | boolean
                  )
                })
                savedSheet = applyRealtimeCellChangesToWorksheetSnapshot(savedSheet, revertedChanges, nextColumns)
                nextConfig.univerSheetData = savedSheet
                const pendingStates = Array.isArray(res.data?.pending_states) ? res.data.pending_states : []
                if (pendingStates.length > 0) {
                  setApprovalStates((current) => {
                    const byID = new Map(current.map((item) => [item.id, item]))
                    pendingStates.forEach((item) => byID.set(item.id, item))
                    return Array.from(byID.values())
                  })
                  setApprovalNotice(`已提交 ${pendingStates.length} 个单元格审批，正式数据保持原值。`)
                  window.setTimeout(() => setApprovalNotice(''), 4200)
                }
                if (remotePatchResetTimerRef.current) clearTimeout(remotePatchResetTimerRef.current)
                remotePatchResetTimerRef.current = setTimeout(() => {
                  applyingRemotePatchRef.current = false
                  remotePatchResetTimerRef.current = null
                }, 200)
              }

              const computedChanges = Array.isArray(res.data?.computed_changes) ? res.data.computed_changes : []
              if (computedChanges.length > 0) {
                applyingRemotePatchRef.current = true
                computedChanges.forEach((change) => {
                  const columnIndex = nextColumns.findIndex((column) => column.key === change.col)
                  if (columnIndex < 0 || change.row < 0) return
                  workbookApi.getActiveSheet().getRange(change.row + 1, columnIndex, 1, 1).setValue((change.value ?? '') as string | number | boolean)
                })
                savedSheet = applyRealtimeCellChangesToWorksheetSnapshot(savedSheet, computedChanges, nextColumns)
                nextConfig.univerSheetData = savedSheet
                if (remotePatchResetTimerRef.current) clearTimeout(remotePatchResetTimerRef.current)
                remotePatchResetTimerRef.current = setTimeout(() => {
                  applyingRemotePatchRef.current = false
                  remotePatchResetTimerRef.current = null
                }, 200)
              }

              latestSheetRef.current = {
                ...snap,
                name: nextSheetName,
                columns: nextColumns,
                frozen: nextFrozen,
                config: nextConfig,
              }
              persistedWorksheetDataRef.current = savedSheet
              if (resyncAfterPersistRef.current && !structuralChangePendingRef.current) {
                // Remote cell updates arrived while rows were moving locally.
                resyncAfterPersistRef.current = false
                window.setTimeout(() => { void syncSheetSilentlyRef.current() }, 0)
              }
            }
          }

          const request = runPersist().finally(() => {
            persistInFlightRef.current = null
          })
          persistInFlightRef.current = request
          await request
        }

        // Expose persistSnapshot for manual save
        persistRef.current = persistSnapshot

        const schedulePersist = (delay = 900) => {
          pendingLocalPersistRef.current = true
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
          if (sheetEditorActiveRef.current || imeComposingRef.current) {
            saveTimerRef.current = null
            return
          }
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null
            if (sheetEditorActiveRef.current || imeComposingRef.current) return
            pendingLocalPersistRef.current = false
            persistSnapshot().catch((e) => {
              console.error('Failed to persist Univer snapshot:', e)
              setActionError(e instanceof Error ? e.message : '保存失败，请稍后再试。')
            })
          }, delay)
        }
        schedulePersistRef.current = () => schedulePersist()

        const disposable = workbookApi.onCommandExecuted((command) => {
          if (command.type === CommandType.MUTATION) {
            const structureOp = structureOpFromMutation(command.id, command.params)
            if (structureOp) {
              pendingStructureOpsRef.current.push(structureOp)
              const rules = protectionSnapshotRef.current
              if (rules.rows.length + rules.columns.length + rules.cells.length > 0) {
                const remapped = remapProtectionSnapshot(rules, [structureOp], latestSheetRef.current.columns || [])
                protectionSnapshotRef.current = remapped
                setProtectionSnapshot(remapped)
              }
            }
          }
          const refreshProtectionLayout = commandChangesProtectionHighlightLayout(command.id)
          // OPERATION commands (selection, scroll, zoom, sidebar toggles, ...) never
          // mutate the saved snapshot, so they must not trigger the expensive
          // save/diff/persist pipeline.
          const mutatesSnapshot = command.type !== CommandType.OPERATION
          const structural = mutatesSnapshot && STRUCTURAL_COMMAND_PATTERN.test(command.id)
          // Remote patches are applied cell by cell and never move rows.
          if (structural && !applyingRemotePatchRef.current) structuralChangePendingRef.current = true
          if (sheetEditorActiveRef.current || imeComposingRef.current) {
            if (mutatesSnapshot) pendingLocalPersistRef.current = true
            return
          }
          if (applyingRemotePatchRef.current) {
            if (refreshProtectionLayout) requestProtectionHighlightRefresh()
            if (mutatesSnapshot) refreshPlainTextBadges({ scan: true })
            return
          }

          syncFilterState()
          syncSelectionState()
          if (refreshProtectionLayout) requestProtectionHighlightRefresh()
          if (mutatesSnapshot) {
            // Only a content change needs a new scan: Univer keeps the badge DOM
            // of every marker anchored through scrolling, zooming and resizing.
            refreshPlainTextBadges({
              scan: true,
              notify: PLAIN_TEXT_PASTE_COMMANDS.has(command.id),
            })
          }
          // A structural edit is saved right away: the shorter the window in
          // which collaborators hold different layouts, the better.
          if (mutatesSnapshot) schedulePersist(structural || structuralChangePendingRef.current ? 200 : 900)
          // Structural edits and fills are what break a fill-down column.
          if (mutatesSnapshot && FORMULA_SCAN_COMMAND_PATTERN.test(command.id)) setFormulaScanToken((token) => token + 1)
        })

        const sendPresenceForCell = (state: 'selected' | 'editing', row: number, column: number) => {
          const columnKey = latestSheetRef.current.columns?.[column]?.key
          const dataRow = row - 1
          const nextState = !columnKey || dataRow < 0 ? 'viewing' : state
          const signature = nextState === 'viewing' ? 'viewing' : `${nextState}:${dataRow}:${columnKey}`
          const now = Date.now()
          const previous = presenceSendRef.current
          const previousState = previous.signature ? previous.signature.split(':')[0] : ''
          // Skip duplicate selections; throttle rapid cursor movement, but always
          // deliver state transitions (selected/editing/viewing) immediately so
          // conflict detection stays reliable.
          if (signature === previous.signature) {
            if (now - previous.sentAt < 4000) return
          } else if (nextState === previousState && now - previous.sentAt < 120) {
            return
          }
          presenceSendRef.current = { signature, sentAt: now }
          if (nextState === 'viewing') {
            wsClient.sendCellPresence(sheetId, 'viewing')
            return
          }
          wsClient.sendCellPresence(sheetId, nextState, dataRow, columnKey)
        }

        const selectionPresenceDisposable = univerAPI.addEvent(univerAPI.Event.SelectionChanged, () => {
          if (sheetEditorActiveRef.current || imeComposingRef.current) return
          const selection = syncSelectionState()
          scheduleSheetViewMemoryPersist()
          if (!selection || selection.includesHeaderRow || selection.rowIndex < 0) {
            wsClient.sendCellPresence(sheetId, 'viewing')
            return
          }
          const columnIndex = latestSheetRef.current.columns?.findIndex((column) => column.key === selection.columnKey) ?? -1
          if (columnIndex >= 0) sendPresenceForCell('selected', selection.rowIndex + 1, columnIndex)
        })

        const searchableOptionClickDisposable = univerAPI.addEvent(univerAPI.Event.CellClicked, (params) => {
          if (params.row <= 0) return
          const column = latestSheetRef.current.columns?.[params.column]
          if (column?.type !== 'select' || !column.searchable || !column.options?.length) return
          let currentValue = ''
          try {
            currentValue = String(params.worksheet.getRange(params.row, params.column, 1, 1).getValues?.()?.[0]?.[0] ?? '')
          } catch {
            currentValue = ''
          }
          setOptionPickerSearch('')
          setOptionPickerTarget({
            row: params.row,
            column: params.column,
            columnKey: column.key,
            columnName: column.name || column.key,
            options: column.options.slice(),
            optionColors: column.optionColors,
            currentValue,
          })
        })

        const scrollPositionDisposable = univerAPI.addEvent(univerAPI.Event.Scroll, () => {
          scheduleSheetViewMemoryPersist()
          // Highlights only cover the area around the viewport.
          if (overlayRefreshTimerRef.current) clearTimeout(overlayRefreshTimerRef.current)
          overlayRefreshTimerRef.current = setTimeout(() => {
            overlayRefreshTimerRef.current = null
            if (showProtectionHighlightsRef.current) protectionHighlightRendererRef.current()
            approvalHighlightRendererRef.current()
          }, 150)
        })

        const selectionRects = (): WorksheetRect[] => {
          try {
            const ranges = workbookApi.getActiveSheet().getSelection()?.getActiveRangeList?.() || []
            return ranges.map((range) => rangeToRect(range.getRange())).filter((rect): rect is WorksheetRect => Boolean(rect))
          } catch {
            return []
          }
        }
        const guardProtectedCommand = (id: string, params: unknown): string => {
          const rules = protectionSnapshotRef.current
          if (rules.rows.length + rules.columns.length + rules.cells.length === 0) return ''
          const columns = latestSheetRef.current.columns || []
          const areas = protectionAreas(rules, columns)
          const value = (params || {}) as { range?: Parameters<typeof rangeToRect>[0]; fromRange?: Parameters<typeof rangeToRect>[0]; toRange?: Parameters<typeof rangeToRect>[0] }
          const user = getStoredUser()
          const canRestructure = isAdmin(user) || areas.every((area) => area.item.owner_id === user?.id)
          const restructureDenied = '此表包含其他人设置的保护或遮罩区域，只有管理员或保护创建者可以插入、删除或移动行列。'
          const describe = (area: (typeof areas)[number]) => describeProtectionArea(area, columns)
          switch (id) {
            case 'sheet.command.insert-row':
            case 'sheet.command.insert-col':
            case 'sheet.command.move-rows':
            case 'sheet.command.move-cols':
              return canRestructure ? '' : restructureDenied
            case 'sheet.command.remove-row-by-range':
            case 'sheet.command.remove-col-by-range': {
              if (!canRestructure) return restructureDenied
              const rect = rangeToRect(value.range)
              if (!rect) return ''
              const area = id.includes('-row-')
                ? findProtectionBlockingRemoval(areas, 'row', rect.startRow, rect.endRow)
                : findProtectionBlockingRemoval(areas, 'column', rect.startColumn, rect.endColumn)
              return area ? `${describe(area)}所在的${id.includes('-row-') ? '行' : '列'}不能删除，请先在「保护设置」中解除保护。` : ''
            }
            case 'sheet.command.delete-range-move-up':
            case 'sheet.command.insert-range-move-down':
            case 'sheet.command.delete-range-move-left':
            case 'sheet.command.insert-range-move-right': {
              const rect = rangeToRect(value.range) || selectionRects().slice(-1)[0]
              if (!rect) return ''
              const vertical = id.endsWith('-up') || id.endsWith('-down')
              const area = findProtectionInRects(areas, [vertical ? { ...rect, endRow: UNBOUNDED_INDEX } : { ...rect, endColumn: UNBOUNDED_INDEX }])
              return area ? `这次操作会让${describe(area)}错位，已阻止。请先解除保护。` : ''
            }
            case 'sheet.command.move-range': {
              const rects = [rangeToRect(value.fromRange), rangeToRect(value.toRange)].filter((rect): rect is WorksheetRect => Boolean(rect))
              const area = findProtectionInRects(areas, rects)
              return area ? `${describe(area)}不能被移动或覆盖。` : ''
            }
            case 'sheet.command.sort-range': {
              const rect = rangeToRect(value.range)
              const area = rect ? findProtectionInRects(areas, [rect]) : undefined
              return area ? `排序会打乱${describe(area)}，已阻止。请缩小排序范围或先解除保护。` : ''
            }
            case 'sheet.command.clear-selection-content':
            case 'sheet.command.clear-selection-all': {
              // Clearing removes cell data only; the protection itself stays. Only
              // content this user cannot see or edit is off limits.
              const area = findProtectionInRects(areas, selectionRects(), (item) => Boolean(item.masked_for_current_user || item.formula_hidden_for_current_user || !item.can_edit))
              return area ? `${describe(area)}对你不可见或不可编辑，不能清除其中的数据。` : ''
            }
            default:
              return ''
          }
        }
        const protectionGuardDisposable = univerAPI.addEvent(univerAPI.Event.BeforeCommandExecute, (event) => {
          const message = guardProtectedCommand(event.id, event.params)
          if (!message) return
          event.cancel = true
          setActionError(message)
        })

        const beforeEditPresenceDisposable = univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, (params) => {
          const columnKey = latestSheetRef.current.columns?.[params.column]?.key
          const dataRow = params.row - 1
          if (!columnKey || dataRow < 0) return
          const rules = protectionSnapshotRef.current
          const cellRules = [
            ...rules.rows.filter((rule) => rule.row_index === dataRow),
            ...rules.columns.filter((rule) => (rule.column_key || rule.key) === columnKey),
            ...rules.cells.filter((rule) => rule.row_index === dataRow && rule.column_key === columnKey),
          ]
          const blockedRule = cellRules.find((rule) => rule.masked_for_current_user || rule.formula_hidden_for_current_user || !rule.can_edit)
          if (blockedRule) {
            params.cancel = true
            setActionError(blockedRule.masked_for_current_user
              ? '该单元格内容已遮罩，不能编辑。'
              : blockedRule.formula_hidden_for_current_user
                ? '该单元格的公式已隐藏，只能查看计算结果。'
                : `该单元格已由 ${blockedRule.owner_name} 保护，不能编辑。`)
            return
          }
          const currentClientId = getRealtimeClientId()
          const ownUserId = getStoredUser()?.id
          // Your own other tabs/accounts must not lock you out of your own cell.
          const conflict = sheetPresenceRef.current.find((entry) => entry.clientId !== currentClientId
            && (ownUserId == null || entry.userId !== ownUserId)
            && entry.state === 'editing'
            && entry.row === dataRow
            && entry.col === columnKey)
          if (conflict) {
            params.cancel = true
            setActionError(`${conflict.username} 正在编辑该单元格，请等待对方结束后再编辑。`)
          }
        })

        const editStartedPresenceDisposable = univerAPI.addEvent(univerAPI.Event.SheetEditStarted, (params) => {
          sheetEditorActiveRef.current = true
          pendingLocalPersistRef.current = true
          const columnKey = latestSheetRef.current.columns?.[params.column]?.key
          activeEditCellRef.current = columnKey && params.row > 0
            ? { row: params.row - 1, col: columnKey }
            : null
          if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current)
            saveTimerRef.current = null
          }
          sendPresenceForCell('editing', params.row, params.column)
        })

        const editEndedPresenceDisposable = univerAPI.addEvent(univerAPI.Event.SheetEditEnded, (params) => {
          completedEditCellRef.current = params.isConfirm ? activeEditCellRef.current : null
          activeEditCellRef.current = null
          sheetEditorActiveRef.current = false
          sendPresenceForCell('selected', params.row, params.column)
          if (pendingLocalPersistRef.current) schedulePersist()
          flushDeferredRealtimeUpdatesRef.current()
          window.setTimeout(() => {
            if (sheetEditorActiveRef.current || imeComposingRef.current) return
            syncSelectionState()
            scheduleSheetViewMemoryPersist()
          }, 0)
        })

        cleanup = () => {
		  disposed = true
          persistSheetViewMemory()
          disposable.dispose()
          cellShiftRepair?.dispose()
          formulaErrorHintDisposable?.dispose()
          plainTextPaste?.dispose()
          pastePlainRef.current = null
          setFormulaErrorHint(null)
          quotedClipboardFix?.dispose()
          editorRepaintFilter?.dispose()
          stopWatchingMarkWipes?.()
          if (overlayRedrawFrame !== null) window.cancelAnimationFrame(overlayRedrawFrame)
          if (overlayRefreshTimerRef.current) { clearTimeout(overlayRefreshTimerRef.current); overlayRefreshTimerRef.current = null }
          protectionMarkLayerRef.current?.clear()
          approvalMarkLayerRef.current?.clear()
          protectionMarkLayerRef.current = null
          approvalMarkLayerRef.current = null
          pasteNotifier?.dispose?.()
          plainTextConvertMenu?.dispose?.()
          selectionPresenceDisposable.dispose()
          searchableOptionClickDisposable.dispose()
          scrollPositionDisposable.dispose()
          beforeEditPresenceDisposable.dispose()
          protectionGuardDisposable.dispose()
          editStartedPresenceDisposable.dispose()
          editEndedPresenceDisposable.dispose()
          persistRef.current = null
          schedulePersistRef.current = () => undefined
          workbookApiRef.current = null
          persistQueuedRef.current = false
          persistInFlightRef.current = null
          if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
          if (sheetViewMemorySaveTimerRef.current) { clearTimeout(sheetViewMemorySaveTimerRef.current); sheetViewMemorySaveTimerRef.current = null }
          if (sheetViewRestoreFrameRef.current !== null) { window.cancelAnimationFrame(sheetViewRestoreFrameRef.current); sheetViewRestoreFrameRef.current = null }
          if (sheetViewRestoreTimerRef.current) { clearTimeout(sheetViewRestoreTimerRef.current); sheetViewRestoreTimerRef.current = null }
          sheetViewMemoryRestoringRef.current = false
          if (deferredRealtimeFlushFrameRef.current !== null) { window.cancelAnimationFrame(deferredRealtimeFlushFrameRef.current); deferredRealtimeFlushFrameRef.current = null }
          if (compositionEndTimerRef.current) { clearTimeout(compositionEndTimerRef.current); compositionEndTimerRef.current = null }
          sheetEditorActiveRef.current = false
          imeComposingRef.current = false
          activeEditCellRef.current = null
          completedEditCellRef.current = null
          pendingLocalPersistRef.current = false
          deferredIncomingChangesRef.current = []
          deferredSilentSyncRef.current = false
          if (remotePatchResetTimerRef.current) { clearTimeout(remotePatchResetTimerRef.current); remotePatchResetTimerRef.current = null }
          applyingRemotePatchRef.current = false
          persistedWorksheetDataRef.current = null
          presenceSendRef.current = { signature: '', sentAt: 0 }
          univerApiRef.current = null
          setHasFilter(false)
          setSelectionState(null)
          setOptionPickerTarget(null)
          setOptionPickerSearch('')

		  disposeCreatedUniver()

		}
      } catch (mountError) {
		disposeCreatedUniver()
        console.error('Failed to initialize Univer sheet:', mountError)
        if (!disposed) {
          setError(mountError instanceof Error ? mountError.message : 'Univer 工作表初始化失败，请稍后重试。')
          setLoading(false)
        }
      }
    }

    mount()
	return () => {
	  disposed = true
	  cancelHeightWait?.()
	  cleanup?.()
	  if (plainTextRefreshFrameRef.current !== null) {
	    window.cancelAnimationFrame(plainTextRefreshFrameRef.current)
	    plainTextRefreshFrameRef.current = null
	  }
	  if (plainTextRetryTimerRef.current) {
	    clearTimeout(plainTextRetryTimerRef.current)
	    plainTextRetryTimerRef.current = null
	  }
	  plainTextRetryCountRef.current = 0
	  plainTextMarkersRef.current = []
	  disposeCreatedUniver()
	}
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveCanEditSheet synced via separate setEditable effect
  }, [sheetId, workbookId, reloadToken, localReloadNonce, canInitializeEditor, persistSheetViewMemory, refreshPlainTextBadges, requestProtectionHighlightRefresh, scheduleSheetViewMemoryPersist])

  useEffect(() => {
    clearPlainTextBadges()
    if (loading) return
    refreshPlainTextBadges({ scan: true })
  }, [clearPlainTextBadges, loading, refreshPlainTextBadges, reloadToken, sheetId])

  useEffect(() => {
    try {
      workbookApiRef.current?.setEditable(effectiveCanEditSheet)
    } catch {
      // Ignore Univer editable sync issues and keep server-side checks authoritative.
    }
  }, [effectiveCanEditSheet])

  // Gallery image picker
  const openImagePicker = useCallback(async () => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能插入图片。')
      return
    }
    setShowImagePicker(true)
    setLoadingGallery(true)
    try {
      const res = await api.get<{ list: GalleryImage[]; total: number }>(
        '/attachments/images?page=1&size=50'
      )
      if (res.code === 0 && res.data) {
        setGalleryImages(res.data.list || [])
      }
    } catch (err) {
      console.error('Failed to load gallery:', err)
    } finally {
      setLoadingGallery(false)
    }
  }, [editLocked])

  const lockImageCell = useCallback(async (worksheetRow: number, worksheetColumn: number) => {
    if (!lockInsertedImageCell || worksheetRow <= 0) return
    const column = latestSheetRef.current.columns?.[worksheetColumn]
    if (!column?.key) return
    const rowIndex = worksheetRow - 1
    const alreadyProtected = protectionSnapshot.cells.some((item) => item.row_index === rowIndex && item.column_key === column.key)
    if (alreadyProtected) return

    const response = await api.post<{ protections?: ProtectionSnapshot }>(`/sheets/${sheetId}/protections`, {
      scope: 'cell',
      action: 'lock',
      row_index: rowIndex,
      column_key: column.key,
      readonly_user_ids: selectedProtectionReadonlyUserIds,
      readonly_department_ids: selectedProtectionReadonlyDepartmentIds,
      editable_user_ids: selectedProtectionEditableUserIds,
      editable_department_ids: selectedProtectionEditableDepartmentIds,
      view_hidden_user_ids: selectedProtectionViewHiddenUserIds,
      view_hidden_department_ids: selectedProtectionViewHiddenDepartmentIds,
      lock_editing: true,
    })
    if (response.code !== 0) {
      throw new Error(response.message || '图片已插入，但锁定所在单元格失败。')
    }
    if (response.data?.protections) {
      setProtectionSnapshot(response.data.protections)
    } else {
      await refreshProtectionSnapshot()
    }
    setShowProtectionHighlights(true)
    requestProtectionHighlightRefresh()
  }, [lockInsertedImageCell, protectionSnapshot.cells, refreshProtectionSnapshot, requestProtectionHighlightRefresh, selectedProtectionEditableDepartmentIds, selectedProtectionEditableUserIds, selectedProtectionReadonlyDepartmentIds, selectedProtectionReadonlyUserIds, selectedProtectionViewHiddenDepartmentIds, selectedProtectionViewHiddenUserIds, sheetId])

  const insertImageToCell = useCallback(async (img: GalleryImage) => {
    const result = univerApiRef.current
    if (!result) return

    const { univerAPI } = result
    try {
      const wb = univerAPI.getActiveWorkbook?.()
      const ws = wb?.getActiveSheet?.()
      const range = ws?.getActiveRange?.() || ws?.getSelection?.()?.getActiveRange?.()
      if (!ws || !range) {
        throw new Error('请先选中要插入图片的单元格。')
      }

      const imageFile = await toImageFile(img)
      const imageRow = range.getRow()
      const imageColumn = range.getColumn()

      const inserted = await (range as typeof range & {
        insertCellImageAsync?: (file: File | string) => Promise<boolean>
      }).insertCellImageAsync?.(imageFile)
      if (!inserted) {
        throw new Error('图片插入失败，请确认当前工作表已启用图片能力。')
      }

      await persistCurrentSheet()
      await lockImageCell(imageRow, imageColumn)
    } catch (e) {
      console.error('Failed to insert image to cell:', e)
      setActionError(e instanceof Error ? e.message : '插入图片失败，请稍后再试。')
    }

    setShowImagePicker(false)
  }, [lockImageCell, persistCurrentSheet])

  // Handle direct file upload from picker
  const handleDirectUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能上传图片。')
      return
    }
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const res = await api.upload(file)
      if (res.code === 0 && res.data) {
        const urlRes = await api.get<{ url: string }>(`/files/${res.data.id}`)
        if (urlRes.code === 0 && urlRes.data) {
          const result = univerApiRef.current
          const { univerAPI } = result || {}
          const wb = univerAPI?.getActiveWorkbook?.()
          const ws = wb?.getActiveSheet?.()
          const range = ws?.getActiveRange?.() || ws?.getSelection?.()?.getActiveRange?.()
          if (!ws || !range) {
            throw new Error('请先选中要插入图片的单元格。')
          }

          const imageRow = range.getRow()
          const imageColumn = range.getColumn()
          const inserted = await (range as typeof range & {
            insertCellImageAsync?: (file: File | string) => Promise<boolean>
          }).insertCellImageAsync?.(file)
          if (!inserted) {
            throw new Error('本地图片插入失败，请稍后重试。')
          }

          await persistCurrentSheet()
          await lockImageCell(imageRow, imageColumn)
          setShowImagePicker(false)
        }
      }
    } catch (err) {
      console.error('Upload failed:', err)
      setActionError(err instanceof Error ? err.message : '上传图片失败，请稍后再试。')
    }
  }, [editLocked, lockImageCell, persistCurrentSheet])

  const getCurrentSheetSnapshot = useCallback(() => {
    const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
    const worksheet = workbook?.getActiveSheet?.()
    if (!workbook || !worksheet) {
      throw new Error('当前工作表还未加载完成。')
    }

    const saved = workbook.save()
    const savedSheetId = saved.sheetOrder[0]
    const savedSheet = saved.sheets[savedSheetId] as Partial<IWorksheetData> | undefined
    if (!savedSheet) {
      throw new Error('未能读取当前工作表内容。')
    }

    return {
      savedSheet,
      columns: latestSheetRef.current.columns || [],
    }
  }, [])

  const closePdfPreview = useCallback(() => {
    if (pdfPreviewUrlRef.current) {
      window.URL.revokeObjectURL(pdfPreviewUrlRef.current)
      pdfPreviewUrlRef.current = null
    }
    setPdfPreview(null)
  }, [])

  useEffect(() => {
    return () => {
      if (pdfPreviewUrlRef.current) {
        window.URL.revokeObjectURL(pdfPreviewUrlRef.current)
        pdfPreviewUrlRef.current = null
      }
    }
  }, [])

  const handleDownloadPreviewPdf = useCallback(() => {
    if (!pdfPreview) return
    triggerBrowserDownload(pdfPreview.blob, pdfPreview.filename)
  }, [pdfPreview])

  const handleDownloadSheet = useCallback(async () => {
    if (!effectiveCanExportSheet) {
      setActionError('当前账号没有导出权限，不能下载工作表。')
      return
    }

    setActionError('')
    setExportAction('download')
    try {
      if (canEditSheet) {
        await persistCurrentSheet()
      }

      const fallbackFilename = `${sanitizeDownloadFilename(latestSheetRef.current.name || '工作表')}.xlsx`
      const response = await api.download(`/sheets/${sheetId}/export?filename=${encodeURIComponent(fallbackFilename)}`)
      if (!response.ok) {
        let message = '下载工作表失败，请稍后再试。'
        try {
          const data = await response.json() as { message?: string }
          if (data?.message) {
            message = data.message
          }
        } catch {
          // Ignore JSON parse errors for binary responses.
        }
        throw new Error(message)
      }

      const blob = await response.blob()
      const filename = parseFilenameFromDisposition(response.headers.get('Content-Disposition'), fallbackFilename)
      triggerBrowserDownload(blob, filename)
    } catch (err) {
      console.error('Failed to download sheet:', err)
      setActionError(err instanceof Error ? err.message : '下载工作表失败，请稍后再试。')
    } finally {
      setExportAction('')
    }
  }, [canEditSheet, effectiveCanExportSheet, persistCurrentSheet, sheetId])

  const handleDownloadWorkbookExcel = useCallback(async () => {
    if (!effectiveCanExportSheet) {
      setActionError('当前账号没有导出权限，不能下载工作簿。')
      return
    }

    setActionError('')
    setExportAction('workbook')
    try {
      if (canEditSheet) {
        await persistCurrentSheet()
      }

      const fallbackFilename = `${sanitizeDownloadFilename(workbookExportName)}.xlsx`
      const response = await api.download(`/workbooks/${workbookId}/export?filename=${encodeURIComponent(fallbackFilename)}`)
      if (!response.ok) {
        let message = '下载工作簿失败，请稍后再试。'
        try {
          const data = await response.json() as { message?: string }
          if (data?.message) {
            message = data.message
          }
        } catch {
          // Ignore JSON parse errors for binary responses.
        }
        throw new Error(message)
      }

      const blob = await response.blob()
      const filename = parseFilenameFromDisposition(response.headers.get('Content-Disposition'), fallbackFilename)
      triggerBrowserDownload(blob, filename)
    } catch (err) {
      console.error('Failed to download workbook:', err)
      setActionError(err instanceof Error ? err.message : '下载工作簿失败，请稍后再试。')
    } finally {
      setExportAction('')
    }
  }, [canEditSheet, effectiveCanExportSheet, persistCurrentSheet, workbookExportName, workbookId])

  const handleDownloadOriginalWorkbook = useCallback(async () => {
    if (!originalWorkbookXlsxAvailable) {
      setActionError('当前工作簿没有可下载的原始 Excel 文件。')
      return
    }
    if (!effectiveCanExportSheet) {
      setActionError('当前账号没有下载原始 Excel 的权限，请联系管理员开启导出权限。')
      return
    }

    setActionError('')
    setExportAction('source')
    try {
      const rawFallbackName = originalWorkbookXlsxFilename || latestSheetRef.current.name || '工作簿'
      const fallbackBase = sanitizeDownloadFilename(rawFallbackName)
      const fallbackFilename = ensureExcelDownloadFilename(fallbackBase)
      const response = await api.download(`/workbooks/${workbookId}/source/xlsx`)
      if (!response.ok) {
        let message = '下载原始 Excel 失败，请稍后再试。'
        try {
          const data = await response.json() as { message?: string }
          if (data?.message) {
            message = data.message
          }
        } catch {
          // Ignore JSON parse errors for binary responses.
        }
        throw new Error(message)
      }

      const blob = await response.blob()
      const filename = parseFilenameFromDisposition(response.headers.get('Content-Disposition'), fallbackFilename)
      triggerBrowserDownload(blob, filename)
    } catch (err) {
      console.error('Failed to download source workbook:', err)
      setActionError(err instanceof Error ? err.message : '下载原始 Excel 失败，请稍后再试。')
    } finally {
      setExportAction('')
    }
  }, [effectiveCanExportSheet, originalWorkbookXlsxAvailable, originalWorkbookXlsxFilename, workbookId])

  const openPdfExportPanel = useCallback(() => {
    const validIDs = new Set(workbookSheetOptions.map((item) => item.id))
    const nextSelected = selectedPdfSheetIds.filter((id) => validIDs.has(id))
    setSelectedPdfSheetIds(nextSelected.length > 0 ? nextSelected : [sheetId])
    setPdfExportScope('current')
    setShowPdfExportPanel(true)
    setActionError('')
  }, [selectedPdfSheetIds, sheetId, workbookSheetOptions])

  const togglePdfSheetSelection = useCallback((targetSheetId: number) => {
    setSelectedPdfSheetIds((current) => {
      if (current.includes(targetSheetId)) {
        return current.filter((id) => id !== targetSheetId)
      }
      return [...current, targetSheetId]
    })
  }, [])

  const handlePreviewPdfExport = useCallback(async () => {
    if (!effectiveCanViewSheet) {
      setActionError('当前账号没有查看权限，不能预览 PDF。')
      return
    }

    const selectedIDs = selectedPdfSheetIds.filter((id) => workbookSheetOptions.some((item) => item.id === id))
    if (pdfExportScope === 'selected' && selectedIDs.length === 0) {
      setActionError('请至少选择一个要导出的工作表。')
      return
    }

    setActionError('')
    setExportAction('pdf')
    try {
      if (canEditSheet) {
        await persistCurrentSheet()
      }

      const fallbackBase =
        pdfExportScope === 'current'
          ? latestSheetRef.current.name || '工作表'
          : pdfExportScope === 'selected'
          ? `${workbookExportName}-选中工作表`
          : workbookExportName
      const fallbackFilename = `${sanitizeDownloadFilename(fallbackBase)}.pdf`
      const pdfOptions = `paper_size=${encodeURIComponent(pdfPaperSize)}&orientation=${encodeURIComponent(pdfOrientation)}&fit_to_width=${pdfFitToWidth ? 'true' : 'false'}`
      const endpoint =
        pdfExportScope === 'current'
          ? `/sheets/${sheetId}/export/pdf?filename=${encodeURIComponent(fallbackFilename)}&${pdfOptions}`
          : `/workbooks/${workbookId}/export/pdf?filename=${encodeURIComponent(fallbackFilename)}&${pdfOptions}${
              pdfExportScope === 'selected' ? `&sheet_ids=${encodeURIComponent(selectedIDs.join(','))}` : ''
            }`
      const response = await api.download(endpoint)
      if (!response.ok) {
        let message = '导出 PDF 失败，请稍后再试。'
        try {
          const data = await response.json() as { message?: string }
          if (data?.message) {
            message = data.message
          }
        } catch {
          // Ignore JSON parse errors for binary responses.
        }
        throw new Error(message)
      }

      const blob = await response.blob()
      const filename = parseFilenameFromDisposition(response.headers.get('Content-Disposition'), fallbackFilename)
      if (pdfPreviewUrlRef.current) {
        window.URL.revokeObjectURL(pdfPreviewUrlRef.current)
      }
      const url = window.URL.createObjectURL(blob)
      pdfPreviewUrlRef.current = url
      setPdfPreview({ url, filename, blob })
      setShowPdfExportPanel(false)
    } catch (err) {
      console.error('Failed to export PDF:', err)
      setActionError(err instanceof Error ? err.message : '生成 PDF 预览失败，请稍后再试。')
    } finally {
      setExportAction('')
    }
  }, [canEditSheet, effectiveCanViewSheet, pdfExportScope, pdfFitToWidth, pdfOrientation, pdfPaperSize, persistCurrentSheet, selectedPdfSheetIds, sheetId, workbookExportName, workbookId, workbookSheetOptions])

  const handlePrintSheet = useCallback(async () => {
    if (!effectiveCanExportSheet) {
      setActionError('当前账号没有导出权限，不能打印工作表。')
      return
    }

    setActionError('')
    setExportAction('print')
    try {
      if (canEditSheet) {
        await persistCurrentSheet()
      }
      const { savedSheet, columns } = getCurrentSheetSnapshot()
      const html = buildSheetPrintHtml(savedSheet, latestSheetRef.current.name || '工作表', columns, 'print')
      await printHtmlWithHiddenFrame(html)
    } catch (err) {
      console.error('Failed to print sheet:', err)
      setActionError(err instanceof Error ? err.message : '打印失败，请稍后再试。')
    } finally {
      setExportAction('')
    }
  }, [canEditSheet, effectiveCanExportSheet, getCurrentSheetSnapshot, persistCurrentSheet])

  useEffect(() => {
    if (!selectionState) {
      setSelectedProtectionLockEditing(true)
      setSelectedProtectionHidden(false)
      setSelectedProtectionHideFormula(false)
      setSelectedProtectionReadonlyUserIds([])
      setSelectedProtectionReadonlyDepartmentIds([])
      setSelectedProtectionEditableUserIds([])
      setSelectedProtectionEditableDepartmentIds([])
      setSelectedProtectionViewHiddenUserIds([])
      setSelectedProtectionViewHiddenDepartmentIds([])
      return
    }

    const currentCell = protectionIndex.cells.get(`${selectionState.rowIndex}:${selectionState.columnKey}`)
    const currentRow = protectionIndex.rows.get(selectionState.rowIndex)
    const currentColumn = protectionIndex.columns.get(selectionState.columnKey)
    const activeProtection = currentCell || currentRow || currentColumn

    if (activeProtection) setProtectionScope(activeProtection.scope)
    setSelectedProtectionLockEditing(activeProtection?.lock_editing ?? true)
    setSelectedProtectionHidden(Boolean(activeProtection?.hidden))
    setSelectedProtectionHideFormula(Boolean(activeProtection?.hide_formula))
    setSelectedProtectionReadonlyUserIds(activeProtection?.readonly_user_ids || [])
    setSelectedProtectionReadonlyDepartmentIds(activeProtection?.readonly_department_ids || [])
    setSelectedProtectionEditableUserIds(activeProtection?.editable_user_ids || [])
    setSelectedProtectionEditableDepartmentIds(activeProtection?.editable_department_ids || [])
    setSelectedProtectionViewHiddenUserIds(activeProtection?.view_hidden_user_ids || [])
    setSelectedProtectionViewHiddenDepartmentIds(activeProtection?.view_hidden_department_ids || [])
  }, [protectionIndex, selectionState])

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-md space-y-3">
          <AlertCircle className="mx-auto h-10 w-10 text-rose-500" />
          <h2 className="text-xl font-semibold text-slate-900">{error}</h2>
        </div>
      </div>
    )
  }

  const showFabs = !showImagePicker && !univerHasOverlay && !showNumberFormatPanel && !showApprovalPanel && !showFieldControlPanel && !showProtectionPanel && !optionPickerTarget
  const currentRowProtection = selectionState ? protectionIndex.rows.get(selectionState.rowIndex) || null : null
  const currentColumnProtection = selectionState ? protectionIndex.columns.get(selectionState.columnKey) || null : null
  const currentCellProtection = selectionState
    ? protectionIndex.cells.get(`${selectionState.rowIndex}:${selectionState.columnKey}`) || null
    : null
  const columnLabelMap = new Map((latestSheetRef.current.columns || []).map((column) => [column.key, column.name || column.key]))
  const getProtectionColumnLabel = (columnKey?: string | null) => {
    if (!columnKey) return '未知列'
    return columnLabelMap.get(columnKey) || columnKey
  }
  const formatProtectionTarget = (item: ProtectionInfo) => {
    if (item.scope === 'row') return `第 ${(item.row_index ?? 0) + 2} 行`
    if (item.scope === 'column') return `列 ${getProtectionColumnLabel(item.column_key || item.key)}`
    return `${getProtectionColumnLabel(item.column_key || item.key)}${(item.row_index ?? 0) + 2}`
  }
  const formatProtectionBadge = (item: ProtectionInfo) => `${formatProtectionTarget(item)} · ${formatProtectionMode(item)} - ${item.owner_name}`
  const canReleaseProtection = (item: ProtectionInfo | null) => Boolean(item && !editLocked && (adminMode || item.owner_id === profile?.id))
  const canUpdateProtectionEditors = (item: ProtectionInfo | null) => Boolean(item && !editLocked && (adminMode || item.owner_id === profile?.id))
  const protectionUserNameMap = new Map(protectionUsers.map((user) => [user.id, user.username]))
  const protectionDepartmentNameMap = new Map(protectionDepartments.map((department) => [department.id, department.name]))
  const normalizedProtectionUserSearch = protectionUserSearch.trim().toLocaleLowerCase('zh-CN')
  const filteredProtectionUsers = normalizedProtectionUserSearch
    ? protectionUsers.filter((user) => `${user.username} ${user.email}`.toLocaleLowerCase('zh-CN').includes(normalizedProtectionUserSearch))
    : protectionUsers
  const describeProtectionPrincipals = (userIds: number[] = [], departmentIds: number[] = []) => [
    ...departmentIds.map((id) => `部门：${protectionDepartmentNameMap.get(id) || `#${id}`}`),
    ...userIds.map((id) => protectionUserNameMap.get(id) || `用户 #${id}`),
  ]
  const formatProtectionWhitelist = (item: ProtectionInfo | null) => {
    if (!item) return '未设置'
    const groups = [
      { label: '修改', values: describeProtectionPrincipals(item.editable_user_ids, item.editable_department_ids) },
      { label: '查看原文', values: describeProtectionPrincipals(item.view_hidden_user_ids, item.view_hidden_department_ids) },
      { label: '只读', values: describeProtectionPrincipals(item.readonly_user_ids, item.readonly_department_ids) },
    ].filter((group) => group.values.length > 0)
    if (groups.length === 0) return '仅创建者和管理员'
    return groups.map((group) => `${group.label}：${group.values.join('、')}`).join('；')
  }
  const selectedProtectionPrincipalCount = new Set([
    ...selectedProtectionReadonlyUserIds,
    ...selectedProtectionReadonlyDepartmentIds.map((id) => -id),
    ...selectedProtectionEditableUserIds,
    ...selectedProtectionEditableDepartmentIds.map((id) => -id),
    ...selectedProtectionViewHiddenUserIds,
    ...selectedProtectionViewHiddenDepartmentIds.map((id) => -id),
  ]).size
  const updateProtectionAccessList = (current: number[], id: number, selected: boolean) => selected
    ? Array.from(new Set([...current, id])).sort((left, right) => left - right)
    : current.filter((item) => item !== id)
  const getProtectionUserAccess = (userId: number): ProtectionWhitelistAccess | '' => {
    if (selectedProtectionEditableUserIds.includes(userId)) return 'edit'
    if (selectedProtectionViewHiddenUserIds.includes(userId)) return 'view_hidden'
    if (selectedProtectionReadonlyUserIds.includes(userId)) return 'readonly'
    return ''
  }
  const getProtectionDepartmentAccess = (departmentId: number): ProtectionWhitelistAccess | '' => {
    if (selectedProtectionEditableDepartmentIds.includes(departmentId)) return 'edit'
    if (selectedProtectionViewHiddenDepartmentIds.includes(departmentId)) return 'view_hidden'
    if (selectedProtectionReadonlyDepartmentIds.includes(departmentId)) return 'readonly'
    return ''
  }
  const setProtectionUserAccess = (userId: number, access: ProtectionWhitelistAccess | '') => {
    setSelectedProtectionReadonlyUserIds((current) => updateProtectionAccessList(current, userId, access === 'readonly'))
    setSelectedProtectionEditableUserIds((current) => updateProtectionAccessList(current, userId, access === 'edit'))
    setSelectedProtectionViewHiddenUserIds((current) => updateProtectionAccessList(current, userId, access === 'view_hidden'))
  }
  const setProtectionDepartmentAccess = (departmentId: number, access: ProtectionWhitelistAccess | '') => {
    setSelectedProtectionReadonlyDepartmentIds((current) => updateProtectionAccessList(current, departmentId, access === 'readonly'))
    setSelectedProtectionEditableDepartmentIds((current) => updateProtectionAccessList(current, departmentId, access === 'edit'))
    setSelectedProtectionViewHiddenDepartmentIds((current) => updateProtectionAccessList(current, departmentId, access === 'view_hidden'))
  }
  const clearProtectionWhitelist = () => {
    setSelectedProtectionReadonlyUserIds([])
    setSelectedProtectionReadonlyDepartmentIds([])
    setSelectedProtectionEditableUserIds([])
    setSelectedProtectionEditableDepartmentIds([])
    setSelectedProtectionViewHiddenUserIds([])
    setSelectedProtectionViewHiddenDepartmentIds([])
  }
  const activeProtection = protectionScope === 'row'
    ? currentRowProtection
    : protectionScope === 'column'
      ? currentColumnProtection
      : currentCellProtection
  const selectProtectionScope = (scope: ProtectionScope) => {
    const item = scope === 'row' ? currentRowProtection : scope === 'column' ? currentColumnProtection : currentCellProtection
    setProtectionScope(scope)
    setSelectedProtectionLockEditing(item?.lock_editing ?? true)
    setSelectedProtectionHidden(Boolean(item?.hidden))
    setSelectedProtectionHideFormula(Boolean(item?.hide_formula))
    setSelectedProtectionReadonlyUserIds(item?.readonly_user_ids || [])
    setSelectedProtectionReadonlyDepartmentIds(item?.readonly_department_ids || [])
    setSelectedProtectionEditableUserIds(item?.editable_user_ids || [])
    setSelectedProtectionEditableDepartmentIds(item?.editable_department_ids || [])
    setSelectedProtectionViewHiddenUserIds(item?.view_hidden_user_ids || [])
    setSelectedProtectionViewHiddenDepartmentIds(item?.view_hidden_department_ids || [])
  }
  const protectionSelectionSize = (() => {
    if (!selectionState) return { rows: 0, columns: 0 }
    const sheetColumns = latestSheetRef.current.columns || []
    const startColumn = sheetColumns.findIndex((column) => column.key === selectionState.columnKey)
    const endColumn = sheetColumns.findIndex((column) => column.key === selectionState.endColumnKey)
    return {
      rows: Math.max(0, selectionState.endRowIndex - selectionState.rowIndex + 1),
      columns: startColumn < 0 || endColumn < 0 ? 0 : Math.abs(endColumn - startColumn) + 1,
    }
  })()
  const effectiveProtectionScope: ProtectionScope = selectionState?.isEntireColumnSelection
    ? 'column'
    : selectionState?.isEntireRowSelection
      ? 'row'
      : protectionScope
  const protectionTargetCount = effectiveProtectionScope === 'row'
    ? protectionSelectionSize.rows
    : effectiveProtectionScope === 'column'
      ? protectionSelectionSize.columns
      : protectionSelectionSize.rows * protectionSelectionSize.columns
  const protectionTargetLabel = `${protectionTargetCount.toLocaleString('zh-CN')} ${effectiveProtectionScope === 'row' ? '行' : effectiveProtectionScope === 'column' ? '列' : '个单元格'}`
  const protectionBatchTooLarge = protectionTargetCount > 5000
  const protectionBatchLarge = effectiveProtectionScope === 'cell' && protectionTargetCount > 300
  const protectionModeMissing = !selectedProtectionLockEditing && !selectedProtectionHidden && !selectedProtectionHideFormula
  const protectionApplyBlockedReason = !selectionState
    ? '请先在表格中框选要保护的范围'
    : editLocked
      ? '当前账号只有查看权限'
      : protectionModeMissing
        ? '请至少选择一种保护方式'
        : protectionBatchTooLarge
          ? '所选单元格超过 5000 个，请改用整列或整行'
          : activeProtection && !canUpdateProtectionEditors(activeProtection)
            ? `该范围由 ${activeProtection.owner_name} 设置，只有创建者或管理员可以修改`
            : ''
  const protectionReleaseBlocked = !selectionState || editLocked || !activeProtection || !canReleaseProtection(activeProtection)
  const normalizedWhitelistSearch = protectionUserSearch.trim().toLocaleLowerCase('zh-CN')
  const whitelistDepartments = protectionWhitelistFilter === 'user'
    ? []
    : protectionDepartments.filter((department) => !normalizedWhitelistSearch || department.name.toLocaleLowerCase('zh-CN').includes(normalizedWhitelistSearch))
  const whitelistUsers = protectionWhitelistFilter === 'department' ? [] : filteredProtectionUsers
  const buildFilteredProtectionRecordGroups = () => protectionOwnerGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => protectionRecordFilter === 'all'
        || (protectionRecordFilter === 'hidden' && item.hidden)
        || (protectionRecordFilter === 'formula' && item.hide_formula)
        || (protectionRecordFilter === 'lock' && item.lock_editing)),
    }))
    .filter((group) => group.items.length > 0)
  const currentProtectionItems = [currentRowProtection, currentColumnProtection, currentCellProtection]
    .filter((item): item is ProtectionInfo => Boolean(item))
  const selectedCellCannotEdit = Boolean(
    selectionState && permissions && (
      !canEditCell(selectionState.columnKey, selectionState.rowIndex) ||
      currentProtectionItems.some((item) => !item.can_edit)
    )
  )
  const selectedCellMasked = currentProtectionItems.some((item) => item.masked_for_current_user)
  const selectedCellFormulaHidden = currentProtectionItems.some((item) => item.formula_hidden_for_current_user)
  const showSelectionRestriction = selectedCellMasked || selectedCellFormulaHidden || (currentProtectionItems.length > 0 && selectedCellCannotEdit)
  const onlineCollaborators = Array.from(sheetPresence.reduce((users, entry) => {
    const current = users.get(entry.userId)
    const priority = { viewing: 0, selected: 1, editing: 2 }
    if (!current || priority[entry.state] > priority[current.state]) users.set(entry.userId, entry)
    return users
  }, new Map<number, SheetPresenceEntry>()).values())
    .sort((left, right) => {
      if (left.userId === profile?.id) return -1
      if (right.userId === profile?.id) return 1
      const priority = { editing: 0, selected: 1, viewing: 2 }
      return priority[left.state] - priority[right.state] || left.username.localeCompare(right.username, 'zh-CN')
    })
  const displayedCollaborators = presenceExpanded ? onlineCollaborators : onlineCollaborators.slice(0, 4)
  // Your own sessions are listed so you can spot a second window, but they never
  // count as an edit conflict against yourself.
  const otherEditingCollaborators = onlineCollaborators.filter((entry) => entry.state === 'editing' && entry.userId !== profile?.id)
  const selfEditingElsewhere = onlineCollaborators.some((entry) => entry.state === 'editing' && entry.userId === profile?.id)
  const currentApprovalStates = selectionState
    ? approvalStates.filter((item) => item.row === selectionState.rowIndex && item.col === selectionState.columnKey)
    : []
  const pendingApprovalStates = approvalStates.filter((item) => item.status === 'pending')
  const normalizedOptionPickerSearch = optionPickerSearch.trim().toLocaleLowerCase('zh-CN')
  const filteredOptionPickerOptions = optionPickerTarget
    ? optionPickerTarget.options.filter((option) => !normalizedOptionPickerSearch || option.toLocaleLowerCase('zh-CN').includes(normalizedOptionPickerSearch))
    : []
  const normalizedApprovalUserSearch = approvalUserSearch.trim().toLocaleLowerCase('zh-CN')
  const filteredApprovalUsers = normalizedApprovalUserSearch
    ? protectionUsers.filter((user) => `${user.username} ${user.email}`.toLocaleLowerCase('zh-CN').includes(normalizedApprovalUserSearch))
    : protectionUsers
  const approvalRangeLabel = (rule: AutomationRule) => {
    const target = rule.approval_ranges?.[0]
    const columnNames = (target?.columns || rule.watched_columns || []).map((key) => columnLabelMap.get(key) || key)
    const rows = typeof target?.start_row === 'number' && typeof target?.end_row === 'number'
      ? `第 ${target.start_row + 2}-${target.end_row + 2} 行`
      : '全部数据行'
    return `${rows} · ${columnNames.length > 0 ? columnNames.join('、') : '全部列'}`
  }
  const approvalRelatedSummary = (item: CellApprovalState) => Object.entries(item.related_data || {})
    .filter(([key, value]) => key !== item.col && value !== null && value !== undefined && value !== '')
    .slice(0, 4)
    .map(([key, value]) => `${item.field_labels?.[key] || columnLabelMap.get(key) || key}：${formatApprovalValue(value)}`)
    .join(' · ')

  return (
    <div
      className="mobile-sheet-editor"
      style={{ width: '100%', height: '100%', position: 'relative', touchAction: 'pan-x pan-y', overscrollBehavior: 'contain' }}
      onDragEnter={handleContainerDragEnter}
      onDragOver={handleContainerDragOver}
      onDragLeave={handleContainerDragLeave}
      onDrop={handleContainerDrop}
      onContextMenu={handleSheetContextMenu}
    >
      <div ref={containerRef} data-sheet-root style={{ width: '100%', height: '100%', position: 'relative' }} />

      <SheetMobileControls
        sheetId={sheetId}
        columnNames={latestSheetRef.current.columns?.map((column) => column.name) ?? []}
        ready={!loading && !error && canViewSheet}
        editable={!editLocked}
        selectionEditable={Boolean(selectionState && selectionState.rowIndex >= 0 && !editLocked && !selectedCellCannotEdit && !selectedCellMasked && !selectedCellFormulaHidden)}
        selectionLabel={selectionState?.rangeLabel || ''}
        changeToken={`${saveStatus}:${reloadToken || ''}:${searchAccessToken}`}
        readCells={async (commitEditor) => {
          if (commitEditor) {
            if (imeComposingRef.current) throw new Error('请先完成正在输入的文字')
            commitActiveCellEditor()
          }
          // Background index refreshes must not commit a half-typed cell.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook()
          const worksheet = workbook?.getActiveSheet()
          if (!workbook || !worksheet) return []
          const snapshot = workbook.save().sheets[worksheet.getSheetId()]
          const result: SheetSearchCell[] = []
          const rules = protectionSnapshotRef.current
          const hiddenRows = new Set(rules.rows.filter((rule) => rule.masked_for_current_user).map((rule) => rule.row_index))
          const hiddenColumns = new Set(rules.columns.filter((rule) => rule.masked_for_current_user).map((rule) => rule.column_key))
          const hiddenCells = new Set(rules.cells.filter((rule) => rule.masked_for_current_user).map((rule) => `${rule.row_index}:${rule.column_key}`))
          let visited = 0
          const maxRows = worksheet.getMaxRows()
          const maxColumns = worksheet.getMaxColumns()
          for (const [rowKey, rowData] of Object.entries(snapshot?.cellData || {})) {
            const row = Number(rowKey)
            if (!Number.isInteger(row) || row < 1 || row >= maxRows) continue
            for (const [columnKey, cell] of Object.entries((rowData || {}) as Record<string, ICellData | null>)) {
              const column = Number(columnKey)
              if (!Number.isInteger(column) || !cell || column >= maxColumns) continue
              const definition = latestSheetRef.current.columns?.[column]
              if (!definition || !permissions?.sheet.canView || resolveCellPermission(permissions, definition.key, row - 1) === 'none' || hiddenRows.has(row - 1) || hiddenColumns.has(definition.key) || hiddenCells.has(`${row - 1}:${definition.key}`)) continue
              const displayed = worksheet.getRange(row, column, 1, 1).getDisplayValue()
              const raw = cell.v ?? cell.p?.body?.dataStream ?? ''
              if (displayed === '••••' || raw === '••••') continue
              const text = [displayed, raw].filter((part) => part !== null && part !== undefined && part !== '').map(String).join('\n')
              if (text) result.push({ row, column, text })
              if (++visited % 500 === 0) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            }
          }
          return result.sort((a, b) => a.row - b.row || a.column - b.column)
        }}
        focusCell={(row, column) => {
          containerRef.current?.dispatchEvent(new Event('yaerp-stop-touch-pan'))
          const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet()
          // A hit found before rows were deleted or the sheet was reloaded can
          // point past the end of the sheet; Univer throws for such ranges.
          if (!worksheet || row < 0 || column < 0 || row >= worksheet.getMaxRows() || column >= worksheet.getMaxColumns()) return
          worksheet.getRange(row, column, 1, 1).activate()
          revealSearchHit(worksheet, row, column)
          syncSelectionState()
        }}
        moveCell={async (rowDelta, columnDelta) => {
          if (imeComposingRef.current) throw new Error('请先完成正在输入的文字')
          commitActiveCellEditor()
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          containerRef.current?.dispatchEvent(new Event('yaerp-stop-touch-pan'))
          const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet()
          if (!worksheet) return
          const range = worksheet.getActiveRange()
          const row = Math.min(worksheet.getMaxRows() - 1, Math.max(1, (range?.getRow() ?? 1) + rowDelta))
          const column = Math.min(worksheet.getMaxColumns() - 1, Math.max(0, (range?.getColumn() ?? 0) + columnDelta))
          worksheet.getRange(row, column, 1, 1).activate()
          revealCell(worksheet, row, column)
          syncSelectionState()
        }}
        undo={async () => {
          if (imeComposingRef.current) throw new Error('请先完成正在输入的文字')
          commitActiveCellEditor()
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          if (!await univerApiRef.current?.univerAPI.undo()) throw new Error('没有可撤销的操作（重新打开表格后可使用版本历史恢复）')
          syncSelectionState()
          await persistRef.current?.()
        }}
        redo={async () => {
          if (imeComposingRef.current) throw new Error('请先完成正在输入的文字')
          commitActiveCellEditor()
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          if (!await univerApiRef.current?.univerAPI.redo()) throw new Error('没有可重做的操作')
          syncSelectionState()
          await persistRef.current?.()
        }}
        readSelected={() => {
          const range = univerApiRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getActiveRange()
          const column = latestSheetRef.current.columns?.[range?.getColumn() ?? -1]
          if (!range || !column || range.getRow() < 1 || !permissions?.sheet.canView || resolveCellPermission(permissions, column.key, range.getRow() - 1) === 'none') return null
          const row = range.getRow() - 1
          const rules = protectionSnapshotRef.current
          if (rules.rows.some((rule) => rule.row_index === row && rule.masked_for_current_user) || rules.columns.some((rule) => rule.column_key === column.key && rule.masked_for_current_user) || rules.cells.some((rule) => rule.row_index === row && rule.column_key === column.key && rule.masked_for_current_user)) return null
          return { row: range.getRow(), column: range.getColumn(), value: String(range.getFormula() || (range.getValue() ?? '')) }
        }}
        writeSelected={async (value, expected) => {
          const range = univerApiRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getActiveRange()
          const column = latestSheetRef.current.columns?.[range?.getColumn() ?? -1]
          if (!range || range.getRow() !== expected.row || range.getColumn() !== expected.column) throw new Error('选区已变化，请回到原单元格或重新打开编辑')
          if (!column || range.getRow() < 1 || editLocked || selectedCellCannotEdit || selectedCellMasked || !canEditCell(column.key, range.getRow() - 1)) throw new Error('这个单元格不可编辑')
          if (column.type === 'formula' && !value.trim().startsWith('=')) throw new Error('公式列不能写入普通值，请先明确取消该列公式')
          // A range selection must not turn the phone's one-cell editor into a
          // bulk overwrite. Only edit its active/top-left cell.
          const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet()
          worksheet?.getRange(range.getRow(), range.getColumn(), 1, 1).setValue(mobileCellValue(value, column.type))
          syncSelectionState()
          await persistRef.current?.()
        }}
        extendSelection={async (rowDelta, columnDelta) => {
          // Touch has no shift+arrow: grow or shrink the range from its
          // bottom-right corner, keeping the anchor cell in place.
          containerRef.current?.dispatchEvent(new Event('yaerp-stop-touch-pan'))
          const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet()
          const range = worksheet?.getActiveRange()
          if (!worksheet || !range) return
          const startRow = range.getRow()
          const startColumn = range.getColumn()
          const endRow = Math.min(worksheet.getMaxRows() - 1, Math.max(startRow, startRow + range.getHeight() - 1 + rowDelta))
          const endColumn = Math.min(worksheet.getMaxColumns() - 1, Math.max(startColumn, startColumn + range.getWidth() - 1 + columnDelta))
          worksheet.getRange(startRow, startColumn, endRow - startRow + 1, endColumn - startColumn + 1).activate()
          revealCell(worksheet, endRow, endColumn)
          syncSelectionState()
        }}
        clearSelected={async () => {
          if (imeComposingRef.current) throw new Error('请先完成正在输入的文字')
          commitActiveCellEditor()
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet()
          const range = worksheet?.getActiveRange()
          if (!worksheet || !range) throw new Error('请先选择要清除的单元格')
          if (editLocked || selectedCellCannotEdit || selectedCellMasked) throw new Error('这个单元格不可编辑')
          // Same command as the Delete key, so permissions and undo behave alike.
          const cleared = await univerApiRef.current?.univerAPI.executeCommand(ClearSelectionContentCommand.id)
          if (!cleared) throw new Error('清除失败，所选单元格可能受保护')
          syncSelectionState()
          await persistRef.current?.()
        }}
        pastePlain={async () => {
          if (editLocked) throw new Error('当前表格不可编辑')
          commitActiveCellEditor()
          await pastePlainRef.current?.()
        }}
      />

      <FormulaErrorTooltip hint={formulaErrorHint} containerRef={containerRef} />
      <FormulaConsistencyBanner
        scanToken={formulaScanToken}
        ready={!loading && !error && canViewSheet}
        editable={!editLocked}
        getSheet={() => univerApiRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet() ?? null}
        focusCell={(row, column) => {
          const worksheet = univerApiRef.current?.univerAPI.getActiveWorkbook()?.getActiveSheet()
          if (!worksheet || row < 0 || column < 0 || row >= worksheet.getMaxRows() || column >= worksheet.getMaxColumns()) return
          worksheet.getRange(row, column, 1, 1).activate()
          worksheet.scrollToCell(row, column)
          syncSelectionState()
        }}
        onRepaired={() => schedulePersistRef.current?.()}
      />
      {clipboardNotice && (
        <div className="pointer-events-none absolute bottom-16 left-1/2 z-[70] max-w-[min(26rem,calc(100%-1rem))] -translate-x-1/2 rounded-lg bg-slate-900/90 px-3 py-2 text-center text-xs text-white shadow-lg" role="status">
          {clipboardNotice}
        </div>
      )}

      {/* Hover card of a non plain text badge. The badges themselves are float
          DOMs anchored by Univer; this layer only draws the card, so it stays
          click through and pointer events never leak onto the grid. */}
      <div ref={plainTextOverlayRef} className="pointer-events-none absolute inset-0 z-[19]">
        {plainTextTooltip && (
          <div
            data-plain-text-tooltip={`${plainTextTooltip.row}:${plainTextTooltip.column}`}
            data-plain-text-tooltip-kind={plainTextTooltip.kind}
            className="pointer-events-auto absolute w-64"
            style={{ left: `${plainTextTooltip.left}px`, top: `${plainTextTooltip.top}px` }}
            onMouseEnter={() => {
              if (plainTextTooltipTimerRef.current) {
                clearTimeout(plainTextTooltipTimerRef.current)
                plainTextTooltipTimerRef.current = null
              }
            }}
            onMouseLeave={() => hidePlainTextTooltip(true)}
          >
            <div className="rounded-lg border border-amber-200 bg-white p-2.5 text-left shadow-xl">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                数据不是纯文本结构
              </div>
              <p className="mt-1 text-[11px] leading-4 text-slate-600">
                {plainTextTooltip.kind === 'rich-text'
                  ? '这一格保存的是富文本（含单元格内格式或换行），不是纯文本。粘贴到记事本、CSV 或其它系统时会丢失结构。'
                  : '这一格的文本里含换行符，粘贴到记事本、CSV 或其它系统时会被拆成多行。'}
                转为纯文本会把换行合并成空格，并去掉单元格内的格式；带链接的单元格不会被转换，链接会保留。
              </p>
              {plainTextTooltip.preview && (
                <p className="mt-1.5 truncate rounded bg-slate-50 px-1.5 py-1 font-mono text-[10px] text-slate-500">{plainTextTooltip.preview}</p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  data-plain-text-convert={`${plainTextTooltip.row}:${plainTextTooltip.column}`}
                  onClick={() => convertPlainTextCell(plainTextTooltip.row, plainTextTooltip.column)}
                  className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-600"
                >
                  <Wrench className="h-3 w-3" />
                  转为纯文本
                </button>
                <button
                  type="button"
                  onClick={() => hidePlainTextTooltip(true)}
                  className="rounded-md px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {onlineCollaborators.length > 0 && (
        <div
          ref={presenceWidgetRef}
          style={presenceDrag.style}
          className={`absolute right-14 top-32 z-[22] w-auto sm:right-16 max-w-[min(16rem,calc(100%-1rem))] sm:max-w-[min(20rem,calc(100%-2rem))] opacity-80 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100 ${presenceDrag.dragging ? 'cursor-grabbing opacity-100 select-none' : 'cursor-grab'}`}
        >
          <button
            {...presenceDrag.handleProps}
            onPointerDown={(event) => {
              // Stop the sheet pan handler from consuming this touch before
              // pointer capture is established on the drag handle.
              event.currentTarget.closest('[data-sheet-root]')?.dispatchEvent(new Event('yaerp-stop-touch-pan'))
              presenceDrag.handleProps.onPointerDown(event)
            }}
            type="button"
            onClick={() => setPresenceExpanded((current) => !current)}
            className="touch-none select-none ml-auto flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1.5 text-left shadow-lg backdrop-blur"
            title={presenceExpanded ? '收起在线协作人员（可拖动）' : '查看在线协作人员（可拖动）'}
            aria-label={presenceExpanded ? '收起在线协作人员' : '查看在线协作人员'}
          >
            <UserRoundCheck className="h-4 w-4 shrink-0 text-emerald-600" />
            <div className="flex -space-x-1.5">
              {displayedCollaborators.slice(0, 4).map((entry) => {
                const visual = visualForUser(entry.userId)
                return <span key={entry.userId} className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold" style={{ backgroundColor: visual.soft, color: visual.stroke }} title={`${entry.userId === profile?.id ? '你' : entry.username} · ${entry.state === 'editing' ? '正在编辑' : entry.state === 'selected' ? '已选中单元格' : '在线查看'}`}>{entry.username.slice(0, 2).toUpperCase()}</span>
              })}
            </div>
            <div className="hidden min-w-0 flex-1 sm:block">
              <div className="truncate text-xs font-semibold text-slate-800">{onlineCollaborators.length} 人在线</div>
              <div className="truncate text-[10px] text-slate-400">{otherEditingCollaborators.length > 0 ? `${otherEditingCollaborators.length} 人正在编辑` : selfEditingElsewhere ? '你在其它窗口编辑中' : '当前无编辑冲突'}</div>
            </div>
            {onlineCollaborators.length > 4 && <span className="shrink-0 text-[10px] font-semibold text-slate-500">+{onlineCollaborators.length - 4}</span>}
            <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${presenceExpanded ? 'rotate-180' : ''}`} />
          </button>

          {presenceExpanded && (
            <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-2xl">
              {onlineCollaborators.map((entry) => {
                const visual = visualForUser(entry.userId)
                const columnName = latestSheetRef.current.columns?.find((column) => column.key === entry.col)?.name || entry.col
                return (
                  <div key={`presence-${entry.userId}`} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50">
                    <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-xs font-semibold" style={{ backgroundColor: visual.soft, color: visual.stroke }}>
                      {entry.username.slice(0, 2).toUpperCase()}
                      <span className={`absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-white ${entry.state === 'editing' ? 'bg-amber-500' : entry.state === 'selected' ? 'bg-sky-500' : 'bg-emerald-500'}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-800">{entry.userId === profile?.id ? `${entry.username}（我）` : entry.username}</div>
                      <div className="mt-0.5 truncate text-xs text-slate-400">{entry.state === 'editing' ? `正在编辑 ${columnName || ''}${typeof entry.row === 'number' ? entry.row + 2 : ''}` : entry.state === 'selected' ? `已选中 ${columnName || ''}${typeof entry.row === 'number' ? entry.row + 2 : ''}` : '正在查看此工作表'}</div>
                    </div>
                    <span className="shrink-0 rounded-lg px-2 py-1 text-[10px] font-medium" style={{ backgroundColor: visual.soft, color: visual.stroke }}>{entry.state === 'editing' ? '编辑中' : entry.state === 'selected' ? '准备编辑' : '在线'}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {(dragImportActive || dragImportUploading) && (
        <div className="absolute inset-0 z-[25] flex items-center justify-center bg-slate-950/18 backdrop-blur-[2px]">
          <div className="w-[min(28rem,calc(100%-2rem))] rounded-[28px] border border-dashed border-sky-300 bg-white/96 px-6 py-8 text-center shadow-2xl">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-50 text-sky-700">
              <Columns3 className="h-6 w-6" />
            </div>
            <div className="mt-4 text-base font-semibold text-slate-900">
              {dragImportUploading ? '正在导入 Excel...' : '拖放 Excel 文件到这里导入'}
            </div>
            <div className="mt-2 text-sm leading-6 text-slate-500">
              导入后会在当前工作簿中自动创建新的工作表。
            </div>
            {dragImportUploading && (
              <div className="mx-auto mt-5 max-w-xs">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
                  <span>Uploading</span>
                  <span>{dragImportProgress}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-sky-500 transition-all duration-200" style={{ width: `${dragImportProgress}%` }} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating toolbar — collapsible, hidden when any overlay/panel is open */}
      {showFabs && (
        <div className={`sheet-floating-stack pointer-events-none fixed bottom-36 z-[70] flex flex-col items-end gap-2 opacity-70 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100 [&_button]:pointer-events-auto md:bottom-[calc(var(--sheet-tabbar-offset)+5.5rem)] ${univerSidebarOpen ? 'right-[22rem] md:right-[24rem]' : 'right-4'}`}>
          {/* Expanded tools — slide up when toggled */}
          {toolbarExpanded && (
            <div className="pointer-events-auto flex max-h-[min(calc(100vh-28rem),32rem)] flex-col items-end gap-2 overflow-y-auto overscroll-contain pr-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
              <FloatingToolHint label="数字与默认格式">
                <button
                  type="button"
                  onClick={openNumberFormatPanel}
                  disabled={editLocked}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-sky-200 bg-sky-50 text-sky-700 shadow-lg transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="数字与默认格式"
                >
                  <Hash className="h-4 w-4" />
                </button>
              </FloatingToolHint>
              <FloatingToolHint label="字段控件（下拉/复选框）">
                <button
                  type="button"
                  onClick={openFieldControls}
                  disabled={editLocked}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 shadow-lg transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="字段控件"
                >
                  <ListChecks className="h-4 w-4" />
                </button>
              </FloatingToolHint>
              <FloatingToolHint label={`审批流程${pendingApprovalStates.length > 0 ? ` · ${pendingApprovalStates.length} 个待审` : ''}`}>
                <button
                  type="button"
                  onClick={openApprovalFlowPanel}
                  disabled={editLocked}
                  className="relative flex h-10 w-10 items-center justify-center rounded-full border border-amber-200 bg-amber-50 text-amber-700 shadow-lg transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="审批流程"
                >
                  <ClipboardCheck className="h-4 w-4" />
                  {pendingApprovalStates.length > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">{Math.min(pendingApprovalStates.length, 99)}</span>}
                </button>
              </FloatingToolHint>
              <FloatingToolHint label="保护设置">
                <button
                  type="button"
                  onClick={() => openCustomProtectionPanel()}
                  className={`flex h-10 w-10 items-center justify-center rounded-full border shadow-lg transition ${
                    showProtectionPanel
                      ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                  aria-label="保护设置"
                >
                  <Shield className="h-4 w-4" />
                </button>
              </FloatingToolHint>
              <FloatingToolHint label={hasFilter ? '清除筛选' : '启用筛选'}>
                <button
                  type="button"
                  onClick={hasFilter ? handleClearFilter : handleEnableFilter}
                  disabled={editLocked}
                  className={`flex h-10 w-10 items-center justify-center rounded-full border shadow-lg transition ${
                    hasFilter
                      ? 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                  aria-label={hasFilter ? '清除筛选' : '启用筛选'}
                >
                  {hasFilter ? <FilterX className="h-4 w-4" /> : <Filter className="h-4 w-4" />}
                </button>
              </FloatingToolHint>
              <FloatingToolHint label="下载当前表 Excel">
                <button
                  type="button"
                  onClick={() => void handleDownloadSheet()}
                  disabled={!effectiveCanExportSheet || exportAction !== ''}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 shadow-lg transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="下载当前表 Excel"
                >
                  <Download className="h-4 w-4" />
                </button>
              </FloatingToolHint>
              <FloatingToolHint label="下载工作簿 Excel">
                <button
                  type="button"
                  onClick={() => void handleDownloadWorkbookExcel()}
                  disabled={!effectiveCanExportSheet || exportAction !== ''}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-200 bg-white text-emerald-700 shadow-lg transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="下载工作簿 Excel"
                >
                  <Files className="h-4 w-4" />
                </button>
              </FloatingToolHint>
              {originalWorkbookXlsxAvailable && (
                <FloatingToolHint label="下载原始 Excel">
                  <button
                    type="button"
                    onClick={() => void handleDownloadOriginalWorkbook()}
                    disabled={!effectiveCanExportSheet || exportAction !== ''}
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-200 bg-white text-emerald-700 shadow-lg transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label="下载原始 Excel"
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                  </button>
                </FloatingToolHint>
              )}
              <FloatingToolHint label="打印当前表">
                <button
                  type="button"
                  onClick={() => void handlePrintSheet()}
                  disabled={!effectiveCanExportSheet || exportAction !== ''}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="打印当前表"
                >
                  <Printer className="h-4 w-4" />
                </button>
              </FloatingToolHint>
              <FloatingToolHint label="PDF 导出与预览">
                <button
                  type="button"
                  onClick={openPdfExportPanel}
                  disabled={!effectiveCanExportSheet || exportAction !== ''}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="PDF 导出与预览"
                >
                  <FileOutput className="h-4 w-4" />
                </button>
              </FloatingToolHint>
              <ImportXlsxButton
                workbookId={workbookId}
                canImport={canImportWorkbook}
                onImported={onExternalReload}
                onError={setActionError}
              />
              <FloatingToolHint label="插入图片">
                <button
                  type="button"
                  onClick={openImagePicker}
                  disabled={editLocked}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="插入图片"
                >
                  <ImagePlus className="h-4 w-4" />
                </button>
              </FloatingToolHint>
            </div>
          )}
          {/* Always visible: plain text conversion + Save + Toolbar toggle */}
          <FloatingToolHint label="把所选区域内的富文本、换行转为纯文本（链接会保留）">
            <button
              type="button"
              data-plain-text-convert-selection="true"
              onClick={convertPlainTextSelection}
              disabled={editLocked}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-amber-200 bg-white text-amber-600 shadow-lg transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="转为纯文本（所选区域）"
            >
              <RemoveFormatting className="h-4 w-4" />
            </button>
          </FloatingToolHint>
          <FloatingToolHint label={saveStatus === 'saving' ? '正在保存' : saveStatus === 'saved' ? '已保存' : '保存表格 (Ctrl+S)'}>
            <button
              type="button"
              onClick={handleManualSave}
              disabled={editLocked}
              className={`flex h-10 w-10 items-center justify-center rounded-full shadow-lg transition ${
                saveStatus === 'saving'
                  ? 'bg-amber-500 text-white'
                  : saveStatus === 'saved'
                  ? 'bg-emerald-500 text-white'
                  : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
              } disabled:cursor-not-allowed disabled:opacity-50`}
              aria-label="保存表格"
            >
              <Save className="h-4 w-4" />
            </button>
          </FloatingToolHint>
          <FloatingToolHint label={toolbarExpanded ? '收起表格工具' : '展开表格工具'}>
            <button
              type="button"
              onClick={() => setToolbarExpanded((v) => !v)}
              className={`flex h-10 w-10 items-center justify-center rounded-full shadow-lg transition ${
                toolbarExpanded
                  ? 'bg-slate-700 text-white hover:bg-slate-600'
                  : 'bg-slate-900 text-white hover:bg-slate-800'
              }`}
              aria-label={toolbarExpanded ? '收起表格工具' : '展开表格工具'}
            >
              {toolbarExpanded ? <ChevronUp className="h-5 w-5" /> : <Wrench className="h-5 w-5" />}
            </button>
          </FloatingToolHint>
        </div>
      )}

      {optionPickerTarget && (
        <div className="fixed inset-0 z-[1100] flex items-end justify-center bg-slate-950/35 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) { setOptionPickerTarget(null); setOptionPickerSearch('') } }}>
          <div className="flex max-h-[82vh] w-full flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:max-w-md sm:rounded-lg">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0"><div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Building2 className="h-4 w-4 text-emerald-600" />选择{optionPickerTarget.columnName}</div><div className="mt-1 truncate text-xs text-slate-400">第 {optionPickerTarget.row + 1} 行 · 支持输入关键词筛选</div></div>
              <button type="button" onClick={() => { setOptionPickerTarget(null); setOptionPickerSearch('') }} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100" title="关闭"><X className="h-4 w-4" /></button>
            </div>
            <div className="border-b border-slate-100 p-4">
              <label className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input autoFocus type="search" value={optionPickerSearch} onChange={(event) => setOptionPickerSearch(event.target.value)} placeholder={`搜索${optionPickerTarget.columnName}...`} className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-emerald-300 focus:bg-white focus:ring-2 focus:ring-emerald-100" /></label>
              {optionPickerTarget.currentValue && <div className="mt-2 text-xs text-slate-400">当前值：<span className="font-semibold text-slate-700">{optionPickerTarget.currentValue}</span></div>}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {filteredOptionPickerOptions.length === 0 ? <div className="px-4 py-10 text-center text-sm text-slate-400">没有匹配的选项</div> : filteredOptionPickerOptions.map((option, index) => {
                const configured = optionPickerTarget.optionColors?.[option]
                const fallback = COMMON_OPTION_COLORS[option] || OPTION_COLOR_PALETTE[index % OPTION_COLOR_PALETTE.length]
                const backgroundColor = configured?.backgroundColor || fallback.backgroundColor
                const textColor = configured?.textColor || fallback.textColor
                const selected = option === optionPickerTarget.currentValue
                return <button key={option} type="button" onClick={() => handleSearchableOptionSelect(option)} className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-slate-50 ${selected ? 'bg-emerald-50' : ''}`}><span className="h-7 w-2 shrink-0 rounded-full" style={{ backgroundColor }} /><span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: textColor }}>{option}</span>{selected && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}</button>
              })}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-3"><span className="text-xs text-slate-400">共 {optionPickerTarget.options.length} 个选项</span><button type="button" onClick={() => handleSearchableOptionSelect(null)} disabled={editLocked} className="h-8 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-40">清空当前值</button></div>
          </div>
        </div>
      )}

      {showFieldControlPanel && (
        <div className="fixed inset-0 z-[88] flex items-center justify-center bg-slate-950/45 px-3 py-5" onMouseDown={(event) => { if (event.target === event.currentTarget && !fieldControlApplying) setShowFieldControlPanel(false) }}>
          <div className="flex max-h-[90vh] w-[min(620px,96vw)] flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><ListChecks className="h-4 w-4 text-emerald-600" />字段控件</div>
                <div className="mt-1 truncate text-xs text-slate-400">应用到：{selectionState?.rangeLabel || '当前选区中的列'}</div>
              </div>
              <button type="button" onClick={() => setShowFieldControlPanel(false)} disabled={fieldControlApplying} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100" title="关闭"><X className="h-4 w-4" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-100 p-1">
                {([
                  { type: 'select' as const, label: '下拉列表', icon: ListChecks },
                  { type: 'checkbox' as const, label: '是/否复选框', icon: CheckSquare2 },
                  { type: 'none' as const, label: '普通文本', icon: Square },
                ]).map((item) => (
                  <button key={item.type} type="button" onClick={() => { setFieldControlType(item.type); if (item.type !== 'select') setFieldControlSearchable(false); if (item.type === 'checkbox') setFieldControlOptions((current) => current.length >= 2 ? current.slice(0, 2) : ['是', '否']) }} className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-2 text-xs font-semibold transition ${fieldControlType === item.type ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                    <item.icon className="h-4 w-4" />{item.label}
                  </button>
                ))}
              </div>

              {fieldControlType !== 'none' && (
                <>
                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-slate-600">快速模板</span>
                    <button type="button" onClick={() => setFieldControlOptions(['待处理', '已完成', '已取消'])} className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50">任务状态</button>
                    <button type="button" onClick={() => setFieldControlOptions(['待审批', '已通过', '已驳回'])} className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50">审批状态</button>
                    <button type="button" onClick={applySupplierFieldTemplate} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"><Building2 className="h-3.5 w-3.5" />供应商</button>
                    <button type="button" onClick={() => { setFieldControlType('checkbox'); setFieldControlSearchable(false); setFieldControlOptions(['是', '否']) }} className="h-8 rounded-lg border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50">是 / 否</button>
                  </div>
                  {fieldControlType === 'select' && (
                    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div><div className="text-xs font-semibold text-slate-700">搜索选择</div><div className="mt-0.5 text-[11px] leading-5 text-slate-400">开启后，点击该列单元格会弹出可搜索的下拉选择器。</div></div>
                      <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={fieldControlSearchable} onChange={(event) => setFieldControlSearchable(event.target.checked)} className="h-4 w-4 rounded border-slate-300 text-emerald-600" />启用搜索</label>
                    </div>
                  )}
                  <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
                    {fieldControlOptions.map((option, index) => {
                      const color = fieldControlColors[option] || COMMON_OPTION_COLORS[option] || OPTION_COLOR_PALETTE[index % OPTION_COLOR_PALETTE.length]
                      return (
                        <div key={`${index}-${option}`} className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2.5 last:border-b-0">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold" style={{ backgroundColor: color.backgroundColor, color: color.textColor }}>{index + 1}</span>
                          <input value={option} onChange={(event) => {
                            const nextValue = event.target.value
                            setFieldControlOptions((current) => current.map((item, itemIndex) => itemIndex === index ? nextValue : item))
                            setFieldControlColors((current) => {
                              const next = { ...current }
                              const existing = next[option]
                              delete next[option]
                              if (nextValue.trim()) next[nextValue] = existing || color
                              return next
                            })
                          }} className="h-9 min-w-[160px] flex-1 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-emerald-300" placeholder={`选项 ${index + 1}`} />
                          <label className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-2 text-[11px] text-slate-500" title="背景颜色"><span>背景</span><input type="color" value={color.backgroundColor.slice(0, 7)} onChange={(event) => setFieldControlColors((current) => ({ ...current, [option]: { ...color, backgroundColor: event.target.value.toUpperCase() } }))} className="h-6 w-7 cursor-pointer border-0 bg-transparent p-0" /></label>
                          <label className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-2 text-[11px] text-slate-500" title="文字颜色"><span>文字</span><input type="color" value={color.textColor.slice(0, 7)} onChange={(event) => setFieldControlColors((current) => ({ ...current, [option]: { ...color, textColor: event.target.value.toUpperCase() } }))} className="h-6 w-7 cursor-pointer border-0 bg-transparent p-0" /></label>
                          {fieldControlType === 'select' && fieldControlOptions.length > 2 && <button type="button" onClick={() => setFieldControlOptions((current) => current.filter((_, itemIndex) => itemIndex !== index))} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="删除选项"><Trash2 className="h-3.5 w-3.5" /></button>}
                        </div>
                      )
                    })}
                  </div>
                  {fieldControlType === 'select' && <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => setFieldControlOptions((current) => [...current, `选项 ${current.length + 1}`])} className="inline-flex h-9 items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 text-xs font-semibold text-slate-600 hover:border-emerald-300 hover:text-emerald-700"><Plus className="h-3.5 w-3.5" />添加选项</button><button type="button" onClick={() => { const values = collectSelectedColumnOptions(); if (values.length > 0) { setFieldControlOptions(values); setFieldControlColors(Object.fromEntries(values.map((option, index) => [option, OPTION_COLOR_PALETTE[index % OPTION_COLOR_PALETTE.length]]))) } else { setActionError('当前列还没有可提取的供应商或选项内容。') } }} className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"><Building2 className="h-3.5 w-3.5" />从当前列提取</button></div>}
                  <div className="mt-4 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2.5 text-xs leading-5 text-emerald-800">下拉项会使用不同颜色显示；供应商等长列表可开启搜索，点击单元格即可筛选并选择。</div>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
              <button type="button" onClick={() => setShowFieldControlPanel(false)} disabled={fieldControlApplying} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600">取消</button>
              <button type="button" onClick={() => void handleApplyFieldControl()} disabled={fieldControlApplying} className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white disabled:opacity-50"><BadgeCheck className="h-4 w-4" />{fieldControlApplying ? '正在应用...' : '应用到选区列'}</button>
            </div>
          </div>
        </div>
      )}

      {showApprovalPanel && (
        <div className="fixed inset-0 z-[88] flex items-center justify-center bg-slate-950/45 px-3 py-5" onMouseDown={(event) => { if (event.target === event.currentTarget && !approvalAction) setShowApprovalPanel(false) }}>
          <div className="flex max-h-[92vh] w-[min(860px,97vw)] flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><ClipboardCheck className="h-4 w-4 text-amber-600" />表格内审批流程</div>
                <div className="mt-1 truncate text-xs text-slate-400">当前选区：{selectionState?.rangeLabel || '未选择'}</div>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={handApprovalSelectionToAI} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2.5 text-xs font-semibold text-sky-700 hover:bg-sky-100"><Bot className="h-3.5 w-3.5" />交给 AI 设计</button>
                <button type="button" onClick={() => setShowApprovalPanel(false)} disabled={Boolean(approvalAction)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100" title="关闭"><X className="h-4 w-4" /></button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(260px,.8fr)]">
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5"><span className="text-xs font-semibold text-slate-600">流程名称</span><input value={approvalName} onChange={(event) => setApprovalName(event.target.value)} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-amber-300" /></label>
                    <label className="space-y-1.5"><span className="text-xs font-semibold text-slate-600">处理逻辑</span><div className="flex h-10 items-center rounded-lg border border-amber-200 bg-amber-50 px-3 text-xs font-semibold text-amber-800">通过才写入，驳回保留原值</div></label>
                  </div>
                  <label className="block space-y-1.5"><span className="text-xs font-semibold text-slate-600">说明</span><textarea value={approvalDescription} onChange={(event) => setApprovalDescription(event.target.value)} rows={2} className="w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-amber-300" /></label>

                  <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-sm font-semibold text-slate-800">审批步骤</div><div className="mt-0.5 text-xs text-slate-400">按顺序执行，可使用员工或部门。</div></div><button type="button" onClick={() => setApprovalSteps((current) => [...current, newApprovalStep(current.length)])} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" />添加步骤</button></div>
                  <div className="space-y-3">
                    {approvalSteps.map((step, stepIndex) => {
                      const principalCount = new Set([...step.user_ids, ...step.department_ids.map((id) => -id)]).size
                      return (
                        <section key={step.id} className="overflow-hidden rounded-lg border border-slate-200">
                          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2.5">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-100 text-xs font-bold text-amber-800">{stepIndex + 1}</span>
                            <input value={step.name} onChange={(event) => setApprovalSteps((current) => current.map((item) => item.id === step.id ? { ...item, name: event.target.value } : item))} className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 text-xs font-semibold outline-none focus:border-amber-300" />
                            <div className="ml-8 flex basis-[calc(100%-2rem)] items-center justify-end gap-2 sm:ml-0 sm:basis-auto">
                              <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-500">需通过<input type="number" min={1} max={Math.max(1, principalCount)} value={step.required_approvals} onChange={(event) => setApprovalSteps((current) => current.map((item) => item.id === step.id ? { ...item, required_approvals: Math.max(1, Number(event.target.value) || 1) } : item))} className="h-8 w-14 rounded-lg border border-slate-200 bg-white px-2 text-center text-xs outline-none" />人</label>
                              {approvalSteps.length > 1 && <button type="button" onClick={() => setApprovalSteps((current) => current.filter((item) => item.id !== step.id))} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600" title="删除步骤"><Trash2 className="h-3.5 w-3.5" /></button>}
                            </div>
                          </div>
                          <div className="grid gap-3 p-3 md:grid-cols-2">
                            <div><div className="mb-1.5 text-xs font-semibold text-slate-600">部门</div><div className="max-h-36 overflow-y-auto rounded-lg border border-slate-200">{protectionDepartments.length === 0 ? <div className="px-3 py-4 text-center text-xs text-slate-400">暂无部门</div> : protectionDepartments.map((department) => <label key={department.id} className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0 hover:bg-slate-50"><input type="checkbox" checked={step.department_ids.includes(department.id)} onChange={(event) => setApprovalSteps((current) => current.map((item) => item.id === step.id ? { ...item, department_ids: event.target.checked ? [...item.department_ids, department.id] : item.department_ids.filter((id) => id !== department.id) } : item))} className="h-4 w-4 rounded border-slate-300 text-amber-600" /><span className="min-w-0 flex-1 truncate">{department.name}</span><span className="text-[10px] text-slate-400">{department.member_count} 人</span></label>)}</div></div>
                            <div><div className="mb-1.5 text-xs font-semibold text-slate-600">员工</div><label className="relative mb-2 block"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" /><input type="search" value={approvalUserSearch} onChange={(event) => setApprovalUserSearch(event.target.value)} placeholder="搜索员工" className="h-8 w-full rounded-lg border border-slate-200 pl-8 pr-2 text-xs outline-none focus:border-amber-300" /></label><div className="max-h-36 overflow-y-auto rounded-lg border border-slate-200">{protectionUsersLoading ? <div className="px-3 py-4 text-center text-xs text-slate-400">正在加载员工...</div> : filteredApprovalUsers.map((user) => <label key={user.id} className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0 hover:bg-slate-50"><input type="checkbox" checked={step.user_ids.includes(user.id)} onChange={(event) => setApprovalSteps((current) => current.map((item) => item.id === step.id ? { ...item, user_ids: event.target.checked ? [...item.user_ids, user.id] : item.user_ids.filter((id) => id !== user.id) } : item))} className="h-4 w-4 rounded border-slate-300 text-amber-600" /><span className="min-w-0 flex-1 truncate">{user.username}</span></label>)}</div></div>
                          </div>
                        </section>
                      )
                    })}
                  </div>
                </div>

                <aside className="space-y-4">
                  <section className="overflow-hidden rounded-lg border border-slate-200"><div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-2.5"><span className="text-sm font-semibold text-slate-800">已配置流程</span><span className="text-xs text-slate-400">{approvalRules.length}</span></div><div className="max-h-56 overflow-y-auto">{approvalLoading ? <div className="px-3 py-6 text-center text-xs text-slate-400">正在加载...</div> : approvalRules.length === 0 ? <div className="px-3 py-6 text-center text-xs text-slate-400">当前工作表暂无审批流程</div> : approvalRules.map((rule) => <div key={rule.id} className="border-b border-slate-100 px-3 py-3 last:border-b-0"><div className="flex items-start gap-2"><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-slate-800">{rule.name}</div><div className="mt-1 text-[11px] leading-5 text-slate-400">{approvalRangeLabel(rule)}</div></div><span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${rule.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{rule.enabled ? '启用' : '停用'}</span>{(adminMode || rule.owner_id === profile?.id) && <button type="button" onClick={() => void handleDeleteApprovalRule(rule)} disabled={approvalAction === `delete:${rule.id}`} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-300 hover:bg-rose-50 hover:text-rose-600" title="删除流程"><Trash2 className="h-3.5 w-3.5" /></button>}</div></div>)}</div></section>
                  <section className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-2.5"><span className="text-sm font-semibold text-slate-800">单元格审批状态</span><span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">待审 {pendingApprovalStates.length}</span></div>
                    <div className="max-h-80 overflow-y-auto">
                      {approvalStates.length === 0 ? <div className="px-3 py-6 text-center text-xs text-slate-400">暂无审批记录</div> : approvalStates.slice(0, 80).map((item) => {
                        const relatedSummary = approvalRelatedSummary(item)
                        return <button key={item.id} type="button" onClick={() => focusApprovalState(item)} className="block w-full border-b border-slate-100 px-3 py-3 text-left last:border-b-0 hover:bg-slate-50"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-semibold text-slate-700">{item.field_labels?.[item.col] || columnLabelMap.get(item.col) || item.col}{item.row + 2} · {item.rule_name}</span><span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${item.status === 'pending' ? 'bg-amber-100 text-amber-800' : item.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : item.status === 'rejected' ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>{item.status === 'pending' ? '待审批' : item.status === 'approved' ? '已通过' : item.status === 'rejected' ? '已驳回' : '已结束'}</span></div><div className="mt-1 text-[11px] text-slate-400">{item.submitted_by_name} · {new Date(item.submitted_at).toLocaleString('zh-CN')}</div><div className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-5 text-amber-800"><span className="text-slate-500">原值：</span>{formatApprovalValue(item.original_value)}<span className="mx-1.5 text-amber-400">→</span><span className="text-slate-500">待审值：</span><strong>{formatApprovalValue(item.proposed_value)}</strong></div>{relatedSummary && <div className="mt-2 line-clamp-2 text-[11px] leading-5 text-slate-500">关联内容：{relatedSummary}</div>}</button>
                      })}
                    </div>
                  </section>
                </aside>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3"><div className="text-xs text-slate-400">审批人仍需拥有对应表格查看权限；正式写入会再次校验提交人的编辑权限。</div><div className="flex items-center gap-2"><button type="button" onClick={() => setShowApprovalPanel(false)} disabled={Boolean(approvalAction)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600">关闭</button><button type="button" onClick={() => void handleCreateApprovalFlow()} disabled={Boolean(approvalAction) || approvalSteps.length === 0} className="inline-flex h-9 items-center gap-2 rounded-lg bg-amber-600 px-4 text-sm font-semibold text-white disabled:opacity-50"><ClipboardCheck className="h-4 w-4" />{approvalAction === 'create' ? '正在创建...' : '应用审批到选区'}</button></div></div>
          </div>
        </div>
      )}

      {showNumberFormatPanel && (
        <div className="fixed inset-0 z-[88] flex items-center justify-center bg-slate-950/45 px-3 py-5" onMouseDown={(event) => { if (event.target === event.currentTarget && !applyingNumberFormat) setShowNumberFormatPanel(false) }}>
          <div className="flex max-h-[90vh] w-[min(680px,96vw)] flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Hash className="h-4 w-4 text-sky-600" />数字与单元格默认格式</div>
                <div className="mt-1 truncate text-xs text-slate-400">当前范围：{selectionState?.rangeLabel || '当前选区'}</div>
              </div>
              <button type="button" onClick={() => setShowNumberFormatPanel(false)} disabled={applyingNumberFormat} className="ui-tooltip inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40" title="关闭" aria-label="关闭数字格式设置" data-tooltip="关闭"><X className="h-4 w-4" /></button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
              <div>
                <div className="mb-2 text-xs font-semibold text-slate-700">应用范围</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {([
                    ['selection', '当前选区'],
                    ['row', '整行默认'],
                    ['column', '整列默认'],
                    ['sheet', '工作表默认'],
                  ] as Array<[NumberFormatScope, string]>).map(([scope, label]) => (
                    <button key={scope} type="button" onClick={() => setNumberFormatScope(scope)} className={`h-9 rounded-lg border px-2 text-xs font-semibold transition ${numberFormatScope === scope ? 'border-sky-300 bg-sky-50 text-sky-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>{label}</button>
                  ))}
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-400">整行、整列和工作表默认格式会同时作用于已有数据，并成为以后新输入单元格的默认格式。</p>
              </div>

              <div>
                <div className="mb-2 text-xs font-semibold text-slate-700">常用格式</div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {NUMBER_FORMAT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => { setNumberFormatPreset(preset.id); setCustomNumberFormat(preset.pattern) }}
                      className={`min-h-14 rounded-lg border px-3 py-2 text-left transition ${numberFormatPreset === preset.id ? 'border-sky-300 bg-sky-50 ring-1 ring-sky-100' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'}`}
                    >
                      <span className={`block text-xs font-semibold ${numberFormatPreset === preset.id ? 'text-sky-700' : 'text-slate-700'}`}>{preset.label}</span>
                      <span className="mt-1 block truncate text-[11px] text-slate-400">{preset.sample}</span>
                    </button>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-slate-700">自定义格式代码</span>
                <input value={customNumberFormat} onChange={(event) => { setCustomNumberFormat(event.target.value); setNumberFormatPreset('custom') }} onKeyDown={(event) => { if (event.key === 'Enter' && !applyingNumberFormat) void handleApplyNumberFormat() }} placeholder="例如：#,##0.00;[Red]-#,##0.00" className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 font-mono text-sm text-slate-700 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100" />
                <p className="mt-2 text-xs leading-5 text-slate-400">“常规”不会把普通数字显示为日期；文本使用 @；公式直接以 = 开头输入，例如 =SUM(A1:A10)。</p>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
              <button type="button" onClick={() => setShowNumberFormatPanel(false)} disabled={applyingNumberFormat} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40">取消</button>
              <button type="button" onClick={() => void handleApplyNumberFormat()} disabled={applyingNumberFormat || !customNumberFormat.trim()} className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-40">{applyingNumberFormat ? '应用中...' : '应用格式'}</button>
            </div>
          </div>
        </div>
      )}

      {showPdfExportPanel && (
        <div className="fixed inset-0 z-[88] flex items-center justify-center bg-slate-950/45 px-4 py-6">
          <div className="w-[min(560px,96vw)] overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900">
                <FileOutput className="h-4 w-4 text-sky-600" />
                <span>PDF 导出范围</span>
              </div>
              <button
                type="button"
                onClick={() => setShowPdfExportPanel(false)}
                className="ui-tooltip flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                title="关闭"
                aria-label="关闭 PDF 导出设置"
                data-tooltip="关闭"
                data-tooltip-side="left"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 p-4">
              <div className="grid grid-cols-3 gap-2">
                {([
                  ['current', '当前表'],
                  ['selected', '多张表'],
                  ['workbook', '整本工作簿'],
                ] as Array<[PDFExportScope, string]>).map(([scope, label]) => (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => setPdfExportScope(scope)}
                    className={`h-10 rounded-lg border px-3 text-sm font-medium transition ${
                      pdfExportScope === scope
                        ? 'border-sky-300 bg-sky-50 text-sky-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {pdfExportScope === 'current' && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
                  将导出当前工作表：<span className="font-semibold text-slate-900">{latestSheetRef.current.name || '工作表'}</span>
                </div>
              )}

              {pdfExportScope === 'selected' && (
                <div className="rounded-lg border border-slate-200">
                  <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-xs font-semibold text-slate-500">
                    <span>选择工作表</span>
                    <span>已选 {selectedPdfSheetIds.length}</span>
                  </div>
                  <div className="max-h-56 overflow-y-auto p-2">
                    {workbookSheetOptions.map((item) => (
                      <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-sm text-slate-700 transition hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={selectedPdfSheetIds.includes(item.id)}
                          onChange={() => togglePdfSheetSelection(item.id)}
                          className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                        />
                        <span className="truncate">{item.name || `工作表 #${item.id}`}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {pdfExportScope === 'workbook' && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-600">
                  将按当前工作簿顺序导出全部 {workbookSheetOptions.length} 张工作表。
                </div>
              )}

              <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs font-semibold text-slate-600">
                  <span>纸张大小</span>
                  <select value={pdfPaperSize} onChange={(event) => setPdfPaperSize(event.target.value as PDFPaperSize)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100">
                    <option value="a4">A4</option>
                    <option value="a3">A3</option>
                    <option value="letter">Letter</option>
                    <option value="legal">Legal</option>
                  </select>
                </label>
                <label className="space-y-1.5 text-xs font-semibold text-slate-600">
                  <span>页面方向</span>
                  <select value={pdfOrientation} onChange={(event) => setPdfOrientation(event.target.value as PDFOrientation)} className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100">
                    <option value="portrait">纵向</option>
                    <option value="landscape">横向</option>
                  </select>
                </label>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 sm:col-span-2">
                  <input type="checkbox" checked={pdfFitToWidth} onChange={(event) => setPdfFitToWidth(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-700">适应一页宽度</span>
                    <span className="mt-0.5 block text-xs leading-5 text-slate-500">自动缩小超宽表格，避免内容超出所选纸张；高度仍可分页。</span>
                  </span>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setShowPdfExportPanel(false)}
                  className="inline-flex h-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handlePreviewPdfExport()}
                  disabled={exportAction !== '' || (pdfExportScope === 'selected' && selectedPdfSheetIds.length === 0)}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <FileOutput className="h-4 w-4" />
                  生成预览
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pdfPreview && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/50 px-4 py-6">
          <div className="flex h-[min(900px,92vh)] w-[min(1120px,96vw)] flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
            <div className="flex min-h-16 items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <FileOutput className="h-4 w-4 text-sky-600" />
                  <span>PDF 预览</span>
                </div>
                <div className="mt-1 truncate text-xs text-slate-500" title={pdfPreview.filename}>
                  {pdfPreview.filename}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={handleDownloadPreviewPdf}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 text-sm font-medium text-sky-700 transition hover:bg-sky-100"
                >
                  <Download className="h-4 w-4" />
                  下载
                </button>
                <button
                  type="button"
                  onClick={closePdfPreview}
                  className="ui-tooltip flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
                  title="关闭"
                  aria-label="关闭 PDF 预览"
                  data-tooltip="关闭预览"
                  data-tooltip-side="left"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <iframe
              title="PDF 预览"
              src={pdfPreview.url}
              className="min-h-0 flex-1 bg-slate-100"
            />
          </div>
        </div>
      )}

      {showProtectionPanel && (() => {
        const recordGroups = buildFilteredProtectionRecordGroups()
        const accessOptions = (
          <>
            <option value="">不加入</option>
            <option value="readonly">只读</option>
            <option value="edit">可修改</option>
            <option value="view_hidden">可看原文/公式</option>
          </>
        )
        const modeCards: Array<{ key: string; checked: boolean; onChange: (value: boolean) => void; icon: typeof Lock; title: string; detail: string; tone: string }> = [
          { key: 'lock', checked: selectedProtectionLockEditing, onChange: setSelectedProtectionLockEditing, icon: Lock, title: '锁定编辑', detail: '没有“可修改”权限的人不能改动内容', tone: 'border-sky-300 bg-sky-50 text-sky-800' },
          { key: 'hidden', checked: selectedProtectionHidden, onChange: setSelectedProtectionHidden, icon: EyeOff, title: '数据遮罩', detail: '其他人只看到 ••••，行列也不能被删除', tone: 'border-slate-400 bg-slate-100 text-slate-800' },
          { key: 'formula', checked: selectedProtectionHideFormula, onChange: setSelectedProtectionHideFormula, icon: Sigma, title: '隐藏公式', detail: '其他人只看到计算结果，结果随数据实时更新', tone: 'border-violet-300 bg-violet-50 text-violet-800' },
        ]
        return (
          <div className="absolute inset-x-2 bottom-2 top-14 z-30 flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl sm:inset-x-auto sm:right-3 sm:w-[440px]">
            <div className="shrink-0 border-b border-slate-200 px-4 pb-0 pt-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Shield className="h-4 w-4 text-sky-600" />保护与遮罩</div>
                  <div className="mt-1 truncate text-xs text-slate-500" title={selectionState?.rangeLabel}>
                    {selectionState ? `当前选择：${selectionState.rangeLabel}` : '先在表格中框选单元格、整行或整列'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => setShowProtectionHighlights((current) => !current)} className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition ${showProtectionHighlights ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`} title={showProtectionHighlights ? '隐藏表格中的保护颜色' : '在表格中标出保护区域'}>
                    {showProtectionHighlights ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    标记
                  </button>
                  <button type="button" onClick={() => setShowProtectionPanel(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" aria-label="关闭保护设置">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex gap-4 text-xs font-semibold" role="tablist">
                {([
                  { value: 'settings', label: '设置保护' },
                  { value: 'records', label: `保护记录 ${allProtectionItems.length}` },
                ] as const).map((tab) => (
                  <button key={tab.value} type="button" role="tab" aria-selected={protectionPanelTab === tab.value} onClick={() => setProtectionPanelTab(tab.value)} className={`-mb-px border-b-2 pb-2 transition ${protectionPanelTab === tab.value ? 'border-sky-600 text-sky-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {protectionPanelTab === 'settings' ? (
              <>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                  {editLocked && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">当前账号只有查看权限，只能查看保护状态。</div>
                  )}
                  {protectionFocusNotice && (
                    <div className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800"><LocateFixed className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">{protectionFocusNotice}</span></div>
                  )}
                  {activeProtection && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600">
                      <div className="font-semibold text-slate-800">该位置已有保护 · {formatProtectionMode(activeProtection)}</div>
                      <div>设置人：{activeProtection.owner_name}　例外名单：{formatProtectionWhitelist(activeProtection)}</div>
                      <div className="text-slate-400">下面已载入现有设置，修改后点击“应用”即可更新。</div>
                    </div>
                  )}

                  <section>
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <h3 className="text-xs font-semibold text-slate-800">1. 保护范围</h3>
                      {selectionState && <span className="text-[11px] text-slate-500">将应用到 <b className="text-slate-700">{protectionTargetLabel}</b></span>}
                    </div>
                    <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
                      {([
                        { value: 'cell', label: '所选单元格', icon: Square },
                        { value: 'row', label: '整行', icon: Rows3 },
                        { value: 'column', label: '整列', icon: Columns3 },
                      ] as Array<{ value: ProtectionScope; label: string; icon: typeof Square }>).map(({ value, label, icon: Icon }) => {
                        const forced = (selectionState?.isEntireColumnSelection && value !== 'column') || (selectionState?.isEntireRowSelection && value !== 'row')
                        return (
                          <button key={value} type="button" onClick={() => selectProtectionScope(value)} disabled={Boolean(forced)} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${effectiveProtectionScope === value ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                            <Icon className="h-3.5 w-3.5" />{label}
                          </button>
                        )
                      })}
                    </div>
                    {(selectionState?.isEntireColumnSelection || selectionState?.isEntireRowSelection) && (
                      <p className="mt-1.5 text-[11px] text-sky-700">已通过{selectionState.isEntireColumnSelection ? '列' : '行'}标题选择，按整{selectionState.isEntireColumnSelection ? '列' : '行'}保护，新增的{selectionState.isEntireColumnSelection ? '行' : '列'}也会自动受保护。</p>
                    )}
                    {protectionBatchLarge && (
                      <p className={`mt-1.5 rounded-md px-2 py-1.5 text-[11px] leading-5 ${protectionBatchTooLarge ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800'}`}>
                        {protectionBatchTooLarge ? '所选单元格超过 5000 个，无法逐个保护。' : '所选单元格较多，'}建议改用「整列」或「整行」：设置更快，表格打开也更流畅。
                      </p>
                    )}
                  </section>

                  <section>
                    <h3 className="mb-2 text-xs font-semibold text-slate-800">2. 保护方式 <span className="font-normal text-slate-400">可多选</span></h3>
                    <div className="space-y-1.5">
                      {modeCards.map(({ key, checked, onChange, icon: Icon, title, detail, tone }) => (
                        <label key={key} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition ${checked ? tone : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'} ${editLocked ? 'cursor-not-allowed opacity-60' : ''}`}>
                          <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={editLocked} className="h-4 w-4 shrink-0 rounded border-slate-300" />
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-semibold">{title}</span>
                            <span className="block text-[11px] leading-4 opacity-75">{detail}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-4 text-slate-400">管理员和设置人始终能看到原文与公式。受保护的行列不能被删除、排序或移位。</p>
                  </section>

                  <section>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-slate-800">3. 例外名单 <span className="font-normal text-slate-400">{selectedProtectionPrincipalCount > 0 ? `已选 ${selectedProtectionPrincipalCount}` : '默认仅设置人和管理员'}</span></h3>
                      {selectedProtectionPrincipalCount > 0 && (
                        <button type="button" onClick={clearProtectionWhitelist} disabled={editLocked} className="text-[11px] font-medium text-slate-500 hover:text-slate-700 disabled:opacity-40">清空</button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input type="search" value={protectionUserSearch} onChange={(event) => setProtectionUserSearch(event.target.value)} placeholder="搜索部门、姓名或邮箱" className="h-8 w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-2 text-xs text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100" />
                      </label>
                      <div className="flex shrink-0 rounded-lg bg-slate-100 p-0.5 text-[11px] font-medium">
                        {([['all', '全部'], ['department', '部门'], ['user', '员工']] as const).map(([value, label]) => (
                          <button key={value} type="button" onClick={() => setProtectionWhitelistFilter(value)} className={`rounded-md px-2 py-1 transition ${protectionWhitelistFilter === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500'}`}>{label}</button>
                        ))}
                      </div>
                    </div>
                    <div className="mt-2 max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                      {protectionUsersLoading ? (
                        <div className="px-3 py-5 text-center text-xs text-slate-400">正在加载成员...</div>
                      ) : protectionUsersError ? (
                        <div className="flex items-center justify-between gap-3 bg-rose-50 px-3 py-2 text-xs text-rose-700"><span>{protectionUsersError}</span><button type="button" onClick={() => { setProtectionDirectoryLoaded(false); setProtectionUsersLoadToken((current) => current + 1) }} className="shrink-0 font-semibold hover:underline">重试</button></div>
                      ) : whitelistDepartments.length === 0 && whitelistUsers.length === 0 ? (
                        <div className="px-3 py-5 text-center text-xs text-slate-400">{protectionUsers.length === 0 && protectionDepartments.length === 0 ? '暂无可选成员，请先创建员工账号。' : '没有匹配的部门或员工'}</div>
                      ) : (
                        <>
                          {whitelistDepartments.map((department) => (
                            <div key={`department-${department.id}`} className="flex items-center gap-2.5 px-3 py-1.5">
                              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sky-50 text-sky-700"><Building2 className="h-3.5 w-3.5" /></div>
                              <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-slate-700">{department.name}</div><div className="text-[10px] text-slate-400">部门 · {department.member_count} 人</div></div>
                              <select aria-label={`设置部门 ${department.name} 的例外权限`} value={getProtectionDepartmentAccess(department.id)} onChange={(event) => setProtectionDepartmentAccess(department.id, event.target.value as ProtectionWhitelistAccess | '')} disabled={editLocked} className={`h-7 w-[7.5rem] rounded-md border px-1.5 text-[11px] outline-none focus:border-sky-300 ${getProtectionDepartmentAccess(department.id) ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-slate-200 bg-white text-slate-500'}`}>{accessOptions}</select>
                            </div>
                          ))}
                          {whitelistUsers.map((user) => (
                            <div key={`user-${user.id}`} className="flex items-center gap-2.5 px-3 py-1.5">
                              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[10px] font-semibold text-slate-600">{user.username.slice(0, 2).toUpperCase()}</div>
                              <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-slate-700">{user.username}</div><div className="truncate text-[10px] text-slate-400">{user.email}</div></div>
                              <select aria-label={`设置员工 ${user.username} 的例外权限`} value={getProtectionUserAccess(user.id)} onChange={(event) => setProtectionUserAccess(user.id, event.target.value as ProtectionWhitelistAccess | '')} disabled={editLocked} className={`h-7 w-[7.5rem] rounded-md border px-1.5 text-[11px] outline-none focus:border-sky-300 ${getProtectionUserAccess(user.id) ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-slate-200 bg-white text-slate-500'}`}>{accessOptions}</select>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                    <p className="mt-1.5 text-[11px] leading-4 text-slate-400">可修改：能编辑并看原文；可看原文/公式：只看不改；只读：不能修改。个人设置优先于部门。</p>
                  </section>
                </div>

                <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-4 py-3">
                  {protectionApplyBlockedReason && selectionState && (
                    <div className="mb-2 text-[11px] font-medium text-amber-700">{protectionApplyBlockedReason}</div>
                  )}
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void handleProtectionRangeChange(protectionScope, 'lock', selectedProtectionHidden)} disabled={Boolean(protectionApplyBlockedReason) || protectionAction === `${protectionScope}:bulk:lock`} title={protectionApplyBlockedReason || undefined} className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-sky-600 px-3 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50">
                      <Shield className="h-4 w-4" />{protectionAction === `${protectionScope}:bulk:lock` ? '正在应用...' : activeProtection ? '更新保护' : '应用保护'}
                    </button>
                    <button type="button" onClick={() => void handleProtectionRangeChange(protectionScope, 'unlock')} disabled={protectionReleaseBlocked || protectionAction === `${protectionScope}:bulk:unlock`} title={protectionReleaseBlocked ? (activeProtection ? '只有设置人或管理员可以解除' : '所选位置没有保护') : '解除所选范围的保护'} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50">
                      <Unlock className="h-4 w-4" />解除
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                  {([
                    ['all', `全部 ${allProtectionItems.length}`],
                    ['hidden', `遮罩 ${allProtectionItems.filter((item) => item.hidden).length}`],
                    ['formula', `隐藏公式 ${allProtectionItems.filter((item) => item.hide_formula).length}`],
                    ['lock', `锁定 ${allProtectionItems.filter((item) => item.lock_editing).length}`],
                  ] as const).map(([value, label]) => (
                    <button key={value} type="button" onClick={() => setProtectionRecordFilter(value)} className={`rounded-full border px-2.5 py-1 transition ${protectionRecordFilter === value ? 'border-sky-300 bg-sky-50 text-sky-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>{label}</button>
                  ))}
                </div>
                {protectionLoading ? (
                  <div className="py-8 text-center text-xs text-slate-400">正在加载...</div>
                ) : recordGroups.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-400">{allProtectionItems.length === 0 ? '当前工作表还没有保护。' : '没有符合筛选条件的保护。'}</div>
                ) : (
                  <div className="space-y-3 text-xs">
                    {recordGroups.map((group) => {
                      const visual = visualForUser(group.ownerId)
                      return (
                        <section key={group.ownerId} className="overflow-hidden rounded-lg border border-slate-200">
                          <div className="flex items-center justify-between px-3 py-2" style={{ backgroundColor: visual.soft }}>
                            <span className="flex min-w-0 items-center gap-2 font-semibold" style={{ color: visual.stroke }}><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: visual.stroke }} />{group.ownerName}</span>
                            <span className="shrink-0 text-[10px]" style={{ color: visual.stroke }}>{group.items.length} 处</span>
                          </div>
                          <div className="divide-y divide-slate-100 bg-white">
                            {(showAllProtections ? group.items : group.items.slice(0, 50)).map((item, index) => (
                              <button key={`${item.scope}-${item.key}-${index}`} type="button" onClick={() => focusProtection(item)} className="block w-full px-3 py-2 text-left transition hover:bg-slate-50" title="点击在表格中定位">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex min-w-0 items-center gap-1.5 font-semibold text-slate-700">
                                    {item.scope === 'row' ? <Rows3 className="h-3.5 w-3.5 shrink-0" style={{ color: visual.stroke }} /> : item.scope === 'column' ? <Columns3 className="h-3.5 w-3.5 shrink-0" style={{ color: visual.stroke }} /> : <Square className="h-3.5 w-3.5 shrink-0" style={{ color: visual.stroke }} />}
                                    <span className="truncate">{formatProtectionTarget(item)}</span>
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1">
                                    {item.hidden && <span className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"><EyeOff className="h-3 w-3" />遮罩</span>}
                                    {item.hide_formula && <span className="inline-flex items-center gap-0.5 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] text-violet-700"><Sigma className="h-3 w-3" />公式</span>}
                                    {item.lock_editing && <span className="inline-flex items-center gap-0.5 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700"><Lock className="h-3 w-3" />锁定</span>}
                                  </div>
                                </div>
                                <div className="mt-0.5 truncate text-[11px] text-slate-500">例外：{formatProtectionWhitelist(item)} · {new Date(item.protected_at).toLocaleDateString('zh-CN')}</div>
                              </button>
                            ))}
                            {!showAllProtections && group.items.length > 50 && (
                              <button type="button" onClick={() => setShowAllProtections(true)} className="block w-full px-3 py-2 text-center text-[11px] font-medium text-sky-700 hover:bg-sky-50">显示全部 {group.items.length} 处</button>
                            )}
                          </div>
                        </section>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })()}

      {/* Save status toast */}
      {saveStatus === 'saved' && (
        <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg">
          已保存
        </div>
      )}

      {approvalNotice && (
        <div className="absolute left-1/2 top-14 z-20 max-w-[min(90%,36rem)] -translate-x-1/2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs font-semibold text-amber-800 shadow-lg">
          {approvalNotice}
        </div>
      )}

      {plainTextActionNotice && (
        <div
          data-plain-text-action-notice="true"
          className="absolute bottom-24 left-1/2 z-[24] -translate-x-1/2 rounded-full bg-slate-800/95 px-4 py-1.5 text-xs font-semibold text-white shadow-lg"
        >
          {plainTextActionNotice}
        </div>
      )}

      {plainTextNotice && (
        <div
          data-plain-text-notice="true"
          className="absolute bottom-24 left-1/2 z-[23] flex w-[min(32rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl border border-amber-200 bg-white/95 px-3 py-2 shadow-xl backdrop-blur"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1 text-[11px] leading-4">
            <span className="font-semibold text-slate-800">本次粘贴的 {plainTextNotice.markers.length} 个单元格不是纯文本结构</span>
            <span className="ml-1 text-slate-400">
              （{plainTextNotice.truncated ? '已检查部分区域，' : '当前工作表'}共 {plainTextNotice.total} 处）
            </span>
          </div>
          <button
            type="button"
            data-plain-text-convert-all="true"
            onClick={() => convertPlainTextMarkers(plainTextMarkersRef.current)}
            className="shrink-0 rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-amber-600"
          >
            全部转为纯文本
          </button>
          <button
            type="button"
            onClick={() => setPlainTextNotice(null)}
            className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100"
          >
            知道了
          </button>
        </div>
      )}

      {actionError && (
        <div role="alert" className="absolute left-1/2 top-14 z-30 flex max-w-[min(92vw,36rem)] -translate-x-1/2 items-start gap-2 rounded-xl bg-rose-600 py-2 pl-4 pr-2 text-xs font-semibold leading-5 text-white shadow-lg">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{actionError}</span>
          <button type="button" onClick={() => setActionError('')} aria-label="关闭提示" className="shrink-0 rounded-md p-0.5 text-white/80 hover:bg-white/15 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {currentApprovalStates.length > 0 && (
        <div className={`pointer-events-none absolute left-3 z-20 flex max-w-[65%] flex-wrap gap-2 [&_button]:pointer-events-auto ${(currentProtectionItems.length > 0 || showSelectionRestriction) ? 'top-[5.5rem]' : 'top-12'}`}>
          {currentApprovalStates.map((item) => (
            <button key={`approval-${item.id}`} type="button" onClick={() => focusApprovalState(item)} className={`inline-flex items-center gap-1.5 rounded-lg border bg-white/95 px-2.5 py-1 text-[11px] font-semibold shadow-sm ${item.status === 'pending' ? 'border-amber-300 text-amber-800' : item.status === 'approved' ? 'border-emerald-300 text-emerald-700' : 'border-rose-300 text-rose-700'}`} title={item.status === 'pending' ? `原值：${formatApprovalValue(item.original_value)} → 待审值：${formatApprovalValue(item.proposed_value)}` : item.rule_name}>
              <ClipboardCheck className="h-3 w-3" />
              {item.status === 'pending' ? '正在审批' : item.status === 'approved' ? '审批已通过' : '审批未通过'} · {item.submitted_by_name}
            </button>
          ))}
        </div>
      )}

      {(currentProtectionItems.length > 0 || showSelectionRestriction) && (
        <div className="pointer-events-none absolute left-3 top-12 z-20 flex max-w-[60%] flex-wrap gap-2 [&_button]:pointer-events-auto">
            {showSelectionRestriction && (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white/95 px-2.5 py-1 text-[11px] font-semibold text-slate-700 shadow-sm" title={selectedCellMasked && selectedCellCannotEdit ? '当前单元格内容已遮罩，且当前账号没有修改权限' : selectedCellMasked ? '当前单元格内容已遮罩' : '当前账号不能修改此单元格'}>
                {selectedCellMasked && <EyeOff className="h-3 w-3" />}
                {selectedCellMasked && <span>内容已遮罩</span>}
                {selectedCellFormulaHidden && !selectedCellMasked && <Sigma className="h-3 w-3" />}
                {selectedCellFormulaHidden && !selectedCellMasked && <span>公式已隐藏</span>}
                {(selectedCellMasked || selectedCellFormulaHidden) && selectedCellCannotEdit && <span className="text-slate-300">·</span>}
                {selectedCellCannotEdit && <Lock className="h-3 w-3" />}
                {selectedCellCannotEdit && <span>不可修改</span>}
              </span>
            )}
            {currentProtectionItems.map((item) => {
                const visual = item.hidden ? HIDDEN_PROTECTION_VISUAL : visualForUser(item.owner_id)
                return <button type="button" key={`${item.scope}-${item.key}`} onClick={() => focusProtection(item)} className="inline-flex items-center gap-1.5 rounded-lg border bg-white/95 px-2.5 py-1 text-[11px] font-semibold shadow-sm" style={{ borderColor: visual.stroke, color: visual.stroke }} title={`点击定位：${formatProtectionMode(item)}`}>{item.hidden ? <EyeOff className="h-3 w-3" /> : item.hide_formula ? <Sigma className="h-3 w-3" /> : <Lock className="h-3 w-3" />}{formatProtectionBadge(item)}</button>
              })}
          </div>
      )}

      {/* Image picker modal */}
      {showImagePicker && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowImagePicker(false)}
        >
          <div
            className="relative w-full max-w-2xl max-h-[80%] flex flex-col rounded-2xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-900">选择图片插入到当前单元格</h3>
              <div className="flex items-center gap-2">
                <label className="cursor-pointer inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                  <ImagePlus className="h-3.5 w-3.5" />
                  上传新图片
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleDirectUpload}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setShowImagePicker(false)}
                  className="ui-tooltip flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  title="关闭图片选择"
                  aria-label="关闭图片选择"
                  data-tooltip="关闭"
                  data-tooltip-side="left"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <label className="mx-4 mt-3 flex cursor-pointer items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
              <input type="checkbox" checked={lockInsertedImageCell} onChange={(event) => setLockInsertedImageCell(event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700"><Lock className="h-3.5 w-3.5" />插入后锁定所在单元格</span>
                <span className="mt-0.5 block text-[11px] leading-5 text-slate-500">防止图片被移动、覆盖或删除；可在保护设置中解除。</span>
              </span>
            </label>

            {/* Gallery grid */}
            <div className="flex-1 overflow-y-auto p-4">
              {loadingGallery ? (
                <div className="flex h-40 items-center justify-center text-sm text-slate-500">
                  正在加载图库...
                </div>
              ) : galleryImages.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center text-center">
                  <ImagePlus className="mb-2 h-8 w-8 text-slate-300" />
                  <p className="text-sm text-slate-500">还没有图片，请先上传。</p>
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-3">
                  {galleryImages.map((img) => (
                    <button
                      key={img.id}
                      type="button"
                      onClick={() => insertImageToCell(img)}
                      className="group relative aspect-square overflow-hidden rounded-xl border border-slate-200 bg-slate-50 transition hover:border-sky-400 hover:ring-2 hover:ring-sky-100"
                    >
                      <img
                        src={img.thumbnail_url || imageThumbnailUrl(img.url, 320)}
                        alt={img.filename}
                        className="h-full w-full object-cover"
                        loading="lazy"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition group-hover:opacity-100">
                        <p className="truncate text-[10px] text-white">{img.filename}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center bg-white/90 backdrop-blur-sm" style={{ position: 'absolute', inset: 0, zIndex: 10 }}>
          <div className="text-center">
            <div className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-sky-600">Univer</div>
            <div className="text-lg font-semibold text-slate-900">正在启动电子表格引擎...</div>
          </div>
        </div>
      )}
    </div>
  )
}
