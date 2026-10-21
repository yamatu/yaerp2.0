'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, FileSpreadsheet, FolderOpen, Home, Loader2, Search, UserRound, X } from 'lucide-react'
import api from '@/lib/api'
import { getStoredUser } from '@/lib/auth'
import type { Folder, FolderContents, Workbook } from '@/types'

export interface ScopeItem { id: number; name: string }

interface Props {
  /** Every workbook the user can open, used for searching across folders. */
  workbooks: Workbook[]
  selectedWorkbooks: ScopeItem[]
  selectedFolders: ScopeItem[]
  onChange: (next: { workbooks: ScopeItem[]; folders: ScopeItem[] }) => void
}

const ONLY_MINE_KEY = 'yaerp:summary-scope-only-mine'

/**
 * Picks the workbooks (or whole folders) an analysis should read, browsing
 * folders like the workbench: a breadcrumb path, sub folders, a search across
 * every accessible workbook and an "only mine" filter.
 */
export default function WorkbookScopePicker({ workbooks, selectedWorkbooks, selectedFolders, onChange }: Props) {
  const me = getStoredUser()
  const [query, setQuery] = useState('')
  const [onlyMine, setOnlyMine] = useState(() => {
    try { return window.localStorage.getItem(ONLY_MINE_KEY) === '1' } catch { return false }
  })
  const [path, setPath] = useState<Folder[]>([])
  const [contents, setContents] = useState<FolderContents | null>(null)
  const [loading, setLoading] = useState(false)
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
  const toggleWorkbook = (workbook: Workbook) => onChange({
    folders: selectedFolders,
    workbooks: workbookSelected(workbook.id) ? selectedWorkbooks.filter((item) => item.id !== workbook.id) : [...selectedWorkbooks, { id: workbook.id, name: workbook.name }],
  })
  const toggleFolder = (folder: Folder) => onChange({
    workbooks: selectedWorkbooks,
    folders: folderSelected(folder.id) ? selectedFolders.filter((item) => item.id !== folder.id) : [...selectedFolders, { id: folder.id, name: folder.name }],
  })

  const checkbox = (checked: boolean) => (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition sm:h-4 sm:w-4 ${checked ? 'border-sky-600 bg-sky-600 text-white' : 'border-slate-300 bg-white'}`}>{checked && <Check className="h-3 w-3" />}</span>
  )
  const workbookRow = (workbook: Workbook) => {
    const checked = workbookSelected(workbook.id)
    return (
      <button key={`w-${workbook.id}`} type="button" onClick={() => toggleWorkbook(workbook)} className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition ${checked ? 'bg-sky-50' : 'hover:bg-slate-50'}`}>
        {checkbox(checked)}
        <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-600" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-800">{workbook.name}</span>
          <span className="block truncate text-xs text-slate-400">{workbook.owner_name || `用户 #${workbook.owner_id}`} · {new Date(workbook.updated_at).toLocaleDateString('zh-CN')}</span>
        </span>
      </button>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">数据范围</span>
        <span className="text-xs text-slate-400">已选 {selectedFolders.length ? `${selectedFolders.length} 个文件夹 · ` : ''}{selectedWorkbooks.length} 个工作簿</span>
      </div>
      {(selectedFolders.length > 0 || selectedWorkbooks.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {selectedFolders.map((folder) => (
            <span key={`sf-${folder.id}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-amber-200 bg-amber-50 py-1 pl-2 pr-1 text-xs text-amber-800">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{folder.name}</span>
              <button type="button" onClick={() => onChange({ workbooks: selectedWorkbooks, folders: selectedFolders.filter((item) => item.id !== folder.id) })} className="rounded p-0.5 hover:bg-amber-100" aria-label={`移除 ${folder.name}`}><X className="h-3 w-3" /></button>
            </span>
          ))}
          {selectedWorkbooks.map((workbook) => (
            <span key={`sw-${workbook.id}`} className="inline-flex max-w-full items-center gap-1 rounded-md border border-sky-200 bg-sky-50 py-1 pl-2 pr-1 text-xs text-sky-800">
              <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{workbook.name}</span>
              <button type="button" onClick={() => onChange({ folders: selectedFolders, workbooks: selectedWorkbooks.filter((item) => item.id !== workbook.id) })} className="rounded p-0.5 hover:bg-sky-100" aria-label={`移除 ${workbook.name}`}><X className="h-3 w-3" /></button>
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
          <button type="button" onClick={() => setOnlyMine((value) => !value)} aria-pressed={onlyMine} className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${onlyMine ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-100'}`}>
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
        <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
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
    </div>
  )
}
