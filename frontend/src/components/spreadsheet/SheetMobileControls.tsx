'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, ClipboardPaste, Eraser, Move, Pencil, Redo2, Scaling, Search, Undo2, X } from 'lucide-react'
import { columnIndexToLetter } from '@/lib/spreadsheet'

export interface SheetSearchCell { row: number; column: number; text: string }
export interface SheetEditCell { row: number; column: number; value: string }

export function mobileCellValue(value: string, type: string): string | number | boolean {
  const text = value.trim()
  if (['number', 'currency', 'percentage'].includes(type) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(text)) {
    const percent = type === 'percentage' && text.endsWith('%')
    const numeric = Number(percent ? text.slice(0, -1) : text)
    if (Number.isFinite(numeric)) return percent ? numeric / 100 : numeric
  }
  if (type === 'checkbox' && /^(true|false)$/i.test(text)) return text.toLowerCase() === 'true'
  return value // text IDs retain leading zeros; blanks remain explicit clears
}

interface Props {
  sheetId: number
  ready: boolean
  editable: boolean
  selectionEditable: boolean
  selectionLabel: string
  changeToken: string
  readCells: (commitEditor?: boolean) => Promise<SheetSearchCell[]>
  focusCell: (row: number, column: number) => void
  moveCell: (rowDelta: number, columnDelta: number) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  readSelected: () => SheetEditCell | null
  writeSelected: (value: string, expected: SheetEditCell) => Promise<void>
  /** Grows or shrinks the selected range from its bottom-right corner. */
  extendSelection?: (rowDelta: number, columnDelta: number) => Promise<void>
  /** Clears the content of the selected cells (the phone has no Delete key). */
  clearSelected?: () => Promise<void>
  /** Pastes the clipboard text as plain values. */
  pastePlain?: () => Promise<void>
}

/**
 * Height of the on-screen keyboard. Phones keep the layout viewport at full
 * height while the keyboard is open, so anything docked to the bottom would
 * sit behind it; the visual viewport tells how much is really visible.
 */
function useKeyboardInset(active: boolean) {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null
    if (!active || !viewport) { setInset(0); return }
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)))
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [active])
  return inset
}

