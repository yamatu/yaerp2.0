import type { IRange } from '@univerjs/core'
import { ICommandService } from '@univerjs/core'
import { DeleteRangeMoveUpCommand, InsertRangeMoveDownCommand, InsertRangeMoveRightCommand } from '@univerjs/sheets'
import { LexerTreeBuilder } from '@univerjs/engine-formula'
import {
  findInconsistentFormulaColumns,
  groupRepairsIntoRuns,
  planVerticalShiftRepairs,
  type FormulaGrid,
  type FormulaRepair,
  type InconsistentColumnResult,
  type MoveFormula,
} from './univer-formula-consistency'

/**
 * "Insert cells and shift down / shift right" (`下移` / `右移`) only moves the
 * cells the user selected. Spreadsheets keep the formula of a moved cell
 * pointing at the cells it referenced before the move (Excel semantics): when
 * only one column is selected, the remaining columns of that row stay behind,
 * so a profit column such as `=E1571-F1571` keeps computing the row that was
 * left above and every value below the insertion looks "shifted" by one row.
 *
 * Tables in this app are uniform columns: every cell of a column repeats the
 * same formula, relative to its own row. For those columns the only useful
 * behaviour after such a partial shift is to keep the pattern, i.e. move the
 * formula together with its row. This module detects exactly that case and
 * rewrites the moved formulas accordingly.
 *
 * The detector is deliberately conservative. The pattern of a column is read
 * from the cell right above the selection, which the shift did not move, and a
 * moved cell is rewritten only when it currently holds that pattern for its own
 * *previous* line. That means:
 *
 * - whole row / whole range shifts, where the referenced cells move together
 *   with the formula and the engine translates it, never match (and the row is
 *   already correct);
 * - a real `insert row` (which the engine translates as well) never matches;
 * - absolute references (`$E$5`) are never touched;
 * - one-off formulas (`=SUM(E2:E5)`, subtotals, lookups, ...) do not match a
 *   uniform column pattern and are left alone.
 */
export type CellShiftDirection = 'down' | 'right' | 'up'

export type CellShiftCommand = { range: IRange; direction: CellShiftDirection }

/** The subset of the `FWorksheet` / `FRange` facade used by the repair. */
export type FormulaSheetLike = {
  getRange: (
    startRow: number,
    startColumn: number,
    numRows: number,
    numColumns: number
  ) => {
    getFormula?: () => string
    setValue: (value: string | { f: string }) => unknown
  }
}

type FormulaRangeLike = ReturnType<FormulaSheetLike['getRange']>

function isRange(value: unknown): value is IRange {
  if (!value || typeof value !== 'object') return false
  const range = value as Partial<IRange>
  return (
    typeof range.startRow === 'number' &&
    typeof range.endRow === 'number' &&
    typeof range.startColumn === 'number' &&
    typeof range.endColumn === 'number'
  )
}

/**
 * Recognises the two commands that move a partial selection of cells, together
 * with the range the user had selected.
 */
export function readCellShiftCommand(
  commandId: string,
  params: unknown,
  fallbackRange?: IRange | null
): CellShiftCommand | null {
  const direction: CellShiftDirection | null =
    commandId === InsertRangeMoveDownCommand.id
      ? 'down'
      : commandId === InsertRangeMoveRightCommand.id
        ? 'right'
        : commandId === DeleteRangeMoveUpCommand.id
          ? 'up'
          : null
  if (!direction) return null

  // The context menu dispatches these commands without params: the handler
  // itself falls back to the current selection, so we do the same.
  const candidate = (params as { range?: unknown } | null | undefined)?.range ?? fallbackRange
  if (!isRange(candidate)) return null
  const range = candidate
  if (range.endRow < range.startRow || range.endColumn < range.startColumn) return null

  return { range, direction }
}

function normalizeMatrix(value: unknown, rows: number, columns: number): string[][] {
  const matrix: string[][] = []
  const source = Array.isArray(value) ? value : []
  for (let row = 0; row < rows; row += 1) {
    const line = Array.isArray(source[row]) ? (source[row] as unknown[]) : []
    const target: string[] = []
    for (let column = 0; column < columns; column += 1) {
      const cell = line[column]
      target.push(typeof cell === 'string' ? cell : '')
    }
    matrix.push(target)
  }
  return matrix
}

type SubscriptionLike = { dispose: () => void }

type CommandServiceLike = {
  onCommandExecuted: (
    callback: (info: { id?: string; params?: unknown } | null | undefined) => void
  ) => SubscriptionLike | null | undefined
  beforeCommandExecuted: (
    callback: (info: { id?: string; params?: unknown } | null | undefined) => void
  ) => SubscriptionLike | null | undefined
}

