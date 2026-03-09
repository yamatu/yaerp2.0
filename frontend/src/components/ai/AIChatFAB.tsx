'use client'

import { MessageSquare } from 'lucide-react'

interface AIChatFABProps {
  onClick: () => void
}

export default function AIChatFAB({ onClick }: AIChatFABProps) {
  return (
    <div className="fixed bottom-6 right-6 z-40">
      <div className="absolute inset-0 rounded-full bg-slate-900/30 animate-ping" />
      <button
        onClick={onClick}
        className="relative bg-slate-900 text-white w-14 h-14 rounded-full shadow-lg hover:bg-slate-800 transition flex items-center justify-center"
        aria-label="打开 AI 助手"
      >
        <MessageSquare className="w-6 h-6" />
      </button>
    </div>
  )
}
