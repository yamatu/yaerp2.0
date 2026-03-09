import type { CellRecord, CellStyle, ColumnDef, Row, SheetConfig } from '@/types'

export interface ClipboardCell {
  value: string
  style?: CellStyle
}

export function columnIndexToLetter(index: number): string {
  let value = index + 1
  let result = ''

  while (value > 0) {
    const remainder = (value - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    value = Math.floor((value - 1) / 26)
  }

  return result
}

export function columnLetterToIndex(value: string): number {
  return value
    .toUpperCase()
    .split('')
    .reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1
}

export function buildNextColumnKey(columns: ColumnDef[]): string {
  const usedKeys = new Set(columns.map((column) => column.key))
  let index = columns.length + 1

  while (usedKeys.has(`col_${index}`)) {
    index += 1
  }

  return `col_${index}`
}

export function parseSheetConfig(config: unknown): SheetConfig {
  if (!config) return {}

  if (typeof config === 'string') {
    try {
      return JSON.parse(config) as SheetConfig
    } catch {
      return {}
    }
  }

  if (typeof config === 'object') {
    return config as SheetConfig
  }

  return {}
}

export function isCellRecord(value: unknown): value is CellRecord {
  return !!value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)
}

export function getCellRecord(value: unknown): CellRecord | null {
  return isCellRecord(value) ? value : null
}

export function getCellValue(value: unknown): unknown {
  return isCellRecord(value) ? value.value : value
}

export function getCellInputValue(value: unknown): string {
  const raw = getCellValue(value)
  return raw == null ? '' : String(raw)
}

export function getCellStyle(value: unknown): CellStyle | undefined {
  return isCellRecord(value) ? value.style : undefined
}

export function buildCellRecord(value: unknown, style?: CellStyle): CellRecord {
  return {
    value,
    ...(style ? { style } : {}),
  }
}

export function mergeCellRecord(
  existing: unknown,
  nextValue: unknown,
  nextStyle?: CellStyle
): unknown {
  const existingStyle = getCellStyle(existing)
  const style = nextStyle || existingStyle

  if (!style || Object.keys(style).length === 0) {
    return nextValue
  }

  return buildCellRecord(nextValue, style)
}

export function normalizeCellValue(input: string, column?: ColumnDef): unknown {
  const trimmed = input.replace(/\r/g, '')
  if (trimmed.trim().startsWith('=')) {
    return trimmed.trim()
  }

  if (!column) return trimmed

  switch (column.type) {
    case 'number': {
      const numeric = Number(trimmed.replace(/,/g, ''))
      return Number.isFinite(numeric) && trimmed !== '' ? numeric : trimmed
    }
    case 'currency': {
      const numeric = Number(trimmed.replace(/[^0-9.-]/g, ''))
      return Number.isFinite(numeric) && trimmed !== '' ? numeric : trimmed
    }
    default:
      return trimmed
  }
}

function extractCellStyleFromElement(element: Element): CellStyle | undefined {
  const style: CellStyle = {}
  const ownStyle = element.getAttribute('style') || ''

  // Extract text color
  const colorMatch = ownStyle.match(/(?<![a-z-])color\s*:\s*([^;]+)/i)?.[1]?.trim()
  if (colorMatch) {
    style.textColor = colorMatch
  }

  // Extract background color
  const bgMatch = ownStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1]?.trim()
  if (bgMatch) {
    style.backgroundColor = bgMatch
  }

  // Check children for styles if not found on the element itself
  if (!style.textColor) {
    const coloredChild = element.querySelector('[style*="color"]')
    if (coloredChild) {
      const childStyle = extractCellStyleFromElement(coloredChild)
      if (childStyle?.textColor) {
        style.textColor = childStyle.textColor
      }
    }
  }

  if (!style.backgroundColor) {
    const bgChild = element.querySelector('[style*="background"]')
    if (bgChild) {
      const childStyle = extractCellStyleFromElement(bgChild)
      if (childStyle?.backgroundColor) {
        style.backgroundColor = childStyle.backgroundColor
      }
    }
  }

  return style.textColor || style.backgroundColor ? style : undefined
}

function parseHtmlClipboard(html: string): ClipboardCell[][] {
  if (typeof DOMParser === 'undefined') return []

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const rows = Array.from(doc.querySelectorAll('tr'))
  if (rows.length === 0) return []

  return rows.map((row) =>
    Array.from(row.children).map((cell) => {
      const cellStyle = extractCellStyleFromElement(cell)
      return {
        value: cell.textContent?.replace(/\r/g, '').trim() || '',
        ...(cellStyle ? { style: cellStyle } : {}),
      }
    })
  )
}

