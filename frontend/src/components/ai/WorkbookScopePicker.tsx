'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, FileSpreadsheet, FolderOpen, Home, Loader2, Search, Table2, UserRound, X } from 'lucide-react'
import api from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import type { Folder, FolderContents, Sheet, Workbook } from '@/types'

export interface ScopeItem { id: number; name: string }

/** One sheet of an analysis; range is an A1 range, empty for the whole sheet. */
export interface SheetScopeItem {
  id: number
  name: string
  workbookId: number
  workbookName: string
  range: string
}

export interface ScopeSelection {
  workbooks: ScopeItem[]
  folders: ScopeItem[]
  sheets: SheetScopeItem[]
}

interface Props {
  /** Every workbook the user can open, used for searching across folders. */
  workbooks: Workbook[]
  value: ScopeSelection
  onChange: (next: ScopeSelection) => void
}

const ONLY_MINE_KEY = 'yaerp:summary-scope-only-mine'
const RANGE_PATTERN = /^\$?[A-Z]{0,3}\$?[0-9]{0,7}(:\$?[A-Z]{0,3}\$?[0-9]{0,7})?$/i

/** A1 range such as A1:F200, B:D, 2:50 or C5; empty means the whole sheet. */
export function isValidSheetRange(value: string) {
  const text = value.replace(/\s+/g, '')
  if (!text) return true
  if (!RANGE_PATTERN.test(text) || text === ':') return false
  const [start, end = start] = text.split(':')
  const hasLetters = (part: string) => /[A-Z]/i.test(part)
  const hasDigits = (part: string) => /[0-9]/.test(part)
  return (hasLetters(start) || hasDigits(start)) && hasLetters(start) === hasLetters(end) && hasDigits(start) === hasDigits(end)
}

/**
 * Picks what an analysis reads: whole folders, whole workbooks or single
 * sheets (optionally a range of each), browsing folders like the workbench
 * with a breadcrumb, a search across every accessible workbook and an "only
 * mine" filter.
 */
