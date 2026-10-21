'use client'

import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { AI_CONTEXT_DROP_EVENT, isContextDrag, readContextDrag } from '@/lib/dataEvents'

interface AIChatFABProps {
  onClick: () => void
  onContextDrop: () => void
  isOpen?: boolean
}

export default function AIChatFAB({ onClick, onContextDrop, isOpen }: AIChatFABProps) {
  const [dropActive, setDropActive] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      // Dropping a workbook or folder on the button opens the chat with it as context.
      onDragOver={(event) => {
        if (!isContextDrag(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropActive(true)
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(event) => {
        setDropActive(false)
        if (!isContextDrag(event.dataTransfer)) return
        event.preventDefault()
        const payload = readContextDrag(event.dataTransfer)
        if (!payload) return
        onContextDrop()
        window.dispatchEvent(new CustomEvent(AI_CONTEXT_DROP_EVENT, { detail: payload }))
      }}
      // Phones: float above the bottom tab bar (or the home indicator), and step
      // aside while the assistant is open because it then covers the screen.
      className={`fixed bottom-[calc(var(--mobile-fab-bottom)+0.75rem)] right-3 z-[60] h-11 w-11 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-white shadow-lg transition hover:bg-slate-800 active:scale-95 md:bottom-[calc(var(--sheet-tabbar-offset)+1.25rem)] md:right-5 md:flex ${isOpen ? 'hidden' : 'flex'} ${dropActive ? 'scale-110 ring-4 ring-amber-300' : ''}`}
      aria-label={isOpen ? '关闭 AI 助手' : '打开 AI 助手'}
      title="打开 AI 助手（也可以把工作簿或文件夹拖到这里）"
    >
      {isOpen ? <X className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      {!isOpen && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />}
    </button>
  )
}
