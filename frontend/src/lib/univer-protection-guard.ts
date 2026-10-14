import type { ColumnDef, ProtectionInfo, ProtectionSnapshot } from '@/types'

/**
 * Protections are addressed by position (data row index and column key), and
 * column keys are positional too. When rows or columns move in the editor the
 * protections have to move with them, otherwise a mask ends up over another
 * row and exposes the data it used to hide. This module:
 *  - records the row/column inserts, removals and moves Univer performs (from
 *    its mutations, so undo/redo is covered), which the save sends to the
 *    server as `structure_ops`;
 *  - finds protections that a delete, shift, sort or clear would destroy, so
 *    the command can be cancelled before it runs.
 * Indexes are worksheet indexes: row 0 is the header row.
 */

export interface WorksheetRect {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

export interface StructureOp {
  kind: 'insert' | 'remove' | 'move'
  axis: 'row' | 'column'
  start: number
  count: number
  /** Move only: the index the block is dropped before, in the layout prior to the move. */
  target?: number
}

export interface ProtectionArea extends WorksheetRect {
  item: ProtectionInfo
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER

interface RangeLike {
  startRow?: number
  endRow?: number
  startColumn?: number
  endColumn?: number
}

function rangeSpan(range: RangeLike | undefined, axis: 'row' | 'column') {
  const start = axis === 'row' ? range?.startRow : range?.startColumn
  const end = axis === 'row' ? range?.endRow : range?.endColumn
  if (typeof start !== 'number' || typeof end !== 'number' || start < 0 || end < start) return null
  return { start, count: end - start + 1 }
}

/** Translates a Univer mutation into a structure op, or null for other mutations. */
export function structureOpFromMutation(id: string, params: unknown): StructureOp | null {
  const value = (params || {}) as { range?: RangeLike; sourceRange?: RangeLike; targetRange?: RangeLike }
  const simple = (kind: 'insert' | 'remove', axis: 'row' | 'column'): StructureOp | null => {
    const span = rangeSpan(value.range, axis)
    return span ? { kind, axis, ...span } : null
  }
  const move = (axis: 'row' | 'column'): StructureOp | null => {
    const span = rangeSpan(value.sourceRange, axis)
    const target = axis === 'row' ? value.targetRange?.startRow : value.targetRange?.startColumn
    if (!span || typeof target !== 'number' || target < 0) return null
    if (target >= span.start && target <= span.start + span.count) return null
    return { kind: 'move', axis, ...span, target }
  }
  switch (id) {
    case 'sheet.mutation.insert-row': return simple('insert', 'row')
    case 'sheet.mutation.remove-rows': return simple('remove', 'row')
    case 'sheet.mutation.move-rows': return move('row')
    case 'sheet.mutation.insert-col': return simple('insert', 'column')
    case 'sheet.mutation.remove-col': return simple('remove', 'column')
    case 'sheet.mutation.move-columns': return move('column')
    default: return null
  }
}

/** Where index ends up after op; null when op removes it. Mirrors the server. */
export function mapStructureIndex(op: StructureOp, index: number): number | null {
  const { start, count } = op
  if (op.kind === 'insert') return index >= start ? index + count : index
  if (op.kind === 'remove') {
    if (index < start) return index
    if (index < start + count) return null
    return index - count
  }
  const target = op.target ?? start
  if (index >= start && index < start + count) {
    return target > start ? target - count + (index - start) : target + (index - start)
  }
  if (target > start) return index >= start + count && index < target ? index - count : index
  return index >= target && index < start ? index + count : index
}

export function protectionAreas(snapshot: ProtectionSnapshot, columns: ColumnDef[]): ProtectionArea[] {
  const columnIndexes = new Map(columns.map((column, index) => [column.key, index]))
  const areas: ProtectionArea[] = []
  snapshot.rows.forEach((item) => {
    if (typeof item.row_index !== 'number') return
    const row = item.row_index + 1
    areas.push({ item, startRow: row, endRow: row, startColumn: 0, endColumn: UNBOUNDED })
  })
  snapshot.columns.forEach((item) => {
    const column = columnIndexes.get(item.column_key || item.key)
    if (column === undefined) return
    areas.push({ item, startRow: 0, endRow: UNBOUNDED, startColumn: column, endColumn: column })
  })
  snapshot.cells.forEach((item) => {
    const column = columnIndexes.get(item.column_key || '')
    if (typeof item.row_index !== 'number' || column === undefined) return
    const row = item.row_index + 1
    areas.push({ item, startRow: row, endRow: row, startColumn: column, endColumn: column })
  })
  return areas
}

function intersects(area: WorksheetRect, rect: WorksheetRect) {
  return area.startRow <= rect.endRow && area.endRow >= rect.startRow &&
    area.startColumn <= rect.endColumn && area.endColumn >= rect.startColumn
}

export function findProtectionInRects(areas: ProtectionArea[], rects: WorksheetRect[], accept: (item: ProtectionInfo) => boolean = () => true) {
  return areas.find((area) => accept(area.item) && rects.some((rect) => intersects(area, rect)))
}

/** Deleting rows destroys row and cell protections on them; a column protection only loses some cells. */
export function findProtectionBlockingRemoval(areas: ProtectionArea[], axis: 'row' | 'column', start: number, end: number) {
  return areas.find((area) => {
    if (axis === 'row') return area.item.scope !== 'column' && area.startRow <= end && area.endRow >= start
    return area.item.scope !== 'row' && area.startColumn <= end && area.endColumn >= start
  })
}

export function describeProtectionArea(area: ProtectionArea, columns: ColumnDef[]) {
  const item = area.item
  const columnName = (key?: string) => {
    const column = columns.find((entry) => entry.key === key)
    return column?.name || key || ''
  }
  const kind = item.hidden ? '数据遮罩' : item.hide_formula ? '隐藏公式' : '保护'
  if (item.scope === 'row') return `第 ${area.startRow + 1} 行的${kind}`
  if (item.scope === 'column') return `「${columnName(item.column_key || item.key)}」列的${kind}`
  return `单元格「${columnName(item.column_key)} / 第 ${area.startRow + 1} 行」的${kind}`
}

/** Applies ops to a protection snapshot so the editor stays in step until the server answers. */
export function remapProtectionSnapshot(snapshot: ProtectionSnapshot, ops: StructureOp[], columns: ColumnDef[]): ProtectionSnapshot {
  if (ops.length === 0) return snapshot
  const columnIndexes = new Map(columns.map((column, index) => [column.key, index]))
  const mapAxis = (axis: 'row' | 'column', index: number) => {
    let current: number | null = index
    for (const op of ops) {
      if (current === null) return null
      if (op.axis === axis) current = mapStructureIndex(op, current)
    }
    return current
  }
  const mapRow = (rowIndex: number | undefined) => {
    if (typeof rowIndex !== 'number') return undefined
    const mapped = mapAxis('row', rowIndex + 1)
    return mapped === null || mapped < 1 ? null : mapped - 1
  }
  const mapColumn = (key: string | undefined) => {
    if (!key) return key
    const index = columnIndexes.get(key)
    if (index === undefined) return key
    const mapped = mapAxis('column', index)
    if (mapped === null) return null
    return columns[mapped]?.key || `col_${mapped + 1}`
  }
  const rows = snapshot.rows.flatMap((item) => {
    const row = mapRow(item.row_index)
    return row === null || row === undefined ? [] : [{ ...item, row_index: row, key: String(row) }]
  })
  const columnItems = snapshot.columns.flatMap((item) => {
    const key = mapColumn(item.column_key || item.key)
    return key ? [{ ...item, column_key: key, key }] : []
  })
  const cells = snapshot.cells.flatMap((item) => {
    const row = mapRow(item.row_index)
    const column = mapColumn(item.column_key)
    return row === null || row === undefined || !column ? [] : [{ ...item, row_index: row, column_key: column, key: `${row}:${column}` }]
  })
  return { rows, columns: columnItems, cells }
}

/** Whole-row/column selections carry NaN or -1 on the open axis: treat that as unbounded. */
export function rangeToRect(range: RangeLike | undefined | null): WorksheetRect | null {
  if (!range) return null
  const bound = (start: number | undefined, end: number | undefined) => {
    const validStart = typeof start === 'number' && Number.isFinite(start) && start >= 0
    const validEnd = typeof end === 'number' && Number.isFinite(end) && end >= 0
    if (!validStart) return { start: 0, end: UNBOUNDED }
    return { start: start as number, end: validEnd ? Math.max(start as number, end as number) : (start as number) }
  }
  const rows = bound(range.startRow, range.endRow)
  const columns = bound(range.startColumn, range.endColumn)
  return { startRow: rows.start, endRow: rows.end, startColumn: columns.start, endColumn: columns.end }
}

export const UNBOUNDED_INDEX = UNBOUNDED