function parsePlainClipboard(text: string): ClipboardCell[][] {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
    .map((line) => line.split('\t').map((value) => ({ value })))
}

export function parseClipboardMatrix(text: string, html?: string): ClipboardCell[][] {
  const htmlGrid = html ? parseHtmlClipboard(html) : []
  if (htmlGrid.length > 0) {
    return htmlGrid
  }

  return parsePlainClipboard(text)
}

const COUNTRY_CURRENCY_MAP: Record<string, string> = {
  cn: 'CNY',
  china: 'CNY',
  '中国': 'CNY',
  zh: 'CNY',
  us: 'USD',
  usa: 'USD',
  america: 'USD',
  'united states': 'USD',
  '美国': 'USD',
  jp: 'JPY',
  japan: 'JPY',
  '日本': 'JPY',
  gb: 'GBP',
  uk: 'GBP',
  britain: 'GBP',
  england: 'GBP',
  '英国': 'GBP',
  eu: 'EUR',
  europe: 'EUR',
  eur: 'EUR',
  '德国': 'EUR',
  '法国': 'EUR',
  '意大利': 'EUR',
  es: 'EUR',
  fr: 'EUR',
  de: 'EUR',
  kr: 'KRW',
  korea: 'KRW',
  'south korea': 'KRW',
  '韩国': 'KRW',
  hk: 'HKD',
  'hong kong': 'HKD',
  '香港': 'HKD',
  tw: 'TWD',
  taiwan: 'TWD',
  '台湾': 'TWD',
  sg: 'SGD',
  singapore: 'SGD',
  '新加坡': 'SGD',
  au: 'AUD',
  australia: 'AUD',
  '澳大利亚': 'AUD',
  ca: 'CAD',
  canada: 'CAD',
  '加拿大': 'CAD',
  in: 'INR',
  india: 'INR',
  '印度': 'INR',
  th: 'THB',
  thailand: 'THB',
  '泰国': 'THB',
  my: 'MYR',
  malaysia: 'MYR',
  '马来西亚': 'MYR',
  vn: 'VND',
  vietnam: 'VND',
  '越南': 'VND',
}

export function resolveCurrencyCode(column: ColumnDef, rowData?: Record<string, unknown>, columns?: ColumnDef[]): string {
  const source = column.currencySource?.trim()
  if (source && rowData) {
    const direct = rowData[source]
    const byNameKey = columns?.find((item) => item.name === source)?.key
    const named = byNameKey ? rowData[byNameKey] : undefined
    const candidate = [direct, named].find((value) => value != null && `${value}`.trim() !== '')

    if (candidate != null) {
      const normalized = `${candidate}`.trim()
      if (/^[A-Z]{3}$/i.test(normalized)) {
        return normalized.toUpperCase()
      }

      const mapped = COUNTRY_CURRENCY_MAP[normalized.toLowerCase()]
      if (mapped) {
        return mapped
      }
    }
  }

  return column.currencyCode || 'CNY'
}

export function formatCurrencyValue(
  value: unknown,
  column: ColumnDef,
  rowData?: Record<string, unknown>,
  columns?: ColumnDef[]
): string {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  return `${resolveCurrencyCode(column, rowData, columns)} ${numeric.toFixed(2)}`
}

function getRowCell(rows: Row[], rowIndex: number, colKey: string): unknown {
  return rows.find((row) => row.row_index === rowIndex)?.data?.[colKey]
}

function parseCellReference(reference: string) {
  const match = reference.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/)
  if (!match) return null

  return {
    columnIndex: columnLetterToIndex(match[1]),
    rowIndex: Number(match[2]) - 1,
  }
}

function splitFormulaArguments(value: string): string[] {
  const result: string[] = []
  let depth = 0
  let current = ''

  value.split('').forEach((char) => {
    if (char === ',' && depth === 0) {
      result.push(current.trim())
      current = ''
      return
    }

    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    current += char
  })

  if (current.trim()) {
    result.push(current.trim())
  }

  return result
}

function toFormulaNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const normalized = value.replace(/CNY\s*/gi, '').replace(/,/g, '').trim()
    const numeric = Number(normalized)
    return Number.isFinite(numeric) ? numeric : 0
  }

  return 0
}

