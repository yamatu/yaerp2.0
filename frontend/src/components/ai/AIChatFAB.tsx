'use client'

import { Bot, X } from 'lucide-react'

interface AIChatFABProps {
  onClick: () => void
  isOpen?: boolean
}

export default function AIChatFAB({ onClick, isOpen }: AIChatFABProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-20 right-6 z-[60] flex h-12 w-12 items-center justify-center rounded-full bg-slate-900 text-white shadow-lg transition hover:bg-slate-800 hover:scale-105 active:scale-95"
      aria-label={isOpen ? '关闭 AI 助手' : '打开 AI 助手'}
    >
      {isOpen ? <X className="h-5 w-5" /> : <Bot className="h-5 w-5" />}
    </button>
  )
}
