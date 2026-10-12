// Run with: node --experimental-strip-types src/lib/univer-formula-consistency.test.mjs
// Uses Univer's own lexer so the moved formulas match what the editor produces.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LexerTreeBuilder } from '@univerjs/engine-formula'
import {
  findInconsistentFormulaColumns,
  formulaShape,
  groupRepairsIntoRuns,
  planVerticalShiftRepairs,
} from './univer-formula-consistency.ts'

const lexer = new LexerTreeBuilder()
const move = (formula, columnOffset, rowOffset) => lexer.moveFormulaRefOffset(formula, columnOffset, rowOffset)

const M = 12
const O = 14
const P = 15
const ROWS = 2000

/** Sheet rows 0..ROWS: header + `O = M*N`, `P = M*N + $Q$1` filled down. */
function filledGrid() {
  const formulas = []
  for (let row = 0; row <= ROWS; row += 1) {
    const line = new Array(17).fill('')
    if (row > 0) {
      line[O] = `=M${row + 1}*N${row + 1}`
      line[P] = `=M${row + 1}*N${row + 1}+$Q$1`
    }
    formulas.push(line)
  }
  formulas[0][16] = ''
  return { top: 0, left: 0, formulas }
}

function clone(grid) {
  return { top: grid.top, left: grid.left, formulas: grid.formulas.map((row) => row.slice()) }
}

function set(grid, row, column, value) {
  while (grid.formulas.length <= row - grid.top) grid.formulas.push(new Array(17).fill(''))
  grid.formulas[row - grid.top][column - grid.left] = value
}

function apply(grid, repairs) {
  const next = clone(grid)
  repairs.forEach((repair) => set(next, repair.row, repair.column, repair.expected))
  return next
}

function misaligned(grid) {
  const bad = []
  grid.formulas.forEach((line, index) => {
    const row = grid.top + index
    if (row === 0) return
    if (line[O] && line[O] !== `=M${row + 1}*N${row + 1}`) bad.push(`O${row + 1}=${line[O]}`)
    if (line[P] && line[P] !== `=M${row + 1}*N${row + 1}+$Q$1`) bad.push(`P${row + 1}=${line[P]}`)
  })
  return bad
}

/**
 * What Univer does on "insert cells, shift down" for M31:N31 (row index 30):
 * every reference to M/N at or below row 31 follows the moved cell, so the
 * formulas of O/P from row 31 on point one row further down.
 */
function univerInsertCellsDown(grid, startRow, count) {
  const next = clone(grid)
  // The shifted data now reaches `count` rows further down.
  set(next, ROWS + count, M, '')
  for (let row = startRow; row <= ROWS; row += 1) {
    set(next, row, O, `=M${row + 1 + count}*N${row + 1 + count}`)
    set(next, row, P, `=M${row + 1 + count}*N${row + 1 + count}+$Q$1`)
  }
  return next
}

/** "Delete cells, shift up" for M41:N41: deleted references become #REF!. */
function univerDeleteCellsUp(grid, startRow, count) {
  const next = clone(grid)
  for (let row = startRow; row <= ROWS; row += 1) {
    if (row < startRow + count) {
      set(next, row, O, '=#REF!*#REF!')
      set(next, row, P, '=#REF!*#REF!+$Q$1')
    } else {
      set(next, row, O, `=M${row + 1 - count}*N${row + 1 - count}`)
      set(next, row, P, `=M${row + 1 - count}*N${row + 1 - count}+$Q$1`)
    }
  }
  return next
}

test('reproduces the misalignment Univer leaves after shifting M:N down', () => {
  const after = univerInsertCellsDown(filledGrid(), 30, 1)
  const bad = misaligned(after)
  assert.equal(bad[0], 'O31==M32*N32')
  assert.ok(bad.length > 3000)
})