/** The facade worksheet methods used to read the pending selection. */
export type FormulaSelectionSheetLike = FormulaSheetLike & {
  getActiveRange?: () => { getRange?: () => IRange } | null | undefined
}

function readSelectedRange(sheet: FormulaSelectionSheetLike | null | undefined): IRange | null {
  try {
    const range = sheet?.getActiveRange?.()?.getRange?.()
    return isRange(range) ? range : null
  } catch {
    return null
  }
}

function getInjector(univer: unknown): { get: <T>(token: unknown) => T } | undefined {
  return (univer as { __getInjector?: () => { get: <T>(token: unknown) => T } } | null)?.__getInjector?.()
}

/**
 * The context-menu items `下移` / `右移` dispatch their command without params
 * and without `unitId`, so the unit-filtered `FWorkbook.onCommandExecuted`
 * stream never reports them and the target range has to be taken from the
 * selection - captured *before* the command runs, while it still holds the
 * cells the user selected.
 */
export function registerCellShiftFormulaRepair(
  univer: unknown,
  resolveSheet: () => FormulaSheetLike | null | undefined,
  onRepaired?: (count: number) => void
): SubscriptionLike | null {
  try {
    const commandService = getInjector(univer)?.get<CommandServiceLike | null | undefined>(ICommandService)
    if (!commandService || typeof commandService.onCommandExecuted !== 'function') return null

    const pendingShifts = new Map<string, { shift: CellShiftCommand; before: VerticalShiftCapture | null }>()
    const shiftCommandIds = new Set<string>([
      InsertRangeMoveDownCommand.id,
      InsertRangeMoveRightCommand.id,
      DeleteRangeMoveUpCommand.id,
    ])

    const before = commandService.beforeCommandExecuted?.((info) => {
      const commandId = info?.id ?? ''
      // Checked first: `beforeCommandExecuted` fires for every mutation, and a
      // large paste dispatches thousands of them.
      if (!shiftCommandIds.has(commandId)) return
      const sheet = resolveSheet()
      const shift = readCellShiftCommand(commandId, info?.params, readSelectedRange(sheet as FormulaSelectionSheetLike))
      if (!shift) return
      // Vertical shifts are repaired from a before/after comparison, so the
      // formulas have to be read while the sheet still holds the old layout.
      const capture = shift.direction === 'right' ? null : captureVerticalShift(sheet, shift)
      pendingShifts.set(commandId, { shift, before: capture })
    })

    const after = commandService.onCommandExecuted((info) => {
      const commandId = info?.id ?? ''
      const pending = pendingShifts.get(commandId)
      if (!pending) return
      pendingShifts.delete(commandId)
      // Run right after the mutations of the shift are applied, but still well
      // inside the save debounce so the repair is persisted together with it.
      window.setTimeout(() => {
        const sheet = resolveSheet()
        const repaired = pending.before
          ? repairVerticalShift(sheet, pending.shift, pending.before)
          : pending.shift.direction === 'up'
            ? 0
            : realignShiftedCellFormulas(sheet, pending.shift)
        if (repaired > 0) onRepaired?.(repaired)
      }, 0)
    })

    return {
      dispose: () => {
        before?.dispose?.()
        after?.dispose?.()
      },
    }
  } catch {
    return null
  }
}

/**
 * Keeps the formulas of a partially shifted range aligned with their own row.
 * Returns the number of rewritten cells so callers can log the repair.
 */