export default function WorkbookScopePicker({ workbooks, value, onChange }: Props) {
  const { workbooks: selectedWorkbooks, folders: selectedFolders, sheets: selectedSheets } = value
  const me = getStoredUser()
  const [query, setQuery] = useState('')
  const [onlyMine, setOnlyMine] = useState(() => {
    try { return window.localStorage.getItem(ONLY_MINE_KEY) === '1' } catch { return false }
  })
  const [path, setPath] = useState<Folder[]>([])
  const [contents, setContents] = useState<FolderContents | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [sheetsByWorkbook, setSheetsByWorkbook] = useState<Record<number, Sheet[] | 'loading' | 'error'>>({})
  const currentFolder = path[path.length - 1] || null

  useEffect(() => {
    try { window.localStorage.setItem(ONLY_MINE_KEY, onlyMine ? '1' : '0') } catch { /* preference only */ }
  }, [onlyMine])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      const res = await api.get<FolderContents>(currentFolder ? `/folders?parent_id=${currentFolder.id}` : '/folders')
      let folders = res.code === 0 && res.data ? res.data.folders || [] : []
      const inFolder = res.code === 0 && res.data ? res.data.workbooks || [] : []
      if (!currentFolder) {
        // Folders other people shared with me live outside my own tree.
        const shared = await api.get<Folder[]>('/folders/shared')
        if (shared.code === 0 && Array.isArray(shared.data)) {
          const known = new Set(folders.map((folder) => folder.id))
          folders = [...folders, ...shared.data.filter((folder) => !known.has(folder.id))]
        }
      }
      if (!cancelled) setContents({ folders, workbooks: inFolder })
    }
    load().catch(() => { if (!cancelled) setContents({ folders: [], workbooks: [] }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [currentFolder])

  const loadSheets = async (workbookId: number) => {
    if (Array.isArray(sheetsByWorkbook[workbookId]) || sheetsByWorkbook[workbookId] === 'loading') return
    setSheetsByWorkbook((current) => ({ ...current, [workbookId]: 'loading' }))
    try {
      const res = await api.get<Workbook>(`/workbooks/${workbookId}?summary=1`)
      const sheets = res.code === 0 && res.data ? res.data.sheets || [] : null
      setSheetsByWorkbook((current) => ({ ...current, [workbookId]: sheets ?? 'error' }))
    } catch {
      setSheetsByWorkbook((current) => ({ ...current, [workbookId]: 'error' }))
    }
  }

  const mine = (ownerId?: number) => !onlyMine || ownerId === me?.id
  const searching = query.trim().length > 0
  const needle = query.trim().toLocaleLowerCase()
  const searchResults = useMemo(() => searching
    ? workbooks.filter((workbook) => mine(workbook.owner_id) && `${workbook.name} ${workbook.owner_name || ''} ${workbook.description || ''}`.toLocaleLowerCase().includes(needle)).slice(0, 200)
    : [],
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [searching, needle, workbooks, onlyMine])
  const folders = (contents?.folders || []).filter((folder) => mine(folder.owner_id))
  const folderWorkbooks = (contents?.workbooks || []).filter((workbook) => mine(workbook.owner_id))

  const workbookSelected = (id: number) => selectedWorkbooks.some((item) => item.id === id)
  const folderSelected = (id: number) => selectedFolders.some((item) => item.id === id)
  const sheetSelected = (id: number) => selectedSheets.some((item) => item.id === id)
  const sheetCount = (workbookId: number) => selectedSheets.filter((item) => item.workbookId === workbookId).length

  const toggleWorkbook = (workbook: Workbook) => onChange({
    ...value,
    workbooks: workbookSelected(workbook.id) ? selectedWorkbooks.filter((item) => item.id !== workbook.id) : [...selectedWorkbooks, { id: workbook.id, name: workbook.name }],
    // The whole workbook replaces its single sheets.
    sheets: workbookSelected(workbook.id) ? selectedSheets : selectedSheets.filter((item) => item.workbookId !== workbook.id),
  })
  const toggleFolder = (folder: Folder) => onChange({
    ...value,
    folders: folderSelected(folder.id) ? selectedFolders.filter((item) => item.id !== folder.id) : [...selectedFolders, { id: folder.id, name: folder.name }],
  })
  const toggleSheet = (workbook: Workbook, sheet: Sheet) => onChange({
    ...value,
    sheets: sheetSelected(sheet.id)
      ? selectedSheets.filter((item) => item.id !== sheet.id)
      : [...selectedSheets, { id: sheet.id, name: sheet.name, workbookId: workbook.id, workbookName: workbook.name, range: '' }],
  })
  const setSheetRange = (sheetId: number, range: string) => onChange({
    ...value,
    sheets: selectedSheets.map((item) => (item.id === sheetId ? { ...item, range } : item)),
  })

  const checkbox = (checked: boolean, disabled = false) => (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition sm:h-4 sm:w-4 ${checked ? (disabled ? 'border-sky-300 bg-sky-300 text-white' : 'border-sky-600 bg-sky-600 text-white') : 'border-slate-300 bg-white'}`}>{checked && <Check className="h-3 w-3" />}</span>
  )

  const sheetList = (workbook: Workbook) => {
    const state = sheetsByWorkbook[workbook.id]
    const wholeWorkbook = workbookSelected(workbook.id)
    if (state === 'loading' || state === undefined) {
      return <div className="flex items-center gap-2 py-2 pl-12 text-xs text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />读取工作表…</div>
    }
    if (state === 'error') return <div className="py-2 pl-12 text-xs text-rose-500">读取工作表失败</div>
    if (state.length === 0) return <div className="py-2 pl-12 text-xs text-slate-400">这个工作簿没有你可查看的工作表</div>
    return (
      <div className="border-t border-slate-100 bg-slate-50/60 py-1">
        {wholeWorkbook && <div className="px-12 py-1 text-[11px] text-sky-700">已选择整个工作簿；取消勾选工作簿后可以只选其中几张表</div>}
        {state.map((sheet) => {
          const checked = wholeWorkbook || sheetSelected(sheet.id)
          const selected = selectedSheets.find((item) => item.id === sheet.id)
          return (
            <div key={sheet.id} className="pl-9 pr-3">
              <button type="button" disabled={wholeWorkbook} onClick={() => toggleSheet(workbook, sheet)} className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-white disabled:cursor-default disabled:hover:bg-transparent">
                {checkbox(checked, wholeWorkbook)}
                <Table2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{sheet.name}</span>
              </button>
              {selected && (
                <label className="mb-1.5 ml-9 flex items-center gap-2 text-xs text-slate-500">
                  <span className="shrink-0">区域</span>
                  <input
                    value={selected.range}
                    onChange={(event) => setSheetRange(sheet.id, event.target.value.toUpperCase())}
                    placeholder="留空为整张表，如 A1:F200、B:D、2:50"
                    aria-label={`${sheet.name} 的分析区域`}
                    className={`h-8 min-w-0 flex-1 rounded-md border bg-white px-2 font-mono text-xs outline-none focus:border-sky-400 ${isValidSheetRange(selected.range) ? 'border-slate-200' : 'border-rose-400 text-rose-600'}`}
                  />
                </label>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const workbookRow = (workbook: Workbook) => {
    const checked = workbookSelected(workbook.id)
    const open = expanded === workbook.id
    const pickedSheets = sheetCount(workbook.id)
    return (
      <div key={`w-${workbook.id}`} className={checked || pickedSheets ? 'bg-sky-50/70' : ''}>
        <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50">
          <button type="button" onClick={() => toggleWorkbook(workbook)} aria-label={`选择整个工作簿 ${workbook.name}`} title="选中整个工作簿">{checkbox(checked)}</button>
          <button type="button" onClick={() => { const next = open ? null : workbook.id; setExpanded(next); if (next) void loadSheets(next) }} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
            <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-600" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-800">{workbook.name}</span>
              <span className="block truncate text-xs text-slate-400">
                {workbook.owner_name || `用户 #${workbook.owner_id}`} · {new Date(workbook.updated_at).toLocaleDateString('zh-CN')}
                {pickedSheets > 0 && <span className="text-sky-700"> · 已选 {pickedSheets} 张表</span>}
              </span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-1 text-xs text-slate-500 hover:bg-white hover:text-slate-800">
              选择工作表{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
          </button>
        </div>
        {open && sheetList(workbook)}
      </div>
    )
  }

  const total = selectedFolders.length + selectedWorkbooks.length + selectedSheets.length
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">数据范围</span>
        <span className="text-xs text-slate-400">
          已选 {selectedFolders.length ? `${selectedFolders.length} 个文件夹 · ` : ''}{selectedWorkbooks.length} 个工作簿{selectedSheets.length ? ` · ${selectedSheets.length} 张工作表` : ''}
        </span>
      </div>
      {total > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedFolders.map((folder) => (
            <span key={`sf-${folder.id}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-amber-200 bg-amber-50 py-1 pl-2 pr-1 text-xs text-amber-800">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{folder.name}</span>
              <button type="button" onClick={() => onChange({ ...value, folders: selectedFolders.filter((item) => item.id !== folder.id) })} className="rounded p-0.5 hover:bg-amber-100" aria-label={`移除 ${folder.name}`}><X className="h-3 w-3" /></button>
            </span>
          ))}
          {selectedWorkbooks.map((workbook) => (
            <span key={`sw-${workbook.id}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-sky-200 bg-sky-50 py-1 pl-2 pr-1 text-xs text-sky-800">
              <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{workbook.name}</span>
              <button type="button" onClick={() => onChange({ ...value, workbooks: selectedWorkbooks.filter((item) => item.id !== workbook.id) })} className="rounded p-0.5 hover:bg-sky-100" aria-label={`移除 ${workbook.name}`}><X className="h-3 w-3" /></button>
            </span>
          ))}
          {selectedSheets.map((sheet) => (
            <span key={`ss-${sheet.id}`} className={`inline-flex max-w-full items-center gap-1 rounded-md border py-1 pl-2 pr-1 text-xs ${isValidSheetRange(sheet.range) ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-300 bg-rose-50 text-rose-700'}`}>
              <Table2 className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{sheet.workbookName} / {sheet.name}{sheet.range.trim() ? ` · ${sheet.range.trim()}` : ' · 整张表'}</span>
              <button type="button" onClick={() => onChange({ ...value, sheets: selectedSheets.filter((item) => item.id !== sheet.id) })} className="rounded p-0.5 hover:bg-white/70" aria-label={`移除 ${sheet.name}`}><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 p-2">
          <label className="relative flex min-w-0 flex-1 items-center">
            <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-slate-400" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全部工作簿（名称、负责人、描述）" className="h-9 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2 text-sm outline-none focus:border-slate-400" />
          </label>
          <button type="button" onClick={() => setOnlyMine((current) => !current)} aria-pressed={onlyMine} className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${onlyMine ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'}`}>
            <UserRound className="h-3.5 w-3.5" />只看自己
          </button>
        </div>
        {!searching && (
          <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-100 px-2 py-1.5 text-xs text-slate-500">
            <button type="button" onClick={() => setPath([])} className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 hover:bg-slate-100"><Home className="h-3.5 w-3.5" />全部</button>
            {path.map((folder, index) => (
              <span key={folder.id} className="inline-flex shrink-0 items-center">
                <ChevronRight className="h-3.5 w-3.5 text-slate-300" />
                <button type="button" onClick={() => setPath(path.slice(0, index + 1))} className={`rounded px-1.5 py-1 hover:bg-slate-100 ${index === path.length - 1 ? 'font-semibold text-slate-800' : ''}`}>{folder.name}</button>
              </span>
            ))}
          </div>
        )}
        <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
          {searching ? (
            searchResults.length ? searchResults.map(workbookRow) : <div className="px-3 py-8 text-center text-sm text-slate-400">没有匹配的工作簿</div>
          ) : loading && !contents ? (
            <div className="flex justify-center py-8 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : (
            <>
              {folders.map((folder) => {
                const checked = folderSelected(folder.id)
                return (
                  <div key={`f-${folder.id}`} className={`flex items-center gap-3 px-3 py-2.5 ${checked ? 'bg-amber-50' : 'hover:bg-slate-50'}`}>
                    <button type="button" onClick={() => toggleFolder(folder)} aria-label={`选择文件夹 ${folder.name}`} title="选中整个文件夹（含子文件夹）">{checkbox(checked)}</button>
                    <button type="button" onClick={() => setPath([...path, folder])} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                      <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-800">{folder.name}</span>
                        <span className="block truncate text-xs text-slate-400">文件夹{folder.owner_name ? ` · ${folder.owner_name}` : ''}</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                    </button>
                  </div>
                )
              })}
              {folderWorkbooks.map(workbookRow)}
              {folders.length === 0 && folderWorkbooks.length === 0 && <div className="px-3 py-8 text-center text-sm text-slate-400">{onlyMine ? '这里没有你创建的工作簿' : '这个文件夹是空的'}</div>}
            </>
          )}
        </div>
      </div>
      <p className="text-[11px] leading-5 text-slate-400">勾选工作簿会分析其中全部工作表；点「选择工作表」可以只分析其中几张表，并为每张表填写区域（例如 A1:F200），AI 只会读取所选范围内的数据。</p>
    </div>
  )
}
