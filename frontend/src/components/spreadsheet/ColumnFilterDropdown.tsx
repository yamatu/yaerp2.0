'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Filter, Search, X } from 'lucide-react'

interface ColumnFilterDropdownProps {
  columnKey: string
  columnName: string
  anchorRect: DOMRect | null
  uniqueValues: string[]
  selectedValues: Set<string>
  onApply: (columnKey: string, selectedValues: Set<string>) => void
  onClose: () => void
}

export default function ColumnFilterDropdown({
  columnKey,
  columnName,
  anchorRect,
  uniqueValues,
  selectedValues,
  onApply,
  onClose,
}: ColumnFilterDropdownProps) {
  const [draftSelected, setDraftSelected] = useState<Set<string>>(() => new Set(selectedValues))
  const [searchText, setSearchText] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    searchInputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  if (!anchorRect) return null

  const filteredValues = uniqueValues.filter((v) =>
    v.toLowerCase().includes(searchText.toLowerCase()),
  )

  const handleToggle = (value: string) => {
    setDraftSelected((prev) => {
      const next = new Set(prev)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }

  const handleSelectAll = () => {
    setDraftSelected(new Set(uniqueValues))
  }

  const handleClearAll = () => {
    setDraftSelected(new Set())
  }

  const handleApply = () => {
    onApply(columnKey, draftSelected)
  }

  const top = anchorRect.bottom + 4
  const left = anchorRect.left

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-50 w-64 rounded-2xl border border-slate-200 bg-white shadow-lg"
      style={{ top, left }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-slate-500" />
          <span className="text-sm font-semibold text-slate-700">
            筛选: {columnName}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Search */}
      <div className="border-b border-slate-100 px-3 py-2">
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5">
          <Search className="h-3.5 w-3.5 text-slate-400" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="搜索值..."
            className="w-full bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400"
          />
          {searchText && (
            <button
              type="button"
              onClick={() => setSearchText('')}
              className="text-slate-400 transition hover:text-slate-600"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Select All / Clear */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2">
        <button
          type="button"
          onClick={handleSelectAll}
          className="rounded-lg px-2.5 py-1 text-xs font-medium text-blue-600 transition hover:bg-blue-50"
        >
          全选
        </button>
        <button
          type="button"
          onClick={handleClearAll}
          className="rounded-lg px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100"
        >
          清除
        </button>
        <span className="ml-auto text-xs text-slate-400">
          {draftSelected.size}/{uniqueValues.length}
        </span>
      </div>

      {/* Value List */}
      <div className="max-h-[320px] overflow-y-auto px-2 py-2">
        {filteredValues.length === 0 ? (
          <div className="py-4 text-center text-xs text-slate-400">
            无匹配项
          </div>
        ) : (
          filteredValues.map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={draftSelected.has(value)}
                onChange={() => handleToggle(value)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 accent-blue-600"
              />
              <span className="truncate text-xs text-slate-700">
                {value === '' ? '(空白)' : value}
              </span>
            </label>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl px-4 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleApply}
          className="rounded-xl bg-slate-900 px-4 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-slate-800"
        >
          应用
        </button>
      </div>
    </div>,
    document.body,
  )
}
