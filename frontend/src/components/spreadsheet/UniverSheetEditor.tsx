'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { AlertCircle, ChevronUp, Columns3, FileOutput, Filter, FilterX, ImagePlus, Lock, Printer, Rows3, Save, Shield, Square, Unlock, Wrench, X } from 'lucide-react'
import type { IWorkbookData, IWorksheetData } from '@univerjs/core'
import { createUniver, defaultTheme, LocaleType } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import UniverPresetSheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import UniverPresetSheetsFilterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN'
import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace'
import UniverPresetSheetsFindReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN'
import { UniverSheetsDrawingUIPlugin } from '@univerjs/sheets-drawing-ui'
import UniverSheetsDrawingZhCN from '@univerjs/sheets-drawing-ui/locale/zh-CN'
import api from '@/lib/api'
import { getStoredUser, isAdmin } from '@/lib/auth'
import { buildUniverWorkbookData, deriveColumnsFromUniverSheet } from '@/lib/univer-sheet'
import { wsClient } from '@/lib/ws'
import { parseSheetConfig } from '@/lib/spreadsheet'
import type { AuthUser, ProtectionInfo, ProtectionSnapshot, Row, Sheet } from '@/types'

interface Props {
  workbookId: string | number
  sheet: Sheet
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
  columnKey: string
  rowLabel: string
  columnLabel: string
  endRowIndex: number
  endColumnKey: string
  rangeLabel: string
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
  if (typeof data.f === 'string' && data.f.trim()) return data.f
  if (typeof data.v === 'string' || typeof data.v === 'number' || typeof data.v === 'boolean') {
    return String(data.v)
  }
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

export default function UniverSheetEditor({ workbookId, sheet, onExternalReload }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestSheetRef = useRef(sheet)
  const univerApiRef = useRef<ReturnType<typeof createUniver> | null>(null)
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
  const [profile] = useState<AuthUser | null>(getStoredUser())
  const adminMode = isAdmin(profile)
  const sheetId = sheet.id

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

      const startRow = Math.max(range.getRow(), 0)
      const endRow = Math.max(range.getLastRow(), 0)
      const rowLabel = `第 ${startRow + 1} 行`
      const rangeLabel =
        startRow === endRow && range.getColumn() === range.getLastColumn()
          ? `${column.name || column.key} / 第 ${startRow + 1} 行`
          : `第 ${startRow + 1}-${endRow + 1} 行 / ${column.name || column.key} 到 ${endColumn?.name || endColumn?.key || column.key}`

      const nextSelection = {
        rowIndex: startRow,
        columnKey: column.key,
        rowLabel,
        columnLabel: column.name || column.key,
        endRowIndex: endRow,
        endColumnKey: endColumn?.key || column.key,
        rangeLabel,
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
    void refreshProtectionSnapshot()
  }, [refreshProtectionSnapshot])

