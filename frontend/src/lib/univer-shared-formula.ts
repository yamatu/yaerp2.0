import type { ICellData, ICellDataForSheetInterceptor, Nullable } from '@univerjs/core'
import { BEFORE_CELL_EDIT, SheetInterceptorService } from '@univerjs/sheets'
import { FormulaDataModel } from '@univerjs/engine-formula'

type Injector = { get: <T>(token: unknown) => T }

function getInjector(univer: unknown): Injector | undefined {
  return (univer as { __getInjector?: () => Injector } | null)?.__getInjector?.()
}

/**
 * Univer collapses runs of similar formulas into a shared formula group: the
 * cell that owns the group keeps `f`, the remaining members only carry the
 * shared id (`si`). The formula engine resolves those members on demand - that
 * is how they keep calculating and rendering - but the inline cell editor and
 * copy/paste read the raw cell data, where `f` is missing. Editing such a cell
 * therefore starts from the cached value and overwrites the formula.
 *
 * This resolver asks the very service the engine uses, so a member cell can be
 * turned back into a self-contained formula wherever the app needs it.
 */
export type SharedFormulaResolver = (
  row: number,
  column: number,
  sheetId: string,
  unitId: string
) => string | undefined

export function createSharedFormulaResolver(univer: unknown): SharedFormulaResolver | null {
  if (!getInjector(univer)) return null

  return (row, column, sheetId, unitId) => {
    try {
      // Looked up on every call because the formula plugin (and therefore the
      // data model) is instantiated lazily with the first workbook.
      const injector = getInjector(univer)
      const formulaDataModel = injector?.get<FormulaDataModel | undefined>(FormulaDataModel)
      if (!formulaDataModel || typeof formulaDataModel.getFormulaStringByCell !== 'function') return undefined
      return formulaDataModel.getFormulaStringByCell(row, column, sheetId, unitId) || undefined
    } catch {
      return undefined
    }
  }
}

/** A cell whose formula has to be restored, together with its resolved formula. */
export type SharedFormulaCell = { row: number; column: number; cell: ICellData }

/** A run of vertically adjacent shared formula cells inside a single column. */
export type SharedFormulaRange = { column: number; startRow: number; cells: ICellData[] }

type CellMatrixLike = Record<string, Record<string, ICellData> | undefined> | undefined

function isSharedFormulaMember(cell: unknown): boolean {
  if (!cell || typeof cell !== 'object') return false
  const shared = (cell as { si?: unknown }).si
  if (shared === undefined || shared === null) return false
  const formula = (cell as { f?: unknown }).f
  return !(typeof formula === 'string' && formula.length > 0)
}

/**
 * Finds every shared formula member without an inline formula and resolves it
 * through the formula engine. Returned cells drop the `si` marker because the
 * resolved formula is self-contained.
 */
export function collectSharedFormulaCells(
  cellData: CellMatrixLike,
  resolve: SharedFormulaResolver | null,
  sheetId: string,
  unitId: string
): { cells: SharedFormulaCell[]; ranges: SharedFormulaRange[] } {
  const cells: SharedFormulaCell[] = []
  if (!resolve || !cellData || typeof cellData !== 'object') return { cells, ranges: [] }

  for (const [rowKey, row] of Object.entries(cellData)) {
    const rowIndex = Number(rowKey)
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || !row || typeof row !== 'object') continue
    for (const [columnKey, cell] of Object.entries(row)) {
      const columnIndex = Number(columnKey)
      if (!Number.isInteger(columnIndex) || columnIndex < 0) continue
      if (!isSharedFormulaMember(cell)) continue
      const formula = resolve(rowIndex, columnIndex, sheetId, unitId)
      if (!formula) continue
      const { si: _shared, ...rest } = cell
      cells.push({ row: rowIndex, column: columnIndex, cell: { ...rest, f: formula } })
    }
  }

  cells.sort((left, right) => (left.column === right.column ? left.row - right.row : left.column - right.column))
  const ranges: SharedFormulaRange[] = []
  const openRanges = new Map<number, SharedFormulaRange>()
  for (const item of cells) {
    const open = openRanges.get(item.column)
    if (open && open.startRow + open.cells.length === item.row) {
      open.cells.push(item.cell)
      continue
    }
    const range: SharedFormulaRange = { column: item.column, startRow: item.row, cells: [item.cell] }
    openRanges.set(item.column, range)
    ranges.push(range)
  }

  return { cells, ranges }
}

/**
 * The inline editor builds its draft from the raw cell, so a shared formula
 * member without `f` opens as its cached value. Handing the editor the resolved
 * formula keeps double click editing (and the value the user sees while typing)
 * on the formula instead of the result.
 *
 * Univer composes these interceptors as a chain: a handler only reaches the next
 * one when it calls `next()`. This one therefore runs first (higher priority than
 * the composed style interceptor) and forwards the patched cell.
 */
export function registerSharedFormulaEditorInterceptor(univer: unknown, attempt = 0) {
  const injector = getInjector(univer)
  if (!injector) return

  try {
    const service = injector.get<SheetInterceptorService | undefined>(SheetInterceptorService)
    if (!service?.writeCellInterceptor) {
      throw new Error('SheetInterceptorService is not available yet')
    }

    const resolve = createSharedFormulaResolver(univer)
    service.writeCellInterceptor.intercept(BEFORE_CELL_EDIT, {
      priority: 200,
      handler: (cell, context, next) => {
        const patched = resolveSharedFormulaCell(cell, context, resolve)
        return typeof next === 'function' ? next(patched) : patched
      },
    })
  } catch (error) {
    if (attempt < 40) {
      setTimeout(() => registerSharedFormulaEditorInterceptor(univer, attempt + 1), 50)
      return
    }
    console.warn('Failed to register the shared formula editor interceptor:', error)
  }
}

type EditorCellContext = {
  row?: number
  col?: number
  unitId?: string
  subUnitId?: string
  worksheet?: { getSheetId?: () => string }
  workbook?: { getUnitId?: () => string }
}

function resolveSharedFormulaCell(
  cell: Nullable<ICellDataForSheetInterceptor>,
  context: EditorCellContext | undefined,
  resolve: SharedFormulaResolver | null
): Nullable<ICellDataForSheetInterceptor> {
  try {
    if (!isSharedFormulaMember(cell)) return cell
    const row = context?.row
    const col = context?.col
    if (typeof row !== 'number' || typeof col !== 'number') return cell
    const sheetId = context?.worksheet?.getSheetId?.() ?? context?.subUnitId
    const unitId = context?.workbook?.getUnitId?.() ?? context?.unitId
    if (!sheetId || !unitId) return cell
    const formula = resolve?.(row, col, sheetId, unitId)
    if (!formula) return cell
    return { ...(cell as ICellDataForSheetInterceptor), f: formula }
  } catch {
    return cell
  }
}
