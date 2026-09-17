/**
 * Detects spreadsheet cells whose content is not plain text.
 *
 * Pasting rich content (a web page, Word, Excel with inline formatting) or
 * typing `Alt+Enter` produces a cell that *looks* like text but actually holds a
 * rich text document: inline formatting, multiple paragraphs, or both. Such a
 * cell does not survive a round trip through a plain text environment (CSV,
 * clipboard text, an export, another system), so the editor flags it with a
 * corner badge and offers to flatten it back to a plain string.
 *
 * Everything here works on the raw worksheet model through the injector, which
 * keeps a full sheet scan cheap, and the conversion goes through Univer's own
 * `set-range-values` command so undo/redo, permissions and the persistence
 * pipeline all keep working.
 */
import { CellValueType, IUniverInstanceService } from '@univerjs/core'

export type NonPlainTextKind = 'rich-text' | 'line-break'

export interface NonPlainTextMarker {
  /** Worksheet row (0 based, includes the header row). */
  row: number
  /** Worksheet column (0 based). */
  column: number
  kind: NonPlainTextKind
  /** The value the cell holds once it has been flattened to plain text. */
  plain: string
  /** Single line preview shown in the badge tooltip. */
  preview: string
  /** Stable identity of the marker, used to diff markers between scans. */
  signature: string
}

