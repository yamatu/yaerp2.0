'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, LocateFixed, Wrench, X } from 'lucide-react'
import { columnIndexToLetter } from '@/lib/spreadsheet'
import { applyFormulaRepairs, scanInconsistentFormulaColumns, type FormulaSheetLike } from '@/lib/univer-formula-alignment'
import type { InconsistentFormulaColumn } from '@/lib/univer-formula-consistency'

interface Props {
  /** Changes whenever the sheet may have to be checked again. */
  scanToken: number
  /** Disables scanning while the sheet is loading. */
  ready: boolean
  editable: boolean
  getSheet: () => FormulaSheetLike | null | undefined
  focusCell: (row: number, column: number) => void
  onRepaired?: (count: number) => void
}

function summarize(columns: InconsistentFormulaColumn[]) {
  return columns.map((column) => `${column.column}:${column.repairs.length}:${column.repairs[0]?.row ?? 0}`).join('|')
}

/**
 * Small, dismissible notice for fill-down formula columns in which some cells
 * reference another row (a partial shift, a mis-anchored paste, an old import).
 * Scanning is debounced and runs in idle time so typing is never slowed down.
 */
export default function FormulaConsistencyBanner({ scanToken, ready, editable, getSheet, focusCell, onRepaired }: Props) {
  const [columns, setColumns] = useState<InconsistentFormulaColumn[]>([])
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState('')
  const dismissedRef = useRef('')
  const latest = useRef({ getSheet, onRepaired })
  latest.current = { getSheet, onRepaired }

  const scan = useCallback(() => {
    const result = scanInconsistentFormulaColumns(latest.current.getSheet())
    const next = result?.columns ?? []
    const signature = summarize(next)
    if (next.length > 0 && signature === dismissedRef.current) {
      setColumns([])
      return
    }
    setColumns(next)
  }, [])

  useEffect(() => {
    if (!ready) return
    let idle: number | null = null
    const timer = window.setTimeout(() => {
      const run = () => {
        idle = null
        try {
          scan()
        } catch (error) {
          console.warn('Formula consistency scan failed:', error)
        }
      }
      const requestIdle = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback
      if (typeof requestIdle === 'function') idle = requestIdle(run, { timeout: 2000 })
      else run()
    }, 900)
    return () => {
      window.clearTimeout(timer)
      const cancelIdle = (window as Window & { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback
      if (idle !== null && typeof cancelIdle === 'function') cancelIdle(idle)
    }
  }, [ready, scan, scanToken])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3600)
    return () => window.clearTimeout(timer)
  }, [notice])

  if (columns.length === 0) {
    return notice ? (
      <div className="pointer-events-none absolute left-1/2 top-2 z-[23] -translate-x-1/2 rounded-full bg-emerald-600/95 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
        {notice}
      </div>
    ) : null
  }

  const total = columns.reduce((sum, column) => sum + column.repairs.length, 0)
  const first = columns[0].repairs[0]
  const repairAll = () => {
    const repairs = columns.flatMap((column) => column.repairs)
    const written = applyFormulaRepairs(latest.current.getSheet(), repairs)
    setColumns([])
    setExpanded(false)
    if (written > 0) {
      setNotice(`已修复 ${written} 个公式，每行重新引用本行数据`)
      latest.current.onRepaired?.(written)
    }
  }

  return (
    <div
      className="absolute left-1/2 top-2 z-[23] w-[min(30rem,calc(100%-1rem))] -translate-x-1/2 rounded-xl border border-amber-200 bg-white/95 p-2 text-xs shadow-lg backdrop-blur"
      role="status"
      data-formula-consistency
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpanded((value) => !value)}>
          <div className="font-semibold text-slate-800">
            {columns.map((column) => `${columnIndexToLetter(column.column)} 列`).join('、')} 有 {total} 个公式引用了其它行
          </div>
          <div className="mt-0.5 truncate text-slate-500">
            整列是下拉填充的同一公式（如 {columnIndexToLetter(columns[0].column)}{columns[0].sampleRow + 1} {columns[0].sampleFormula}），这些单元格没有引用本行，合计可能不对。
          </div>
        </button>
        <button type="button" aria-label="忽略公式提示" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100" onClick={() => { dismissedRef.current = summarize(columns); setColumns([]) }}>
          <X className="h-4 w-4" />
        </button>
      </div>
      {expanded && (
        <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto rounded-lg bg-slate-50 p-1.5 font-mono text-[11px] text-slate-600">
          {columns.flatMap((column) => column.repairs.slice(0, 50).map((repair) => (
            <li key={`${repair.row}:${repair.column}`}>
              <button type="button" className="w-full truncate text-left hover:text-sky-700" onClick={() => focusCell(repair.row, repair.column)}>
                {columnIndexToLetter(repair.column)}{repair.row + 1}: {repair.current} → {repair.expected}
              </button>
            </li>
          )))}
        </ul>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        {first && (
          <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md px-2 font-medium text-slate-600 hover:bg-slate-100" onClick={() => focusCell(first.row, first.column)}>
            <LocateFixed className="h-3.5 w-3.5" />定位
          </button>
        )}
        {editable && (
          <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md bg-amber-500 px-3 font-semibold text-white hover:bg-amber-600" onClick={repairAll}>
            <Wrench className="h-3.5 w-3.5" />一键修复为本行公式
          </button>
        )}
      </div>
    </div>
  )
}