  // Manual save handler — triggers immediate persist
  const handleManualSave = useCallback(async () => {
    if (!persistRef.current) return
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
      setActionError(e instanceof Error ? e.message : '保存失败，请稍后再试。')
      setSaveStatus('idle')
    }
  }, [])

  const handleEnableFilter = useCallback(async () => {
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
      await handleManualSave()
    } catch (err) {
      console.error('Failed to enable filter:', err)
      setActionError(err instanceof Error ? err.message : '启用筛选失败，请稍后再试。')
    }
  }, [handleManualSave, syncFilterState])

  const handleClearFilter = useCallback(async () => {
    setActionError('')

    try {
      const workbook = univerApiRef.current?.univerAPI.getActiveWorkbook?.()
      const worksheet = workbook?.getActiveSheet?.()
      const filter = worksheet?.getFilter?.()
      if (!filter) return

      filter.remove()
      syncFilterState()
      await handleManualSave()
    } catch (err) {
      console.error('Failed to clear filter:', err)
      setActionError(err instanceof Error ? err.message : '清除筛选失败，请稍后再试。')
    }
  }, [handleManualSave, syncFilterState])

  const handleProtectionChange = useCallback(async (scope: 'row' | 'column' | 'cell', action: 'lock' | 'unlock') => {
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
  }, [refreshProtectionSnapshot, sheetId, syncSelectionState])

  const handleProtectionRangeChange = useCallback(async (scope: 'row' | 'column', action: 'lock' | 'unlock') => {
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

    const requests: Array<{ scope: 'row' | 'column'; row_index?: number; column_key?: string }> = []
    if (scope === 'row') {
      for (let row = selection.rowIndex; row <= selection.endRowIndex; row += 1) {
        requests.push({ scope: 'row', row_index: row })
      }
    } else {
      const start = Math.min(startColumnIndex, endColumnIndex)
      const end = Math.max(startColumnIndex, endColumnIndex)
      for (let index = start; index <= end; index += 1) {
        requests.push({ scope: 'column', column_key: columns[index]?.key })
      }
    }

    if (requests.length === 0) return

    setActionError('')
    setProtectionAction(`${scope}:bulk:${action}`)

    try {
      for (const request of requests) {
        const res = await api.post(`/sheets/${sheetId}/protections`, { ...request, action })
        if (res.code !== 0) {
          throw new Error(res.message || '批量保护失败')
        }
      }
      await refreshProtectionSnapshot()
    } catch (err) {
      console.error('Failed to update protection range:', err)
      setActionError(err instanceof Error ? err.message : '批量保护失败，请稍后再试。')
    } finally {
      setProtectionAction('')
    }
  }, [refreshProtectionSnapshot, sheetId, syncSelectionState])

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

    const unsubscribeReload = wsClient.on('sheet_reload', (msg) => {
      if (msg.sheetId !== sheetId) return
      void onExternalReload?.()
    })

    return () => {
      unsubscribeBatch()
      unsubscribeReload()
    }
  }, [applyIncomingChanges, onExternalReload, sheetId])

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

        containerRef.current.innerHTML = ''

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
            UniverSheetsFilterPreset(),
            UniverSheetsFindReplacePreset(),
          ],
          plugins: [UniverSheetsDrawingUIPlugin],
        })

        const { univer, univerAPI } = univerResult
        univerApiRef.current = univerResult

        const workbookApi = univerAPI.createUniverSheet(workbookData)
        workbookApi.setEditable(true)
        syncFilterState()
        syncSelectionState()
        if (!disposed) setLoading(false)

        const persistSnapshot = async () => {
          const snap = latestSheetRef.current
          const saved = workbookApi.save()
          const savedSheetId = saved.sheetOrder[0]
          const savedSheet = saved.sheets[savedSheetId] as Partial<IWorksheetData>
          if (!savedSheet) return
          const nextColumns = deriveColumnsFromUniverSheet(savedSheet, snap.columns || [])
          const currentConfig = parseSheetConfig(snap.config)
          const res = await api.put(`/sheets/${snap.id}`, {
            name: savedSheet.name || snap.name,
            sort_order: snap.sort_order,
            columns: nextColumns,
            frozen: snap.frozen || { row: 0, col: 0 },
            config: { ...currentConfig, univerSheetData: savedSheet, univerStyles: saved.styles || {} },
          })

          if (res.code !== 0) {
            throw new Error(res.message || '保存工作表失败')
          }
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
          if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
          univerApiRef.current = null
          setHasFilter(false)
          setSelectionState(null)

          try {
            ;(univer as { dispose?: () => void }).dispose?.()
          } catch (disposeError) {
            console.error('Failed to dispose Univer instance:', disposeError)
          }

          if (containerRef.current) {
            containerRef.current.innerHTML = ''
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
  }, [sheetId, workbookId])

  // Gallery image picker
  const openImagePicker = useCallback(async () => {
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
  }, [])

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

      const inserted = await (range as typeof range & {
        insertCellImageAsync?: (file: string) => Promise<boolean>
      }).insertCellImageAsync?.(img.url)
      if (!inserted) {
        throw new Error('图片插入失败，请确认当前工作表已启用图片能力。')
      }

      await handleManualSave()
    } catch (e) {
      console.error('Failed to insert image to cell:', e)
      setActionError(e instanceof Error ? e.message : '插入图片失败，请稍后再试。')
    }

    setShowImagePicker(false)
  }, [handleManualSave])

  // Handle direct file upload from picker
  const handleDirectUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const res = await api.upload(file)
      if (res.code === 0 && res.data) {
        // Get the URL for the uploaded file
        const urlRes = await api.get<{ url: string }>(`/files/${res.data.id}`)
        if (urlRes.code === 0 && urlRes.data) {
          await insertImageToCell({
            id: res.data.id,
            filename: file.name,
            url: urlRes.data.url,
            size: file.size,
          })
        }
      }
    } catch (err) {
      console.error('Upload failed:', err)
      setActionError('上传图片失败，请稍后再试。')
    }
  }, [insertImageToCell])

  const handlePrintSheet = useCallback((mode: 'print' | 'pdf') => {
    try {
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

      const columns = deriveColumnsFromUniverSheet(savedSheet, latestSheetRef.current.columns || [])
      const cellData = savedSheet.cellData || {}
      const dataRowKeys = Object.keys(cellData)
        .map((key) => Number(key))
        .filter((rowIndex) => Number.isFinite(rowIndex) && rowIndex > 0)
      const lastDataRow = dataRowKeys.length > 0 ? Math.max(...dataRowKeys) : 1
      const rowsHtml = Array.from({ length: lastDataRow }, (_, rowOffset) => {
        const rowIndex = rowOffset + 1
        const rowCells = columns.map((_, columnIndex) => {
          const cell = (cellData[rowIndex] as Record<number, unknown> | undefined)?.[columnIndex]
          return `<td>${escapeHtml(getWorksheetCellText(cell)) || '&nbsp;'}</td>`
        }).join('')
        return `<tr><th>${rowIndex + 1}</th>${rowCells}</tr>`
      }).join('')

      const headerHtml = columns.map((column) => `<th>${escapeHtml(column.name || column.key)}</th>`).join('')
      const title = `${latestSheetRef.current.name || '工作表'} - ${mode === 'pdf' ? '导出 PDF' : '打印'}`
      const printWindow = window.open('', '_blank', 'noopener,noreferrer,width=1200,height=900')
      if (!printWindow) {
        throw new Error('浏览器阻止了打印窗口，请允许弹窗后重试。')
      }

      printWindow.document.write(`
        <html>
          <head>
            <title>${escapeHtml(title)}</title>
            <style>
              body { font-family: "Microsoft YaHei", sans-serif; padding: 24px; color: #0f172a; }
              h1 { margin: 0 0 8px; font-size: 24px; }
              p { margin: 0 0 20px; color: #64748b; font-size: 12px; }
              table { width: 100%; border-collapse: collapse; table-layout: fixed; }
              th, td { border: 1px solid #cbd5e1; padding: 8px 10px; font-size: 12px; vertical-align: top; word-break: break-word; }
              thead th { background: #e2e8f0; font-weight: 700; }
              tbody th { background: #f8fafc; width: 70px; }
              @media print { body { padding: 0; } }
            </style>
          </head>
          <body>
            <h1>${escapeHtml(latestSheetRef.current.name || '工作表')}</h1>
            <p>${mode === 'pdf' ? '系统已打开浏览器打印窗口，请在打印目标中选择“保存为 PDF”。' : '使用浏览器打印窗口输出当前工作表。'}</p>
            <table>
              <thead><tr><th>行号</th>${headerHtml}</tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </body>
        </html>
      `)
      printWindow.document.close()
      printWindow.focus()
      printWindow.print()
    } catch (err) {
      console.error('Failed to print sheet:', err)
      setActionError(err instanceof Error ? err.message : '打印失败，请稍后再试。')
    }
  }, [])

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
  const canReleaseProtection = (item: ProtectionInfo | null) => Boolean(item && (adminMode || item.owner_id === profile?.id))
  const visibleProtectionBadges = [
    ...protectionSnapshot.rows.slice(0, 3).map((item) => `行 ${(item.row_index || 0) + 1} - ${item.owner_name}`),
    ...protectionSnapshot.columns.slice(0, 3).map((item) => `列 ${item.column_key || item.key} - ${item.owner_name}`),
  ].slice(0, 6)

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }} />

      {/* Floating toolbar — collapsible, hidden when any overlay/panel is open */}
      {showFabs && (
        <div className="absolute right-3 bottom-16 z-20 flex flex-col items-center gap-2">
          {/* Expanded tools — slide up when toggled */}
          {toolbarExpanded && (
            <div className="flex flex-col items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
              <button
                type="button"
                onClick={() => {
                  syncSelectionState()
                  setShowProtectionPanel((current) => !current)
                }}
                className={`flex h-9 w-9 items-center justify-center rounded-full border shadow-lg transition ${
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
                className={`flex h-9 w-9 items-center justify-center rounded-full border shadow-lg transition ${
                  hasFilter
                    ? 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
                title={hasFilter ? '清除筛选' : '启用筛选'}
              >
                {hasFilter ? <FilterX className="h-4 w-4" /> : <Filter className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => handlePrintSheet('print')}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50"
                title="打印当前表"
              >
                <Printer className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => handlePrintSheet('pdf')}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50"
                title="导出 PDF"
              >
                <FileOutput className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={openImagePicker}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-lg transition hover:bg-slate-50"
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
            className={`flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition ${
              saveStatus === 'saving'
                ? 'bg-amber-500 text-white'
                : saveStatus === 'saved'
                ? 'bg-emerald-500 text-white'
                : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
            }`}
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
        <div className="absolute right-16 bottom-16 z-20 w-[320px] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
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
              ) : protectionSnapshot.rows.length + protectionSnapshot.columns.length === 0 ? (
                <div className="text-xs text-slate-400">当前工作表还没有行/列保护记录。</div>
              ) : (
                <div className="space-y-2 text-xs text-slate-500">
                  {[...protectionSnapshot.rows.slice(0, 3), ...protectionSnapshot.columns.slice(0, 3)].map((item) => (
                    <div key={`${item.scope}-${item.key}`} className="rounded-lg bg-slate-50 px-3 py-2">
                      {item.scope === 'row' ? `第 ${(item.row_index || 0) + 1} 行` : `${item.column_key || item.key} 列`} - {item.owner_name}
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