export interface CellRange {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

interface RichTextDocumentLike {
  body?: { dataStream?: string }
}

export interface CellLike {
  v?: unknown
  p?: RichTextDocumentLike | null
  f?: string | null
}

interface WorksheetLike {
  getCell: (row: number, column: number) => CellLike | null | undefined
}

interface FacadeRangeLike {
  // Method syntax on purpose: the facade narrows the parameter to
  // `ICellData | CellValue`, which stays assignable this way.
  setValue(value: unknown): unknown
}

interface FacadeWorksheetLike {
  getRange: (row: number, column: number, numRows: number, numColumns: number) => FacadeRangeLike
  getScrollState?: () => { sheetViewStartRow?: number; sheetViewStartColumn?: number } | null | undefined
  /** Returns the used area of the sheet (not the viewport). */
  getVisibleRange?: () => CellRange | null | undefined
}

export interface PlainRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PlainTextBadgeData {
  row: number
  column: number
  kind: NonPlainTextKind
  preview: string
  /** Flattens this cell to plain text. */
  onConvert?: () => void
  /** Reports the badge rectangle while the pointer hovers it. */
  onHover?: (rect: PlainRect | null) => void
}

interface PlainTextBadgeHandle {
  id: string
  dispose: () => void
}

type FloatDomAdder = (
  range: unknown,
  layer: { componentKey: string; data?: PlainTextBadgeData },
  layout: { width: number; height: number; marginX: number; marginY: number },
  id?: string
) => PlainTextBadgeHandle | null | undefined

interface InjectorLike {
  get: <T>(token: unknown) => T
}

const MAX_PREVIEW_LENGTH = 48
/** Upper bound for one scan; beyond it the scan follows the viewport instead. */
const MAX_SCANNED_CELLS = 20000
const MAX_MARKERS = 400
/** Rows and columns a viewport bound scan covers. */
const SCAN_ROW_SPAN = 80
const SCAN_COLUMN_SPAN = 40
/**
 * Key the badge component is registered under. Univer positions the float DOM
 * for us, so the badge follows scrolling, zooming, frozen panes and the device
 * scale factor without any coordinate math on our side.
 */
export const PLAIN_TEXT_BADGE_COMPONENT_KEY = 'yaerp-plain-text-badge'
/** Side length of the corner triangle. */
export const PLAIN_TEXT_BADGE_SIZE = 11
/** The float DOM layer insets its content by this many pixels on every side. */
const PLAIN_TEXT_BADGE_INSET = 4

/** Rich text stores its text in a data stream where `\r` terminates a paragraph. */
export function documentPlainText(document: RichTextDocumentLike | null | undefined) {
  const dataStream = document?.body?.dataStream
  if (typeof dataStream !== 'string') return ''
  return dataStream.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
}

/**
 * Returns the structure hidden in a cell, or `null` when the cell already is
 * plain text. Line breaks are flattened to a single space so converting a cell
 * always produces a value that no longer needs a badge.
 */
export function inspectPlainTextCell(
  cell: CellLike | null | undefined
): { kind: NonPlainTextKind; plain: string; preview: string } | null {
  if (!cell) return null
  const hasDocument = typeof cell.p?.body?.dataStream === 'string'
  const scalar =
    typeof cell.v === 'string'
      ? cell.v
      : typeof cell.v === 'number' || typeof cell.v === 'boolean'
        ? String(cell.v)
        : ''
  const text = hasDocument ? documentPlainText(cell.p) : scalar
  const hasLineBreak = /[\r\n]/.test(text)
  if (!hasDocument && !hasLineBreak) return null
  const plain = text.replace(/[\r\n]+/g, ' ').trim()
  return {
    kind: hasDocument ? 'rich-text' : 'line-break',
    plain,
    preview: plain.length > MAX_PREVIEW_LENGTH ? `${plain.slice(0, MAX_PREVIEW_LENGTH)}…` : plain,
  }
}

function getInjector(univer: unknown): InjectorLike | undefined {
  return (univer as { __getInjector?: () => InjectorLike } | null)?.__getInjector?.()
}

/**
 * Reads the raw worksheet so a scan does not pay for a facade lookup per cell.
 * Returns `null` while the workbook is still being created.
 */
export function createWorksheetCellReader(
  univer: unknown,
  unitId: string,
  subUnitId: string
): ((row: number, column: number) => CellLike | null | undefined) | null {
  try {
    const injector = getInjector(univer)
    const instanceService = injector?.get<IUniverInstanceService | undefined>(IUniverInstanceService)
    const workbook = instanceService?.getUniverSheetInstance(unitId)
    const worksheet = workbook?.getSheetBySheetId?.(subUnitId) as WorksheetLike | null | undefined
    if (!worksheet) return null
    return (row, column) => worksheet.getCell(row, column)
  } catch (error) {
    console.warn('Failed to read the worksheet for plain text checks:', error)
    return null
  }
}

function clampRange(range: CellRange, rowCount: number, columnCount: number): CellRange {
  const startRow = Math.max(0, Math.min(range.startRow, Math.max(0, rowCount - 1)))
  const endRow = Math.max(startRow, Math.min(range.endRow, Math.max(0, rowCount - 1)))
  const startColumn = Math.max(0, Math.min(range.startColumn, Math.max(0, columnCount - 1)))
  const endColumn = Math.max(startColumn, Math.min(range.endColumn, Math.max(0, columnCount - 1)))
  return { startRow, endRow, startColumn, endColumn }
}

function clampCount(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/**
 * Scans a range for cells that are not plain text. The scan is bounded so a
 * sheet full of rich text can never stall a render pass.
 */
export function collectNonPlainTextMarkers(
  readCell: (row: number, column: number) => CellLike | null | undefined,
  range: CellRange
): NonPlainTextMarker[] {
  const markers: NonPlainTextMarker[] = []
  let scanned = 0
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      scanned += 1
      if (scanned > MAX_SCANNED_CELLS) return markers
      let cell: CellLike | null | undefined
      try {
        cell = readCell(row, column)
      } catch {
        continue
      }
      const inspected = inspectPlainTextCell(cell)
      if (!inspected) continue
      markers.push({
        row,
        column,
        kind: inspected.kind,
        plain: inspected.plain,
        preview: inspected.preview,
        signature: `${row}:${column}:${inspected.kind}:${inspected.preview}`,
      })
      if (markers.length >= MAX_MARKERS) return markers
    }
  }
  return markers
}

export interface ScanArea {
  range: CellRange
  rowCount: number
  columnCount: number
  /** True when the used area was too large to scan in one pass. */
  truncated: boolean
}

function readUsedRange(worksheet: FacadeWorksheetLike | null | undefined): CellRange | null {
  try {
    const used = worksheet?.getVisibleRange?.()
    if (!used || !Number.isFinite(used.startRow) || !Number.isFinite(used.endRow)) return null
    if (!Number.isFinite(used.startColumn) || !Number.isFinite(used.endColumn)) return null
    return {
      startRow: Math.max(0, Math.floor(used.startRow)),
      endRow: Math.max(0, Math.floor(used.endRow)),
      startColumn: Math.max(0, Math.floor(used.startColumn)),
      endColumn: Math.max(0, Math.floor(used.endColumn)),
    }
  } catch {
    return null
  }
}

