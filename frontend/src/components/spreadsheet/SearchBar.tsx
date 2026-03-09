'use client'

import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  searchQuery: string
  onSearchChange: (query: string) => void
  matchCount: number
  currentMatchIndex: number
  onPrev: () => void
  onNext: () => void
}

export default function SearchBar({
  open,
  onClose,
  searchQuery,
  onSearchChange,
  matchCount,
  currentMatchIndex,
  onPrev,
  onNext,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      inputRef.current?.focus()
    }
  }, [open])

  if (!open) return null

  return (
    <div className="absolute right-4 top-4 z-50 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-lg">
      <Search className="h-4 w-4 shrink-0 text-slate-400" />
      <input
        ref={inputRef}
        type="text"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) {
              onPrev()
            } else {
              onNext()
            }
          } else if (e.key === 'Escape') {
            onClose()
          }
        }}
        className="h-8 w-48 border-none bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
        placeholder="搜索..."
      />

      {searchQuery && (
        <span className="shrink-0 text-xs font-semibold text-slate-500">
          {matchCount > 0 ? `${currentMatchIndex + 1}/${matchCount}` : '0/0'}
        </span>
      )}

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onPrev}
          disabled={matchCount === 0}
          className="rounded-full p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          title="上一个"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={matchCount === 0}
          className="rounded-full p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          title="下一个"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="rounded-full p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
        title="关闭"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
