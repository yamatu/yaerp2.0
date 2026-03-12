'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { AlertCircle, ChevronUp, Columns3, Download, FileOutput, Filter, FilterX, ImagePlus, Lock, Printer, Rows3, Save, Shield, Square, Unlock, Wrench, X } from 'lucide-react'
import type { IWorkbookData, IWorksheetData } from '@univerjs/core'
import { createUniver, defaultTheme, LocaleType } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import UniverPresetSheetsFilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import UniverPresetSheetsFindReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN'
import UniverSheetsDrawingZhCN from '@univerjs/sheets-drawing-ui/locale/zh-CN'
import api from '@/lib/api'
import { usePermission } from '@/hooks/usePermission'
import { getStoredUser, isAdmin } from '@/lib/auth'
import { buildUniverWorkbookData, deriveColumnsFromUniverSheet } from '@/lib/univer-sheet'
import { wsClient } from '@/lib/ws'
import { columnIndexToLetter, parseSheetConfig } from '@/lib/spreadsheet'
import type { AuthUser, ColumnDef, ProtectionInfo, ProtectionSnapshot, Row, Sheet } from '@/types'

interface Props {
  workbookId: string | number
  sheet: Sheet
  reloadToken?: string
  onExternalReload?: () => Promise<void> | void
}

