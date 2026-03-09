'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  CopyPlus,
  Edit3,
  FileSpreadsheet,
  Filter,
  Lock,
  Plus,
  Rows3,
  Sparkles,
  TableProperties,
  Trash2,
} from 'lucide-react'
import { useSheetData } from '@/hooks/useSheet'
import { useAutoSave } from '@/hooks/useAutoSave'
import { usePermission } from '@/hooks/usePermission'
import { getStoredUser, isAdmin as userIsAdmin } from '@/lib/auth'
import { api } from '@/lib/api'
import { DEFAULT_SHEET_COLUMNS } from '@/lib/sheet-template'
import {
  buildNextColumnKey,
  columnIndexToLetter,
  evaluateCellValue,
  formatCurrencyValue,
  getCellInputValue,
  getCellStyle,
  getCellValue as getStoredCellValue,
  mergeCellRecord,
  normalizeCellValue,
  parseClipboardMatrix,
  parseSheetConfig,
} from '@/lib/spreadsheet'
import { wsClient } from '@/lib/ws'
import type {
  AdvancedFilterConfig,
  ColumnDef,
  FilterOperator,
  FilterRule,
  MergedCellRange,
  Row,
  Sheet,
  SheetConfig,
  SortRule,
  WSMessage,
} from '@/types'
import Toolbar from './Toolbar'
import FormulaBar from './FormulaBar'
import SearchBar from './SearchBar'
import ColumnFilterDropdown from './ColumnFilterDropdown'
import SheetOverview from './SheetOverview'

interface Props {
  sheetId: number
  sheet: Sheet
}

interface LocalCellChange {
  row: number
  col: string
  value: unknown
}

interface ContextMenuState {
  anchorX: number
  anchorY: number
  kind: 'cell' | 'column'
  row?: number
  col: string
}

interface CellRange {
  startRow: number
  endRow: number
  startCol: string
  endCol: string
}

const COLUMN_TYPES: ColumnDef['type'][] = ['text', 'number', 'currency', 'formula', 'date', 'select']
const DEFAULT_TEXT_COLOR = '#0f172a'
const QUICK_TEXT_COLORS = ['#0f172a', '#2563eb', '#059669', '#dc2626', '#d97706', '#7c3aed']
const QUICK_FILL_COLORS = ['#ffffff', '#fef3c7', '#dcfce7', '#dbeafe', '#fee2e2', '#ede9fe']
const FILTER_OPERATOR_OPTIONS: Array<{ value: FilterOperator; label: string }> = [
  { value: 'contains', label: '包含' },
  { value: 'equals', label: '等于' },
  { value: 'not_equals', label: '不等于' },
  { value: 'starts_with', label: '开头是' },
  { value: 'ends_with', label: '结尾是' },
  { value: 'greater_than', label: '大于' },
  { value: 'greater_or_equal', label: '大于等于' },
  { value: 'less_than', label: '小于' },
  { value: 'less_or_equal', label: '小于等于' },
  { value: 'is_empty', label: '为空' },
  { value: 'is_not_empty', label: '不为空' },
]

function createClientId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function parseColumns(columns: unknown): ColumnDef[] {
  if (!columns) return []

  if (Array.isArray(columns)) {
    return columns as ColumnDef[]
  }

  if (typeof columns === 'string') {
    try {
      const parsed = JSON.parse(columns)
      return Array.isArray(parsed) ? (parsed as ColumnDef[]) : []
    } catch {
      return []
    }
  }

  return []
}

function createEmptyRow(sheetId: number, rowIndex: number, value: Record<string, unknown>): Row {
  const now = new Date().toISOString()

  return {
    id: 0,
    sheet_id: sheetId,
    row_index: rowIndex,
    data: value,
    created_at: now,
    updated_at: now,
  }
}

function applyCellChanges(rows: Row[], changes: LocalCellChange[], sheetId: number): Row[] {
  const rowMap = new Map<number, Row>()

  rows.forEach((row) => {
    rowMap.set(row.row_index, {
      ...row,
      data: { ...(row.data || {}) },
    })
  })

  changes.forEach((change) => {
    const existing = rowMap.get(change.row)
    if (existing) {
      existing.data = {
        ...(existing.data || {}),
        [change.col]: change.value,
      }
      existing.updated_at = new Date().toISOString()
      return
    }

    rowMap.set(change.row, createEmptyRow(sheetId, change.row, { [change.col]: change.value }))
  })

  return Array.from(rowMap.values()).sort((a, b) => a.row_index - b.row_index)
}

function shiftRowsAfterInsert(rows: Row[], afterRow: number): Row[] {
  return rows
    .map((row) =>
      row.row_index > afterRow
        ? { ...row, row_index: row.row_index + 1 }
        : row
    )
    .sort((a, b) => a.row_index - b.row_index)
}

function shiftRowsAfterDelete(rows: Row[], targetRow: number): Row[] {
  return rows
    .filter((row) => row.row_index !== targetRow)
    .map((row) =>
      row.row_index > targetRow
        ? { ...row, row_index: row.row_index - 1 }
        : row
    )
    .sort((a, b) => a.row_index - b.row_index)
}

function formatCellValue(
  value: unknown,
  column: ColumnDef,
  rowData?: Record<string, unknown>,
  columns?: ColumnDef[]
): string {
  if (value == null || value === '') return ''

  if (column.type === 'currency') {
    return formatCurrencyValue(value, column, rowData, columns)
  }

  if (column.type === 'date') {
    const date = new Date(String(value))
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('zh-CN')
  }

  return String(value)
}

function normalizeRange(range: CellRange, columns: ColumnDef[]): CellRange {
  const startIndex = columns.findIndex((column) => column.key === range.startCol)
  const endIndex = columns.findIndex((column) => column.key === range.endCol)
  const minIndex = Math.min(startIndex, endIndex)
  const maxIndex = Math.max(startIndex, endIndex)

  return {
    startRow: Math.min(range.startRow, range.endRow),
    endRow: Math.max(range.startRow, range.endRow),
    startCol: columns[Math.max(0, minIndex)]?.key || range.startCol,
    endCol: columns[Math.max(0, maxIndex)]?.key || range.endCol,
  }
}