function readScrollStart(worksheet: FacadeWorksheetLike | null | undefined) {
  try {
    const state = worksheet?.getScrollState?.()
    return {
      row: state && Number.isFinite(state.sheetViewStartRow) ? Math.max(0, Math.floor(state.sheetViewStartRow as number)) : 0,
      column:
        state && Number.isFinite(state.sheetViewStartColumn)
          ? Math.max(0, Math.floor(state.sheetViewStartColumn as number))
          : 0,
    }
  } catch {
    return { row: 0, column: 0 }
  }
}

/**
 * Decides which area a scan covers. The whole used area is scanned so a badge
 * shows up wherever the data is, and only a sheet too large for one pass falls
 * back to a viewport bound scan.
 */
export function resolveScanArea(
  worksheet: FacadeWorksheetLike | null | undefined,
  fallback: { rowCount: number; columnCount: number }
): ScanArea {
  const rowCount = clampCount(fallback.rowCount)
  const columnCount = clampCount(fallback.columnCount)
  const used = readUsedRange(worksheet) ?? {
    startRow: 0,
    endRow: Math.max(0, rowCount - 1),
    startColumn: 0,
    endColumn: Math.max(0, columnCount - 1),
  }
  const range = clampRange(used, rowCount, columnCount)
  const cells = (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1)
  if (cells <= MAX_SCANNED_CELLS) return { range, rowCount, columnCount, truncated: false }
  const start = readScrollStart(worksheet)
  return {
    range: clampRange(
      {
        startRow: start.row,
        endRow: start.row + SCAN_ROW_SPAN - 1,
        startColumn: start.column,
        endColumn: start.column + SCAN_COLUMN_SPAN - 1,
      },
      rowCount,
      columnCount
    ),
    rowCount,
    columnCount,
    truncated: true,
  }
}

/**
 * Adds the corner badge of a marked cell. Univer anchors this DOM to the cell
 * and keeps it there while the sheet scrolls or zooms, and the returned handle
 * has to be disposed when the cell is no longer marked.
 */
export function addPlainTextBadge(
  worksheet: FacadeWorksheetLike | null | undefined,
  marker: NonPlainTextMarker,
  data: PlainTextBadgeData
): PlainTextBadgeHandle | null {
  if (!worksheet) return null
  const owner = worksheet as unknown as { addFloatDomToRange?: FloatDomAdder }
  if (typeof owner.addFloatDomToRange !== 'function') return null
  try {
    // Called on the worksheet: the facade method reads its own state.
    const handle = owner.addFloatDomToRange(
      worksheet.getRange(marker.row, marker.column, 1, 1),
      { componentKey: PLAIN_TEXT_BADGE_COMPONENT_KEY, data },
      {
        width: PLAIN_TEXT_BADGE_SIZE + PLAIN_TEXT_BADGE_INSET,
        height: PLAIN_TEXT_BADGE_SIZE + PLAIN_TEXT_BADGE_INSET,
        marginX: 0,
        marginY: 0,
      },
      `${PLAIN_TEXT_BADGE_COMPONENT_KEY}-${marker.row}-${marker.column}`
    )
    return handle ?? null
  } catch (error) {
    console.warn('Failed to place a plain text badge:', error)
    return null
  }
}

/**
 * Rewrites the cell as a plain string: the rich text document that carried the
 * formatting and the paragraphs is dropped. Going through `setValue` keeps the
 * change undoable and routable through the existing save pipeline.
 */
export function convertMarkerToPlainText(
  worksheet: FacadeWorksheetLike | null | undefined,
  marker: NonPlainTextMarker
): boolean {
  if (!worksheet) return false
  try {
    worksheet.getRange(marker.row, marker.column, 1, 1).setValue({
      v: marker.plain,
      t: CellValueType.STRING,
      p: null,
    })
    return true
  } catch (error) {
    console.warn('Failed to convert a cell to plain text:', error)
    return false
  }
}
