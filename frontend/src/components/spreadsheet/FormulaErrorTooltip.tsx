'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { AlertCircle } from 'lucide-react'
import { columnIndexToLetter } from '@/lib/spreadsheet'
import type { FormulaErrorHint } from '@/lib/univer-formula-error-hint'

interface Props {
  hint: (FormulaErrorHint & { value?: string; detail?: string }) | null
  containerRef: RefObject<HTMLElement | null>
}

const WIDTH = 220
const HOVER_DELAY = 350

/**
 * Explains a formula error next to the pointer. The tooltip is purely visual:
 * `pointer-events: none` on the whole subtree, so it can never cover a cell in
 * a way that blocks selecting, editing or deleting it (desktop or touch).
 */
export default function FormulaErrorTooltip({ hint, containerRef }: Props) {
  const pointerRef = useRef<{ x: number; y: number; touch: boolean } | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const track = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' }
    }
    root.addEventListener('pointermove', track, { capture: true, passive: true })
    root.addEventListener('pointerdown', track, { capture: true, passive: true })
    return () => {
      root.removeEventListener('pointermove', track, true)
      root.removeEventListener('pointerdown', track, true)
    }
  }, [containerRef])

  useEffect(() => {
    if (!hint) {
      setVisible(false)
      return
    }
    const root = containerRef.current
    const pointer = pointerRef.current
    if (!root || !pointer) return
    const bounds = root.getBoundingClientRect()
    const height = 64
    // Below-right of the pointer, flipped when it would leave the sheet. The
    // offset keeps the hovered cell itself visible.
    let left = pointer.x - bounds.left + 14
    let top = pointer.y - bounds.top + (pointer.touch ? 28 : 18)
    if (left + WIDTH > bounds.width - 8) left = Math.max(8, pointer.x - bounds.left - WIDTH - 14)
    if (top + height > bounds.height - 8) top = Math.max(8, pointer.y - bounds.top - height - (pointer.touch ? 28 : 14))
    setPosition({ left, top })
    if (!pointer.touch) {
      // A short hover delay: sweeping across the grid must not flash tooltips.
      setVisible(false)
      const delay = window.setTimeout(() => setVisible(true), HOVER_DELAY)
      return () => window.clearTimeout(delay)
    }
    // There is no hover on a phone: show the explanation briefly after a tap.
    setVisible(true)
    const timer = window.setTimeout(() => setVisible(false), 2600)
    return () => window.clearTimeout(timer)
  }, [containerRef, hint])

  if (!hint || !visible || !position) return null
  return (
    <div
      className="pointer-events-none absolute z-[24] select-none rounded-lg border border-rose-200 bg-white/95 px-2.5 py-1.5 text-left shadow-lg"
      style={{ left: position.left, top: position.top, width: WIDTH }}
      role="tooltip"
      data-formula-error-hint={`${hint.row}:${hint.column}`}
    >
      <div className="flex items-center gap-1 text-[11px] font-semibold text-rose-600">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{columnIndexToLetter(hint.column)}{hint.row + 1} {hint.value || hint.title}</span>
      </div>
      <p className="mt-0.5 text-[11px] leading-4 text-slate-600">{hint.detail || hint.message}</p>
      <p className="mt-0.5 text-[10px] leading-4 text-slate-400">选中后按 Delete 可清除</p>
    </div>
  )
}