export default function SpreadsheetEditor({ sheetId, sheet: initialSheet }: Props) {
  const { sheet, rows, loading, setRows, setSheet } = useSheetData(sheetId, initialSheet)
  const { saveStatus, saveChange } = useAutoSave()
  const {
    permissions,
    loading: permissionsLoading,
    canEditCell,
    canViewColumn,
  } = usePermission(sheetId)
  const currentUser = getStoredUser()
  const isAdminUser = userIsAdmin(currentUser)
  const [activeCell, setActiveCell] = useState<{ row: number; col: string } | null>(null)
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [formulaText, setFormulaText] = useState('')
  const [creatingStarterColumns, setCreatingStarterColumns] = useState(false)
  const [showColumnForm, setShowColumnForm] = useState(false)
  const [columnFormMode, setColumnFormMode] = useState<'create' | 'edit'>('create')
  const [editingColumnKey, setEditingColumnKey] = useState<string | null>(null)
  const [columnInsertIndex, setColumnInsertIndex] = useState<number | null>(null)
  const [editingHeaderKey, setEditingHeaderKey] = useState<string | null>(null)
  const [headerEditValue, setHeaderEditValue] = useState('')
  const [newColumnName, setNewColumnName] = useState('')
  const [newColumnType, setNewColumnType] = useState<ColumnDef['type']>('text')
  const [newColumnOptions, setNewColumnOptions] = useState('')
  const [newCurrencyCode, setNewCurrencyCode] = useState('CNY')
  const [newCurrencySource, setNewCurrencySource] = useState('')
  const [operationError, setOperationError] = useState('')
  const [zoomLevel, setZoomLevel] = useState(100)
  const [columnWidthOverrides, setColumnWidthOverrides] = useState<Record<string, number>>({})
  const [resizingColumn, setResizingColumn] = useState<{
    key: string
    startX: number
    startWidth: number
  } | null>(null)
  const [selectionRange, setSelectionRange] = useState<CellRange | null>(null)
  const [isSelecting, setIsSelecting] = useState(false)
  const [formatPainterStyle, setFormatPainterStyle] = useState<{
    textColor?: string
    backgroundColor?: string
  } | null>(null)
  const [isPaintingFormat, setIsPaintingFormat] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const columnWidthRef = useRef<Record<string, number>>({})
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [contextMenuPosition, setContextMenuPosition] = useState<{ left: number; top: number } | null>(null)

  const parsedColumns = useMemo(() => parseColumns(sheet?.columns), [sheet?.columns])
  const sheetConfig = useMemo(() => parseSheetConfig(sheet?.config), [sheet?.config])
  const lockedCells = sheetConfig.lockedCells || {}
  const mergedCells = sheetConfig.mergedCells || []
  const advancedFilter: AdvancedFilterConfig = sheetConfig.advancedFilter || {
    match: 'all',
    rules: [],
    sorts: [],
  }
  const canViewSheet = permissions?.sheet.canView ?? true
  const canEditSheet = permissions?.sheet.canEdit ?? false
  const canManageStructure = isAdminUser
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)
  const [filterDraft, setFilterDraft] = useState<AdvancedFilterConfig>(advancedFilter)

  // Search state
  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchIndex, setSearchMatchIndex] = useState(0)

  // Column filter state
  const [columnFilterTarget, setColumnFilterTarget] = useState<{
    columnKey: string
    columnName: string
    anchorRect: DOMRect | null
  } | null>(null)

  useEffect(() => {
    setFilterDraft(advancedFilter)
  }, [advancedFilter])

  useEffect(() => {
    setZoomLevel(sheetConfig.zoom || 100)
  }, [sheetConfig.zoom, sheetId])

  useEffect(() => {
    setColumnWidthOverrides((prev) => {
      const next = { ...prev }
      parsedColumns.forEach((column) => {
        next[column.key] = next[column.key] || column.width || 160
      })

      return Object.fromEntries(parsedColumns.map((column) => [column.key, next[column.key]]))
    })
  }, [parsedColumns])

  useEffect(() => {
    columnWidthRef.current = columnWidthOverrides
  }, [columnWidthOverrides])

  const columns = useMemo(
    () => (permissions ? parsedColumns.filter((column) => canViewColumn(column.key)) : parsedColumns),
    [canViewColumn, parsedColumns, permissions]
  )

  const activeColumnIndex = activeCell
    ? columns.findIndex((column) => column.key === activeCell.col)
    : -1
  const activeParsedColumnIndex = activeCell
    ? parsedColumns.findIndex((column) => column.key === activeCell.col)
    : -1
  const activeColumn = activeColumnIndex >= 0 ? columns[activeColumnIndex] : null
  const activeCellLabel =
    activeCell && activeColumnIndex >= 0
      ? `${columnIndexToLetter(activeColumnIndex)}${activeCell.row + 1}`
      : ''
  const normalizedSelection = selectionRange ? normalizeRange(selectionRange, columns) : null
  const selectionLabel = normalizedSelection
    ? `${columnIndexToLetter(Math.max(0, columns.findIndex((column) => column.key === normalizedSelection.startCol)))}${normalizedSelection.startRow + 1}:${columnIndexToLetter(Math.max(0, columns.findIndex((column) => column.key === normalizedSelection.endCol)))}${normalizedSelection.endRow + 1}`
    : ''

  const getRawCell = useCallback(
    (rowIndex: number, colKey: string): unknown => rows.find((row) => row.row_index === rowIndex)?.data?.[colKey],
    [rows]
  )

  const isCellLocked = useCallback(
    (rowIndex: number, colKey: string) => !!lockedCells[`${rowIndex}:${colKey}`],
    [lockedCells]
  )

  const isCellEditable = useCallback(
    (colKey: string, rowIndex: number) => {
      if (!canEditCell(colKey, rowIndex)) return false
      if (!isAdminUser && isCellLocked(rowIndex, colKey)) return false
      return true
    },
    [canEditCell, isAdminUser, isCellLocked]
  )

  const getInputValue = useCallback(
    (rowIndex: number, colKey: string): string => {
      const raw = getRawCell(rowIndex, colKey)
      return getCellInputValue(raw)
    },
    [getRawCell]
  )

  const getResolvedCellValue = useCallback(
    (rowIndex: number, colKey: string) => {
      const raw = getRawCell(rowIndex, colKey)
      return evaluateCellValue(rows, parsedColumns, rowIndex, colKey, raw)
    },
    [getRawCell, parsedColumns, rows]
  )

  const rowMap = useMemo(() => new Map(rows.map((row) => [row.row_index, row])), [rows])

  const maxRows = useMemo(() => {
    const highestRow = rows.reduce((max, row) => Math.max(max, row.row_index), -1)
    return Math.max(highestRow + 9, 30)
  }, [rows])

  const displayRowIndices = useMemo(() => {
    const base = Array.from({ length: maxRows }, (_, index) => index)

    const filtered = advancedFilter.rules.length
      ? base.filter((rowIndex) => {
          const results = advancedFilter.rules.map((rule) => {
            const column = parsedColumns.find((item) => item.key === rule.columnKey)
            if (!column) return true

            const raw = rowMap.get(rowIndex)?.data?.[rule.columnKey]
            const resolved = evaluateCellValue(rows, parsedColumns, rowIndex, rule.columnKey, raw)
            const text = `${resolved ?? ''}`.trim().toLowerCase()
            const compareText = (rule.value || '').trim().toLowerCase()
            const numericValue = Number(text.replace(/[^0-9.-]/g, ''))
            const numericCompare = Number(compareText.replace(/[^0-9.-]/g, ''))

            switch (rule.operator) {
              case 'contains':
                return text.includes(compareText)
              case 'equals':
                return text === compareText
              case 'not_equals':
                return text !== compareText
              case 'starts_with':
                return text.startsWith(compareText)
              case 'ends_with':
                return text.endsWith(compareText)
              case 'greater_than':
                return Number.isFinite(numericValue) && Number.isFinite(numericCompare) && numericValue > numericCompare
              case 'greater_or_equal':
                return Number.isFinite(numericValue) && Number.isFinite(numericCompare) && numericValue >= numericCompare
              case 'less_than':
                return Number.isFinite(numericValue) && Number.isFinite(numericCompare) && numericValue < numericCompare
              case 'less_or_equal':
                return Number.isFinite(numericValue) && Number.isFinite(numericCompare) && numericValue <= numericCompare
              case 'is_empty':
                return text === ''
              case 'is_not_empty':
                return text !== ''
              default:
                return true
            }
          })

          return advancedFilter.match === 'any' ? results.some(Boolean) : results.every(Boolean)
        })
      : base

    // Apply column filters (Excel-style per-column checkbox filters)
    const columnFilters = advancedFilter.columnFilters || {}
    const columnFilterKeys = Object.keys(columnFilters)
    const columnFiltered = columnFilterKeys.length > 0
      ? filtered.filter((rowIndex) => {
          return columnFilterKeys.every((colKey) => {
            const allowedValues = columnFilters[colKey]
            if (!allowedValues || allowedValues.length === 0) return true
            const raw = rowMap.get(rowIndex)?.data?.[colKey]
            const resolved = evaluateCellValue(rows, parsedColumns, rowIndex, colKey, raw)
            const text = `${resolved ?? ''}`.trim()
            return allowedValues.includes(text)
          })
        })
      : filtered

    if (advancedFilter.sorts.length === 0) {
      return columnFiltered
    }

    return [...columnFiltered].sort((leftRow, rightRow) => {
      for (const sortRule of advancedFilter.sorts) {
        const leftRaw = rowMap.get(leftRow)?.data?.[sortRule.columnKey]
        const rightRaw = rowMap.get(rightRow)?.data?.[sortRule.columnKey]
        const leftValue = evaluateCellValue(rows, parsedColumns, leftRow, sortRule.columnKey, leftRaw)
        const rightValue = evaluateCellValue(rows, parsedColumns, rightRow, sortRule.columnKey, rightRaw)
        const leftText = `${leftValue ?? ''}`.trim()
        const rightText = `${rightValue ?? ''}`.trim()

        if (!leftText && !rightText) continue
        if (!leftText) return 1
        if (!rightText) return -1

        const leftNumber = Number(leftText.replace(/[^0-9.-]/g, ''))
        const rightNumber = Number(rightText.replace(/[^0-9.-]/g, ''))
        const direction = sortRule.direction === 'asc' ? 1 : -1

        if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
          if (leftNumber !== rightNumber) {
            return leftNumber > rightNumber ? direction : -direction
          }
          continue
        }

        const comparison = leftText.localeCompare(rightText, 'zh-CN', { numeric: true, sensitivity: 'base' })
        if (comparison !== 0) {
          return comparison * direction
        }
      }

      return leftRow - rightRow
    })
  }, [advancedFilter, maxRows, parsedColumns, rowMap, rows])

  const displayRowPositionMap = useMemo(
    () => new Map(displayRowIndices.map((rowIndex, position) => [rowIndex, position])),
    [displayRowIndices]
  )

  // Search: compute matches
  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return []
    const q = searchQuery.toLowerCase()
    const matches: Array<{ row: number; col: string }> = []
    for (const rowIndex of displayRowIndices) {
      for (const column of columns) {
        const raw = rowMap.get(rowIndex)?.data?.[column.key]
        const resolved = evaluateCellValue(rows, parsedColumns, rowIndex, column.key, raw)
        const text = `${resolved ?? ''}`.toLowerCase()
        if (text.includes(q)) {
          matches.push({ row: rowIndex, col: column.key })
        }
      }
    }
    return matches
  }, [searchQuery, displayRowIndices, columns, rowMap, rows, parsedColumns])

  const isSearchMatch = useCallback(
    (rowIndex: number, colKey: string) => {
      if (!searchQuery.trim()) return false
      return searchMatches.some((m) => m.row === rowIndex && m.col === colKey)
    },
    [searchMatches, searchQuery]
  )

  const isCurrentSearchMatch = useCallback(
    (rowIndex: number, colKey: string) => {
      if (searchMatches.length === 0) return false
      const current = searchMatches[searchMatchIndex]
      return current?.row === rowIndex && current?.col === colKey
    },
    [searchMatches, searchMatchIndex]
  )

  const handleSearchNext = useCallback(() => {
    if (searchMatches.length === 0) return
    const nextIndex = (searchMatchIndex + 1) % searchMatches.length
    setSearchMatchIndex(nextIndex)
    const match = searchMatches[nextIndex]
    if (match) setActiveCell({ row: match.row, col: match.col })
  }, [searchMatches, searchMatchIndex])

  const handleSearchPrev = useCallback(() => {
    if (searchMatches.length === 0) return
    const prevIndex = (searchMatchIndex - 1 + searchMatches.length) % searchMatches.length
    setSearchMatchIndex(prevIndex)
    const match = searchMatches[prevIndex]
    if (match) setActiveCell({ row: match.row, col: match.col })
  }, [searchMatches, searchMatchIndex])

  // Column filter: get unique values for a column
  const getUniqueValuesForColumn = useCallback(
    (columnKey: string): string[] => {
      const values = new Set<string>()
      for (const rowIndex of displayRowIndices) {
        const raw = rowMap.get(rowIndex)?.data?.[columnKey]
        const resolved = evaluateCellValue(rows, parsedColumns, rowIndex, columnKey, raw)
        values.add(`${resolved ?? ''}`.trim())
      }
      return Array.from(values).sort((a, b) => a.localeCompare(b, 'zh-CN'))
    },
    [displayRowIndices, rowMap, rows, parsedColumns]
  )

  const persistStructure = useCallback(
    async (nextColumns: ColumnDef[], nextConfig: SheetConfig) => {
      if (!sheet) return

      const nextSheet: Sheet = {
        ...sheet,
        columns: nextColumns,
        config: nextConfig,
      }

      await api.put(`/sheets/${sheetId}`, {
        name: nextSheet.name,
        sort_order: nextSheet.sort_order,
        columns: nextColumns,
        frozen: nextSheet.frozen || { row: 0, col: 0 },
        config: nextConfig,
      })

      setSheet(nextSheet)
    },
    [setSheet, sheet, sheetId]
  )

  const handleColumnFilterApply = useCallback(
    async (columnKey: string, selectedValues: Set<string>) => {
      const nextColumnFilters = {
        ...(advancedFilter.columnFilters || {}),
        [columnKey]: Array.from(selectedValues),
      }
      const nextFilter = { ...advancedFilter, columnFilters: nextColumnFilters }
      setFilterDraft(nextFilter)
      setColumnFilterTarget(null)
      try {
        await persistStructure(parsedColumns, {
          ...sheetConfig,
          advancedFilter: nextFilter,
        })
      } catch (err) {
        console.error('Failed to apply column filter:', err)
      }
    },
    [advancedFilter, parsedColumns, persistStructure, sheetConfig]
  )

  const getMergeForCell = useCallback(
    (rowIndex: number, colKey: string) =>
      mergedCells.find((range) => {
        const startIndex = columns.findIndex((column) => column.key === range.startCol)
        const endIndex = columns.findIndex((column) => column.key === range.endCol)
        const currentIndex = columns.findIndex((column) => column.key === colKey)

        return (
          rowIndex >= range.startRow &&
          rowIndex <= range.endRow &&
          currentIndex >= Math.min(startIndex, endIndex) &&
          currentIndex <= Math.max(startIndex, endIndex)
        )
      }) || null,
    [columns, mergedCells]
  )

  const getRenderableMerge = useCallback(
    (rowIndex: number, colKey: string) => {
      const merge = getMergeForCell(rowIndex, colKey)
      if (!merge) return null

      const startColIndex = columns.findIndex((column) => column.key === merge.startCol)
      const endColIndex = columns.findIndex((column) => column.key === merge.endCol)
      const startRowPosition = displayRowPositionMap.get(merge.startRow)
      const endRowPosition = displayRowPositionMap.get(merge.endRow)

      if (
        startColIndex < 0 ||
        endColIndex < 0 ||
        startRowPosition === undefined ||
        endRowPosition === undefined
      ) {
        return null
      }

      const expectedRows = Array.from({ length: merge.endRow - merge.startRow + 1 }, (_, index) => merge.startRow + index)
      const visibleRows = displayRowIndices.slice(startRowPosition, endRowPosition + 1)
      const renderableRows =
        visibleRows.length === expectedRows.length && visibleRows.every((value, index) => value === expectedRows[index])

      if (!renderableRows) {
        return null
      }

      const normalizedMerge = normalizeRange(merge, columns)
      const rowSpan = endRowPosition - startRowPosition + 1
      const colSpan =
        columns.findIndex((column) => column.key === normalizedMerge.endCol) -
        columns.findIndex((column) => column.key === normalizedMerge.startCol) +
        1

      if (rowIndex === normalizedMerge.startRow && colKey === normalizedMerge.startCol) {
        return { merge: normalizedMerge, rowSpan, colSpan, hidden: false }
      }

      return { merge: normalizedMerge, rowSpan, colSpan, hidden: true }
    },
    [columns, displayRowIndices, displayRowPositionMap, getMergeForCell]
  )

  const activeRawCell = activeCell ? getRawCell(activeCell.row, activeCell.col) : null
  const activeTextColor = getCellStyle(activeRawCell)?.textColor || DEFAULT_TEXT_COLOR
  const activeFillColor = getCellStyle(activeRawCell)?.backgroundColor || '#ffffff'
  const activeCellLocked = activeCell ? isCellLocked(activeCell.row, activeCell.col) : false
  const formulaReadOnly = !activeCell || !isCellEditable(activeCell.col, activeCell.row)
  const cellMinHeight = Math.max(34, Math.round(40 * (zoomLevel / 100)))
  const cellFontSize = Math.max(12, Math.round(14 * (zoomLevel / 100)))

  const getColumnWidth = useCallback(
    (column: ColumnDef) => columnWidthOverrides[column.key] || column.width || 160,
    [columnWidthOverrides]
  )

  const getColumnIndexByKey = useCallback(
    (columnKey: string) => columns.findIndex((column) => column.key === columnKey),
    [columns]
  )

  const isCellInSelection = useCallback(
    (rowIndex: number, colKey: string) => {
      if (!normalizedSelection) return false

      const startIndex = getColumnIndexByKey(normalizedSelection.startCol)
      const endIndex = getColumnIndexByKey(normalizedSelection.endCol)
      const currentIndex = getColumnIndexByKey(colKey)

      return (
        rowIndex >= normalizedSelection.startRow &&
        rowIndex <= normalizedSelection.endRow &&
        currentIndex >= startIndex &&
        currentIndex <= endIndex
      )
    },
    [getColumnIndexByKey, normalizedSelection]
  )

  const resetColumnForm = useCallback(() => {
    setShowColumnForm(false)
    setColumnFormMode('create')
    setEditingColumnKey(null)
    setColumnInsertIndex(null)
    setNewColumnName('')
    setNewColumnOptions('')
    setNewColumnType('text')
    setNewCurrencyCode('CNY')
    setNewCurrencySource('')
  }, [])

  const openCreateColumnForm = useCallback(
    (insertIndex?: number) => {
      setColumnFormMode('create')
      setEditingColumnKey(null)
      setColumnInsertIndex(insertIndex ?? (activeParsedColumnIndex >= 0 ? activeParsedColumnIndex + 1 : parsedColumns.length))
      setNewColumnName('')
      setNewColumnOptions('')
      setNewColumnType('text')
      setNewCurrencyCode('CNY')
      setNewCurrencySource('')
      setShowColumnForm(true)
      setContextMenu(null)
    },
    [activeParsedColumnIndex, parsedColumns.length]
  )

  const openEditColumnForm = useCallback(
    (columnKey: string) => {
      const targetColumn = parsedColumns.find((column) => column.key === columnKey)
      if (!targetColumn) return

      setColumnFormMode('edit')
      setEditingColumnKey(columnKey)
      setColumnInsertIndex(parsedColumns.findIndex((column) => column.key === columnKey))
      setNewColumnName(targetColumn.name)
      setNewColumnType(targetColumn.type)
      setNewColumnOptions(targetColumn.options?.join(', ') || '')
      setNewCurrencyCode(targetColumn.currencyCode || 'CNY')
      setNewCurrencySource(targetColumn.currencySource || '')
      setShowColumnForm(true)
      setContextMenu(null)
    },
    [parsedColumns]
  )

  useEffect(() => {
    wsClient.connect()
    wsClient.joinSheet(sheetId)

    const unsubCell = wsClient.on('cell_update', (msg: WSMessage) => {
      if (msg.sheetId !== sheetId || msg.row === undefined || !msg.col) return
      const row = msg.row
      const col = msg.col
      setRows((prev) => applyCellChanges(prev, [{ row, col, value: msg.value }], sheetId))
    })

    const unsubBatch = wsClient.on('batch_update', (msg: WSMessage) => {
      if (msg.sheetId !== sheetId || !msg.changes?.length) return
      const changes = msg.changes.map((change) => ({
        row: change.row,
        col: change.col,
        value: change.value,
      }))
      setRows((prev) => applyCellChanges(prev, changes, sheetId))
    })

    const unsubInsert = wsClient.on('row_insert', (msg: WSMessage) => {
      if (msg.sheetId !== sheetId || msg.afterRow === undefined) return
      const afterRow = msg.afterRow
      setRows((prev) => shiftRowsAfterInsert(prev, afterRow))
    })

    const unsubDelete = wsClient.on('row_delete', (msg: WSMessage) => {
      if (msg.sheetId !== sheetId || msg.row === undefined) return
      const row = msg.row
      setRows((prev) => shiftRowsAfterDelete(prev, row))
    })

    return () => {
      unsubCell()
      unsubBatch()
      unsubInsert()
      unsubDelete()
      wsClient.disconnect()
    }
  }, [setRows, sheetId])

  useEffect(() => {
    if (!resizingColumn) return

    const handleMouseMove = (event: MouseEvent) => {
      const nextWidth = Math.max(110, resizingColumn.startWidth + event.clientX - resizingColumn.startX)
      setColumnWidthOverrides((prev) => ({
        ...prev,
        [resizingColumn.key]: nextWidth,
      }))
    }

    const handleMouseUp = async () => {
      const finalWidth = columnWidthRef.current[resizingColumn.key] || resizingColumn.startWidth

      if (canManageStructure) {
        try {
          await persistStructure(
            parsedColumns.map((column) =>
              column.key === resizingColumn.key ? { ...column, width: finalWidth } : column
            ),
            sheetConfig
          )
        } catch (err) {
          console.error('Failed to persist column width:', err)
          setOperationError('保存列宽失败，请稍后再试。')
        }
      }

      setResizingColumn(null)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [canManageStructure, parsedColumns, persistStructure, resizingColumn, sheetConfig])

  useEffect(() => {
    if (!contextMenu) return

    const frame = window.requestAnimationFrame(() => {
      const menu = contextMenuRef.current
      const gap = 8
      const width = menu?.offsetWidth || 240
      const height = menu?.offsetHeight || 220

      let left = contextMenu.anchorX + gap
      let top = contextMenu.anchorY + gap

      if (left + width > window.innerWidth - gap) {
        left = Math.max(gap, contextMenu.anchorX - width - gap)
      }

      if (top + height > window.innerHeight - gap) {
        top = Math.max(gap, contextMenu.anchorY - height - gap)
      }

      setContextMenuPosition({ left, top })
    })

    const handleClose = () => setContextMenu(null)
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null)
      }
    }

    window.addEventListener('click', handleClose)
    window.addEventListener('scroll', handleClose, true)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('click', handleClose)
      window.removeEventListener('scroll', handleClose, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!contextMenu) {
      setContextMenuPosition(null)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!activeCell) {
      setFormulaText('')
      return
    }

    setFormulaText(getInputValue(activeCell.row, activeCell.col))
  }, [activeCell, getInputValue, rows])

  const applyCellUpdates = useCallback(
    (changes: LocalCellChange[]) => {
      if (changes.length === 0) return
      setRows((prev) => applyCellChanges(prev, changes, sheetId))
      changes.forEach((change) => {
        saveChange({
          sheet_id: sheetId,
          row: change.row,
          col: change.col,
          value: change.value,
        })
      })
    },
    [saveChange, setRows, sheetId]
  )

  const handleCellClick = (rowIndex: number, colKey: string) => {
    setContextMenu(null)
    setActiveCell({ row: rowIndex, col: colKey })
    setSelectionRange({ startRow: rowIndex, endRow: rowIndex, startCol: colKey, endCol: colKey })
    containerRef.current?.focus()
  }

  const handleCellMouseDown = (rowIndex: number, colKey: string) => {
    setContextMenu(null)
    setActiveCell({ row: rowIndex, col: colKey })
    setSelectionRange({ startRow: rowIndex, endRow: rowIndex, startCol: colKey, endCol: colKey })
    setIsSelecting(true)
    setIsPaintingFormat(!!formatPainterStyle)
    containerRef.current?.focus()
  }

  const handleCellMouseEnter = (rowIndex: number, colKey: string) => {
    if (!isSelecting && !isPaintingFormat) return
    setSelectionRange((prev) =>
      prev
        ? {
            ...prev,
            endRow: rowIndex,
            endCol: colKey,
          }
        : { startRow: rowIndex, endRow: rowIndex, startCol: colKey, endCol: colKey }
    )
  }

  const handleCellMouseMove = (rowIndex: number, colKey: string) => {
    if (!isSelecting && !isPaintingFormat) return
    setSelectionRange((prev) =>
      prev
        ? {
            ...prev,
            endRow: rowIndex,
            endCol: colKey,
          }
        : { startRow: rowIndex, endRow: rowIndex, startCol: colKey, endCol: colKey }
    )
  }

  const handleCellDoubleClick = (rowIndex: number, colKey: string) => {
    if (!isCellEditable(colKey, rowIndex)) return
    setActiveCell({ row: rowIndex, col: colKey })
    setEditingCell({ row: rowIndex, col: colKey })
    setEditValue(getInputValue(rowIndex, colKey))
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const openCellContextMenu = useCallback(
    (event: React.MouseEvent, row: number, col: string) => {
      event.preventDefault()
      setActiveCell({ row, col })
      setContextMenu({ anchorX: event.clientX, anchorY: event.clientY, kind: 'cell', row, col })
    },
    []
  )

  const openColumnContextMenu = useCallback(
    (event: React.MouseEvent, col: string) => {
      event.preventDefault()
      setActiveCell((prev) => ({ row: prev?.row ?? 0, col }))
      setContextMenu({ anchorX: event.clientX, anchorY: event.clientY, kind: 'column', col })
    },
    []
  )

  const commitActiveValue = useCallback(
    (nextValue: string, target = editingCell || activeCell) => {
      if (!target) return
      if (!isCellEditable(target.col, target.row)) return

      const column = columns.find((item) => item.key === target.col)
      const existingRaw = getRawCell(target.row, target.col)
      const normalized = normalizeCellValue(nextValue, column || undefined)
      const nextStoredValue = mergeCellRecord(existingRaw, normalized, getCellStyle(existingRaw))

      applyCellUpdates([{ row: target.row, col: target.col, value: nextStoredValue }])
      setEditingCell(null)
      setEditValue('')
    },
    [activeCell, applyCellUpdates, columns, editingCell, getRawCell, isCellEditable]
  )

  const insertRowAfter = useCallback(
    async (afterRow: number, focusRow = afterRow + 1, focusCol?: string) => {
      setOperationError('')

      try {
        await api.post(`/sheets/${sheetId}/rows`, { after_row: afterRow })
        setRows((prev) => shiftRowsAfterInsert(prev, afterRow))
        if (columns.length > 0) {
          setActiveCell({ row: Math.max(0, focusRow), col: focusCol || activeCell?.col || columns[0].key })
        }
        wsClient.send({ type: 'row_insert', sheetId, afterRow })
      } catch (err) {
        console.error('Failed to insert row:', err)
        setOperationError('插入行失败，请稍后再试。')
      }
    },
    [activeCell?.col, columns, setRows, sheetId]
  )

  const handleAddRow = async () => {
    await insertRowAfter(activeCell ? activeCell.row : rows.length - 1)
  }

  const deleteRowAt = useCallback(
    async (rowIndex: number) => {
      setOperationError('')

      try {
        await api.delete(`/sheets/${sheetId}/rows/${rowIndex}`)
        setRows((prev) => shiftRowsAfterDelete(prev, rowIndex))
        wsClient.send({ type: 'row_delete', sheetId, row: rowIndex })
      } catch (err) {
        console.error('Failed to delete row:', err)
        setOperationError('删除行失败，请稍后再试。')
      }
    },
    [setRows, sheetId]
  )

  const handleDeleteRow = async () => {
    if (!activeCell) return
    await deleteRowAt(activeCell.row)
  }

  const clearCellAt = useCallback(
    (row: number, col: string) => {
      if (!isCellEditable(col, row)) return
      applyCellUpdates([{ row, col, value: '' }])
    },
    [applyCellUpdates, isCellEditable]
  )

  const applyStyleAt = useCallback(
    (row: number, col: string, stylePatch: Partial<{ textColor: string; backgroundColor: string }>) => {
      if (!isCellEditable(col, row)) return

      const existingRaw = getRawCell(row, col)
      const currentValue = getStoredCellValue(existingRaw) ?? ''
      const nextStoredValue = mergeCellRecord(existingRaw, currentValue, {
        ...(getCellStyle(existingRaw) || {}),
        ...stylePatch,
      })

      applyCellUpdates([{ row, col, value: nextStoredValue }])
    },
    [applyCellUpdates, getRawCell, isCellEditable]
  )

  const applyStyleToRange = useCallback(
    (range: CellRange, stylePatch: Partial<{ textColor: string; backgroundColor: string }>) => {
      const normalized = normalizeRange(range, columns)
      const startIndex = getColumnIndexByKey(normalized.startCol)
      const endIndex = getColumnIndexByKey(normalized.endCol)

      for (let rowCursor = normalized.startRow; rowCursor <= normalized.endRow; rowCursor += 1) {
        for (let colCursor = startIndex; colCursor <= endIndex; colCursor += 1) {
          const targetColumn = columns[colCursor]
          if (!targetColumn) continue
          applyStyleAt(rowCursor, targetColumn.key, stylePatch)
        }
      }
    },
    [applyStyleAt, columns, getColumnIndexByKey]
  )

  useEffect(() => {
    if (!isSelecting && !isPaintingFormat) return

    const handleMouseUp = () => {
      if (isPaintingFormat && formatPainterStyle && selectionRange) {
        applyStyleToRange(selectionRange, formatPainterStyle)
        setFormatPainterStyle(null)
      }

      setIsSelecting(false)
      setIsPaintingFormat(false)
    }

    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [applyStyleToRange, formatPainterStyle, isPaintingFormat, isSelecting, selectionRange])

  const handleSaveColumn = async () => {
    if (!sheet || !newColumnName.trim()) return

    setOperationError('')

    try {
      const baseColumn: ColumnDef = {
        key: editingColumnKey || buildNextColumnKey(parsedColumns),
        name: newColumnName.trim(),
        type: newColumnType,
        width: editingColumnKey
          ? getColumnWidth(parsedColumns.find((column) => column.key === editingColumnKey) || { key: '', name: '', type: 'text' })
          : 160,
        ...(newColumnType === 'currency'
          ? {
              currencyCode: newCurrencyCode.trim().toUpperCase() || 'CNY',
              currencySource: newCurrencySource.trim() || undefined,
            }
          : {}),
        ...(newColumnType === 'select' && newColumnOptions.trim()
          ? { options: newColumnOptions.split(',').map((item) => item.trim()).filter(Boolean) }
          : {}),
      }

      if (columnFormMode === 'edit' && editingColumnKey) {
        const nextColumns = parsedColumns.map((column) =>
          column.key === editingColumnKey
            ? {
                ...column,
                ...baseColumn,
                ...(newColumnType === 'select'
                  ? { options: baseColumn.options || [] }
                  : { options: undefined }),
                ...(newColumnType === 'currency'
                  ? {
                      currencyCode: baseColumn.currencyCode,
                      currencySource: baseColumn.currencySource,
                    }
                  : { currencyCode: undefined, currencySource: undefined }),
              }
            : column
        )

        await persistStructure(nextColumns, sheetConfig)
        resetColumnForm()
        return
      }

      const insertIndex = columnInsertIndex ?? (activeParsedColumnIndex >= 0 ? activeParsedColumnIndex + 1 : parsedColumns.length)
      const nextColumns = [...parsedColumns]
      nextColumns.splice(Math.max(0, insertIndex), 0, baseColumn)

      await persistStructure(nextColumns, sheetConfig)
      setColumnWidthOverrides((prev) => ({ ...prev, [baseColumn.key]: baseColumn.width || 160 }))
      resetColumnForm()
      setActiveCell((prev) => ({ row: prev?.row ?? 0, col: baseColumn.key }))
    } catch (err) {
      console.error('Failed to save column:', err)
      setOperationError('保存列定义失败，请稍后再试。')
    }
  }

  const saveHeaderName = useCallback(
    async (columnKey: string, nextName: string) => {
      const trimmedName = nextName.trim()
      if (!trimmedName) {
        setEditingHeaderKey(null)
        setHeaderEditValue('')
        return
      }

      try {
        const nextColumns = parsedColumns.map((column) =>
          column.key === columnKey ? { ...column, name: trimmedName } : column
        )
        await persistStructure(nextColumns, sheetConfig)
      } catch (err) {
        console.error('Failed to rename column:', err)
        setOperationError('修改列名失败，请稍后再试。')
      } finally {
        setEditingHeaderKey(null)
        setHeaderEditValue('')
      }
    },
    [parsedColumns, persistStructure, sheetConfig]
  )

  const deleteColumnByKey = useCallback(
    async (columnKey: string) => {
      if (!sheet) return

      const nextColumns = parsedColumns.filter((column) => column.key !== columnKey)
      if (nextColumns.length === parsedColumns.length) return

      const nextLockedCells = Object.fromEntries(
        Object.entries(lockedCells).filter(([cellKey]) => !cellKey.endsWith(`:${columnKey}`))
      )

      setOperationError('')

      try {
        await persistStructure(nextColumns, {
          ...sheetConfig,
          lockedCells: nextLockedCells,
        })

        const nextVisibleColumns = nextColumns.filter((column) => canViewColumn(column.key))
        setActiveCell(
          nextVisibleColumns.length > 0
            ? {
                row: activeCell?.row ?? 0,
                col: nextVisibleColumns[Math.max(0, activeColumnIndex - 1)]?.key || nextVisibleColumns[0].key,
              }
            : null
        )
      } catch (err) {
        console.error('Failed to delete column:', err)
        setOperationError('删除列失败，请稍后再试。')
      }
    },
    [activeCell?.row, activeColumnIndex, canViewColumn, lockedCells, parsedColumns, persistStructure, sheet, sheetConfig]
  )

  const handleDeleteColumn = async () => {
    if (!activeCell) return
    await deleteColumnByKey(activeCell.col)
  }

  const toggleLockAt = useCallback(
    async (row: number, col: string) => {
      if (!sheet) return

      const lockKey = `${row}:${col}`
      const nextLockedCells = { ...lockedCells }

      if (nextLockedCells[lockKey]) {
        delete nextLockedCells[lockKey]
      } else {
        nextLockedCells[lockKey] = true
      }

      setOperationError('')

      try {
        await persistStructure(parsedColumns, {
          ...sheetConfig,
          lockedCells: nextLockedCells,
        })
      } catch (err) {
        console.error('Failed to toggle cell lock:', err)
        setOperationError('更新锁定状态失败，请稍后再试。')
      }
    },
    [lockedCells, parsedColumns, persistStructure, sheet, sheetConfig]
  )

  const handleToggleLock = async () => {
    if (!activeCell) return
    await toggleLockAt(activeCell.row, activeCell.col)
  }

  const handleApplyTextColor = (color: string) => {
    if (!activeCell) return
    applyStyleAt(activeCell.row, activeCell.col, { textColor: color })
  }

  const handleApplyFillColor = (color: string) => {
    if (!activeCell) return
    applyStyleAt(activeCell.row, activeCell.col, { backgroundColor: color })
  }

  const handlePaste = async (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!activeCell) return

    const plain = event.clipboardData.getData('text/plain')
    const html = event.clipboardData.getData('text/html')
    if (!plain && !html) return

    event.preventDefault()
    setOperationError('')

    const matrix = parseClipboardMatrix(plain, html)
    if (matrix.length === 0) return

    const startColumnIndex = columns.findIndex((column) => column.key === activeCell.col)
    if (startColumnIndex < 0) return

    let workingParsedColumns = parsedColumns
    let workingColumns = columns
    const widestRow = Math.max(...matrix.map((row) => row.length))
    const missingCount = Math.max(0, startColumnIndex + widestRow - workingColumns.length)

    if (missingCount > 0) {
      if (!canManageStructure) {
        setOperationError('当前可见列不足，且你没有自动扩展列的权限。')
        return
      }

      const autoColumns: ColumnDef[] = []
      for (let index = 0; index < missingCount; index += 1) {
        autoColumns.push({
          key: buildNextColumnKey([...workingParsedColumns, ...autoColumns]),
          name: `导入列 ${workingParsedColumns.length + index + 1}`,
          type: 'text',
          width: 160,
        })
      }

      workingParsedColumns = [...workingParsedColumns, ...autoColumns]

      try {
        await persistStructure(workingParsedColumns, sheetConfig)
        setColumnWidthOverrides((prev) => ({
          ...prev,
          ...Object.fromEntries(autoColumns.map((column) => [column.key, column.width || 160])),
        }))
        workingColumns = permissions
          ? workingParsedColumns.filter((column) => canViewColumn(column.key))
          : workingParsedColumns
      } catch (err) {
        console.error('Failed to auto-create import columns:', err)
        setOperationError('自动扩展导入列失败，请稍后再试。')
        return
      }
    }

    const updates: LocalCellChange[] = []

    matrix.forEach((clipboardRow, rowOffset) => {
      clipboardRow.forEach((clipboardCell, colOffset) => {
        const column = workingColumns[startColumnIndex + colOffset]
        if (!column) return

        const rowIndex = activeCell.row + rowOffset
        if (!isCellEditable(column.key, rowIndex)) return

        const existingRaw = getRawCell(rowIndex, column.key)
        const normalized = normalizeCellValue(clipboardCell.value, column)
        const nextStoredValue = mergeCellRecord(existingRaw, normalized, clipboardCell.style || getCellStyle(existingRaw))

        updates.push({
          row: rowIndex,
          col: column.key,
          value: nextStoredValue,
        })
      })
    })

    applyCellUpdates(updates)
  }

  const handleCreateStarterColumns = async () => {
    if (!sheet) return

    setCreatingStarterColumns(true)
    setOperationError('')

    try {
      await persistStructure(DEFAULT_SHEET_COLUMNS, sheetConfig)
      setActiveCell({ row: 0, col: DEFAULT_SHEET_COLUMNS[0].key })
    } catch (err) {
      console.error('Failed to create starter columns:', err)
      setOperationError('创建基础字段失败，请稍后再试。')
    } finally {
      setCreatingStarterColumns(false)
    }
  }

  const handleMergeSelection = async () => {
    if (!normalizedSelection || !sheet) return

    const isSingleCell =
      normalizedSelection.startRow === normalizedSelection.endRow &&
      normalizedSelection.startCol === normalizedSelection.endCol
    if (isSingleCell) return

    const nextMergedCells = [
      ...mergedCells.filter((range) => {
        const rowOverlap =
          normalizedSelection.endRow < range.startRow || normalizedSelection.startRow > range.endRow
        const currentStartIndex = getColumnIndexByKey(normalizedSelection.startCol)
        const currentEndIndex = getColumnIndexByKey(normalizedSelection.endCol)
        const rangeStartIndex = getColumnIndexByKey(range.startCol)
        const rangeEndIndex = getColumnIndexByKey(range.endCol)
        const colOverlap = currentEndIndex < rangeStartIndex || currentStartIndex > rangeEndIndex
        return rowOverlap || colOverlap
      }),
      {
        startRow: normalizedSelection.startRow,
        endRow: normalizedSelection.endRow,
        startCol: normalizedSelection.startCol,
        endCol: normalizedSelection.endCol,
      },
    ]

    try {
      await persistStructure(parsedColumns, {
        ...sheetConfig,
        mergedCells: nextMergedCells,
      })
    } catch (err) {
      console.error('Failed to merge cells:', err)
      setOperationError('合并单元格失败，请稍后再试。')
    }
  }

  const unmergeAt = useCallback(
    async (rowIndex: number, colKey: string) => {
      const targetMerge = getMergeForCell(rowIndex, colKey)
      if (!targetMerge) return

      try {
        await persistStructure(parsedColumns, {
          ...sheetConfig,
          mergedCells: mergedCells.filter(
            (range) =>
              !(
                range.startRow === targetMerge.startRow &&
                range.endRow === targetMerge.endRow &&
                range.startCol === targetMerge.startCol &&
                range.endCol === targetMerge.endCol
              )
          ),
        })
      } catch (err) {
        console.error('Failed to unmerge cells:', err)
        setOperationError('取消合并失败，请稍后再试。')
      }
    },
    [getMergeForCell, mergedCells, parsedColumns, persistStructure, sheetConfig]
  )

  const saveAdvancedFilter = async () => {
    try {
      await persistStructure(parsedColumns, {
        ...sheetConfig,
        advancedFilter: filterDraft,
      })
      setShowAdvancedFilter(false)
    } catch (err) {
      console.error('Failed to save filter config:', err)
      setOperationError('保存筛选配置失败，请稍后再试。')
    }
  }

  const resetAdvancedFilter = async () => {
    const cleared: AdvancedFilterConfig = { match: 'all', rules: [], sorts: [] }
    setFilterDraft(cleared)

    try {
      await persistStructure(parsedColumns, {
        ...sheetConfig,
        advancedFilter: cleared,
      })
      setShowAdvancedFilter(false)
    } catch (err) {
      console.error('Failed to reset filter config:', err)
      setOperationError('重置筛选配置失败，请稍后再试。')
    }
  }

  const addFilterRule = () => {
    setFilterDraft((prev) => ({
      ...prev,
      rules: [
        ...prev.rules,
        {
          id: createClientId('filter'),
          columnKey: columns[0]?.key || parsedColumns[0]?.key || '',
          operator: 'contains',
          value: '',
        },
      ],
    }))
  }

  const addSortRule = () => {
    setFilterDraft((prev) => ({
      ...prev,
      sorts: [
        ...prev.sorts,
        {
          id: createClientId('sort'),
          columnKey: columns[0]?.key || parsedColumns[0]?.key || '',
          direction: 'asc',
        },
      ],
    }))
  }

  const applyQuickSort = async (columnKey: string, direction: 'asc' | 'desc') => {
    const nextFilter = {
      ...advancedFilter,
      sorts: [{ id: createClientId('sort'), columnKey, direction }],
    }

    setFilterDraft(nextFilter)
    try {
      await persistStructure(parsedColumns, {
        ...sheetConfig,
        advancedFilter: nextFilter,
      })
    } catch (err) {
      console.error('Failed to sort column:', err)
      setOperationError('排序失败，请稍后再试。')
    }
  }

  const handleGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Ctrl+F: open search
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      setShowSearch(true)
      return
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      if (columns.length === 0) return
      setSelectionRange({
        startRow: 0,
        endRow: displayRowIndices[displayRowIndices.length - 1] ?? 0,
        startCol: columns[0].key,
        endCol: columns[columns.length - 1].key,
      })
      setActiveCell({ row: 0, col: columns[0].key })
      return
    }

    if (event.key === 'Escape') {
      setSelectionRange(null)
      setFormatPainterStyle(null)
      setIsSelecting(false)
      setIsPaintingFormat(false)
    }
  }

  const contextColumnIndex = contextMenu
    ? parsedColumns.findIndex((column) => column.key === contextMenu.col)
    : -1
  const activeMerge = activeCell ? getMergeForCell(activeCell.row, activeCell.col) : null
  const canMergeSelection =
    !!normalizedSelection &&
    (normalizedSelection.startRow !== normalizedSelection.endRow ||
      normalizedSelection.startCol !== normalizedSelection.endCol)

  if (loading || permissionsLoading) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center rounded-[28px] border border-slate-200/80 bg-white/90">
        <div className="text-center text-slate-500">
          <div className="mb-3 text-sm font-medium uppercase tracking-[0.24em] text-sky-600">
            Loading
          </div>
          <div className="text-lg font-semibold text-slate-800">正在准备工作表...</div>
        </div>
      </div>
    )
  }

  if (!canViewSheet) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center rounded-[28px] border border-amber-200 bg-amber-50/70 px-6 text-center">
        <div className="max-w-md space-y-3">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-white text-amber-600 shadow-sm">
            <Lock className="h-7 w-7" />
          </div>
          <h2 className="text-2xl font-semibold text-slate-900">当前角色没有查看权限</h2>
          <p className="text-sm leading-6 text-slate-600">
            请先在权限配置里为当前角色开启此工作表的查看权限，然后再进入编辑视图。
          </p>
        </div>
      </div>
    )
  }

  if (parsedColumns.length === 0) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center rounded-[28px] border border-dashed border-slate-300 bg-[linear-gradient(180deg,rgba(248,250,252,0.95),rgba(255,255,255,0.98))] px-6 py-10">
        <div className="max-w-xl text-center">
          <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-[28px] bg-[linear-gradient(135deg,#e0f2fe,#fef3c7)] text-slate-900 shadow-[0_18px_40px_-24px_rgba(15,23,42,0.5)]">
            <FileSpreadsheet className="h-8 w-8" />
          </div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-sky-100 bg-sky-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">
            <Sparkles className="h-3.5 w-3.5" />
            Template
          </div>
          <h2 className="text-3xl font-semibold tracking-tight text-slate-950">这张表还没有字段结构</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            {canManageStructure
              ? '先建立一个表模板，再让员工按模板录入数据。你可以一键生成基础字段，也可以继续使用上方的添加列能力细化模板。'
              : '当前工作表模板还没配置完成。请联系管理员先定义列结构和锁定规则。'}
          </p>

          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {DEFAULT_SHEET_COLUMNS.map((column) => (
              <span
                key={column.key}
                className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-sm"
              >
                {column.name}
              </span>
            ))}
          </div>

          {canManageStructure && (
            <button
              type="button"
              onClick={handleCreateStarterColumns}
              disabled={creatingStarterColumns}
              className="mt-8 inline-flex items-center gap-2 rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_40px_-24px_rgba(15,23,42,0.9)] transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <TableProperties className="h-4 w-4" />
              {creatingStarterColumns ? '正在创建字段...' : '一键创建基础字段'}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[28px] border border-slate-200/80 bg-white shadow-[0_25px_80px_-48px_rgba(15,23,42,0.45)]">
      <Toolbar
        saveStatus={saveStatus}
        activeCellLabel={activeCellLabel}
        zoomLevel={zoomLevel}
        canEditSheet={canEditSheet}
        canManageStructure={canManageStructure}
        canDeleteRow={!!activeCell}
        canDeleteColumn={!!activeCell && columns.some((column) => column.key === activeCell.col)}
        isActiveCellLocked={activeCellLocked}
        activeTextColor={activeTextColor}
        onZoomChange={setZoomLevel}
        onAddRow={handleAddRow}
        onDeleteRow={handleDeleteRow}
        onOpenAddColumn={() =>
          showColumnForm && columnFormMode === 'create' ? resetColumnForm() : openCreateColumnForm()
        }
        onDeleteColumn={handleDeleteColumn}
        onToggleLock={handleToggleLock}
        onTextColorChange={handleApplyTextColor}
      />

      {showColumnForm && canManageStructure && (
        <div className="border-b border-slate-200/80 bg-slate-50/80 px-4 py-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">
                {columnFormMode === 'edit' ? '编辑列定义' : '新增列定义'}
              </div>
              <div className="text-xs text-slate-500">
                {columnFormMode === 'edit'
                  ? '可以直接修改第一列或任意列，不需要再删除重建。'
                  : '新列会插入到当前选中列附近，更接近 Excel 的插列体验。'}
              </div>
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-[1.1fr_0.85fr_1fr_auto]">
            <input
              type="text"
              value={newColumnName}
              onChange={(event) => setNewColumnName(event.target.value)}
              className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
              placeholder="输入新列名称，例如：审批备注"
            />
            <select
              value={newColumnType}
              onChange={(event) => setNewColumnType(event.target.value as ColumnDef['type'])}
              className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
            >
              {COLUMN_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newColumnOptions}
              onChange={(event) => setNewColumnOptions(event.target.value)}
              disabled={newColumnType !== 'select'}
              className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:bg-slate-100"
              placeholder="下拉选项，用逗号分隔"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSaveColumn}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"
              >
                <Plus className="h-4 w-4" />
                {columnFormMode === 'edit' ? '保存列' : '添加列'}
              </button>
              <button
                type="button"
                onClick={resetColumnForm}
                className="inline-flex h-11 items-center rounded-full border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
              >
                取消
              </button>
            </div>
          </div>

          {newColumnType === 'currency' && (
            <div className="mt-3 grid gap-3 rounded-2xl border border-slate-200 bg-white/70 p-3 lg:grid-cols-2">
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  默认币种
                </label>
                <input
                  type="text"
                  value={newCurrencyCode}
                  onChange={(event) => setNewCurrencyCode(event.target.value.toUpperCase())}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  placeholder="例如：CNY、USD、JPY"
                  maxLength={6}
                />
              </div>
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  国家/币种来源列
                </label>
                <input
                  type="text"
                  value={newCurrencySource}
                  onChange={(event) => setNewCurrencySource(event.target.value)}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm text-slate-700 outline-none transition focus:border-sky-300 focus:ring-2 focus:ring-sky-100"
                  placeholder="填列 key 或列名，如 country / 国家"
                />
              </div>
              <div className="lg:col-span-2 rounded-2xl border border-amber-100 bg-amber-50/80 px-4 py-3 text-xs leading-6 text-amber-900">
                如果你的同一张表会出现不同国家的金额，建议新增一个“国家”或“币种”列，再把这里的来源列指向它。
                这样预算列就不会再默认全部显示为人民币。
              </div>
            </div>
          )}
        </div>
      )}

      <FormulaBar
        activeCellLabel={activeCellLabel}
        value={formulaText}
        readOnly={formulaReadOnly}
        onChange={setFormulaText}
        onApply={() => commitActiveValue(formulaText, activeCell)}
      />

      {operationError && (
        <div className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
          <div className="inline-flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {operationError}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 bg-slate-50/80 px-4 py-2.5 text-xs font-medium text-slate-500">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
          <TableProperties className="h-3.5 w-3.5 text-sky-600" />
          可见字段 {columns.length}
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
          <Plus className="h-3.5 w-3.5 text-amber-500" />
          支持多单元格粘贴与行列扩展
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
          <Lock className="h-3.5 w-3.5 text-rose-500" />
          已锁定单元格 {Object.keys(lockedCells).length}
        </div>
        {normalizedSelection && (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 font-semibold text-sky-700 shadow-sm">
            已选择区域 {selectionLabel}
          </div>
        )}
        {formatPainterStyle && (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 font-semibold text-amber-700 shadow-sm">
            格式刷已启用，拖动鼠标应用到目标区域
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 bg-white px-4 py-3 text-xs text-slate-600">
        <button
          type="button"
          onClick={() => void handleMergeSelection()}
          disabled={!canManageStructure || !canMergeSelection}
          className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          合并选中单元格
        </button>
        <button
          type="button"
          onClick={() => activeCell && void unmergeAt(activeCell.row, activeCell.col)}
          disabled={!canManageStructure || !activeMerge}
          className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          取消合并
        </button>
        <button
          type="button"
          onClick={() => setShowAdvancedFilter((prev) => !prev)}
          className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold transition hover:border-slate-300 hover:bg-slate-100"
        >
          {showAdvancedFilter ? '收起筛选排序' : '高级筛选与排序'}
        </button>
        <div className="rounded-full border border-slate-200 bg-white px-3 py-2 text-slate-500 shadow-sm">
          已配置筛选 {advancedFilter.rules.length} 条 / 排序 {advancedFilter.sorts.length} 条
        </div>
      </div>

      {showAdvancedFilter && (
        <div className="border-b border-slate-200/80 bg-slate-50/80 px-4 py-4">
          <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-[24px] border border-slate-200 bg-white/90 p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">高级筛选</div>
                  <div className="text-xs text-slate-500">支持多条件组合，适合你要的更像 Excel 的高级筛选方式。</div>
                </div>
                <button
                  type="button"
                  onClick={addFilterRule}
                  className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold transition hover:border-slate-300 hover:bg-slate-100"
                >
                  新增条件
                </button>
              </div>
              <div className="mb-3 flex items-center gap-3 text-xs font-semibold text-slate-600">
                匹配方式
                <select
                  value={filterDraft.match}
                  onChange={(event) =>
                    setFilterDraft((prev) => ({
                      ...prev,
                      match: event.target.value as AdvancedFilterConfig['match'],
                    }))
                  }
                  className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none"
                >
                  <option value="all">满足全部条件</option>
                  <option value="any">满足任一条件</option>
                </select>
              </div>
              <div className="space-y-3">
                {filterDraft.rules.map((rule) => (
                  <div key={rule.id} className="grid gap-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-3 lg:grid-cols-[1fr_1fr_1fr_auto]">
                    <select
                      value={rule.columnKey}
                      onChange={(event) =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          rules: prev.rules.map((item) =>
                            item.id === rule.id ? { ...item, columnKey: event.target.value } : item
                          ),
                        }))
                      }
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none"
                    >
                      {parsedColumns.map((column) => (
                        <option key={column.key} value={column.key}>
                          {column.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={rule.operator}
                      onChange={(event) =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          rules: prev.rules.map((item) =>
                            item.id === rule.id ? { ...item, operator: event.target.value as FilterOperator } : item
                          ),
                        }))
                      }
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none"
                    >
                      {FILTER_OPERATOR_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={rule.value || ''}
                      onChange={(event) =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          rules: prev.rules.map((item) =>
                            item.id === rule.id ? { ...item, value: event.target.value } : item
                          ),
                        }))
                      }
                      disabled={rule.operator === 'is_empty' || rule.operator === 'is_not_empty'}
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none disabled:bg-slate-100"
                      placeholder="筛选值"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          rules: prev.rules.filter((item) => item.id !== rule.id),
                        }))
                      }
                      className="h-10 rounded-xl border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
                    >
                      删除
                    </button>
                  </div>
                ))}
                {filterDraft.rules.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
                    还没有筛选条件，可以点击“新增条件”开始配置。
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-[24px] border border-slate-200 bg-white/90 p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">排序规则</div>
                  <div className="text-xs text-slate-500">支持多级排序，例如先国家再预算。</div>
                </div>
                <button
                  type="button"
                  onClick={addSortRule}
                  className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold transition hover:border-slate-300 hover:bg-slate-100"
                >
                  新增排序
                </button>
              </div>
              <div className="space-y-3">
                {filterDraft.sorts.map((sort) => (
                  <div key={sort.id} className="grid gap-2 rounded-2xl border border-slate-200 bg-slate-50/80 p-3 lg:grid-cols-[1fr_1fr_auto]">
                    <select
                      value={sort.columnKey}
                      onChange={(event) =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          sorts: prev.sorts.map((item) =>
                            item.id === sort.id ? { ...item, columnKey: event.target.value } : item
                          ),
                        }))
                      }
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none"
                    >
                      {parsedColumns.map((column) => (
                        <option key={column.key} value={column.key}>
                          {column.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={sort.direction}
                      onChange={(event) =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          sorts: prev.sorts.map((item) =>
                            item.id === sort.id ? { ...item, direction: event.target.value as SortRule['direction'] } : item
                          ),
                        }))
                      }
                      className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none"
                    >
                      <option value="asc">升序</option>
                      <option value="desc">降序</option>
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        setFilterDraft((prev) => ({
                          ...prev,
                          sorts: prev.sorts.filter((item) => item.id !== sort.id),
                        }))
                      }
                      className="h-10 rounded-xl border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:bg-rose-100"
                    >
                      删除
                    </button>
                  </div>
                ))}
                {filterDraft.sorts.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
                    还没有排序规则，可以点击“新增排序”开始配置。
                  </div>
                )}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={saveAdvancedFilter}
                  className="rounded-full bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  应用筛选与排序
                </button>
                <button
                  type="button"
                  onClick={resetAdvancedFilter}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                >
                  清空配置
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <SearchBar
          open={showSearch}
          onClose={() => { setShowSearch(false); setSearchQuery('') }}
          searchQuery={searchQuery}
          onSearchChange={(q) => { setSearchQuery(q); setSearchMatchIndex(0) }}
          matchCount={searchMatches.length}
          currentMatchIndex={searchMatchIndex}
          onPrev={handleSearchPrev}
          onNext={handleSearchNext}
        />
      <div
        ref={containerRef}
        tabIndex={0}
        onPaste={handlePaste}
        onKeyDown={handleGridKeyDown}
        className="h-full select-none overflow-auto bg-[linear-gradient(180deg,rgba(255,255,255,0.68),rgba(248,250,252,0.96))] outline-none"
      >
        <table className="min-w-full border-separate border-spacing-0" style={{ fontSize: `${cellFontSize}px` }}>
          <thead className="sticky top-0 z-20 backdrop-blur">
            <tr>
              <th className="sticky left-0 z-30 w-14 border-b border-r border-slate-200 bg-slate-100/95 px-2 py-3 text-center text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                #
              </th>
              {columns.map((column, index) => {
                const selected = activeCell?.col === column.key
                const inSelection = normalizedSelection ? isCellInSelection(normalizedSelection.startRow, column.key) : false

                return (
                  <th
                    key={column.key}
                    className={`relative border-b border-r border-slate-200 px-4 py-3 text-left ${
                      selected ? 'bg-sky-50 text-sky-900' : inSelection ? 'bg-sky-50/70 text-sky-800' : 'bg-white/95 text-slate-700'
                    }`}
                    style={{ width: getColumnWidth(column), minWidth: 120 }}
                    onDoubleClick={() => {
                      if (!canManageStructure) return
                      setEditingHeaderKey(column.key)
                      setHeaderEditValue(column.name)
                    }}
                    onContextMenu={(event) => openColumnContextMenu(event, column.key)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                        {columnIndexToLetter(index)}
                      </span>
                      {editingHeaderKey === column.key ? (
                        <input
                          autoFocus
                          type="text"
                          value={headerEditValue}
                          onChange={(event) => setHeaderEditValue(event.target.value)}
                          onBlur={() => void saveHeaderName(column.key, headerEditValue)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void saveHeaderName(column.key, headerEditValue)
                            }

                            if (event.key === 'Escape') {
                              setEditingHeaderKey(null)
                              setHeaderEditValue('')
                            }
                          }}
                          className="h-8 w-full rounded-lg border border-sky-200 bg-white px-2 text-sm font-semibold text-slate-800 outline-none ring-2 ring-sky-100"
                        />
                      ) : (
                        <span className="font-semibold">{column.name}</span>
                      )}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                          setColumnFilterTarget({
                            columnKey: column.key,
                            columnName: column.name,
                            anchorRect: rect,
                          })
                        }}
                        className={`ml-auto shrink-0 rounded p-0.5 transition hover:bg-slate-200 ${
                          advancedFilter.columnFilters?.[column.key]?.length ? 'text-sky-600' : 'text-slate-400'
                        }`}
                        title="列筛选"
                      >
                        <Filter className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <button
                      type="button"
                      aria-label={`resize-${column.name}`}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setResizingColumn({
                          key: column.key,
                          startX: event.clientX,
                          startWidth: getColumnWidth(column),
                        })
                      }}
                      className="absolute right-0 top-0 h-full w-2 cursor-col-resize bg-transparent transition hover:bg-sky-200/70"
                    />
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {displayRowIndices.map((rowIndex) => (
              <tr key={rowIndex} className="group">
                <td
                  className={`sticky left-0 z-10 border-b border-r border-slate-200 px-2 text-center text-xs font-medium transition group-hover:bg-sky-50/70 ${
                    normalizedSelection && rowIndex >= normalizedSelection.startRow && rowIndex <= normalizedSelection.endRow
                      ? 'bg-sky-50/85 text-sky-700'
                      : 'bg-slate-50/95 text-slate-400'
                  }`}
                  style={{ minHeight: `${cellMinHeight}px`, height: `${cellMinHeight}px` }}
                >
                  {rowIndex + 1}
                </td>
                {columns.map((column) => {
                  const rawValue = getRawCell(rowIndex, column.key)
                  const cellValue = getResolvedCellValue(rowIndex, column.key)
                  const inputValue = getCellInputValue(rawValue)
                  const cellStyle = getCellStyle(rawValue)
                  const selected = activeCell?.row === rowIndex && activeCell?.col === column.key
                  const inSelection = isCellInSelection(rowIndex, column.key)
                  const editing = editingCell?.row === rowIndex && editingCell?.col === column.key
                  const locked = isCellLocked(rowIndex, column.key)
                  const readOnly = !isCellEditable(column.key, rowIndex)
                  const cellBackground = cellStyle?.backgroundColor
                  const mergeState = getRenderableMerge(rowIndex, column.key)

                  if (mergeState?.hidden) {
                    return null
                  }

                  return (
                    <td
                      key={column.key}
                      rowSpan={mergeState?.rowSpan}
                      colSpan={mergeState?.colSpan}
                      className={`relative border-b border-r border-slate-200 px-0 py-0 align-top transition ${
                        selected ? 'bg-sky-50/80 ring-2 ring-sky-400 ring-inset' : isCurrentSearchMatch(rowIndex, column.key) ? 'bg-amber-200/80 ring-2 ring-amber-400 ring-inset' : isSearchMatch(rowIndex, column.key) ? 'bg-amber-100/60' : inSelection ? 'bg-sky-50/60' : 'bg-white/70'
                      } ${readOnly ? 'bg-slate-50/90' : 'group-hover:bg-sky-50/40'} cursor-cell`}
                      onClick={() => handleCellClick(rowIndex, column.key)}
                      onMouseDown={() => handleCellMouseDown(rowIndex, column.key)}
                      onMouseEnter={() => handleCellMouseEnter(rowIndex, column.key)}
                      onMouseMove={() => handleCellMouseMove(rowIndex, column.key)}
                      onDoubleClick={() => handleCellDoubleClick(rowIndex, column.key)}
                      onContextMenu={(event) => openCellContextMenu(event, rowIndex, column.key)}
                      style={{ minHeight: `${cellMinHeight}px` }}
                    >
                      {locked && (
                        <Lock className="absolute right-1.5 top-1.5 h-3.5 w-3.5 text-rose-400" />
                      )}

                      {editing ? (
                        <input
                          ref={inputRef}
                          type="text"
                          value={editValue}
                          onChange={(event) => setEditValue(event.target.value)}
                          onBlur={() => commitActiveValue(editValue)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              commitActiveValue(editValue)
                              setActiveCell({ row: rowIndex + 1, col: column.key })
                            }

                            if (event.key === 'Escape') {
                              setEditingCell(null)
                              setEditValue('')
                            }

                            if (event.key === 'Tab') {
                              event.preventDefault()
                              commitActiveValue(editValue)
                              if (activeColumnIndex >= 0 && activeColumnIndex < columns.length - 1) {
                                setActiveCell({ row: rowIndex, col: columns[activeColumnIndex + 1].key })
                              }
                            }
                          }}
                          className="h-full min-h-[40px] w-full border border-sky-200 bg-white px-2.5 py-2 outline-none ring-2 ring-sky-100"
                          style={{
                            color: cellStyle?.textColor || DEFAULT_TEXT_COLOR,
                            backgroundColor: cellBackground || '#ffffff',
                          }}
                          placeholder={column.type === 'formula' ? '=A2+B2' : undefined}
                        />
                      ) : (
                        <div
                          className="min-h-[40px] px-2.5 py-2"
                          style={{
                            minHeight: `${cellMinHeight}px`,
                            color: cellStyle?.textColor || DEFAULT_TEXT_COLOR,
                            backgroundColor: cellBackground || 'transparent',
                          }}
                        >
                          {column.type === 'select' && column.options ? (
                            <span
                              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                                cellValue ? 'bg-sky-100 text-sky-700' : 'bg-slate-100 text-slate-400'
                              }`}
                            >
                              {cellValue ? String(cellValue) : '未设置'}
                            </span>
                          ) : (
                            <div className="truncate" title={inputValue.startsWith('=') ? inputValue : undefined}>
                              {formatCellValue(cellValue, column, rows.find((row) => row.row_index === rowIndex)?.data, parsedColumns)}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>

      {columnFilterTarget && (
        <ColumnFilterDropdown
          columnKey={columnFilterTarget.columnKey}
          columnName={columnFilterTarget.columnName}
          anchorRect={columnFilterTarget.anchorRect}
          uniqueValues={getUniqueValuesForColumn(columnFilterTarget.columnKey)}
          selectedValues={new Set(advancedFilter.columnFilters?.[columnFilterTarget.columnKey] || [])}
          onApply={handleColumnFilterApply}
          onClose={() => setColumnFilterTarget(null)}
        />
      )}

      {contextMenu && typeof document !== 'undefined' && createPortal(
        <div
          ref={contextMenuRef}
          data-sheet-context-menu="true"
          className="fixed z-[120] w-60 overflow-hidden rounded-2xl border border-slate-200/90 bg-white/96 p-1 shadow-[0_24px_60px_-32px_rgba(15,23,42,0.45)] ring-1 ring-slate-200/70 backdrop-blur-sm"
          style={{ left: contextMenuPosition?.left ?? contextMenu.anchorX, top: contextMenuPosition?.top ?? contextMenu.anchorY }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.kind === 'cell' ? (
            <>
              <button
                type="button"
                onClick={() => {
                  handleCellDoubleClick(contextMenu.row || 0, contextMenu.col)
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <Edit3 className="h-4 w-4" />
                编辑单元格
              </button>
              <button
                type="button"
                onClick={() => {
                  clearCellAt(contextMenu.row || 0, contextMenu.col)
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <Trash2 className="h-4 w-4" />
                清空单元格
              </button>
              {canManageStructure && (
                <button
                  type="button"
                  onClick={() => {
                    if (canMergeSelection) {
                      void handleMergeSelection()
                    }
                    setContextMenu(null)
                  }}
                  disabled={!canMergeSelection}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <TableProperties className="h-4 w-4" />
                  合并选中单元格
                </button>
              )}
              {canManageStructure && activeMerge && (
                <button
                  type="button"
                  onClick={() => {
                    void unmergeAt(contextMenu.row || 0, contextMenu.col)
                    setContextMenu(null)
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
                >
                  <TableProperties className="h-4 w-4" />
                  取消合并单元格
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const raw = getRawCell(contextMenu.row || 0, contextMenu.col)
                  const style = getCellStyle(raw)
                  if (style) {
                    setFormatPainterStyle({
                      textColor: style.textColor,
                      backgroundColor: style.backgroundColor,
                    })
                  }
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <CopyPlus className="h-4 w-4" />
                启用格式刷
              </button>
              <button
                type="button"
                onClick={() => {
                  void insertRowAfter((contextMenu.row || 0) - 1, contextMenu.row || 0, contextMenu.col)
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <Rows3 className="h-4 w-4" />
                在上方插入行
              </button>
              <button
                type="button"
                onClick={() => {
                  void insertRowAfter(contextMenu.row || 0, (contextMenu.row || 0) + 1, contextMenu.col)
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <CopyPlus className="h-4 w-4" />
                在下方插入行
              </button>
              <button
                type="button"
                onClick={() => {
                  void deleteRowAt(contextMenu.row || 0)
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-rose-700 transition hover:bg-rose-50"
              >
                <Trash2 className="h-4 w-4" />
                删除当前行
              </button>
              {canManageStructure && (
                <button
                  type="button"
                  onClick={() => {
                    void toggleLockAt(contextMenu.row || 0, contextMenu.col)
                    setContextMenu(null)
                  }}
                  className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
                >
                  <Lock className="h-4 w-4" />
                  {isCellLocked(contextMenu.row || 0, contextMenu.col) ? '解除锁定单元格' : '锁定单元格'}
                </button>
              )}
              <div className="my-1 border-t border-slate-200/80" />
              <div className="px-3 py-2">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  文字颜色
                </div>
                <div className="flex flex-wrap gap-2">
                  {QUICK_TEXT_COLORS.map((color) => (
                    <button
                      key={`text-${color}`}
                      type="button"
                      onClick={() => {
                        applyStyleAt(contextMenu.row || 0, contextMenu.col, { textColor: color })
                        setContextMenu(null)
                      }}
                      className={`h-6 w-6 rounded-full border border-white shadow-sm ring-2 ${
                        activeTextColor === color ? 'ring-slate-400' : 'ring-transparent'
                      }`}
                      style={{ backgroundColor: color }}
                      title={color}
                    />
                  ))}
                </div>
              </div>
              <div className="px-3 pb-2">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  填充颜色
                </div>
                <div className="flex flex-wrap gap-2">
                  {QUICK_FILL_COLORS.map((color) => (
                    <button
                      key={`fill-${color}`}
                      type="button"
                      onClick={() => {
                        applyStyleAt(contextMenu.row || 0, contextMenu.col, { backgroundColor: color })
                        setContextMenu(null)
                      }}
                      className={`h-6 w-6 rounded-full border border-slate-200 shadow-sm ring-2 ${
                        activeFillColor === color ? 'ring-slate-400' : 'ring-transparent'
                      }`}
                      style={{ backgroundColor: color }}
                      title={color}
                    />
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  openEditColumnForm(contextMenu.col)
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <Edit3 className="h-4 w-4" />
                编辑当前列
              </button>
              <button
                type="button"
                onClick={() => {
                  void applyQuickSort(contextMenu.col, 'asc')
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <Sparkles className="h-4 w-4" />
                按本列升序排序
              </button>
              <button
                type="button"
                onClick={() => {
                  void applyQuickSort(contextMenu.col, 'desc')
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <Sparkles className="h-4 w-4" />
                按本列降序排序
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAdvancedFilter(true)
                  setFilterDraft((prev) => ({
                    ...prev,
                    rules: prev.rules.length
                      ? prev.rules
                      : [{ id: createClientId('filter'), columnKey: contextMenu.col, operator: 'contains', value: '' }],
                  }))
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <Sparkles className="h-4 w-4" />
                打开高级筛选
              </button>
              <button
                type="button"
                onClick={() => {
                  openCreateColumnForm(Math.max(0, contextColumnIndex))
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <CopyPlus className="h-4 w-4" />
                在左侧插入列
              </button>
              <button
                type="button"
                onClick={() => {
                  openCreateColumnForm(contextColumnIndex + 1)
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100"
              >
                <Plus className="h-4 w-4" />
                在右侧插入列
              </button>
              <button
                type="button"
                onClick={() => {
                  void deleteColumnByKey(contextMenu.col)
                  setContextMenu(null)
                }}
                className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-rose-700 transition hover:bg-rose-50"
              >
                <Trash2 className="h-4 w-4" />
                删除当前列
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
