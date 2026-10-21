'use client'

import { useEffect, useRef, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { AI_CONTEXT_DROP_EVENT, isContextDrag, readContextDrag } from '@/lib/dataEvents'
import { useFloatingDrag, type FloatingDragPosition } from '@/hooks/useFloatingDrag'

interface AIChatFABProps {
  onClick: () => void
  onContextDrop: () => void
  isOpen?: boolean
}

const POSITION_KEY = 'yaerp:ai-fab-position'

function readPosition(): FloatingDragPosition | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(POSITION_KEY) || 'null') as Partial<FloatingDragPosition> | null
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return { x: parsed.x, y: parsed.y }
  } catch {
    // Ignore malformed storage.
  }
  return null
}

export default function AIChatFAB({ onClick, onContextDrop, isOpen }: AIChatFABProps) {
  const [dropActive, setDropActive] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const drag = useFloatingDrag({ elementRef: buttonRef, ignoreInteractive: false })
  const { moveTo, position } = drag

  useEffect(() => {
    const saved = readPosition()
    if (saved) moveTo(saved.x, saved.y)
  }, [moveTo])

  useEffect(() => {
    if (!position) return
    const timeout = window.setTimeout(() => {
      try { window.localStorage.setItem(POSITION_KEY, JSON.stringify(position)) } catch { /* session only */ }
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [position])

  return (
    <button
      ref={buttonRef}
      type="button"
      {...drag.handleProps}
      style={drag.style}
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
      className={`fixed bottom-[calc(var(--mobile-fab-bottom)+0.75rem)] right-3 z-[60] h-11 w-11 touch-none select-none items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-white shadow-lg hover:bg-slate-800 md:bottom-[calc(var(--sheet-tabbar-offset)+1.25rem)] md:right-5 md:flex ${isOpen ? 'hidden' : 'flex'} ${drag.dragging ? 'cursor-grabbing' : 'cursor-grab transition-colors active:scale-95'} ${dropActive ? 'scale-110 ring-4 ring-amber-300' : ''}`}
      aria-label={isOpen ? '关闭 AI 助手' : '打开 AI 助手'}
      title="AI 助手：点击打开，按住可拖动位置；也可以把工作簿或文件夹拖到这里"
    >
      {isOpen ? <X className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      {!isOpen && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-400" />}
    </button>
  )
}