export function evaluateCellValue(
  rows: Row[],
  columns: ColumnDef[],
  rowIndex: number,
  colKey: string,
  rawCell: unknown,
  visited = new Set<string>()
): unknown {
  const rawValue = getCellValue(rawCell)
  if (typeof rawValue !== 'string' || !rawValue.trim().startsWith('=')) {
    return rawValue
  }

  const currentKey = `${rowIndex}:${colKey}`
  if (visited.has(currentKey)) {
    return '#CYCLE!'
  }

  const nextVisited = new Set(visited)
  nextVisited.add(currentKey)

  const resolveReference = (reference: string): unknown => {
    const parsed = parseCellReference(reference)
    if (!parsed) return 0

    const column = columns[parsed.columnIndex]
    if (!column) return 0

    const referencedRaw = getRowCell(rows, parsed.rowIndex, column.key)
    return evaluateCellValue(rows, columns, parsed.rowIndex, column.key, referencedRaw, nextVisited)
  }

  const resolveRange = (reference: string): unknown[] => {
    const [startRef, endRef] = reference.split(':')
    const start = parseCellReference(startRef)
    const end = parseCellReference(endRef)
    if (!start || !end) return []

    const rowStart = Math.min(start.rowIndex, end.rowIndex)
    const rowEnd = Math.max(start.rowIndex, end.rowIndex)
    const colStart = Math.min(start.columnIndex, end.columnIndex)
    const colEnd = Math.max(start.columnIndex, end.columnIndex)
    const values: unknown[] = []

    for (let rowCursor = rowStart; rowCursor <= rowEnd; rowCursor += 1) {
      for (let colCursor = colStart; colCursor <= colEnd; colCursor += 1) {
        const column = columns[colCursor]
        if (!column) continue
        const referencedRaw = getRowCell(rows, rowCursor, column.key)
        values.push(evaluateCellValue(rows, columns, rowCursor, column.key, referencedRaw, nextVisited))
      }
    }

    return values
  }

  const evaluateArgument = (token: string): unknown => {
    if (/^[A-Z]+\d+:[A-Z]+\d+$/i.test(token)) {
      return resolveRange(token)
    }

    if (/^[A-Z]+\d+$/i.test(token)) {
      return resolveReference(token)
    }

    const numeric = Number(token)
    if (!Number.isNaN(numeric)) {
      return numeric
    }

    return token
  }

  try {
    let expression = rawValue.trim().slice(1).toUpperCase()

    if (/^[A-Z]+\d+$/.test(expression)) {
      return resolveReference(expression)
    }

    let hasFunctions = true
    while (hasFunctions) {
      hasFunctions = false
      expression = expression.replace(
        /(SUM|AVERAGE|AVG|MIN|MAX|COUNT)\(([^()]*)\)/g,
        (_, fn: string, argsString: string) => {
          hasFunctions = true
          const args = splitFormulaArguments(argsString)
          const values = args.flatMap((token) => {
            const resolved = evaluateArgument(token)
            return Array.isArray(resolved) ? resolved : [resolved]
          })

          switch (fn) {
            case 'SUM':
              return String(values.reduce((total, value) => total + toFormulaNumber(value), 0))
            case 'AVERAGE':
            case 'AVG':
              return values.length === 0
                ? '0'
                : String(values.reduce((total, value) => total + toFormulaNumber(value), 0) / values.length)
            case 'MIN':
              return values.length === 0 ? '0' : String(Math.min(...values.map(toFormulaNumber)))
            case 'MAX':
              return values.length === 0 ? '0' : String(Math.max(...values.map(toFormulaNumber)))
            case 'COUNT':
              return String(values.filter((value) => `${value}`.trim() !== '').length)
            default:
              return '0'
          }
        }
      )
    }

    expression = expression.replace(/\b([A-Z]+\d+)\b/g, (_, reference: string) => {
      const resolved = resolveReference(reference)
      return String(toFormulaNumber(resolved))
    })

    const safeExpression = expression.replace(/\^/g, '**')
    if (!/^[0-9+\-*/().\s*]+$/.test(safeExpression)) {
      return '#ERROR!'
    }

    const evaluated = Function(`"use strict"; return (${safeExpression});`)() as unknown
    return Number.isFinite(evaluated as number) ? evaluated : '#ERROR!'
  } catch {
    return '#ERROR!'
  }
}
