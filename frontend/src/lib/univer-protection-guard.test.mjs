// Run with: node --experimental-strip-types src/lib/univer-protection-guard.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  findProtectionBlockingRemoval,
  findProtectionInRects,
  mapStructureIndex,
  protectionAreas,
  rangeToRect,
  remapProtectionSnapshot,
  structureOpFromMutation,
} from './univer-protection-guard.ts'

const columns = [{ key: 'col_a' }, { key: 'col_b' }, { key: 'col_c' }]
const rule = (scope, extra) => ({ scope, key: '', owner_id: 1, owner_name: 'admin', lock_editing: false, hidden: true, can_edit: true, masked_for_current_user: false, protected_at: '', ...extra })

test('move semantics match Univer (and the server)', () => {
  const down = { kind: 'move', axis: 'row', start: 2, count: 2, target: 6 }
  assert.deepEqual([0, 2, 3, 4, 5, 6].map((index) => mapStructureIndex(down, index)), [0, 4, 5, 2, 3, 6])
  const up = { kind: 'move', axis: 'row', start: 5, count: 2, target: 1 }
  assert.deepEqual([0, 1, 4, 5, 6, 7].map((index) => mapStructureIndex(up, index)), [0, 3, 6, 1, 2, 7])
  assert.equal(mapStructureIndex({ kind: 'remove', axis: 'row', start: 3, count: 2 }, 4), null)
})

test('structure ops are read from Univer mutations', () => {
  assert.deepEqual(
    structureOpFromMutation('sheet.mutation.insert-row', { range: { startRow: 4, endRow: 6, startColumn: 0, endColumn: 9 } }),
    { kind: 'insert', axis: 'row', start: 4, count: 3 },
  )
  assert.deepEqual(
    structureOpFromMutation('sheet.mutation.move-columns', { sourceRange: { startColumn: 1, endColumn: 1 }, targetRange: { startColumn: 4 } }),
    { kind: 'move', axis: 'column', start: 1, count: 1, target: 4 },
  )
  assert.equal(structureOpFromMutation('sheet.mutation.set-range-values', {}), null)
})

test('protections follow inserted rows and columns', () => {
  const snapshot = {
    rows: [rule('row', { key: '4', row_index: 4 })],
    columns: [rule('column', { key: 'col_b', column_key: 'col_b' })],
    cells: [rule('cell', { key: '9:col_c', row_index: 9, column_key: 'col_c' })],
  }
  const next = remapProtectionSnapshot(snapshot, [
    { kind: 'insert', axis: 'row', start: 3, count: 2 },
    { kind: 'insert', axis: 'column', start: 0, count: 1 },
  ], columns)
  assert.equal(next.rows[0].row_index, 6)
  assert.equal(next.columns[0].column_key, 'col_c')
  assert.equal(next.cells[0].key, '11:col_4')
})

test('removing rows or columns with protections is detected', () => {
  const snapshot = {
    rows: [],
    columns: [rule('column', { key: 'col_b', column_key: 'col_b' })],
    cells: [rule('cell', { key: '2:col_a', row_index: 2, column_key: 'col_a' })],
  }
  const areas = protectionAreas(snapshot, columns)
  assert.ok(findProtectionBlockingRemoval(areas, 'row', 3, 3), 'worksheet row 3 holds a masked cell')
  assert.equal(findProtectionBlockingRemoval(areas, 'row', 5, 9), undefined, 'a column mask does not block deleting rows')
  assert.ok(findProtectionBlockingRemoval(areas, 'column', 1, 1))
  assert.equal(findProtectionBlockingRemoval(areas, 'column', 2, 2), undefined)
})

test('whole row/column selections are unbounded on the open axis', () => {
  const rect = rangeToRect({ startRow: Number.NaN, endRow: Number.NaN, startColumn: 1, endColumn: 1 })
  assert.equal(rect.startRow, 0)
  assert.ok(rect.endRow > 1e9)
  const areas = protectionAreas({ rows: [], columns: [], cells: [rule('cell', { row_index: 500, column_key: 'col_b' })] }, columns)
  assert.ok(findProtectionInRects(areas, [rect]))
})