interface GalleryImage {
  id: number
  filename: string
  url: string
  size: number
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

function wrapWorksheetData(
  workbookId: string | number,
  sheet: Sheet,
  worksheetData: Partial<IWorksheetData>,
  locale: IWorkbookData['locale'],
  savedStyles?: Record<string, unknown>
): IWorkbookData {
  const sheetKey = worksheetData.id || `sheet-${sheet.id}`
  return {
    id: `workbook-${workbookId}-sheet-${sheet.id}`,
    name: sheet.name || 'Workbook',
    appVersion: '0.5.0',
    locale,
    styles: (savedStyles || {}) as IWorkbookData['styles'],
    sheetOrder: [sheetKey],
    sheets: {
      [sheetKey]: {
        ...worksheetData,
        id: sheetKey,
        name: worksheetData.name || sheet.name || 'Sheet1',
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

export default function UniverSheetEditor({ workbookId, sheet, reloadToken, onExternalReload }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistInFlightRef = useRef<Promise<void> | null>(null)
  const persistQueuedRef = useRef(false)
  const latestSheetRef = useRef(sheet)
  const univerApiRef = useRef<ReturnType<typeof createUniver> | null>(null)
  const workbookApiRef = useRef<{ setEditable: (editable: boolean) => void } | null>(null)
  const persistRef = useRef<(() => Promise<void>) | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showImagePicker, setShowImagePicker] = useState(false)
  const [galleryImages, setGalleryImages] = useState<GalleryImage[]>([])
  const [loadingGallery, setLoadingGallery] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [univerHasOverlay, setUniverHasOverlay] = useState(false)
  const [toolbarExpanded, setToolbarExpanded] = useState(false)
  const [hasFilter, setHasFilter] = useState(false)
  const [actionError, setActionError] = useState('')
  const [showProtectionPanel, setShowProtectionPanel] = useState(false)
  const [selectionState, setSelectionState] = useState<SelectionState | null>(null)
  const [protectionSnapshot, setProtectionSnapshot] = useState<ProtectionSnapshot>({ rows: [], columns: [], cells: [] })
  const [protectionLoading, setProtectionLoading] = useState(false)
  const [protectionAction, setProtectionAction] = useState('')
  const [exportAction, setExportAction] = useState<'' | 'download' | 'print' | 'pdf'>('')
  const [profile] = useState<AuthUser | null>(getStoredUser())
  const adminMode = isAdmin(profile)
  const sheetId = sheet.id
  const { permissions, loading: permissionLoading } = usePermission(sheetId)
  const canEditSheet = permissions?.sheet.canEdit ?? false
  const canExportSheet = permissions?.sheet.canExport ?? false
  const editLocked = permissionLoading || !canEditSheet

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

      const column = columns[range.getColumn()]
      const endColumn = columns[range.getLastColumn()]
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
        startRow === endRow && range.getColumn() === range.getLastColumn()
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

  // Hide global FABs when image picker or Univer modal dialog is open
  useEffect(() => {
    if (showImagePicker || univerHasOverlay || showProtectionPanel) {
      document.body.classList.add('fab-hidden')
    } else {
      document.body.classList.remove('fab-hidden')
    }
    return () => { document.body.classList.remove('fab-hidden') }
  }, [showImagePicker, showProtectionPanel, univerHasOverlay])

  // Watch for Univer modal overlays only (dialogs, confirm modals, sidebars)
  // Avoid matching toolbar/panel elements that are always present
  useEffect(() => {
    const check = () => {
      const overlays = document.querySelectorAll(
        '.univer-dialog, .univer-confirm-modal, .univer-sidebar'
      )
      // Filter to only visible overlays (offsetParent !== null or has display)
      let hasVisible = false
      overlays.forEach((el) => {
        if ((el as HTMLElement).offsetParent !== null) hasVisible = true
      })
      setUniverHasOverlay(hasVisible)
    }

    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    check()
    return () => observer.disconnect()
  }, [])

  useEffect(() => { latestSheetRef.current = sheet }, [sheet])

  useEffect(() => {
    setLoading(true)
    setError('')
    setActionError('')
    setSelectionState(null)
    setProtectionSnapshot({ rows: [], columns: [], cells: [] })
    setShowProtectionPanel(false)
    setToolbarExpanded(false)
    setHasFilter(false)
  }, [sheetId])

  useEffect(() => {
    void refreshProtectionSnapshot()
  }, [refreshProtectionSnapshot])

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

  const handleProtectionChange = useCallback(async (scope: 'row' | 'column' | 'cell', action: 'lock' | 'unlock') => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能修改保护状态。')
      return
    }
    const selection = syncSelectionState()
    if (!selection) {
      setActionError('请先在工作表中选中一个单元格。')
      return
    }
    setActionError('')
    setProtectionAction(`${scope}:${action}`)

    try {
      const payload: { scope: string; action: string; row_index?: number; column_key?: string } = {
        scope,
        action,
      }
      if (scope === 'row' || scope === 'cell') {
        payload.row_index = selection.rowIndex
      }
      if (scope === 'column' || scope === 'cell') {
        payload.column_key = selection.columnKey
      }

      const res = await api.post<{ sheet?: Sheet; protections?: ProtectionSnapshot }>(`/sheets/${sheetId}/protections`, payload)
      if (res.code !== 0) {
        setActionError(res.message || '更新保护状态失败，请稍后再试。')
        return
      }

      if (res.data?.sheet) {
        latestSheetRef.current = {
          ...latestSheetRef.current,
          config: res.data.sheet.config,
        }
      }
      if (res.data?.protections) {
        setProtectionSnapshot(res.data.protections)
      } else {
        await refreshProtectionSnapshot()
      }
    } catch (err) {
      console.error('Failed to update protection:', err)
      setActionError('更新保护状态失败，请稍后再试。')
    } finally {
      setProtectionAction('')
    }
  }, [editLocked, refreshProtectionSnapshot, sheetId, syncSelectionState])

  const handleProtectionRangeChange = useCallback(async (scope: 'row' | 'column' | 'cell', action: 'lock' | 'unlock') => {
    if (editLocked) {
      setActionError('当前账号只有查看权限，不能修改保护状态。')
      return
    }
    const selection = syncSelectionState()
    if (!selection) {
      setActionError('请先在工作表中框选需要保护的范围。')
      return
    }
    const columns = latestSheetRef.current.columns || []
    const startColumnIndex = columns.findIndex((column) => column.key === selection.columnKey)
    const endColumnIndex = columns.findIndex((column) => column.key === selection.endColumnKey)
    if (startColumnIndex < 0 || endColumnIndex < 0) {
      setActionError('当前选择的列信息无效，请重新选择。')
      return
    }

    const requests: Array<{ scope: 'row' | 'column' | 'cell'; row_index?: number; column_key?: string }> = []
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
        items: requests.map((request) => ({ ...request, action })),
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
  }, [editLocked, refreshProtectionSnapshot, sheetId, syncSelectionState])

  const applyIncomingChanges = useCallback((changes: Array<{ row: number; col: string; value: unknown }>) => {
    if (changes.length === 0) return

    try {
      const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      const columns = latestSheetRef.current.columns || []
      if (!worksheet) return

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

      syncSelectionState()
    } catch (err) {
      console.error('Failed to apply incoming sheet updates:', err)
    }
  }, [syncSelectionState])

  useEffect(() => {
    wsClient.connect()

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

    return () => {
      unsubscribeBatch()
    }
  }, [applyIncomingChanges, sheetId])

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
    const el = containerRef.current
    if (!el) return

    let disposed = false
    let cleanup: (() => void) | null = null

    const mount = async () => {
      setLoading(true)
      setError('')
      try {
        // Read the latest sheet data from the ref, not from closure
        const currentSheet = latestSheetRef.current
        setActionError('')
        const config = parseSheetConfig(currentSheet.config)
        const localeCode = 'zh-CN' as IWorkbookData['locale']
        let workbookData: IWorkbookData

        if (config.univerSheetData && typeof config.univerSheetData === 'object') {
          workbookData = wrapWorksheetData(
            workbookId, currentSheet,
            config.univerSheetData as Partial<IWorksheetData>,
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
        workbookApi.setEditable(canEditSheet)
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
              const savedSheet = saved.sheets[savedSheetId] as Partial<IWorksheetData>
              if (!savedSheet) continue

              const nextColumns = deriveColumnsFromUniverSheet(savedSheet, snap.columns || [])
              const currentConfig = parseSheetConfig(snap.config)
              const nextConfig = { ...currentConfig, univerSheetData: savedSheet, univerStyles: saved.styles || {} }
              const res = await api.put(`/sheets/${snap.id}`, {
                name: savedSheet.name || snap.name,
                sort_order: snap.sort_order,
                columns: nextColumns,
                frozen: snap.frozen || { row: 0, col: 0 },
                config: nextConfig,
              })

              if (res.code !== 0) {
                throw new Error(res.message || '保存工作表失败')
              }

              latestSheetRef.current = {
                ...snap,
                name: savedSheet.name || snap.name,
                columns: nextColumns,
                config: nextConfig,
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

        const schedulePersist = () => {
          if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
          saveTimerRef.current = setTimeout(() => {
            persistSnapshot().catch((e) => {
              console.error('Failed to persist Univer snapshot:', e)
              setActionError(e instanceof Error ? e.message : '保存失败，请稍后再试。')
            })
          }, 900)
        }

        const disposable = workbookApi.onCommandExecuted(() => {
          schedulePersist()
          syncFilterState()
          syncSelectionState()
        })

        cleanup = () => {
          disposable.dispose()
          persistRef.current = null
          workbookApiRef.current = null
          persistQueuedRef.current = false
          persistInFlightRef.current = null
          if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, sheetId, workbookId])

  useEffect(() => {
    try {
      workbookApiRef.current?.setEditable(canEditSheet)
    } catch {
      // Ignore Univer editable sync issues and keep server-side checks authoritative.
    }
  }, [canEditSheet])

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

      const inserted = await (range as typeof range & {
        insertCellImageAsync?: (file: File | string) => Promise<boolean>
      }).insertCellImageAsync?.(imageFile)
      if (!inserted) {
        throw new Error('图片插入失败，请确认当前工作表已启用图片能力。')
      }

      await persistCurrentSheet()
    } catch (e) {
      console.error('Failed to insert image to cell:', e)
      setActionError(e instanceof Error ? e.message : '插入图片失败，请稍后再试。')
    }

    setShowImagePicker(false)
  }, [persistCurrentSheet])

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

          const inserted = await (range as typeof range & {
            insertCellImageAsync?: (file: File | string) => Promise<boolean>
          }).insertCellImageAsync?.(file)
          if (!inserted) {
            throw new Error('本地图片插入失败，请稍后重试。')
          }

          await persistCurrentSheet()
          setShowImagePicker(false)
        }
      }
    } catch (err) {
      console.error('Upload failed:', err)
      setActionError(err instanceof Error ? err.message : '上传图片失败，请稍后再试。')
    }
  }, [editLocked, persistCurrentSheet])

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

  const handleDownloadSheet = useCallback(async () => {
    if (!canExportSheet) {
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
  }, [canEditSheet, canExportSheet, persistCurrentSheet, sheetId])

  const handleDownloadPdf = useCallback(async () => {
    if (!canExportSheet) {
      setActionError('当前账号没有导出权限，不能导出 PDF。')
      return
    }

    setActionError('')
    setExportAction('pdf')
    try {
      if (canEditSheet) {
        await persistCurrentSheet()
      }

      const fallbackFilename = `${sanitizeDownloadFilename(latestSheetRef.current.name || '工作表')}.pdf`
      const response = await api.download(`/sheets/${sheetId}/export/pdf?filename=${encodeURIComponent(fallbackFilename)}`)
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
      triggerBrowserDownload(blob, filename)
    } catch (err) {
      console.error('Failed to export PDF:', err)
      setActionError(err instanceof Error ? err.message : '导出 PDF 失败，请稍后再试。')
    } finally {
      setExportAction('')
    }
  }, [canEditSheet, canExportSheet, persistCurrentSheet, sheetId])

  const handlePrintSheet = useCallback(async () => {
    if (!canExportSheet) {
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
  }, [canEditSheet, canExportSheet, getCurrentSheetSnapshot, persistCurrentSheet])

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
  const canReleaseProtection = (item: ProtectionInfo | null) => Boolean(item && !editLocked && (adminMode || item.owner_id === profile?.id))
  const visibleProtectionBadges = [
    ...protectionSnapshot.rows.slice(0, 3).map((item) => `行 ${(item.row_index || 0) + 2} - ${item.owner_name}`),
    ...protectionSnapshot.columns.slice(0, 3).map((item) => `列 ${item.column_key || item.key} - ${item.owner_name}`),
  ].slice(0, 6)

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />

      {/* Floating toolbar — collapsible, hidden when any overlay/panel is open */}
      {showFabs && (
        <div className="absolute right-4 bottom-20 z-20 flex flex-col items-end gap-2">
          {/* Expanded tools — slide up when toggled */}
          {toolbarExpanded && (
            <div className="flex flex-col items-end gap-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
              <button
                type="button"
                onClick={() => {
                  syncSelectionState()
                  setShowProtectionPanel((current) => !current)
                }}
                className={`flex h-10 w-10 items-center justify-center rounded-full border shadow-lg transition ${
                  showProtectionPanel
                    ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
                title="保护设置"
              >
                <Shield className="h-4 w-4" />
              </button>
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
              >
                {hasFilter ? <FilterX className="h-4 w-4" /> : <Filter className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadSheet()}
                disabled={!canExportSheet || exportAction !== ''}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 shadow-lg transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                title="下载当前表"
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void handlePrintSheet()}
                disabled={!canExportSheet || exportAction !== ''}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="打印当前表"
              >
                <Printer className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadPdf()}
                disabled={!canExportSheet || exportAction !== ''}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="导出 PDF"
              >
                <FileOutput className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={openImagePicker}
                disabled={editLocked}
                className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="插入图片"
              >
                <ImagePlus className="h-4 w-4" />
              </button>
            </div>
          )}
          {/* Always visible: Save + Toolbar toggle */}
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
            title="保存 (Ctrl+S)"
          >
            <Save className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setToolbarExpanded((v) => !v)}
            className={`flex h-10 w-10 items-center justify-center rounded-full shadow-lg transition ${
              toolbarExpanded
                ? 'bg-slate-700 text-white hover:bg-slate-600'
                : 'bg-slate-900 text-white hover:bg-slate-800'
            }`}
            title={toolbarExpanded ? '收起工具栏' : '展开工具栏'}
          >
            {toolbarExpanded ? <ChevronUp className="h-5 w-5" /> : <Wrench className="h-5 w-5" />}
          </button>
        </div>
      )}

      {showProtectionPanel && (
        <div className="absolute right-20 bottom-20 z-20 w-[340px] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">保护设置</div>
              <div className="mt-1 text-xs leading-5 text-slate-500">
                当前选择：{selectionState ? selectionState.rangeLabel : '未选中单元格'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setShowProtectionPanel(false)}
              className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3">
            {editLocked && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
                当前账号只有查看权限，可以查看保护状态，但不能加锁、解锁或保存表格。
              </div>
            )}
            {selectionState && (selectionState.endRowIndex > selectionState.rowIndex || selectionState.endColumnKey !== selectionState.columnKey) && (
              <div className="rounded-xl border border-sky-200 bg-sky-50/80 p-3">
                <div className="mb-2 text-sm font-semibold text-sky-800">批量保护所选范围</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleProtectionRangeChange('row', 'lock')}
                    disabled={protectionAction === 'row:bulk:lock'}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-sky-200 bg-white px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Lock className="h-4 w-4" />
                    保护选中行
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleProtectionRangeChange('row', 'unlock')}
                    disabled={protectionAction === 'row:bulk:unlock'}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-sky-200 bg-white px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Unlock className="h-4 w-4" />
                    解除选中行保护
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleProtectionRangeChange('column', 'lock')}
                    disabled={protectionAction === 'column:bulk:lock'}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-sky-200 bg-white px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Lock className="h-4 w-4" />
                    保护选中列
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleProtectionRangeChange('column', 'unlock')}
                    disabled={protectionAction === 'column:bulk:unlock'}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-sky-200 bg-white px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Unlock className="h-4 w-4" />
                    解除选中列保护
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleProtectionRangeChange('cell', 'lock')}
                    disabled={protectionAction === 'cell:bulk:lock'}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-sky-200 bg-white px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Lock className="h-4 w-4" />
                    保护选中单元格
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleProtectionRangeChange('cell', 'unlock')}
                    disabled={protectionAction === 'cell:bulk:unlock'}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-sky-200 bg-white px-3 text-sm font-semibold text-sky-700 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Unlock className="h-4 w-4" />
                    解除选中单元格保护
                  </button>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Rows3 className="h-4 w-4 text-sky-600" />
                行保护
              </div>
              <div className="text-xs leading-5 text-slate-500">
                {currentRowProtection ? `已由 ${currentRowProtection.owner_name} 于 ${new Date(currentRowProtection.protected_at).toLocaleString('zh-CN')} 添加` : '当前行未加保护'}
              </div>
              <button
                type="button"
                onClick={() => void handleProtectionChange('row', currentRowProtection ? 'unlock' : 'lock')}
                disabled={protectionAction === `row:${currentRowProtection ? 'unlock' : 'lock'}` || (currentRowProtection !== null && !canReleaseProtection(currentRowProtection))}
                className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {currentRowProtection ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                {currentRowProtection ? '解除当前行保护' : '保护当前行'}
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Columns3 className="h-4 w-4 text-sky-600" />
                列保护
              </div>
              <div className="text-xs leading-5 text-slate-500">
                {currentColumnProtection ? `已由 ${currentColumnProtection.owner_name} 于 ${new Date(currentColumnProtection.protected_at).toLocaleString('zh-CN')} 添加` : '当前列未加保护'}
              </div>
              <button
                type="button"
                onClick={() => void handleProtectionChange('column', currentColumnProtection ? 'unlock' : 'lock')}
                disabled={protectionAction === `column:${currentColumnProtection ? 'unlock' : 'lock'}` || (currentColumnProtection !== null && !canReleaseProtection(currentColumnProtection))}
                className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {currentColumnProtection ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                {currentColumnProtection ? '解除当前列保护' : '保护当前列'}
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Square className="h-4 w-4 text-sky-600" />
                单元格保护
              </div>
              <div className="text-xs leading-5 text-slate-500">
                {currentCellProtection ? `已由 ${currentCellProtection.owner_name} 于 ${new Date(currentCellProtection.protected_at).toLocaleString('zh-CN')} 添加` : '当前单元格未加保护'}
              </div>
              <button
                type="button"
                onClick={() => void handleProtectionChange('cell', currentCellProtection ? 'unlock' : 'lock')}
                disabled={protectionAction === `cell:${currentCellProtection ? 'unlock' : 'lock'}` || (currentCellProtection !== null && !canReleaseProtection(currentCellProtection))}
                className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {currentCellProtection ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
                {currentCellProtection ? '解除当前单元格保护' : '保护当前单元格'}
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="mb-2 text-sm font-semibold text-slate-800">最近的保护记录</div>
              {protectionLoading ? (
                <div className="text-xs text-slate-400">正在加载...</div>
              ) : protectionSnapshot.rows.length + protectionSnapshot.columns.length + protectionSnapshot.cells.length === 0 ? (
                <div className="text-xs text-slate-400">当前工作表还没有行/列保护记录。</div>
              ) : (
                <div className="space-y-2 text-xs text-slate-500">
                  {[...protectionSnapshot.rows.slice(0, 2), ...protectionSnapshot.columns.slice(0, 2), ...protectionSnapshot.cells.slice(0, 2)].map((item) => (
                    <div key={`${item.scope}-${item.key}`} className="rounded-lg bg-slate-50 px-3 py-2">
                      {item.scope === 'row'
                        ? `第 ${(item.row_index || 0) + 2} 行`
                        : item.scope === 'column'
                        ? `${item.column_key || item.key} 列`
                        : `${item.column_key || item.key}${(item.row_index || 0) + 2}`}
                      {' '} - {item.owner_name}
                    </div>
                  ))}
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

      {visibleProtectionBadges.length > 0 && (
        <div className="absolute left-3 top-3 z-20 flex max-w-[60%] flex-wrap gap-2">
          {visibleProtectionBadges.map((badge) => (
            <div key={badge} className="rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1 text-[11px] font-semibold text-amber-700 shadow-sm">
              {badge}
            </div>
          ))}
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
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

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
