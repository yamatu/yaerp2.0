/**
 * Pure helpers that keep "filled down" formula columns aligned with their own
 * row. Nothing in here touches Univer: callers hand in formula grids read from
 * the sheet and a `move` function (Univer's `LexerTreeBuilder.moveFormulaRefOffset`
 * in the app, the same lexer in the node test), and receive a list of cells to
 * rewrite. That keeps the logic unit testable without a browser.
 *
 * Background: tables in this app are uniform columns. `O5 = M5*N5`,
 * `O6 = M6*N6`, ... Excel semantics translate references whenever the cells
 * they point at move, so a partial shift (`插入单元格，活动单元格下移` /
 * `删除单元格，下方单元格上移` on M:N only) leaves column O pointing at the
 * neighbouring row (or at `#REF!`) from the shift downwards - the totals then
 * silently compute the wrong rows. Users expect every row to keep computing
 * itself, which is what these helpers restore.
 */

/** Moves the relative references of a formula by the given offsets. */
export type MoveFormula = (formula: string, columnOffset: number, rowOffset: number) => string

/** A rectangular block of formulas read from the sheet (`''` = no formula). */
export interface FormulaGrid {
  /** Sheet row of `formulas[0]`. */
  top: number
  /** Sheet column of `formulas[*][0]`. */
  left: number
  formulas: string[][]
}

export interface FormulaRepair {
  row: number
  column: number
  /** Formula the cell holds now (`''` when it is empty). */
  current: string
  /** Formula the cell has to hold to compute its own row again. */
  expected: string
}

export type VerticalShiftDirection = 'down' | 'up'