export function realignShiftedCellFormulas(
  sheet: FormulaSheetLike | null | undefined,
  shift: CellShiftCommand
): number {
  if (!sheet || typeof sheet.getRange !== 'function') return 0

  let lexer: LexerTreeBuilder
  try {
    lexer = new LexerTreeBuilder()
  } catch {
    return 0
  }

  const { range, direction } = shift
  const offsetX = direction === 'right' ? range.endColumn - range.startColumn + 1 : 0
  const offsetY = direction === 'down' ? range.endRow - range.startRow + 1 : 0

  // The formula pattern of a column (row) is taken from the cell directly above
  // (left of) the selection: that cell was not moved by the shift, so it still
  // holds the formula of its own row. A moved cell cannot be used as the
  // anchor: the engine translates the references of a moved cell whenever the
  // referenced cells move with it (whole row / whole range shifts), and those
  // cells must stay as they are.
  const anchorRow = range.startRow - 1
  const anchorColumn = range.startColumn - 1
  if (direction === 'down' && anchorRow < 0) return 0
  if (direction === 'right' && anchorColumn < 0) return 0

  // The engine pushes the whole remainder of the column (row) below the
  // selection, so the repair has to look far past the selected block. Read the
  // affected band of the sheet once instead of asking the facade per cell.
  const grid = sheet as FormulaSheetLike & { getMaxRows?: () => number; getMaxColumns?: () => number }
  const gridRows = Math.floor(Number(grid.getMaxRows?.() ?? 0)) || range.endRow + offsetY + 1
  const gridColumns = Math.floor(Number(grid.getMaxColumns?.() ?? 0)) || range.endColumn + offsetX + 1
  const bandTop = direction === 'down' ? anchorRow : range.startRow
  const bandBottom =
    direction === 'down' ? Math.max(gridRows - 1, range.endRow + offsetY) : range.endRow
  const bandLeft = direction === 'right' ? anchorColumn : range.startColumn
  const bandRight =
    direction === 'right' ? Math.max(gridColumns - 1, range.endColumn + offsetX) : range.endColumn

  const bandRange = sheet.getRange(
    bandTop,
    bandLeft,
    bandBottom - bandTop + 1,
    bandRight - bandLeft + 1
  ) as FormulaRangeLike & { getFormulas?: () => unknown }
  let rawFormulas: unknown
  try {
    rawFormulas = bandRange.getFormulas?.()
  } catch {
    rawFormulas = undefined
  }
  const formulas = normalizeMatrix(rawFormulas, bandBottom - bandTop + 1, bandRight - bandLeft + 1)
  const formulaAt = (row: number, column: number): string => formulas[row - bandTop]?.[column - bandLeft] ?? ''

  const repair = (row: number, column: number, anchor: string, delta: number): boolean => {
    const current = formulaAt(row, column)
    if (!current) return false
    // Where the pattern sits for the line this cell was moved from.
    const previousDelta = direction === 'down' ? delta - offsetY : delta - offsetX
    const previous = lexer.moveFormulaRefOffset(
      anchor,
      direction === 'down' ? 0 : previousDelta,
      direction === 'down' ? previousDelta : 0
    )
    // Only continue a uniform pattern, i.e. a cell that held this column's (row's)
    // formula for its own previous line. One-off formulas (subtotals, lookups)
    // and cells the engine already translated never match.
    if (current !== previous) return false
    const target = lexer.moveFormulaRefOffset(
      anchor,
      direction === 'down' ? 0 : delta,
      direction === 'down' ? delta : 0
    )
    if (!target || target === current) return false
    // `setValue` also drops the cached value, so the formula engine recomputes
    // the cell from its new references (same call the app uses for reverts).
    sheet.getRange(row, column, 1, 1).setValue({ f: target })
    return true
  }

  let repaired = 0
  if (direction === 'down') {
    for (let column = range.startColumn; column <= range.endColumn && column <= bandRight; column += 1) {
      const anchor = formulaAt(anchorRow, column)
      if (!anchor) continue
      for (let row = range.startRow + offsetY; row <= bandBottom; row += 1) {
        if (repair(row, column, anchor, row - anchorRow)) repaired += 1
      }
    }
  } else {
    for (let row = range.startRow; row <= range.endRow && row <= bandBottom; row += 1) {
      const anchor = formulaAt(row, anchorColumn)
      if (!anchor) continue
      for (let column = range.startColumn + offsetX; column <= bandRight; column += 1) {
        if (repair(row, column, anchor, column - anchorColumn)) repaired += 1
      }
    }
  }

  return repaired
}

/** Facade methods used to read a block of formulas and the used area. */
type FormulaGridSheetLike = FormulaSheetLike & {
  getMaxRows?: () => number
  getMaxColumns?: () => number
  getDataRange?: () => { getLastRow?: () => number; getLastColumn?: () => number } | null | undefined
}

/** Formulas of the band a vertical shift touches, read before it ran. */
export type VerticalShiftCapture = { grid: FormulaGrid; lastRow: number; lastColumn: number }

/** Rows x columns read for one repair; larger sheets fall back to no repair. */
const MAX_CAPTURED_CELLS = 1_500_000

function createMove(): MoveFormula | null {
  try {
    const lexer = new LexerTreeBuilder()
    return (formula, columnOffset, rowOffset) => lexer.moveFormulaRefOffset(formula, columnOffset, rowOffset)
  } catch {
    return null
  }
}

