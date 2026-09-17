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
 *
 * A cell that holds a hyperlink is never a marker: the link lives in the rich
 * text document, so flattening the cell would throw the link away. The context
 * menu entry that flattens a whole selection is registered from here as well,
 * because it has to agree with the very same rule.
 */
import { CellValueType, CommandType, CustomRangeType, ICommandService, IUniverInstanceService, RANGE_TYPE } from '@univerjs/core'
import {
  ContextMenuGroup,
  ContextMenuPosition,
  IMenuManagerService,
  MenuItemType,
  MenuManagerPosition,
  type IMenuItem,
} from '@univerjs/ui'

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

interface CustomRangeLike {
  /** `CustomRangeType`, stored as a number. */
  rangeType?: unknown
}

interface RichTextDocumentLike {
  body?: { dataStream?: string; customRanges?: CustomRangeLike[] } | null
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
  getRow?: () => number
  getLastRow?: () => number
  getColumn?: () => number
  getLastColumn?: () => number
}

interface FacadeWorksheetLike {
  getRange: (row: number, column: number, numRows: number, numColumns: number) => FacadeRangeLike
  getScrollState?: () => { sheetViewStartRow?: number; sheetViewStartColumn?: number } | null | undefined
  /** Used area of the sheet: `A1` up to the last cell that holds content. */
  getDataRange?: () => FacadeRangeLike | null | undefined
}

