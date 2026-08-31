'use client'

import { Sparkles, X } from 'lucide-react'

interface AIChatFABProps {
  onClick: () => void
  isOpen?: boolean
}

export default function AIChatFAB({ onClick, isOpen }: AIChatFABProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-20 right-3 z-[60] flex h-11 w-11 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-white shadow-lg transition hover:bg-slate-800 active:scale-95 md:bottom-5 md:right-5"
      aria-label={isOpen ? '关闭 AI 助手' : '打开 AI 助手'}
    >
      {isOpen ? <X className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      {!isOpen && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />}
    </button>
  )
}
