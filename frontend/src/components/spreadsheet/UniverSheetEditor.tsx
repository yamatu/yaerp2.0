'use client'

import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { AlertCircle, ChevronDown, ChevronUp, Columns3, Download, Eye, EyeOff, FileOutput, FileSpreadsheet, Files, Filter, FilterX, ImagePlus, LocateFixed, Lock, Printer, Rows3, Save, Search, Shield, Square, Unlock, UserRoundCheck, Users, Wrench, X } from 'lucide-react'
import type { ICellData, IWorkbookData, IWorksheetData } from '@univerjs/core'
import { createUniver, defaultTheme, LocaleType } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import UniverPresetSheetsFilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import UniverPresetSheetsFindReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN'
import UniverSheetsDrawingZhCN from '@univerjs/sheets-drawing-ui/locale/zh-CN'
import { CellAlertType, SetScrollRelativeCommand, SetZoomRatioCommand } from '@univerjs/sheets-ui'
import api from '@/lib/api'
import { usePermission } from '@/hooks/usePermission'
import { getStoredUser, isAdmin } from '@/lib/auth'
import { buildUniverWorkbookData, deriveColumnsFromUniverSheet } from '@/lib/univer-sheet'
import { wsClient } from '@/lib/ws'
import { getRealtimeClientId } from '@/lib/realtimeClient'
import { subscribeDataChanged, subscribePrepareDataMutation } from '@/lib/dataEvents'
import { columnIndexToLetter, parseSheetConfig } from '@/lib/spreadsheet'
import ImportXlsxButton, { uploadWorkbookXlsx } from '@/components/spreadsheet/ImportXlsxButton'
import type { AuthUser, CellUpdate, ColumnDef, Department, ProtectionInfo, ProtectionSnapshot, Row, Sheet, SheetPresenceEntry, User } from '@/types'

interface Props {
  workbookId: string | number
  workbookName?: string
  workbookSheets?: Array<Pick<Sheet, 'id' | 'name'>>
  sheet: Sheet
  reloadToken?: string
  onExternalReload?: () => Promise<void> | void
  optimisticCanEdit?: boolean
  canImportWorkbook?: boolean
}

interface GalleryImage {
  id: number
  filename: string
  url: string
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

function FloatingToolHint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="group relative">
      <span className="pointer-events-none absolute right-12 top-1/2 z-10 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-within:opacity-100">
        {label}
      </span>
      {children}
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
  fill: 'rgba(71, 85, 105, 0.12)',
  soft: '#e2e8f0',
}

function visualForUser(userId: number) {
  const safeId = Number.isFinite(userId) ? Math.abs(userId) : 0
  return PROTECTION_VISUALS[safeId % PROTECTION_VISUALS.length]
}

