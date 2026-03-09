'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowUpDown,
  Calendar,
  FileSpreadsheet,
  Grid3X3,
  List,
} from 'lucide-react'

interface SheetOverviewProps {
  sheets: Array<{
    id: number
    name: string
    sort_order: number
    updated_at: string
    rowCount: number
  }>
  activeSheetId: number
  onSelectSheet: (sheetId: number) => void
  onRenameSheet?: (sheetId: number, newName: string) => void
}

type ViewMode = 'grid' | 'list'
type SortKey = 'name' | 'date'

function formatDate(iso: string): string {
  const d = new Date(iso)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day} ${h}:${min}`
}

export default function SheetOverview({
  sheets,
  activeSheetId,
  onSelectSheet,
  onRenameSheet,
}: SheetOverviewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    sheetId: number
  } | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const sortedSheets = [...sheets].sort((a, b) => {
    if (sortKey === 'name') return a.name.localeCompare(b.name, 'zh-CN')
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  })

  /* ---------- context menu ---------- */

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, sheetId: number) => {
      if (!onRenameSheet) return
      e.preventDefault()
      setContextMenu({ x: e.clientX, y: e.clientY, sheetId })
    },
    [onRenameSheet],
  )

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        contextMenuRef.current &&
        !contextMenuRef.current.contains(e.target as Node)
      ) {
        setContextMenu(null)
      }
    }
    if (contextMenu) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [contextMenu])

  const startRename = useCallback(
    (sheetId: number) => {
      const sheet = sheets.find((s) => s.id === sheetId)
      if (!sheet) return
      setRenamingId(sheetId)
      setRenameValue(sheet.name)
      setContextMenu(null)
    },
    [sheets],
  )

  useEffect(() => {
    if (renamingId !== null) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [renamingId])

  const commitRename = useCallback(() => {
    if (renamingId !== null && renameValue.trim() && onRenameSheet) {
      onRenameSheet(renamingId, renameValue.trim())
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue, onRenameSheet])

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        commitRename()
      } else if (e.key === 'Escape') {
        setRenamingId(null)
        setRenameValue('')
      }
    },
    [commitRename],
  )

  /* ---------- mini grid placeholder lines ---------- */

  const PLACEHOLDER_COLORS = [
    'bg-slate-300',
    'bg-sky-200',
    'bg-emerald-200',
    'bg-amber-200',
    'bg-slate-200',
  ]

  function MiniGridPreview() {
    return (
      <div className="mt-3 flex flex-col gap-[3px] rounded-lg bg-slate-50 p-2">
        {PLACEHOLDER_COLORS.map((color, i) => (
          <div key={i} className="flex gap-[3px]">
            {[0, 1, 2, 3].map((j) => (
              <div
                key={j}
                className={`h-[5px] flex-1 rounded-sm ${i === 0 ? 'bg-slate-400' : color}`}
              />
            ))}
          </div>
        ))}
      </div>
    )
  }

  /* ---------- render ---------- */

  return (
    <div className="relative flex h-full flex-col gap-4 p-6">
      {/* header bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-800">
          工作表总览
        </h2>

        <div className="flex items-center gap-2">
          {/* sort toggle */}
          <button
            onClick={() => setSortKey(sortKey === 'name' ? 'date' : 'name')}
            className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 shadow-sm transition-colors hover:bg-slate-50"
            title="切换排序方式"
          >
            <ArrowUpDown className="h-4 w-4" />
            {sortKey === 'name' ? '名称' : '修改日期'}
          </button>

          {/* view toggle */}
          <div className="flex overflow-hidden rounded-lg border border-slate-200 shadow-sm">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-2.5 py-1.5 transition-colors ${
                viewMode === 'grid'
                  ? 'bg-slate-800 text-white'
                  : 'bg-white text-slate-500 hover:bg-slate-50'
              }`}
              title="网格视图"
            >
              <Grid3X3 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`px-2.5 py-1.5 transition-colors ${
                viewMode === 'list'
                  ? 'bg-slate-800 text-white'
                  : 'bg-white text-slate-500 hover:bg-slate-50'
              }`}
              title="列表视图"
            >
              <List className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* grid view */}
      {viewMode === 'grid' && (
        <div className="grid grid-cols-2 gap-4 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {sortedSheets.map((sheet) => (
            <div
              key={sheet.id}
              onClick={() => onSelectSheet(sheet.id)}
              onDoubleClick={() => onSelectSheet(sheet.id)}
              onContextMenu={(e) => handleContextMenu(e, sheet.id)}
              className={`group cursor-pointer rounded-2xl border bg-white p-4 shadow transition-all hover:shadow-md ${
                sheet.id === activeSheetId
                  ? 'border-sky-400 ring-2 ring-sky-200'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              {/* sheet name */}
              {renamingId === sheet.id ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={handleRenameKeyDown}
                  className="w-full rounded border border-sky-300 px-1 py-0.5 text-sm font-medium text-slate-800 outline-none focus:ring-1 focus:ring-sky-400"
                />
              ) : (
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-500" />
                  <span className="truncate text-sm font-medium text-slate-800">
                    {sheet.name}
                  </span>
                </div>
              )}

              {/* mini grid preview */}
              <MiniGridPreview />

              {/* meta info */}
              <div className="mt-3 flex flex-col gap-1 text-xs text-slate-400">
                <span>{sheet.rowCount} 行</span>
                <span className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {formatDate(sheet.updated_at)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* list view */}
      {viewMode === 'list' && (
        <div className="overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                <th className="px-4 py-3">工作表名称</th>
                <th className="px-4 py-3 text-right">行数</th>
                <th className="px-4 py-3 text-right">修改日期</th>
              </tr>
            </thead>
            <tbody>
              {sortedSheets.map((sheet) => (
                <tr
                  key={sheet.id}
                  onClick={() => onSelectSheet(sheet.id)}
                  onDoubleClick={() => onSelectSheet(sheet.id)}
                  onContextMenu={(e) => handleContextMenu(e, sheet.id)}
                  className={`cursor-pointer border-b border-slate-50 transition-colors hover:bg-slate-50 ${
                    sheet.id === activeSheetId ? 'bg-sky-50' : ''
                  }`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <FileSpreadsheet className="h-4 w-4 shrink-0 text-emerald-500" />
                      {renamingId === sheet.id ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={handleRenameKeyDown}
                          className="rounded border border-sky-300 px-1 py-0.5 text-sm font-medium text-slate-800 outline-none focus:ring-1 focus:ring-sky-400"
                        />
                      ) : (
                        <span
                          className={`font-medium ${
                            sheet.id === activeSheetId
                              ? 'text-sky-600'
                              : 'text-slate-800'
                          }`}
                        >
                          {sheet.name}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-500">
                    {sheet.rowCount} 行
                  </td>
                  <td className="px-4 py-3 text-right text-slate-400">
                    {formatDate(sheet.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* right-click context menu (rename, admin only) */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[120px] rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => startRename(contextMenu.sheetId)}
            className="flex w-full items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            重命名
          </button>
        </div>
      )}
    </div>
  )
}