export default function SheetMobileControls(props: Props) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cells, setCells] = useState<SheetSearchCell[]>([])
  const [hits, setHits] = useState<SheetSearchCell[]>([])
  const [index, setIndex] = useState(-1)
  const [searching, setSearching] = useState(false)
  const [padOpen, setPadOpen] = useState(false)
  const [extending, setExtending] = useState(false)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [editCell, setEditCell] = useState<SheetEditCell | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const wasSearchOpen = useRef(false)
  const latest = useRef(props)
  latest.current = props
  const keyboardInset = useKeyboardInset(editing)

  useEffect(() => {
    setQuery(''); setHits([]); setIndex(-1); setEditing(false); setSearchOpen(false); setExtending(false)
  }, [props.sheetId])

  useEffect(() => {
    if (!searchOpen || !props.ready) { wasSearchOpen.current = false; return }
    let cancelled = false
    const commitEditor = !wasSearchOpen.current
    wasSearchOpen.current = true
    setCells([]); setHits([]); setIndex(-1); setSearching(true)
    latest.current.readCells(commitEditor).then((result) => { if (!cancelled) setCells(result) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : '读取表格失败') })
      .finally(() => { if (!cancelled) setSearching(false) })
    return () => { cancelled = true }
  }, [searchOpen, props.ready, props.sheetId, props.changeToken])

  useEffect(() => {
    if (!searchOpen) return
    const timer = window.setTimeout(() => {
      const needle = query.trim().toLocaleLowerCase()
      const result = needle ? cells.filter((cell) => cell.text.toLocaleLowerCase().includes(needle)) : []
      setHits(result); setIndex(result.length ? 0 : -1)
      if (result[0]) latest.current.focusCell(result[0].row, result[0].column)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query, cells, searchOpen])

  const navigate = (delta: number) => {
    if (!hits.length) return
    const next = (index + delta + hits.length) % hits.length
    setIndex(next)
    props.focusCell(hits[next].row, hits[next].column)
  }
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError('')
    try { await operation() } catch (err) { setError(err instanceof Error ? err.message : '操作失败') }
    finally { busyRef.current = false; setBusy(false) }
  }
  const move = async (row: number, column: number) => {
    if (extending && !editing && props.extendSelection) {
      await props.extendSelection(row, column)
      return
    }
    if (editing && editCell && value !== editCell.value) await props.writeSelected(value, editCell)
    await props.moveCell(row, column)
    if (editing) {
      const next = props.readSelected()
      setEditCell(next); setValue(next?.value || '')
      if (!next) setEditing(false)
    }
  }
  const startEditing = () => {
    const selected = props.readSelected()
    if (!selected) { setError('请先点选一个可编辑的单元格'); return }
    setEditCell(selected); setValue(selected.value); setEditing(true)
  }
  const buttonClass = 'flex h-11 min-w-11 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 shadow-sm active:bg-sky-100 disabled:opacity-40'
  const canEditSelection = props.ready && props.selectionEditable && !busy
  // Sits above the global quick-nav button (fixed in the bottom-left corner)
  // and above the cell editor form while that is open.
  const barBottom = editing ? 112 + keyboardInset : 56

  return <>
    <div className="pointer-events-auto absolute left-2 z-[60] max-w-[calc(100%-1rem)] rounded-xl border border-slate-200 bg-white/95 p-1 shadow-lg" style={{ bottom: barBottom }} data-sheet-mobile-controls onPointerDown={(event) => { if (editing) event.preventDefault() }}>
      <div className="flex items-center gap-1">
        <button type="button" className={buttonClass} disabled={!props.ready} title="搜索当前表内容" aria-label="搜索当前表内容" onClick={() => { setSearchOpen((open) => !open); window.setTimeout(() => inputRef.current?.focus(), 50) }}><Search className="h-5 w-5" /></button>
        <button type="button" className={`${buttonClass} md:hidden`} disabled={!props.ready || !props.editable || busy} title="撤销上一步" aria-label="撤销上一步" onClick={() => void run(props.undo)}><Undo2 className="h-5 w-5" /></button>
        <button type="button" className={`${buttonClass} md:hidden`} disabled={!props.ready || !props.editable || busy} title="重做" aria-label="重做" onClick={() => void run(props.redo)}><Redo2 className="h-5 w-5" /></button>
        {!editing && <button type="button" className={`${buttonClass} md:hidden`} disabled={!canEditSelection} title="编辑选中单元格" aria-label="编辑选中单元格" onClick={startEditing}><Pencil className="h-5 w-5" /></button>}
        {!editing && props.clearSelected && <button type="button" className={`${buttonClass} md:hidden`} disabled={!canEditSelection} title="清除选中单元格内容" aria-label="清除选中单元格内容" onClick={() => void run(props.clearSelected!)}><Eraser className="h-5 w-5" /></button>}
        <button type="button" className={`${buttonClass} md:hidden ${padOpen ? 'border-sky-300 bg-sky-50 text-sky-700' : ''}`} disabled={!props.ready} title="方向键与选区" aria-label="虚拟方向键" aria-expanded={padOpen} onClick={() => setPadOpen((open) => !open)}><Move className="h-5 w-5" /></button>
      </div>
      {padOpen && <div className="mt-1 md:hidden">
        <div className="mb-1 truncate text-center text-xs text-slate-500">{props.selectionLabel || '选择一个单元格'}{extending && !editing ? ' · 方向键调整选区大小' : ''}</div>
        <div className="flex items-center justify-center gap-3">
          <div className={`grid w-fit ${editing ? 'grid-cols-4' : 'grid-cols-3'} gap-1`}>
            {!editing && <span />}<button type="button" aria-label={extending ? '选区向上收缩一行' : '上一个单元格'} className={buttonClass} disabled={busy || !props.ready} onClick={() => void run(() => move(-1, 0))}><ArrowUp className="h-5 w-5" /></button>{!editing && <span />}
            <button type="button" aria-label={extending ? '选区向左收缩一列' : '左一个单元格'} className={buttonClass} disabled={busy || !props.ready} onClick={() => void run(() => move(0, -1))}><ArrowLeft className="h-5 w-5" /></button>
            {!editing && <button type="button" aria-label="扩展选区" aria-pressed={extending} title="开启后用方向键扩大/缩小选区" className={`${buttonClass} ${extending ? 'border-sky-400 bg-sky-100 text-sky-700' : ''}`} disabled={!props.ready || !props.extendSelection} onClick={() => setExtending((current) => !current)}><Scaling className="h-4 w-4" /></button>}
            <button type="button" aria-label={extending ? '选区向右扩展一列' : '右一个单元格'} className={buttonClass} disabled={busy || !props.ready} onClick={() => void run(() => move(0, 1))}><ArrowRight className="h-5 w-5" /></button>
            {!editing && <span />}<button type="button" aria-label={extending ? '选区向下扩展一行' : '下一个单元格'} className={buttonClass} disabled={busy || !props.ready} onClick={() => void run(() => move(1, 0))}><ArrowDown className="h-5 w-5" /></button>{!editing && <span />}
          </div>
          {!editing && props.pastePlain && <button type="button" className={`${buttonClass} h-auto flex-col gap-1 px-2 py-2 text-[11px] leading-tight`} disabled={!props.ready || !props.editable || busy} aria-label="粘贴为纯文本（仅值）" onClick={() => void run(props.pastePlain!)}><ClipboardPaste className="h-5 w-5" />粘贴<br />纯文本</button>}
        </div>
      </div>}
    </div>
    {searchOpen && <div className="absolute left-2 right-2 top-2 z-[65] rounded-xl border border-sky-200 bg-white/95 p-2 shadow-xl md:left-4 md:right-auto md:w-96" role="search" aria-label="当前表内容搜索">
      <div className="flex items-center gap-1">
        <Search className="h-5 w-5 shrink-0 text-sky-600" />
        <input ref={inputRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前表中的数据" className="h-11 min-w-0 flex-1 rounded-lg bg-slate-50 px-2 text-base outline-none focus:ring-2 focus:ring-sky-300" onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') { event.preventDefault(); navigate(event.shiftKey ? -1 : 1) } if (event.key === 'Escape') setSearchOpen(false) }} />
        <button type="button" className={buttonClass} aria-label="关闭搜索" onClick={() => setSearchOpen(false)}><X className="h-4 w-4" /></button>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-slate-600" aria-live="polite">{searching ? '正在读取最新数据…' : !query.trim() ? '支持文字、编号、数字；仅搜索你可见的数据' : hits.length ? `${index + 1} / ${hits.length} · ${columnIndexToLetter(hits[index]?.column ?? 0)}${(hits[index]?.row ?? 0) + 1} · ${hits[index]?.text.split('\n')[0]}` : '没有找到匹配内容'}</span>
        <div className="flex gap-1"><button type="button" className={buttonClass} disabled={!hits.length || searching} aria-label="上一个搜索结果" onClick={() => navigate(-1)}><ChevronUp className="h-4 w-4" /></button><button type="button" className={buttonClass} disabled={!hits.length || searching} aria-label="下一个搜索结果" onClick={() => navigate(1)}><ChevronDown className="h-4 w-4" /></button></div>
      </div>
    </div>}
    {editing && editCell && <form className="absolute left-2 right-2 z-[75] rounded-xl border border-sky-200 bg-white p-3 shadow-xl" style={{ bottom: 8 + keyboardInset }} data-sheet-mobile-editor onSubmit={(event) => { event.preventDefault(); void run(async () => { await props.writeSelected(value, editCell); setEditing(false) }) }}>
      <div className="mb-2 flex items-center justify-between text-sm font-semibold"><span>编辑 {columnIndexToLetter(editCell.column)}{editCell.row + 1}</span><button type="button" aria-label="取消编辑" className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 active:bg-slate-100" onClick={() => setEditing(false)}><X className="h-5 w-5" /></button></div>
      <div className="flex gap-2"><input autoFocus value={value} readOnly={!props.selectionEditable} enterKeyHint="done" onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} className="h-11 min-w-0 flex-1 rounded-lg border px-2 text-base" />
      {value !== '' && <button type="button" aria-label="清空输入" className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 active:bg-slate-100" onClick={() => setValue('')}><Eraser className="h-4 w-4" /></button>}
      <button type="submit" disabled={busy || !props.ready || !props.selectionEditable} className="h-11 shrink-0 rounded-lg bg-sky-600 px-3 text-sm text-white disabled:opacity-50">保存</button></div>
    </form>}
    {error && <button type="button" onClick={() => setError('')} className="absolute bottom-2 left-2 right-2 z-[80] rounded-lg bg-rose-50 p-3 text-left text-sm text-rose-700">{error} · 点击关闭</button>}
  </>
}