test('insert cells shift down keeps every row computing itself', () => {
  const before = filledGrid()
  const after = univerInsertCellsDown(before, 30, 1)
  const shift = { direction: 'down', startRow: 30, endRow: 30, startColumn: M, endColumn: M + 1 }
  const repairs = planVerticalShiftRepairs(before, after, shift, move)
  const repaired = apply(after, repairs)
  assert.deepEqual(misaligned(repaired), [])
  // The data was pushed one row further: the pattern follows it.
  assert.equal(repaired.formulas[ROWS + 1][O], `=M${ROWS + 2}*N${ROWS + 2}`)
})

test('delete cells shift up repairs #REF! and the shifted rows', () => {
  const before = filledGrid()
  const after = univerDeleteCellsUp(before, 40, 2)
  const shift = { direction: 'up', startRow: 40, endRow: 41, startColumn: M, endColumn: M + 1 }
  const repairs = planVerticalShiftRepairs(before, after, shift, move)
  assert.deepEqual(misaligned(apply(after, repairs)), [])
})

test('formulas that moved with the shift compute their new row', () => {
  // The shifted block itself holds a fill-down formula (column M = K*L).
  const before = filledGrid()
  for (let row = 1; row <= 50; row += 1) set(before, row, M, `=K${row + 1}*L${row + 1}`)
  const after = clone(before)
  // Univer moved M31:M50 one row down; refs to K/L did not move, so the text
  // is unchanged and now computes the row above.
  for (let row = 50; row >= 30; row -= 1) set(after, row + 1, M, before.formulas[row][M])
  set(after, 30, M, '')
  const shift = { direction: 'down', startRow: 30, endRow: 30, startColumn: M, endColumn: M }
  const repairs = planVerticalShiftRepairs(before, after, shift, move)
  const repaired = apply(after, repairs)
  for (let row = 1; row <= 51; row += 1) assert.equal(repaired.formulas[row][M], `=K${row + 1}*L${row + 1}`, `M${row + 1}`)
})

test('one-off formulas keep Excel semantics', () => {
  const before = filledGrid()
  set(before, 5, 3, '=SUM(M2:M100)')
  const after = univerInsertCellsDown(before, 30, 1)
  set(after, 5, 3, '=SUM(M2:M101)')
  const shift = { direction: 'down', startRow: 30, endRow: 30, startColumn: M, endColumn: M + 1 }
  const repairs = planVerticalShiftRepairs(before, after, shift, move)
  assert.ok(repairs.every((repair) => repair.column !== 3))
})

test('whole row inserts are already consistent and need no repair', () => {
  const grid = filledGrid()
  const result = findInconsistentFormulaColumns(grid, move)
  assert.equal(result.columns.length, 0)
})

test('the scan finds and repairs cells pointing at another row', () => {
  const broken = univerInsertCellsDown(filledGrid(), 30, 1)
  // Rows 41.. were brought back by an opposite shift: only 31..40 stay wrong.
  for (let row = 40; row <= ROWS; row += 1) {
    set(broken, row, O, `=M${row + 1}*N${row + 1}`)
    set(broken, row, P, `=M${row + 1}*N${row + 1}+$Q$1`)
  }
  set(broken, 60, O, '=#REF!*N61')
  set(broken, 3, 3, '=SUM(O2:O9)')
  const result = findInconsistentFormulaColumns(broken, move)
  assert.deepEqual(result.columns.map((column) => column.column), [O, P])
  const repairs = result.columns.flatMap((column) => column.repairs)
  assert.equal(repairs.length, 21)
  assert.deepEqual(misaligned(apply(broken, repairs)), [])
  const runs = groupRepairsIntoRuns(repairs)
  assert.equal(runs.length, 3)
})

test('formula shapes ignore row numbers and string literals', () => {
  assert.equal(formulaShape('=M5*N5'), formulaShape('=#REF!*N9'))
  assert.equal(formulaShape('=IF(A1="B2",$C$3,LOG10(D4))'), '=IF(R="B2",R,LOG10(R))')
})
