import type { ICellData, IWorkbookData, IWorksheetData } from '@univerjs/core'
import type { ColumnDef, Row, Sheet } from '@/types'
import { columnIndexToLetter } from './spreadsheet'

function normalizeRowsForUniver(rows: Row[]): Row[] {
  const normalized = rows
    .filter((row) => Number.isInteger(row.row_index) && row.row_index >= 0)
    .sort((left, right) => left.row_index - right.row_index || left.id - right.id)

  const deduped: Row[] = []
  for (const row of normalized) {
    const last = deduped[deduped.length - 1]
    if (last && last.row_index === row.row_index) {
      deduped[deduped.length - 1] = row
      continue
    }
    deduped.push(row)
  }

  return deduped
}

function getHeaderColumns(sheet: Sheet, rows: Row[]): ColumnDef[] {
  if (sheet.columns && Array.isArray(sheet.columns) && sheet.columns.length > 0) {
    return sheet.columns
  }

  const keySet = new Set<string>()
  rows.forEach((row) => {
    Object.keys(row.data || {}).forEach((key) => keySet.add(key))
  })

  return Array.from(keySet).map((key, index) => ({
    key,
    name: columnIndexToLetter(index),
    type: 'text',
    width: 140,
  }))
}

function normalizeBackendCell(raw: unknown): ICellData | null {
  if (raw == null || raw === '') return null

  if (typeof raw === 'string') {
    if (raw.startsWith('=')) {
      return { f: raw }
    }

    return { v: raw }
  }

  if (typeof raw === 'number' || typeof raw === 'boolean') {
    return { v: raw }
  }

  if (typeof raw === 'object') {
    const data = raw as Record<string, unknown>
    const explicitFormula = typeof data.formula === 'string' ? data.formula : undefined
    const value = data.value

    if (explicitFormula) {
      return { f: explicitFormula }
    }

    if (typeof value === 'string' && value.startsWith('=')) {
      return { f: value }
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return { v: value }
    }
  }

  return null
}

export function buildUniverWorkbookData(
  workbookId: string | number,
  sheet: Sheet,
  rows: Row[],
  locale: IWorkbookData['locale']
): IWorkbookData {
  const normalizedRows = normalizeRowsForUniver(rows)
  const columns = getHeaderColumns(sheet, normalizedRows)
  const sheetKey = `sheet-${sheet.id}`
  const columnCount = Math.max(columns.length, 26)
  const maxRowIndex = normalizedRows.reduce((max, row) => Math.max(max, row.row_index), -1)
  const rowCount = Math.max(maxRowIndex + 25, 200)

  const cellData: Record<number, Record<number, ICellData>> = {
    0: {},
  }

  columns.forEach((column, index) => {
    cellData[0][index] = { v: column.name || columnIndexToLetter(index) }
  })

  normalizedRows.forEach((row) => {
    const targetRow = row.row_index + 1
    cellData[targetRow] = cellData[targetRow] || {}

    columns.forEach((column, colIndex) => {
      const normalized = normalizeBackendCell(row.data?.[column.key])
      if (normalized) {
        cellData[targetRow][colIndex] = normalized
      }
    })
  })

  const worksheetData: Partial<IWorksheetData> = {
    id: sheetKey,
    name: sheet.name || 'Sheet1',
    tabColor: '',
    hidden: 0,
    freeze: {
      xSplit: 0,
      ySplit: 1,
      startRow: 1,
      startColumn: 0,
    },
    rowCount,
    columnCount,
    zoomRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: 140,
    defaultRowHeight: 28,
    mergeData: [],
    cellData,
    rowData: {},
    columnData: columns.reduce<NonNullable<IWorksheetData['columnData']>>((acc, column, index) => {
      acc[index] = { w: column.width || 140 }
      return acc
    }, {}),
    rowHeader: { width: 46 },
    columnHeader: { height: 30 },
    showGridlines: 1,
    rightToLeft: 0,
  }

  return {
    id: `workbook-${workbookId}-sheet-${sheet.id}`,
    name: sheet.name || 'Workbook',
    appVersion: '0.5.0',
    locale,
    styles: {},
    sheetOrder: [sheetKey],
    sheets: {
      [sheetKey]: worksheetData,
    },
  }
}

function getCellDisplayValue(cell: Record<string, unknown> | undefined): string {
  if (!cell) return ''
  if (typeof cell.f === 'string' && cell.f.trim()) return cell.f

  const value = cell.v
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return ''
}

export function deriveColumnsFromUniverSheet(
  worksheetData: Partial<IWorksheetData>,
  fallbackColumns: ColumnDef[]
): ColumnDef[] {
  const headerRow = (worksheetData.cellData || {})[0] || {}
  const columnCount = Math.max(
    worksheetData.columnCount || 0,
    fallbackColumns.length,
    ...Object.keys(headerRow).map((key) => Number(key) + 1),
    1
  )

  return Array.from({ length: columnCount }, (_, index) => {
    const existing = fallbackColumns[index]
    const headerCell = headerRow[index] as Record<string, unknown> | undefined
    const headerValue = getCellDisplayValue(headerCell)

    return {
      key: existing?.key || `col_${index + 1}`,
      name: headerValue || existing?.name || columnIndexToLetter(index),
      type: existing?.type || 'text',
      width:
        (worksheetData.columnData as Record<number, { w?: number }> | undefined)?.[index]?.w ||
        existing?.width ||
        140,
      ...(existing?.currencyCode ? { currencyCode: existing.currencyCode } : {}),
      ...(existing?.currencySource ? { currencySource: existing.currencySource } : {}),
      ...(existing?.options ? { options: existing.options } : {}),
    }
  })
}
