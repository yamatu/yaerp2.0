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
      className="fixed bottom-60 right-4 z-[60] flex h-11 w-11 items-center justify-center rounded-full bg-slate-900/90 text-white shadow-lg backdrop-blur transition hover:bg-slate-800 hover:scale-105 active:scale-95 md:bottom-56"
      aria-label={isOpen ? '关闭 AI 助手' : '打开 AI 助手'}
    >
      {isOpen ? <X className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
    </button>
  )
}
