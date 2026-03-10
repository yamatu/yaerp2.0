'use client'

import { Bot } from 'lucide-react'

interface AIChatFABProps {
  onClick: () => void
}

export default function AIChatFAB({ onClick }: AIChatFABProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-white shadow-lg transition hover:bg-slate-800 hover:scale-105 active:scale-95"
      aria-label="打开 AI 助手"
    >
      <Bot className="h-6 w-6" />
    </button>
  )
}