function protectionVisualKey(item: Pick<ProtectionInfo, 'owner_id' | 'hidden'>) {
  return item.hidden ? 'hidden' : `owner:${item.owner_id}`
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
    if (row < 1 || row >= maxRows || column === undefined || column < 0 || column >= maxColumns) return
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
  const rowStart = Math.max(0, visibleRange.startRow - 12)
  const rowEnd = Math.min(maxRows - 1, visibleRange.endRow + 12)
  const columnStart = Math.max(0, visibleRange.startColumn - 4)
  const columnEnd = Math.min(maxColumns - 1, visibleRange.endColumn + 4)
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
    getLargestVisibleElement(root, '.univer-render-canvas') ||
    getLargestVisibleElement(root, '.univer-sheet-container') ||
    root
  const rect = viewport.getBoundingClientRect()
  const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left))
  const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top))

  return { x, y }
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
  const sheetKey = worksheetSnapshot.id || `sheet-${sheet.id}`
  return {
    id: `workbook-${workbookId}-sheet-${sheet.id}`,
    name: sheet.name || 'Workbook',
    appVersion: '0.5.0',
    locale,
    styles: cloneJsonSnapshot((savedStyles || {}) as IWorkbookData['styles']),
    sheetOrder: [sheetKey],
    sheets: {
      [sheetKey]: {
        ...worksheetSnapshot,
        id: sheetKey,
        name: sheet.name || worksheetSnapshot.name || 'Sheet1',
      },
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
    return base || {}
  }

  return {
    ...(base || {}),
    ...next,
  }
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

    const previousValue = getUniverPatchCellValue(getWorksheetCell(previousSheet, worksheetRow, columnIndex))
    const nextValue = getUniverPatchCellValue(getWorksheetCell(nextSheet, worksheetRow, columnIndex))
    if (areJsonSnapshotsEqual(previousValue, nextValue)) return

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
      const hadPreviousStyle = Boolean(previousCell && typeof previousCell === 'object' && (previousCell as { s?: unknown }).s)
      if (!style && !hadPreviousStyle) return
      const nextCell = cloneJsonSnapshot(rawCell as ICellData)
      if (style) nextCell.s = style
      else delete nextCell.s
      sheetFacade.getRange(rowIndex, columnIndex, 1, 1).setValue(nextCell)
      applied += 1
    })
  })

  const rowData = snapshot.rowData as Record<string, { h?: unknown } | undefined> | undefined
  Object.entries(rowData || {}).forEach(([rowKey, row]) => {
    const rowIndex = Number(rowKey)
    if (Number.isInteger(rowIndex) && rowIndex >= 0 && typeof row?.h === 'number') {
      sheetFacade.setRowHeight(rowIndex, row.h)
    }
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

function getVisibleUniverCellEditor(root: HTMLElement | null) {
  const editor = root?.querySelector<HTMLElement>('.univer-editor-container')
  if (!editor) return null

  const rect = editor.getBoundingClientRect()
  if (rect.width <= 4 || rect.height <= 4) return null
  if (rect.right < 0 || rect.bottom < 0 || rect.left > window.innerWidth || rect.top > window.innerHeight) return null

  return editor
}

export default function UniverSheetEditor({ workbookId, workbookName, workbookSheets = [], sheet, reloadToken, onExternalReload, optimisticCanEdit = false, canImportWorkbook = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistInFlightRef = useRef<Promise<void> | null>(null)
  const persistQueuedRef = useRef(false)
  const latestSheetRef = useRef(sheet)
  const univerApiRef = useRef<ReturnType<typeof createUniver> | null>(null)
  const workbookApiRef = useRef<{ setEditable: (editable: boolean) => void } | null>(null)
  const persistRef = useRef<(() => Promise<void>) | null>(null)
  const reloadTokenRef = useRef(reloadToken)
  const pdfPreviewUrlRef = useRef<string | null>(null)
  const applyingRemotePatchRef = useRef(false)
  const remotePatchResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const silentSyncInFlightRef = useRef<Promise<void> | null>(null)
  const silentSyncQueuedRef = useRef(false)
  const persistedWorksheetDataRef = useRef<Partial<IWorksheetData> | null>(null)
  const protectionHighlightDisposablesRef = useRef<UniverDisposable[]>([])
  const presenceDisposablesRef = useRef<UniverDisposable[]>([])
  const protectionFocusDisposableRef = useRef<UniverDisposable | null>(null)
  const protectionFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const protectionHighlightRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const protectionHighlightRenderFrameRef = useRef<number | null>(null)
  const protectionHighlightRenderGenerationRef = useRef(0)
  const protectionHighlightRendererRef = useRef<() => void>(() => undefined)
  const protectionSnapshotRef = useRef<ProtectionSnapshot>({ rows: [], columns: [], cells: [] })
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showImagePicker, setShowImagePicker] = useState(false)
  const [lockInsertedImageCell, setLockInsertedImageCell] = useState(true)
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([])
  const [loadingGallery, setLoadingGallery] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [univerHasOverlay, setUniverHasOverlay] = useState(false)
  const [univerSidebarOpen, setUniverSidebarOpen] = useState(false)
  const [toolbarExpanded, setToolbarExpanded] = useState(false)
  const [hasFilter, setHasFilter] = useState(false)
  const [actionError, setActionError] = useState('')
  const [dragImportActive, setDragImportActive] = useState(false)
  const [dragImportUploading, setDragImportUploading] = useState(false)
  const [dragImportProgress, setDragImportProgress] = useState(0)
  const dragDepthRef = useRef(0)
  const [showProtectionPanel, setShowProtectionPanel] = useState(false)
  const [showAllProtections, setShowAllProtections] = useState(false)
  const [selectionState, setSelectionState] = useState<SelectionState | null>(null)
  const [protectionSnapshot, setProtectionSnapshot] = useState<ProtectionSnapshot>({ rows: [], columns: [], cells: [] })
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
  const [selectedProtectionHidden, setSelectedProtectionHidden] = useState(false)
  const [selectedProtectionReadonlyUserIds, setSelectedProtectionReadonlyUserIds] = useState<number[]>([])
  const [selectedProtectionReadonlyDepartmentIds, setSelectedProtectionReadonlyDepartmentIds] = useState<number[]>([])
  const [selectedProtectionEditableUserIds, setSelectedProtectionEditableUserIds] = useState<number[]>([])
  const [selectedProtectionEditableDepartmentIds, setSelectedProtectionEditableDepartmentIds] = useState<number[]>([])
  const [selectedProtectionViewHiddenUserIds, setSelectedProtectionViewHiddenUserIds] = useState<number[]>([])
  const [selectedProtectionViewHiddenDepartmentIds, setSelectedProtectionViewHiddenDepartmentIds] = useState<number[]>([])
  const [showProtectionHighlights, setShowProtectionHighlights] = useState(false)
  const [protectionFocusNotice, setProtectionFocusNotice] = useState('')
  const [sheetPresence, setSheetPresence] = useState<SheetPresenceEntry[]>([])
  const [presenceExpanded, setPresenceExpanded] = useState(false)
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
  const { permissions, loading: permissionLoading } = usePermission(sheetId)
  const canViewSheet = permissions?.sheet.canView ?? false
  const canEditSheet = permissions?.sheet.canEdit ?? false
  const canExportSheet = permissions?.sheet.canExport ?? false
  const hasPermissionSnapshot = permissions !== null
  const effectiveCanViewSheet = hasPermissionSnapshot ? canViewSheet : true
  const effectiveCanEditSheet = hasPermissionSnapshot ? canEditSheet : optimisticCanEdit
  const effectiveCanExportSheet = hasPermissionSnapshot ? canExportSheet : optimisticCanEdit
  const canInitializeEditor = optimisticCanEdit || !permissionLoading
  const editLocked = !effectiveCanEditSheet
  const activeSheetConfig = parseSheetConfig(sheet.config)
  const importSource = activeSheetConfig.importSource
  const originalWorkbookXlsxAvailable = Boolean(importSource?.attachment_id)
  const originalWorkbookXlsxFilename = typeof importSource?.filename === 'string' ? importSource.filename : ''
  const workbookSheetOptions = workbookSheets.length > 0 ? workbookSheets : [{ id: sheet.id, name: sheet.name }]
  const workbookExportName = workbookName || '工作簿'

  const commitActiveCellEditor = useCallback(() => {
    const root = containerRef.current
    if (!getVisibleUniverCellEditor(root)) return false

    const confirmButton = root?.querySelector<HTMLElement>('.univer-formula-icon .univer-icon-container-success')
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
        setSelectionState(null)
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
        setSelectionState(null)
        return null
      }

      const rawStartRow = Math.max(range.getRow(), 0)
      const rawEndRow = Math.max(range.getLastRow(), 0)
      const includesHeaderRow = rawStartRow === 0 || rawEndRow === 0
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
      }

      setSelectionState(nextSelection)
      return nextSelection
    } catch {
      setSelectionState(null)
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

  const clearProtectionHighlights = useCallback(() => {
    protectionHighlightRenderGenerationRef.current += 1
    if (protectionHighlightRenderFrameRef.current !== null) {
      window.cancelAnimationFrame(protectionHighlightRenderFrameRef.current)
      protectionHighlightRenderFrameRef.current = null
    }
    protectionHighlightDisposablesRef.current.forEach((item) => item.dispose())
    protectionHighlightDisposablesRef.current = []
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
    setProtectionFocusNotice(`${item.owner_name}${item.hidden ? ' 隐藏并保护了 ' : ' 保护了 '}${item.scope === 'row' ? `第 ${(item.row_index ?? 0) + 2} 行` : item.scope === 'column' ? `列 ${item.column_key || item.key}` : `${item.column_key || item.key}${(item.row_index ?? 0) + 2}`}`)
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

    const generation = protectionHighlightRenderGenerationRef.current
    let blockIndex = 0
    const renderChunk = () => {
      if (generation !== protectionHighlightRenderGenerationRef.current || !showProtectionHighlightsRef.current) return
      protectionHighlightRenderFrameRef.current = null
      const frameStartedAt = performance.now()
      let renderedInFrame = 0
      while (blockIndex < renderBlocks.length && renderedInFrame < 48 && performance.now() - frameStartedAt < 8) {
        const block = renderBlocks[blockIndex]
        blockIndex += 1
        renderedInFrame += 1
        try {
          const visual = block.hidden ? HIDDEN_PROTECTION_VISUAL : visualForUser(block.ownerId)
          const range = worksheet.getRange(
            block.startRow,
            block.startColumn,
            block.endRow - block.startRow + 1,
            block.endColumn - block.startColumn + 1
          )
          protectionHighlightDisposablesRef.current.push(range.highlight({
            stroke: visual.stroke,
            strokeWidth: block.scope === 'cell' ? 2 : 1.25,
            strokeDash: block.scope === 'cell' ? 0 : 4,
            fill: visual.fill,
            rowHeaderFill: block.scope === 'row' ? visual.fill : undefined,
            rowHeaderStroke: block.scope === 'row' ? visual.stroke : undefined,
            columnHeaderFill: block.scope === 'column' ? visual.fill : undefined,
            columnHeaderStroke: block.scope === 'column' ? visual.stroke : undefined,
          }))
        } catch (highlightError) {
          console.error('Failed to highlight protected range:', highlightError)
        }
      }
      if (blockIndex < renderBlocks.length) {
        protectionHighlightRenderFrameRef.current = window.requestAnimationFrame(renderChunk)
      }
    }
    renderChunk()
  }, [clearProtectionHighlights])
  protectionHighlightRendererRef.current = renderProtectionHighlights

  useEffect(() => {
    protectionSnapshotRef.current = protectionSnapshot
    showProtectionHighlightsRef.current = showProtectionHighlights
    protectionHighlightsLoadingRef.current = loading
    if (!showProtectionHighlights || loading) {
      if (protectionHighlightRefreshTimerRef.current) {
        clearTimeout(protectionHighlightRefreshTimerRef.current)
        protectionHighlightRefreshTimerRef.current = null
      }
      clearProtectionHighlights()
      return
    }
    requestProtectionHighlightRefresh()
  }, [clearProtectionHighlights, loading, protectionSnapshot, requestProtectionHighlightRefresh, showProtectionHighlights])

  useEffect(() => {
    if (!showProtectionHighlights) return
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
  }, [requestProtectionHighlightRefresh, showProtectionHighlights])

  useEffect(() => {
    clearPresenceVisuals()
    if (loading) return
    const currentClientId = getRealtimeClientId()
    const columns = latestSheetRef.current.columns || []
    const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
    const worksheet = workbook?.getActiveSheet?.()
    if (!worksheet) return

    sheetPresence.forEach((entry) => {
      if (entry.clientId === currentClientId || entry.state === 'viewing' || typeof entry.row !== 'number' || !entry.col) return
      const columnIndex = columns.findIndex((column) => column.key === entry.col)
      if (columnIndex < 0) return
      const visual = visualForUser(entry.userId)
      try {
        const range = worksheet.getRange(entry.row + 1, columnIndex, 1, 1)
        presenceDisposablesRef.current.push(range.highlight({
          stroke: visual.stroke,
          strokeWidth: entry.state === 'editing' ? 3 : 2,
          strokeDash: entry.state === 'editing' ? 0 : 5,
          isAnimationDash: entry.state !== 'editing',
          fill: entry.state === 'editing' ? visual.fill : 'rgba(255, 255, 255, 0.01)',
        }))
        presenceDisposablesRef.current.push(range.attachAlertPopup({
          key: `yaerp-presence-${sheetId}-${entry.clientId || entry.userId}`,
          type: entry.state === 'editing' ? CellAlertType.WARNING : CellAlertType.INFO,
          title: `${entry.username}${entry.state === 'editing' ? '正在编辑' : '已选中'}此单元格`,
          message: entry.state === 'editing' ? '请等待对方结束编辑，避免同时覆盖内容。' : '对方可能准备编辑此单元格。',
          width: 260,
          height: 88,
        }))
      } catch (presenceError) {
        console.error('Failed to render collaborator presence:', presenceError)
      }
    })
    return clearPresenceVisuals
  }, [clearPresenceVisuals, loading, sheetId, sheetPresence])

  useEffect(() => () => {
    clearProtectionHighlights()
    clearPresenceVisuals()
    protectionFocusDisposableRef.current?.dispose()
    protectionFocusDisposableRef.current = null
    if (protectionFocusTimerRef.current) clearTimeout(protectionFocusTimerRef.current)
    if (protectionHighlightRefreshTimerRef.current) clearTimeout(protectionHighlightRefreshTimerRef.current)
  }, [clearPresenceVisuals, clearProtectionHighlights])

  // Hide global FABs when image picker or blocking Univer dialogs are open
  useEffect(() => {
    if (showImagePicker || univerHasOverlay || showProtectionPanel) {
      document.body.classList.add('fab-hidden')
    } else {
      document.body.classList.remove('fab-hidden')
    }
    return () => { document.body.classList.remove('fab-hidden') }
  }, [showImagePicker, showProtectionPanel, univerHasOverlay])

  // Watch Univer blocking dialogs and side panels separately.
  useEffect(() => {
    const check = () => {
      const overlays = document.querySelectorAll('.univer-dialog, .univer-confirm-modal')
      const sidebars = document.querySelectorAll('.univer-sidebar')
      let hasVisible = false
      overlays.forEach((el) => {
        if ((el as HTMLElement).offsetParent !== null) hasVisible = true
      })
      let hasVisibleSidebar = false
      sidebars.forEach((el) => {
        if ((el as HTMLElement).offsetParent !== null) hasVisibleSidebar = true
      })
      setUniverHasOverlay(hasVisible)
      setUniverSidebarOpen(hasVisibleSidebar)
    }

    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    check()
    return () => observer.disconnect()
  }, [])

  useEffect(() => { latestSheetRef.current = sheet }, [sheet])

  useEffect(() => {
    sheetPresenceRef.current = sheetPresence
  }, [sheetPresence])

  useEffect(() => {
    setLoading(true)
    setError('')
    setActionError('')
    setSelectionState(null)
    setProtectionSnapshot({ rows: [], columns: [], cells: [] })
    setShowProtectionPanel(false)
    setShowAllProtections(false)
    setShowProtectionHighlights(false)
    setProtectionFocusNotice('')
    setProtectionUserSearch('')
    setProtectionScope('cell')
    setSelectedProtectionHidden(false)
    setSelectedProtectionReadonlyUserIds([])
    setSelectedProtectionReadonlyDepartmentIds([])
    setSelectedProtectionEditableUserIds([])
    setSelectedProtectionEditableDepartmentIds([])
    setSelectedProtectionViewHiddenUserIds([])
    setSelectedProtectionViewHiddenDepartmentIds([])
    setSheetPresence([])
    setPresenceExpanded(false)
    setToolbarExpanded(false)
    setHasFilter(false)
  }, [sheetId])

  useEffect(() => {
    void refreshProtectionSnapshot()
  }, [refreshProtectionSnapshot])

  useEffect(() => {
    if (!showProtectionPanel || protectionDirectoryLoaded) return

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
  }, [protectionDirectoryLoaded, protectionUsersLoadToken, showProtectionPanel])

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
      setActionError('Current account does not have permission to import XLSX.')
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
    const xlsxFile = files.find((item) => item.name.toLowerCase().endsWith('.xlsx'))
    if (!xlsxFile) {
      setActionError('Only .xlsx files can be dropped here.')
      return
    }
    void handleDroppedXlsxImport(xlsxFile)
  }, [canImportWorkbook, dragImportUploading, handleDroppedXlsxImport])

  const openCustomProtectionPanel = useCallback((options?: { showAll?: boolean }) => {
    syncSelectionState()
    setShowAllProtections(Boolean(options?.showAll))
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
        syncSelectionState()
      }, 0)
    }

    root.addEventListener('pointerup', syncAfterPointerAction, true)
    root.addEventListener('keyup', syncAfterPointerAction, true)
    return () => {
      root.removeEventListener('pointerup', syncAfterPointerAction, true)
      root.removeEventListener('keyup', syncAfterPointerAction, true)
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
    if (selection.includesHeaderRow && scope !== 'column') {
      setActionError('表头不属于数据行；如需保护字段，请选择“所选整列”。')
      return
    }
    const columns = latestSheetRef.current.columns || []
    const startColumnIndex = columns.findIndex((column) => column.key === selection.columnKey)
    const endColumnIndex = columns.findIndex((column) => column.key === selection.endColumnKey)
    if (scope !== 'row' && (startColumnIndex < 0 || endColumnIndex < 0)) {
      setActionError('当前选择的列信息无效，请重新选择。')
      return
    }

    const requests: Array<Omit<ProtectionMutationPayload, 'action'>> = []
    if (scope === 'row') {
      for (let row = selection.rowIndex; row <= selection.endRowIndex; row += 1) {
        requests.push({ scope: 'row', row_index: row })
      }
    } else if (scope === 'column') {
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
      const res = await api.post(`/sheets/${sheetId}/protections/batch`, {
        items: requests.map((request) => ({
          ...request,
          action,
          ...(action === 'lock' ? { readonly_user_ids: selectedProtectionReadonlyUserIds } : {}),
          ...(action === 'lock' ? { readonly_department_ids: selectedProtectionReadonlyDepartmentIds } : {}),
          ...(action === 'lock' ? { editable_user_ids: selectedProtectionEditableUserIds } : {}),
          ...(action === 'lock' ? { editable_department_ids: selectedProtectionEditableDepartmentIds } : {}),
          ...(action === 'lock' ? { view_hidden_user_ids: selectedProtectionViewHiddenUserIds } : {}),
          ...(action === 'lock' ? { view_hidden_department_ids: selectedProtectionViewHiddenDepartmentIds } : {}),
          ...(action === 'lock' && typeof hidden === 'boolean' ? { hidden } : {}),
        })),
      })
      if (res.code !== 0) {
        throw new Error(res.message || '批量保护失败')
      }
      await refreshProtectionSnapshot()
    } catch (err) {
      console.error('Failed to update protection range:', err)
      setActionError(err instanceof Error ? err.message : '批量保护失败，请稍后再试。')
    } finally {
      setProtectionAction('')
    }
  }, [editLocked, refreshProtectionSnapshot, selectedProtectionEditableDepartmentIds, selectedProtectionEditableUserIds, selectedProtectionReadonlyDepartmentIds, selectedProtectionReadonlyUserIds, selectedProtectionViewHiddenDepartmentIds, selectedProtectionViewHiddenUserIds, sheetId, syncSelectionState])

  const applyIncomingChanges = useCallback((changes: Array<{ row: number; col: string; value: unknown }>) => {
    if (changes.length === 0) return

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
    if (silentSyncInFlightRef.current) {
      silentSyncQueuedRef.current = true
      return silentSyncInFlightRef.current
    }

    const runSync = async () => {
      do {
        silentSyncQueuedRef.current = false

        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        await persistInFlightRef.current

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

        const [sheetResponse, rowsResponse] = await Promise.all([
          api.get<Sheet>(`/sheets/${sheetId}`),
          api.get<Row[]>(`/sheets/${sheetId}/data`),
        ])
        if (sheetResponse.code !== 0 || !sheetResponse.data) {
          throw new Error(sheetResponse.message || '同步工作表信息失败')
        }
        if (rowsResponse.code !== 0) {
          throw new Error(rowsResponse.message || '同步工作表数据失败')
        }

        const nextSheet = sheetResponse.data
        const nextColumns = nextSheet.columns || []
        const nextConfig = parseSheetConfig(nextSheet.config)
        let serverSnapshot: Partial<IWorksheetData>
        if (nextConfig.univerSheetData && typeof nextConfig.univerSheetData === 'object') {
          serverSnapshot = cloneJsonSnapshot(nextConfig.univerSheetData as Partial<IWorksheetData>)
        } else {
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
          nextConfig.univerStyles as Record<string, unknown> | undefined,
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
      setSheetPresence(msg.presence)
    })

    const unsubscribeProtection = wsClient.on('protection_updated', (msg) => {
      if (msg.sheetId !== sheetId) return
      void refreshProtectionSnapshot()
    })

    const unsubscribeSheetSync = wsClient.on('sheet_sync', (msg) => {
      if (msg.sheetId !== sheetId) return
      void syncSheetSilently()
    })

    return () => {
      unsubscribeBatch()
      unsubscribePresence()
      unsubscribeProtection()
      unsubscribeSheetSync()
      wsClient.leaveSheet(sheetId)
      setSheetPresence([])
    }
  }, [applyIncomingChanges, refreshProtectionSnapshot, sheetId, syncSheetSilently])

  useEffect(() => subscribeDataChanged((detail) => {
    if (!detail.sheetIds.includes(sheetId)) return
    void syncSheetSilently()
  }), [sheetId, syncSheetSilently])

  useEffect(() => subscribePrepareDataMutation(async () => {
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

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (!canInitializeEditor) {
      setLoading(true)
      return
    }

    let disposed = false
    let cleanup: (() => void) | null = null

    const mount = async () => {
      setLoading(true)
      setError('')
      try {
        // On reload (triggered by WebSocket sheet_reload), refresh sheet
        // metadata first, then prefer the latest Univer snapshot in config.
        const isReload = reloadTokenRef.current !== reloadToken
        reloadTokenRef.current = reloadToken

        // If this is a reload, re-fetch the sheet metadata first
        let currentSheet = latestSheetRef.current
        if (isReload) {
          try {
            const sheetRes = await api.get<Sheet>(`/sheets/${currentSheet.id}`)
            if (sheetRes.code === 0 && sheetRes.data) {
              currentSheet = sheetRes.data
              latestSheetRef.current = currentSheet
            }
          } catch {
            // Fall through with existing sheet data
          }
        }

        setActionError('')
        const config = parseSheetConfig(currentSheet.config)
        const localeCode = 'zh-CN' as IWorkbookData['locale']
        let workbookData: IWorkbookData

        if (config.univerSheetData && typeof config.univerSheetData === 'object') {
          const worksheetSnapshot = cloneJsonSnapshot(config.univerSheetData as Partial<IWorksheetData>)
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
        const ensureHeight = () =>
          new Promise<void>((resolve) => {
            const check = () => {
              if (containerRef.current && containerRef.current.offsetHeight > 0) {
                resolve()
              } else {
                requestAnimationFrame(check)
              }
            }
            check()
          })

        await ensureHeight()
        if (disposed || !containerRef.current) return

        const localeKey = LocaleType.ZH_CN
        const univerResult = createUniver({
          locale: localeKey,
          theme: defaultTheme,
          locales: {
            [localeKey]: {
              ...UniverPresetSheetsCoreZhCN,
              ...UniverPresetSheetsFindReplaceZhCN,
              ...UniverPresetSheetsFilterZhCN,
              ...UniverSheetsDrawingZhCN,
            },
          },
          presets: [
            UniverSheetsCorePreset({
              container: containerRef.current,
              header: true,
              toolbar: true,
              formulaBar: true,
              contextMenu: true,
              menu: UNIVER_PROTECTION_CONTEXT_MENU_CONFIG,
              footer: false,
            }),
            UniverSheetsDrawingPreset(),
            UniverSheetsFilterPreset(),
            UniverSheetsFindReplacePreset(),
          ],
        })

        const { univer, univerAPI } = univerResult
        univerApiRef.current = univerResult

        const workbookApi = univerAPI.createUniverSheet(workbookData)
        workbookApiRef.current = workbookApi as { setEditable: (editable: boolean) => void }
        workbookApi.setEditable(effectiveCanEditSheet)
        syncFilterState()
        syncSelectionState()
        if (!disposed) setLoading(false)

        const persistSnapshot = async () => {
          persistQueuedRef.current = true
          if (persistInFlightRef.current) {
            await persistInFlightRef.current
            return
          }

          const runPersist = async () => {
            while (persistQueuedRef.current) {
              persistQueuedRef.current = false
              const snap = latestSheetRef.current
              const saved = workbookApi.save()
              const savedSheetId = saved.sheetOrder[0]
              const savedSheet = cloneJsonSnapshot(saved.sheets[savedSheetId] as Partial<IWorksheetData>)
              if (!savedSheet) continue

              const nextColumns = deriveColumnsFromUniverSheet(savedSheet, snap.columns || [])
              const currentConfig = parseSheetConfig(snap.config)
              const previousSheet = persistedWorksheetDataRef.current ||
                (currentConfig.univerSheetData && typeof currentConfig.univerSheetData === 'object'
                  ? cloneJsonSnapshot(currentConfig.univerSheetData as Partial<IWorksheetData>)
                  : undefined)
              const cellChanges = buildRealtimeCellChanges(snap.id, previousSheet, savedSheet, nextColumns)
              const nextConfig = {
                ...currentConfig,
                univerSheetData: savedSheet,
                univerStyles: mergeUniverStyleMap(
                  currentConfig.univerStyles as Record<string, unknown> | undefined,
                  cloneJsonSnapshot(saved.styles as Record<string, unknown> | undefined)
                ),
              }
              const nextSheetName = snap.name || savedSheet.name || 'Sheet1'
              const nextFrozen = snap.frozen || { row: 0, col: 0 }
              const hasSnapshotChanged =
                nextSheetName !== snap.name ||
                !areJsonSnapshotsEqual(nextColumns, snap.columns || []) ||
                !areJsonSnapshotsEqual(nextFrozen, snap.frozen || { row: 0, col: 0 }) ||
                !areJsonSnapshotsEqual(nextConfig, currentConfig)

              if (!hasSnapshotChanged && cellChanges.length === 0) {
                latestSheetRef.current = {
                  ...snap,
                  name: nextSheetName,
                  columns: nextColumns,
                  frozen: nextFrozen,
                  config: cloneJsonSnapshot(nextConfig),
                }
                persistedWorksheetDataRef.current = cloneJsonSnapshot(savedSheet)
                continue
              }

              const res = await api.put(`/sheets/${snap.id}`, {
                name: nextSheetName,
                sort_order: snap.sort_order,
                columns: nextColumns,
                frozen: nextFrozen,
                config: nextConfig,
                cell_changes: cellChanges,
              })

              if (res.code !== 0) {
                throw new Error(res.message || '保存工作表失败')
              }

              latestSheetRef.current = {
                ...snap,
                name: nextSheetName,
                columns: nextColumns,
                frozen: nextFrozen,
                config: cloneJsonSnapshot(nextConfig),
              }
              persistedWorksheetDataRef.current = cloneJsonSnapshot(savedSheet)
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

        const schedulePersist = () => {
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
          saveTimerRef.current = setTimeout(() => {
            persistSnapshot().catch((e) => {
              console.error('Failed to persist Univer snapshot:', e)
              setActionError(e instanceof Error ? e.message : '保存失败，请稍后再试。')
            })
          }, 900)
        }

        const disposable = workbookApi.onCommandExecuted((command) => {
          const refreshProtectionLayout = commandChangesProtectionHighlightLayout(command.id)
          if (applyingRemotePatchRef.current) {
            syncFilterState()
            syncSelectionState()
            if (refreshProtectionLayout) requestProtectionHighlightRefresh()
            return
          }

          schedulePersist()
          syncFilterState()
          syncSelectionState()
          if (refreshProtectionLayout) requestProtectionHighlightRefresh()
        })

        const sendPresenceForCell = (state: 'selected' | 'editing', row: number, column: number) => {
          const columnKey = latestSheetRef.current.columns?.[column]?.key
          const dataRow = row - 1
          if (!columnKey || dataRow < 0) {
            wsClient.sendCellPresence(sheetId, 'viewing')
            return
          }
          wsClient.sendCellPresence(sheetId, state, dataRow, columnKey)
        }

        const selectionPresenceDisposable = univerAPI.addEvent(univerAPI.Event.SelectionChanged, () => {
          const selection = syncSelectionState()
          if (!selection || selection.includesHeaderRow || selection.rowIndex < 0) {
            wsClient.sendCellPresence(sheetId, 'viewing')
            return
          }
          const columnIndex = latestSheetRef.current.columns?.findIndex((column) => column.key === selection.columnKey) ?? -1
          if (columnIndex >= 0) sendPresenceForCell('selected', selection.rowIndex + 1, columnIndex)
        })

        const beforeEditPresenceDisposable = univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, (params) => {
          const columnKey = latestSheetRef.current.columns?.[params.column]?.key
          const dataRow = params.row - 1
          if (!columnKey || dataRow < 0) return
          const currentClientId = getRealtimeClientId()
          const conflict = sheetPresenceRef.current.find((entry) => entry.clientId !== currentClientId
            && entry.state === 'editing'
            && entry.row === dataRow
            && entry.col === columnKey)
          if (conflict) {
            params.cancel = true
            setActionError(`${conflict.username} 正在编辑该单元格，请等待对方结束后再编辑。`)
          }
        })

        const editStartedPresenceDisposable = univerAPI.addEvent(univerAPI.Event.SheetEditStarted, (params) => {
          sendPresenceForCell('editing', params.row, params.column)
        })

        const editEndedPresenceDisposable = univerAPI.addEvent(univerAPI.Event.SheetEditEnded, (params) => {
          sendPresenceForCell('selected', params.row, params.column)
        })

        cleanup = () => {
          disposable.dispose()
          selectionPresenceDisposable.dispose()
          beforeEditPresenceDisposable.dispose()
          editStartedPresenceDisposable.dispose()
          editEndedPresenceDisposable.dispose()
          persistRef.current = null
          workbookApiRef.current = null
          persistQueuedRef.current = false
          persistInFlightRef.current = null
          if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
          if (remotePatchResetTimerRef.current) { clearTimeout(remotePatchResetTimerRef.current); remotePatchResetTimerRef.current = null }
          applyingRemotePatchRef.current = false
          persistedWorksheetDataRef.current = null
          univerApiRef.current = null
          setHasFilter(false)
          setSelectionState(null)

          try {
            ;(univer as { dispose?: () => void }).dispose?.()
          } catch (disposeError) {
            console.error('Failed to dispose Univer instance:', disposeError)
          }

		}
      } catch (mountError) {
        console.error('Failed to initialize Univer sheet:', mountError)
        if (!disposed) {
          setError(mountError instanceof Error ? mountError.message : 'Univer 工作表初始化失败，请稍后重试。')
          setLoading(false)
        }
      }
    }

    mount()
    return () => { disposed = true; cleanup?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveCanEditSheet synced via separate setEditable effect
  }, [sheetId, workbookId, reloadToken, canInitializeEditor, requestProtectionHighlightRefresh])

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
      const fallbackFilename = fallbackBase.toLowerCase().endsWith('.xlsx') ? fallbackBase : `${fallbackBase}.xlsx`
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
      setSelectedProtectionHidden(false)
      setSelectedProtectionReadonlyUserIds([])
      setSelectedProtectionReadonlyDepartmentIds([])
      setSelectedProtectionEditableUserIds([])
      setSelectedProtectionEditableDepartmentIds([])
      setSelectedProtectionViewHiddenUserIds([])
      setSelectedProtectionViewHiddenDepartmentIds([])
      return
    }

    const currentCell = protectionSnapshot.cells.find(
      (item) => item.row_index === selectionState.rowIndex && item.column_key === selectionState.columnKey
    )
    const currentRow = protectionSnapshot.rows.find((item) => item.row_index === selectionState.rowIndex)
    const currentColumn = protectionSnapshot.columns.find((item) => item.column_key === selectionState.columnKey)
    const activeProtection = currentCell || currentRow || currentColumn

    if (activeProtection) setProtectionScope(activeProtection.scope)
    setSelectedProtectionHidden(Boolean(activeProtection?.hidden))
    setSelectedProtectionReadonlyUserIds(activeProtection?.readonly_user_ids || [])
    setSelectedProtectionReadonlyDepartmentIds(activeProtection?.readonly_department_ids || [])
    setSelectedProtectionEditableUserIds(activeProtection?.editable_user_ids || [])
    setSelectedProtectionEditableDepartmentIds(activeProtection?.editable_department_ids || [])
    setSelectedProtectionViewHiddenUserIds(activeProtection?.view_hidden_user_ids || [])
    setSelectedProtectionViewHiddenDepartmentIds(activeProtection?.view_hidden_department_ids || [])
  }, [protectionSnapshot.cells, protectionSnapshot.columns, protectionSnapshot.rows, selectionState])

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

  const showFabs = !showImagePicker && !univerHasOverlay
  const currentRowProtection = selectionState
    ? protectionSnapshot.rows.find((item) => item.row_index === selectionState.rowIndex) || null
    : null
  const currentColumnProtection = selectionState
    ? protectionSnapshot.columns.find((item) => item.column_key === selectionState.columnKey) || null
    : null
  const currentCellProtection = selectionState
    ? protectionSnapshot.cells.find(
        (item) => item.row_index === selectionState.rowIndex && item.column_key === selectionState.columnKey
      ) || null
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
  const formatProtectionBadge = (item: ProtectionInfo) => `${formatProtectionTarget(item)} - ${item.owner_name}`
  const allProtectionItems = [
    ...protectionSnapshot.rows,
    ...protectionSnapshot.columns,
    ...protectionSnapshot.cells,
  ]
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
    setSelectedProtectionHidden(Boolean(item?.hidden))
    setSelectedProtectionReadonlyUserIds(item?.readonly_user_ids || [])
    setSelectedProtectionReadonlyDepartmentIds(item?.readonly_department_ids || [])
    setSelectedProtectionEditableUserIds(item?.editable_user_ids || [])
    setSelectedProtectionEditableDepartmentIds(item?.editable_department_ids || [])
    setSelectedProtectionViewHiddenUserIds(item?.view_hidden_user_ids || [])
    setSelectedProtectionViewHiddenDepartmentIds(item?.view_hidden_department_ids || [])
  }
  const currentProtectionItems = [currentRowProtection, currentColumnProtection, currentCellProtection]
    .filter((item): item is ProtectionInfo => Boolean(item))
  const protectionOwnerGroups = Array.from(allProtectionItems.reduce((groups, item) => {
    const current = groups.get(item.owner_id) || { ownerId: item.owner_id, ownerName: item.owner_name, items: [] as ProtectionInfo[] }
    current.items.push(item)
    groups.set(item.owner_id, current)
    return groups
  }, new Map<number, { ownerId: number; ownerName: string; items: ProtectionInfo[] }>()).values())
    .sort((left, right) => left.ownerName.localeCompare(right.ownerName, 'zh-CN'))
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

  return (
    <div
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onDragEnter={handleContainerDragEnter}
      onDragOver={handleContainerDragOver}
      onDragLeave={handleContainerDragLeave}
      onDrop={handleContainerDrop}
      onContextMenu={handleSheetContextMenu}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />

      {onlineCollaborators.length > 0 && (
        <div className="absolute right-3 top-14 z-[22] w-[min(20rem,calc(100%-1.5rem))]">
          <button type="button" onClick={() => setPresenceExpanded((current) => !current)} className="ml-auto flex min-h-10 max-w-full items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1.5 text-left shadow-lg backdrop-blur" title={presenceExpanded ? '收起在线协作人员' : '查看在线协作人员'} aria-label={presenceExpanded ? '收起在线协作人员' : '查看在线协作人员'}>
            <UserRoundCheck className="h-4 w-4 shrink-0 text-emerald-600" />
            <div className="flex -space-x-1.5">
              {displayedCollaborators.slice(0, 4).map((entry) => {
                const visual = visualForUser(entry.userId)
                return <span key={entry.userId} className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-[10px] font-semibold" style={{ backgroundColor: visual.soft, color: visual.stroke }} title={`${entry.username} · ${entry.state === 'editing' ? '正在编辑' : entry.state === 'selected' ? '已选中单元格' : '在线查看'}`}>{entry.username.slice(0, 2).toUpperCase()}</span>
              })}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold text-slate-800">{onlineCollaborators.length} 人在线</div>
              <div className="truncate text-[10px] text-slate-400">{onlineCollaborators.filter((entry) => entry.state === 'editing').length > 0 ? `${onlineCollaborators.filter((entry) => entry.state === 'editing').length} 人正在编辑` : '当前无编辑冲突'}</div>
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
              {dragImportUploading ? 'Importing XLSX...' : 'Drop XLSX file to import'}
            </div>
            <div className="mt-2 text-sm leading-6 text-slate-500">
              The file will be imported into this workbook and a new sheet will be created automatically.
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
        <div className={`fixed bottom-32 z-[70] flex flex-col items-end gap-2 md:bottom-28 ${univerSidebarOpen ? 'right-[22rem] md:right-[24rem]' : 'right-4'}`}>
          {/* Expanded tools — slide up when toggled */}
          {toolbarExpanded && (
            <div className="flex flex-col items-end gap-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
              <FloatingToolHint label="保护设置">
                <button
                  type="button"
                  onClick={() => {
                    syncSelectionState()
                    setShowAllProtections(false)
                    setShowProtectionPanel((current) => !current)
                  }}
                  className={`flex h-10 w-10 items-center justify-center rounded-full border shadow-lg transition ${
                    showProtectionPanel
                      ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                  title="保护设置"
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
                  title={hasFilter ? '清除筛选' : '启用筛选'}
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
                  title="下载当前表 Excel"
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
                  title="下载工作簿 Excel"
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
                    title="下载原始 Excel"
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
                  title="打印当前表"
                  aria-label="打印当前表"
                >
                  <Printer className="h-4 w-4" />
                </button>
              </FloatingToolHint>
              <FloatingToolHint label="PDF 导出与预览">
                <button
                  type="button"
                  onClick={openPdfExportPanel}
                  disabled={!effectiveCanViewSheet || exportAction !== ''}
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  title="PDF 导出与预览"
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
                  title="插入图片"
                  aria-label="插入图片"
                >
                  <ImagePlus className="h-4 w-4" />
                </button>
              </FloatingToolHint>
            </div>
          )}
          {/* Always visible: Save + Toolbar toggle */}
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
              title="保存表格 (Ctrl+S)"
              aria-label="保存表格"
            >
              <Save className="h-4 w-4" />
            </button>
          </FloatingToolHint>
          <div className="group relative">
            <span className="pointer-events-none absolute right-12 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white opacity-0 shadow-lg transition group-hover:opacity-100">
              {toolbarExpanded ? '收起表格工具' : '展开表格工具'}
            </span>
            <button
              type="button"
              onClick={() => setToolbarExpanded((v) => !v)}
              className={`flex h-10 w-10 items-center justify-center rounded-full shadow-lg transition ${
                toolbarExpanded
                  ? 'bg-slate-700 text-white hover:bg-slate-600'
                  : 'bg-slate-900 text-white hover:bg-slate-800'
              }`}
              title={toolbarExpanded ? '收起表格工具' : '展开表格工具'}
              aria-label={toolbarExpanded ? '收起表格工具' : '展开表格工具'}
            >
              {toolbarExpanded ? <ChevronUp className="h-5 w-5" /> : <Wrench className="h-5 w-5" />}
            </button>
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

      {showProtectionPanel && (
        <div className="absolute inset-x-3 bottom-3 z-30 max-h-[min(820px,calc(100vh-5rem))] overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 shadow-2xl sm:inset-x-auto sm:bottom-20 sm:right-20 sm:w-[560px]">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">选区保护与数据白名单</div>
              <div className="mt-1 text-xs leading-5 text-slate-500">
                当前选择：{selectionState ? selectionState.rangeLabel : '未选中单元格'}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button type="button" onClick={() => setShowProtectionHighlights((current) => !current)} className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition ${showProtectionHighlights ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`} title={showProtectionHighlights ? '隐藏保护区域颜色' : '显示保护区域颜色'}>
                {showProtectionHighlights ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {showProtectionHighlights ? '隐藏标记' : '显示标记'}
              </button>
              <button type="button" onClick={() => setShowProtectionPanel(false)} className="ui-tooltip inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600" title="关闭保护设置" aria-label="关闭保护设置" data-tooltip="关闭" data-tooltip-side="left">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {editLocked && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                当前账号只有查看权限，可以查看保护状态，但不能加锁、解锁或保存表格。
              </div>
            )}
            {protectionFocusNotice && (
              <div className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800">
                <LocateFixed className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">{protectionFocusNotice}</span>
              </div>
            )}
            {protectionOwnerGroups.length > 0 && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold text-slate-700">保护颜色图例</div>
                <div className="flex flex-wrap gap-2">
                  {protectionOwnerGroups.map((group) => {
                    const visual = visualForUser(group.ownerId)
                    return <span key={group.ownerId} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: visual.fill, border: `2px solid ${visual.stroke}` }} />{group.ownerName}<span className="text-slate-400">{group.items.length}</span></span>
                  })}
                  {allProtectionItems.some((item) => item.hidden) && <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600"><EyeOff className="h-3 w-3 text-slate-600" />对其他人隐藏</span>}
                </div>
              </div>
            )}
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <div className="border-b border-slate-200 bg-slate-50 px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-800">1. 选择保护范围</div>
                  <span className="rounded-md bg-white px-2 py-1 text-[11px] font-medium text-slate-500">拖动框选后直接应用</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-slate-200/70 p-1">
                  {([
                    { value: 'cell', label: '精确选区', icon: Square },
                    { value: 'row', label: '所选整行', icon: Rows3 },
                    { value: 'column', label: '所选整列', icon: Columns3 },
                  ] as Array<{ value: ProtectionScope; label: string; icon: typeof Square }>).map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => selectProtectionScope(value)}
                      className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-semibold transition ${protectionScope === value ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                </div>
                <label className={`mt-3 flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${selectedProtectionHidden ? 'border-slate-400 bg-slate-100' : 'border-slate-200 bg-white'}`}>
                  <input type="checkbox" checked={selectedProtectionHidden} onChange={(event) => setSelectedProtectionHidden(event.target.checked)} disabled={editLocked} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-700" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700"><EyeOff className="h-3.5 w-3.5" />对未授权人员遮罩数据</span>
                    <span className="mt-0.5 block text-[11px] leading-5 text-slate-500">未获得“修改”或“查看遮罩内容”的成员只会看到 ••••。</span>
                  </span>
                </label>
              </div>

              <div className="px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><Users className="h-4 w-4 text-sky-600" />2. 配置白名单</div>
                    <div className="mt-1 text-[11px] leading-5 text-slate-500">修改可编辑并看原文；查看遮罩内容只能看原文；只读不能修改。</div>
                  </div>
                  <button type="button" onClick={clearProtectionWhitelist} disabled={editLocked || selectedProtectionPrincipalCount === 0} className="h-8 shrink-0 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-500 transition hover:bg-slate-50 disabled:opacity-40">清空 {selectedProtectionPrincipalCount || ''}</button>
                </div>

                {protectionDepartments.length > 0 && (
                  <div className="mt-3">
                    <div className="mb-1.5 text-xs font-semibold text-slate-600">部门</div>
                    <div className="max-h-40 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                      {protectionDepartments.map((department) => (
                        <div key={department.id} className="flex items-center gap-3 px-3 py-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-50 text-sky-700"><Users className="h-3.5 w-3.5" /></div>
                          <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-slate-700">{department.name}</div><div className="text-[10px] text-slate-400">{department.member_count} 名成员</div></div>
                          <select aria-label={`设置部门 ${department.name} 的选区权限`} value={getProtectionDepartmentAccess(department.id)} onChange={(event) => setProtectionDepartmentAccess(department.id, event.target.value as ProtectionWhitelistAccess | '')} disabled={editLocked} className="h-8 w-32 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none focus:border-sky-300">
                            <option value="">不加入</option><option value="readonly">只读</option><option value="edit">修改</option><option value="view_hidden">查看遮罩内容</option>
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-3">
                  <div className="mb-1.5 flex items-center justify-between gap-3"><span className="text-xs font-semibold text-slate-600">员工</span><span className="text-[10px] text-slate-400">个人设置优先于部门</span></div>
                  {protectionUsersLoading ? (
                    <div className="rounded-lg border border-slate-200 px-3 py-4 text-center text-xs text-slate-400">正在加载员工...</div>
                  ) : protectionUsersError ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"><span>{protectionUsersError}</span><button type="button" onClick={() => { setProtectionDirectoryLoaded(false); setProtectionUsersLoadToken((current) => current + 1) }} className="shrink-0 font-semibold text-rose-800 hover:underline">重试</button></div>
                  ) : protectionUsers.length === 0 ? (
                    <div className="rounded-lg bg-slate-50 px-3 py-3 text-xs text-slate-400">暂无可选择员工，请先创建并启用员工账号。</div>
                  ) : (
                    <>
                      <label className="relative block">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                        <input type="search" value={protectionUserSearch} onChange={(event) => setProtectionUserSearch(event.target.value)} placeholder="搜索姓名或邮箱" className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-8 pr-2 text-xs text-slate-700 outline-none transition focus:border-sky-300 focus:bg-white focus:ring-2 focus:ring-sky-100" />
                      </label>
                      <div className="mt-2 max-h-52 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                        {filteredProtectionUsers.length === 0 ? (
                          <div className="px-2 py-5 text-center text-xs text-slate-400">没有匹配的员工</div>
                        ) : filteredProtectionUsers.map((user) => (
                          <div key={user.id} className="flex items-center gap-3 px-3 py-2">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[10px] font-semibold text-slate-600">{user.username.slice(0, 2).toUpperCase()}</div>
                            <div className="min-w-0 flex-1"><div className="truncate text-xs font-medium text-slate-700">{user.username}</div><div className="truncate text-[10px] text-slate-400">{user.email}</div></div>
                            <select aria-label={`设置员工 ${user.username} 的选区权限`} value={getProtectionUserAccess(user.id)} onChange={(event) => setProtectionUserAccess(user.id, event.target.value as ProtectionWhitelistAccess | '')} disabled={editLocked} className="h-8 w-32 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none focus:border-sky-300">
                              <option value="">不加入</option><option value="readonly">只读</option><option value="edit">修改</option><option value="view_hidden">查看遮罩内容</option>
                            </select>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="border-t border-slate-200 bg-slate-50 px-3 py-3">
                {activeProtection && <div className="mb-2 text-[11px] leading-5 text-slate-500">当前{protectionScope === 'row' ? '行' : protectionScope === 'column' ? '列' : '单元格'}已由 {activeProtection.owner_name} 设置：{formatProtectionWhitelist(activeProtection)}</div>}
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <button type="button" onClick={() => void handleProtectionRangeChange(protectionScope, 'lock', selectedProtectionHidden)} disabled={!selectionState || editLocked || protectionAction === `${protectionScope}:bulk:lock` || Boolean(activeProtection && !canUpdateProtectionEditors(activeProtection))} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-sky-600 px-3 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"><Shield className="h-4 w-4" />保存并应用到选区</button>
                  <button type="button" onClick={() => void handleProtectionRangeChange(protectionScope, 'unlock')} disabled={!selectionState || editLocked || protectionAction === `${protectionScope}:bulk:unlock` || Boolean(activeProtection && !canReleaseProtection(activeProtection))} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"><Unlock className="h-4 w-4" />解除</button>
                </div>
                <div className="mt-2 text-[10px] leading-5 text-slate-400">白名单会并入最终权限矩阵；工作簿或工作表的锁定、归档状态仍然优先。</div>
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <button
                type="button"
                onClick={() => setShowAllProtections((value) => !value)}
                disabled={protectionLoading || allProtectionItems.length === 0}
                className="flex w-full items-center justify-between gap-3 text-left disabled:cursor-default"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Shield className="h-4 w-4 text-amber-600" />
                  全部保护记录
                </span>
                <span className="flex items-center gap-2 text-xs text-slate-500">
                  共 {allProtectionItems.length} 项
                  {allProtectionItems.length > 0 && (
                    <ChevronUp className={`h-4 w-4 transition-transform ${showAllProtections ? '' : 'rotate-180'}`} />
                  )}
                </span>
              </button>
              {protectionLoading ? (
                <div className="mt-3 text-xs text-slate-400">正在加载...</div>
              ) : allProtectionItems.length === 0 ? (
                <div className="mt-3 text-xs text-slate-400">当前工作表还没有保护记录。</div>
              ) : showAllProtections ? (
                <div className="mt-3 max-h-80 space-y-3 overflow-y-auto pr-1 text-xs">
                  {protectionOwnerGroups.map((group) => {
                    const visual = visualForUser(group.ownerId)
                    return (
                      <section key={group.ownerId} className="overflow-hidden rounded-lg border border-slate-200">
                        <div className="flex items-center justify-between px-3 py-2" style={{ backgroundColor: visual.soft }}>
                          <span className="flex min-w-0 items-center gap-2 font-semibold" style={{ color: visual.stroke }}><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: visual.stroke }} />{group.ownerName}</span>
                          <span className="shrink-0 text-[10px]" style={{ color: visual.stroke }}>{group.items.length} 个区域</span>
                        </div>
                        <div className="divide-y divide-slate-100 bg-white">
                          {group.items.map((item, index) => (
                            <button key={`${item.scope}-${item.key}-${index}`} type="button" onClick={() => focusProtection(item)} className="block w-full px-3 py-2.5 text-left transition hover:bg-slate-50">
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-2 font-semibold text-slate-700">
                                  {item.scope === 'row' ? <Rows3 className="h-3.5 w-3.5 shrink-0" style={{ color: visual.stroke }} /> : item.scope === 'column' ? <Columns3 className="h-3.5 w-3.5 shrink-0" style={{ color: visual.stroke }} /> : <Square className="h-3.5 w-3.5 shrink-0" style={{ color: visual.stroke }} />}
                                  <span className="truncate">{formatProtectionTarget(item)}</span>
                                  {item.hidden && <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"><EyeOff className="h-3 w-3" />已遮盖</span>}
                                </div>
                                <LocateFixed className="h-3.5 w-3.5 shrink-0 text-slate-300" />
                              </div>
                              <div className="mt-1 leading-5 text-slate-500">{new Date(item.protected_at).toLocaleString('zh-CN')}</div>
                              <div className="mt-1 truncate leading-5 text-slate-500">白名单：{formatProtectionWhitelist(item)}</div>
                            </button>
                          ))}
                        </div>
                      </section>
                    )
                  })}
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-slate-500">
                  <span className="rounded-full bg-slate-100 px-2 py-1">行 {protectionSnapshot.rows.length}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-1">列 {protectionSnapshot.columns.length}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-1">单元格 {protectionSnapshot.cells.length}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Save status toast */}
      {saveStatus === 'saved' && (
        <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg">
          已保存
        </div>
      )}

      {actionError && (
        <div className="absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full bg-rose-500 px-4 py-1.5 text-xs font-semibold text-white shadow-lg">
          {actionError}
        </div>
      )}

      {currentProtectionItems.length > 0 && (
        <div className="absolute left-3 top-3 z-20 flex max-w-[60%] flex-wrap gap-2">
	          {currentProtectionItems.map((item) => {
                const visual = item.hidden ? HIDDEN_PROTECTION_VISUAL : visualForUser(item.owner_id)
                return <button type="button" key={`${item.scope}-${item.key}`} onClick={() => focusProtection(item)} className="inline-flex items-center gap-1.5 rounded-lg border bg-white/95 px-2.5 py-1 text-[11px] font-semibold shadow-sm" style={{ borderColor: visual.stroke, color: visual.stroke }} title="点击定位保护区域">{item.hidden ? <EyeOff className="h-3 w-3" /> : <Shield className="h-3 w-3" />}{formatProtectionBadge(item)}</button>
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
                        src={img.url}
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