export interface PlainRect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisposableLike {
  dispose?: () => void
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
/** Command the context menu entry dispatches. */
export const PLAIN_TEXT_CONVERT_COMMAND_ID = 'yaerp-plain-text-convert'
const PLAIN_TEXT_CONVERT_MENU_KEY = 'yaerpPlainTextConvert'

/**
 * A hyperlink is stored inside the rich text document, so a cell that carries
 * one is deliberately left alone: flattening it would drop the link.
 */
function hasHyperlink(document: RichTextDocumentLike | null | undefined) {
  const ranges = document?.body?.customRanges
  if (!Array.isArray(ranges)) return false
  return ranges.some((range) => {
    const type = range?.rangeType
    return type === CustomRangeType.HYPERLINK || type === 'HYPERLINK'
  })
}

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
  if (hasHyperlink(cell.p)) return null
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
    const used = worksheet?.getDataRange?.()
    if (!used?.getRow || !used.getLastRow || !used.getColumn || !used.getLastColumn) return null
    const range = {
      startRow: used.getRow(),
      endRow: used.getLastRow(),
      startColumn: used.getColumn(),
      endColumn: used.getLastColumn(),
    }
    if (!Number.isFinite(range.startRow) || !Number.isFinite(range.endRow)) return null
    if (!Number.isFinite(range.startColumn) || !Number.isFinite(range.endColumn)) return null
    if (range.endRow < range.startRow || range.endColumn < range.startColumn) return null
    return {
      startRow: Math.max(0, Math.floor(range.startRow)),
      endRow: Math.max(0, Math.floor(range.endRow)),
      startColumn: Math.max(0, Math.floor(range.startColumn)),
      endColumn: Math.max(0, Math.floor(range.endColumn)),
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

function finiteIndex(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

/**
 * Turns a selection into the area a batch conversion has to cover. A whole row
 * or column selection only carries one index pair, so it is widened to the used
 * area of the sheet; `RANGE_TYPE.ALL` covers everything.
 */
function expandSelectionRange(
  range: { startRow: number; endRow: number; startColumn: number; endColumn: number },
  rangeType: number | undefined,
  used: CellRange | null
): CellRange {
  const startRow = finiteIndex(range.startRow, used?.startRow ?? 0)
  const expanded: CellRange = {
    startRow,
    endRow: finiteIndex(range.endRow, used?.endRow ?? startRow),
    startColumn: finiteIndex(range.startColumn, used?.startColumn ?? 0),
    endColumn: finiteIndex(range.endColumn, used?.endColumn ?? range.startColumn),
  }
  if (used) {
    if (rangeType === RANGE_TYPE.ROW || rangeType === RANGE_TYPE.ALL) {
      expanded.startColumn = Math.min(expanded.startColumn, used.startColumn)
      expanded.endColumn = Math.max(expanded.endColumn, used.endColumn)
    }
    if (rangeType === RANGE_TYPE.COLUMN || rangeType === RANGE_TYPE.ALL) {
      expanded.startRow = Math.min(expanded.startRow, used.startRow)
      expanded.endRow = Math.max(expanded.endRow, used.endRow)
    }
  }
  if (expanded.endRow < expanded.startRow) expanded.endRow = expanded.startRow
  if (expanded.endColumn < expanded.startColumn) expanded.endColumn = expanded.startColumn
  return expanded
}

interface MenuManagerLike {
  mergeMenu: (source: unknown) => unknown
}

interface SelectionRangeLike {
  getRange?: () => (CellRange & { rangeType?: number }) | null | undefined
}

interface FacadeSelectionLike {
  getActiveRangeList?: () => SelectionRangeLike[]
}

/**
 * Resolves the areas a batch conversion covers for the current selection. A
 * whole row or column selection is widened to the used area of the sheet, so
 * selecting a row header and choosing "convert" cleans the entire row.
 */
export function resolveSelectionScanAreas(
  worksheet: FacadeWorksheetLike | null | undefined,
  selection: FacadeSelectionLike | null | undefined
): CellRange[] {
  try {
    const ranges = selection?.getActiveRangeList?.()
    if (!Array.isArray(ranges) || ranges.length === 0) return []
    const used = readUsedRange(worksheet)
    const areas: CellRange[] = []
    ranges.forEach((entry) => {
      const raw = entry?.getRange?.()
      if (!raw) return
      areas.push(expandSelectionRange(raw, raw.rangeType, used))
    })
    return areas
  } catch (error) {
    console.warn('Failed to read the current selection:', error)
    return []
  }
}

/**
 * Registers the command and the context menu entry that flatten the current
 * selection in one go, so a whole row can be cleaned up without opening the
 * badge tooltip of every cell. The entry shows up on the grid, the row header
 * and the column header menus, and it follows the same rule as the badge scan:
 * cells holding a hyperlink are left untouched.
 */
export function registerPlainTextConvertMenu(univer: unknown, onConvert: () => void): DisposableLike | null {
  try {
    const injector = getInjector(univer)
    const commandService = injector?.get<ICommandService | undefined>(ICommandService)
    if (!commandService?.registerCommand) return null
    const disposable = commandService.registerCommand({
      id: PLAIN_TEXT_CONVERT_COMMAND_ID,
      type: CommandType.OPERATION,
      handler: () => {
        onConvert()
        return true
      },
    })
    const menuManager = injector?.get<MenuManagerLike | undefined>(IMenuManagerService)
    if (menuManager?.mergeMenu) {
      const entry = {
        order: 900,
        menuItemFactory: (): IMenuItem => ({
          id: PLAIN_TEXT_CONVERT_MENU_KEY,
          commandId: PLAIN_TEXT_CONVERT_COMMAND_ID,
          title: '转为纯文本',
          type: MenuItemType.BUTTON,
        }),
      }
      const group = { [ContextMenuGroup.OTHERS]: { [PLAIN_TEXT_CONVERT_MENU_KEY]: entry } }
      menuManager.mergeMenu({
        [MenuManagerPosition.CONTEXT_MENU]: {
          [ContextMenuPosition.MAIN_AREA]: group,
          [ContextMenuPosition.ROW_HEADER]: group,
          [ContextMenuPosition.COL_HEADER]: group,
        },
      })
    }
    return disposable ?? null
  } catch (error) {
    console.warn('Failed to register the plain text conversion command:', error)
    return null
  }
}