export interface VerticalShift {
  direction: VerticalShiftDirection
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

export function formulaAt(grid: FormulaGrid, row: number, column: number): string {
  const value = grid.formulas[row - grid.top]?.[column - grid.left]
  return typeof value === 'string' ? value : ''
}

function gridBottom(grid: FormulaGrid) {
  return grid.top + grid.formulas.length - 1
}

function gridRight(grid: FormulaGrid) {
  let width = 0
  grid.formulas.forEach((row) => {
    if (row.length > width) width = row.length
  })
  return grid.left + width - 1
}

function safeMove(move: MoveFormula, formula: string, columnOffset: number, rowOffset: number): string {
  if (columnOffset === 0 && rowOffset === 0) return formula
  try {
    const moved = move(formula, columnOffset, rowOffset)
    return typeof moved === 'string' ? moved : ''
  } catch {
    return ''
  }
}

/**
 * A cell belongs to a fill-down run when its formula is the formula of the
 * cell above (or below) moved by one row. A single formula is never treated as
 * a pattern: one-off formulas (totals, lookups) keep Excel semantics.
 */
export function isFillDownCell(grid: FormulaGrid, row: number, column: number, move: MoveFormula): boolean {
  const formula = formulaAt(grid, row, column)
  if (!formula) return false
  const above = formulaAt(grid, row - 1, column)
  if (above && safeMove(move, above, 0, 1) === formula) return true
  const below = formulaAt(grid, row + 1, column)
  if (below && safeMove(move, below, 0, -1) === formula) return true
  return false
}

/**
 * Plans the rewrites after a partial vertical shift. `before` must be read
 * before the command ran and `after` once it was applied; both should cover
 * the rows from just above the shift to the bottom of the used area and every
 * used column.
 *
 * - cells that stayed in place keep the formula they had (Univer translated
 *   it because the referenced cells moved);
 * - cells that moved with the shift compute the row they landed on;
 * - for a downward shift the hole opened inside a uniform column is filled
 *   with the column pattern, and columns that stay in place are extended over
 *   the rows the shifted data was pushed into, so nothing drops out of a total.
 */
export function planVerticalShiftRepairs(
  before: FormulaGrid,
  after: FormulaGrid,
  shift: VerticalShift,
  move: MoveFormula
): FormulaRepair[] {
  const repairs: FormulaRepair[] = []
  const count = shift.endRow - shift.startRow + 1
  if (count <= 0) return repairs
  const offset = shift.direction === 'down' ? count : -count
  const firstColumn = Math.min(before.left, after.left)
  const lastColumn = Math.max(gridRight(before), gridRight(after))
  const lastRow = gridBottom(before)
  const planned = new Set<string>()

  const plan = (row: number, column: number, expected: string) => {
    if (!expected || expected.includes('#REF!')) return
    const key = `${row}:${column}`
    if (planned.has(key)) return
    const current = formulaAt(after, row, column)
    if (current === expected) return
    planned.add(key)
    repairs.push({ row, column, current, expected })
  }

  for (let column = firstColumn; column <= lastColumn; column += 1) {
    const moved = column >= shift.startColumn && column <= shift.endColumn
    let lastUniformRow = -1
    let lastUniformFormula = ''
    let lastUniformChanged = false

    for (let row = shift.startRow; row <= lastRow; row += 1) {
      const formula = formulaAt(before, row, column)
      if (!formula || !isFillDownCell(before, row, column, move)) continue
      // Cells removed by an upward shift do not exist any more.
      if (moved && shift.direction === 'up' && row <= shift.endRow) continue
      const target = moved ? row + offset : row
      const current = formulaAt(after, target, column)
      // An emptied cell was cleared on purpose (or never moved): leave it.
      if (!current) continue
      const expected = moved ? safeMove(move, formula, 0, offset) : formula
      plan(target, column, expected)
      if (!moved) {
        lastUniformRow = row
        lastUniformFormula = formula
        lastUniformChanged = current !== formula
      }
    }

    if (shift.direction !== 'down') continue

    if (moved) {
      // The shift opened a hole inside a uniform column: keep it computing.
      const anchorRow = shift.startRow - 1
      const anchor = formulaAt(before, anchorRow, column)
      const continued = formulaAt(before, shift.startRow, column)
      if (
        anchor &&
        continued &&
        safeMove(move, anchor, 0, 1) === continued &&
        isFillDownCell(before, anchorRow, column, move)
      ) {
        for (let row = shift.startRow; row <= shift.endRow; row += 1) {
          if (formulaAt(after, row, column)) continue
          const value = after.formulas[row - after.top]?.[column - after.left]
          if (value === undefined) continue
          plan(row, column, safeMove(move, anchor, 0, row - anchorRow))
        }
      }
      continue
    }

    // A column that stayed in place whose last fill-down formula depended on
    // the shifted cells: the data it computed was pushed `count` rows further
    // down, so the pattern follows it.
    if (lastUniformRow >= shift.startRow && lastUniformChanged) {
      for (let step = 1; step <= count; step += 1) {
        const row = lastUniformRow + step
        if (row > gridBottom(after)) break
        if (formulaAt(before, row, column) || formulaAt(after, row, column)) break
        plan(row, column, safeMove(move, lastUniformFormula, 0, step))
      }
    }
  }

  return repairs
}

/** Formula text with every cell reference (and `#REF!`) replaced by `R`. */
export function formulaShape(formula: string): string {
  let result = ''
  let index = 0
  while (index < formula.length) {
    const character = formula[index]
    if (character === '"') {
      // String literals are kept verbatim; a doubled quote is an escaped quote.
      let end = index + 1
      while (end < formula.length) {
        if (formula[end] === '"') {
          if (formula[end + 1] === '"') {
            end += 2
            continue
          }
          break
        }
        end += 1
      }
      result += formula.slice(index, end + 1)
      index = end + 1
      continue
    }
    const rest = formula.slice(index)
    const reference = /^(?:#REF!|\$?[A-Za-z]{1,3}\$?\d+)/.exec(rest)
    const previous = formula[index - 1]
    if (reference && !(previous && /[A-Za-z0-9_.]/.test(previous))) {
      const next = rest[reference[0].length]
      if (!next || !/[A-Za-z0-9_(]/.test(next)) {
        result += 'R'
        index += reference[0].length
        continue
      }
    }
    result += character
    index += 1
  }
  return result
}

export interface InconsistentFormulaColumn {
  column: number
  /** Number of formulas that follow the column pattern. */
  consistent: number
  /** A formula of the pattern and the row it sits in, for the UI. */
  sampleRow: number
  sampleFormula: string
  repairs: FormulaRepair[]
}

export interface ConsistencyOptions {
  /** Minimum number of cells that have to share the pattern. */
  minPattern?: number
  /** Share of same-shaped formulas that have to follow the pattern. */
  minShare?: number
  /** Upper bound for formulas inspected per scan. */
  maxCells?: number
}

/**
 * Finds formula columns where most cells follow one fill-down pattern but some
 * cells of the same shape reference another row (or `#REF!`). Those are the
 * cells a structural edit or a mis-anchored copy left behind; one-off formulas
 * with a different shape are never reported.
 */
export function findInconsistentFormulaColumns(
  grid: FormulaGrid,
  move: MoveFormula,
  options: ConsistencyOptions = {}
): InconsistentColumnResult {
  const minPattern = options.minPattern ?? 4
  const minShare = options.minShare ?? 0.6
  const maxCells = options.maxCells ?? 60000
  const columns: InconsistentFormulaColumn[] = []
  const bottom = gridBottom(grid)
  const right = gridRight(grid)
  let inspected = 0
  let truncated = false

  for (let column = grid.left; column <= right && !truncated; column += 1) {
    const cells: Array<{ row: number; formula: string; shape: string; key: string }> = []
    for (let row = grid.top; row <= bottom; row += 1) {
      const formula = formulaAt(grid, row, column)
      if (!formula) continue
      inspected += 1
      if (inspected > maxCells) {
        truncated = true
        break
      }
      const shape = formulaShape(formula)
      // Normalise to one base row: relative references then line up for every
      // member of the same fill-down pattern. Moving downwards never produces
      // an invalid reference, so this works for any row.
      const key = formula.includes('#REF!') ? `#REF:${row}` : safeMove(move, formula, 0, bottom + 1 - row)
      cells.push({ row, formula, shape, key })
    }
    if (truncated || cells.length < minPattern) continue

    const byKey = new Map<string, { count: number; row: number; formula: string; shape: string }>()
    cells.forEach((cell) => {
      if (!cell.key || cell.key.startsWith('#REF:')) return
      const entry = byKey.get(cell.key)
      if (entry) entry.count += 1
      else byKey.set(cell.key, { count: 1, row: cell.row, formula: cell.formula, shape: cell.shape })
    })
    let dominant: { count: number; row: number; formula: string; shape: string } | null = null
    byKey.forEach((entry) => {
      if (!dominant || entry.count > dominant.count) dominant = entry
    })
    const pattern = dominant as { count: number; row: number; formula: string; shape: string } | null
    if (!pattern || pattern.count < minPattern) continue
    // A pattern whose formula has no relative reference never depends on the row.
    const probe = safeMove(move, pattern.formula, 0, 1)
    if (!probe || probe === pattern.formula) continue

    const sameShape = cells.filter((cell) => cell.shape === pattern.shape)
    if (pattern.count / sameShape.length < minShare) continue

    const patternKey = safeMove(move, pattern.formula, 0, bottom + 1 - pattern.row)
    const repairs: FormulaRepair[] = []
    sameShape.forEach((cell) => {
      if (cell.key === patternKey) return
      const expected = safeMove(move, pattern.formula, 0, cell.row - pattern.row)
      if (!expected || expected.includes('#REF!') || expected === cell.formula) return
      repairs.push({ row: cell.row, column, current: cell.formula, expected })
    })
    if (repairs.length === 0) continue
    columns.push({
      column,
      consistent: pattern.count,
      sampleRow: pattern.row,
      sampleFormula: pattern.formula,
      repairs,
    })
  }

  return { columns, truncated }
}

export interface InconsistentColumnResult {
  columns: InconsistentFormulaColumn[]
  /** True when the sheet held more formulas than one scan inspects. */
  truncated: boolean
}

/**
 * Groups repairs into vertical runs so callers can write a whole run with a
 * single `setValues` call (and a single undo step per run).
 */
export function groupRepairsIntoRuns(repairs: FormulaRepair[]): Array<{ column: number; startRow: number; formulas: string[] }> {
  const sorted = repairs.slice().sort((left, right) => left.column - right.column || left.row - right.row)
  const runs: Array<{ column: number; startRow: number; formulas: string[] }> = []
  sorted.forEach((repair) => {
    const last = runs[runs.length - 1]
    if (last && last.column === repair.column && last.startRow + last.formulas.length === repair.row) {
      last.formulas.push(repair.expected)
      return
    }
    runs.push({ column: repair.column, startRow: repair.row, formulas: [repair.expected] })
  })
  return runs
}