function readUsedExtent(sheet: FormulaGridSheetLike) {
  let lastRow = 0
  let lastColumn = 0
  try {
    const used = sheet.getDataRange?.()
    lastRow = Math.max(0, Math.floor(Number(used?.getLastRow?.() ?? 0)) || 0)
    lastColumn = Math.max(0, Math.floor(Number(used?.getLastColumn?.() ?? 0)) || 0)
  } catch {
    // Fall back to the grid size below.
  }
  const maxRows = Math.floor(Number(sheet.getMaxRows?.() ?? 0)) || lastRow + 1
  const maxColumns = Math.floor(Number(sheet.getMaxColumns?.() ?? 0)) || lastColumn + 1
  return {
    lastRow: Math.min(lastRow, maxRows - 1),
    lastColumn: Math.min(lastColumn, maxColumns - 1),
    maxRows,
    maxColumns,
  }
}

/** Reads `formulas[row][column]` of a block (`''` where a cell has none). */
export function readFormulaGrid(
  sheet: FormulaSheetLike | null | undefined,
  top: number,
  bottom: number,
  left: number,
  right: number
): FormulaGrid | null {
  if (!sheet || bottom < top || right < left) return null
  try {
    const range = sheet.getRange(top, left, bottom - top + 1, right - left + 1) as FormulaRangeLike & {
      getFormulas?: () => unknown
    }
    const formulas = normalizeMatrix(range.getFormulas?.(), bottom - top + 1, right - left + 1)
    return { top, left, formulas }
  } catch {
    return null
  }
}

function captureVerticalShift(sheet: FormulaSheetLike | null | undefined, shift: CellShiftCommand): VerticalShiftCapture | null {
  if (!sheet) return null
  const grid = sheet as FormulaGridSheetLike
  const extent = readUsedExtent(grid)
  const lastRow = Math.max(extent.lastRow, shift.range.endRow)
  const lastColumn = Math.max(extent.lastColumn, shift.range.endColumn)
  const top = Math.max(0, shift.range.startRow - 1)
  if ((lastRow - top + 1) * (lastColumn + 1) > MAX_CAPTURED_CELLS) return null
  const before = readFormulaGrid(sheet, top, lastRow, 0, lastColumn)
  return before ? { grid: before, lastRow, lastColumn } : null
}

/** Writes repairs run by run; returns the number of rewritten cells. */
export function applyFormulaRepairs(sheet: FormulaSheetLike | null | undefined, repairs: FormulaRepair[]): number {
  if (!sheet || repairs.length === 0) return 0
  let written = 0
  groupRepairsIntoRuns(repairs).forEach((run) => {
    try {
      const range = sheet.getRange(run.startRow, run.column, run.formulas.length, 1) as FormulaRangeLike & {
        setValues?: (values: Array<Array<{ f: string }>>) => unknown
      }
      if (typeof range.setValues === 'function') {
        range.setValues(run.formulas.map((formula) => [{ f: formula }]))
      } else {
        run.formulas.forEach((formula, index) => sheet.getRange(run.startRow + index, run.column, 1, 1).setValue({ f: formula }))
      }
      written += run.formulas.length
    } catch (error) {
      console.warn('Failed to rewrite shifted formulas:', error)
    }
  })
  return written
}

function repairVerticalShift(
  sheet: FormulaSheetLike | null | undefined,
  shift: CellShiftCommand,
  capture: VerticalShiftCapture
): number {
  if (!sheet || (shift.direction !== 'down' && shift.direction !== 'up')) return 0
  const move = createMove()
  if (!move) return 0
  const extent = readUsedExtent(sheet as FormulaGridSheetLike)
  const count = shift.range.endRow - shift.range.startRow + 1
  const bottom = Math.min(extent.maxRows - 1, capture.lastRow + (shift.direction === 'down' ? count : 0))
  const after = readFormulaGrid(sheet, capture.grid.top, bottom, 0, capture.lastColumn)
  if (!after) return 0
  const repairs = planVerticalShiftRepairs(
    capture.grid,
    after,
    {
      direction: shift.direction,
      startRow: shift.range.startRow,
      endRow: shift.range.endRow,
      startColumn: shift.range.startColumn,
      endColumn: shift.range.endColumn,
    },
    move
  )
  return applyFormulaRepairs(sheet, repairs)
}

/**
 * Scans the used area for fill-down formula columns in which some cells
 * reference another row (or `#REF!`). The editor offers to repair them.
 */
export function scanInconsistentFormulaColumns(sheet: FormulaSheetLike | null | undefined): InconsistentColumnResult | null {
  if (!sheet) return null
  const move = createMove()
  if (!move) return null
  const extent = readUsedExtent(sheet as FormulaGridSheetLike)
  if ((extent.lastRow + 1) * (extent.lastColumn + 1) > MAX_CAPTURED_CELLS) return null
  const grid = readFormulaGrid(sheet, 0, extent.lastRow, 0, extent.lastColumn)
  if (!grid) return null
  return findInconsistentFormulaColumns(grid, move)
}
