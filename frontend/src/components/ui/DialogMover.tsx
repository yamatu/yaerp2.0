'use client'

import { useEffect } from 'react'

// Makes every dialog whose backdrop carries `data-movable-dialog` movable on
// desktop: drag the title bar (the panel's first row, or an element marked
// `data-dialog-handle`) to move the window. Once moved, the backdrop turns
// see-through and lets clicks pass, so the page behind can be read, selected
// and copied while the dialog stays open. Double-click the title bar to put the
// window back. Mounted once in the root layout; dialogs need no extra code.

const HANDLE_MAX_HEIGHT = 140
const INTERACTIVE = 'button, a, input, textarea, select, label, option, [role="button"], [role="switch"], [contenteditable="true"], [data-no-drag]'

const offsets = new WeakMap<HTMLElement, { x: number; y: number }>()

function visible(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && element.getAttribute('aria-hidden') !== 'true' && element.offsetParent !== null
}

function dialogPanel(overlay: HTMLElement) {
  const marked = overlay.querySelector<HTMLElement>(':scope > [data-dialog-panel]')
  if (marked) return marked
  return Array.from(overlay.children).find(visible) ?? null
}

function dialogHandle(panel: HTMLElement, target: HTMLElement) {
  const marked = target.closest<HTMLElement>('[data-dialog-handle]')
  if (marked && panel.contains(marked)) return marked
  const first = Array.from(panel.children).find(visible)
  if (first && first.contains(target) && first.offsetHeight <= HANDLE_MAX_HEIGHT) return first
  return null
}

function applyOffset(overlay: HTMLElement, panel: HTMLElement, x: number, y: number) {
  offsets.set(panel, { x, y })
  // `translate` leaves any React-managed `transform` on the panel untouched.
  panel.style.translate = x || y ? `${x}px ${y}px` : ''
  if (x || y) overlay.dataset.floating = 'true'
  else if (overlay.dataset.floatingDefault !== 'true') delete overlay.dataset.floating
}

export default function DialogMover() {
  useEffect(() => {
    const desktop = () => window.matchMedia('(min-width: 640px)').matches

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === 'touch' || !desktop()) return
      const target = event.target as HTMLElement | null
      const overlay = target?.closest<HTMLElement>('[data-movable-dialog]')
      if (!target || !overlay || target.closest(INTERACTIVE)) return
      const panel = dialogPanel(overlay)
      if (!panel || !panel.contains(target) || !dialogHandle(panel, target)) return

      event.preventDefault()
      const start = offsets.get(panel) ?? { x: 0, y: 0 }
      const rect = panel.getBoundingClientRect()
      const startX = event.clientX
      const startY = event.clientY
      let moved = false
      const move = (moveEvent: PointerEvent) => {
        const rawX = moveEvent.clientX - startX
        const rawY = moveEvent.clientY - startY
        if (!moved && Math.abs(rawX) < 4 && Math.abs(rawY) < 4) return
        moved = true
        // Keep at least part of the title bar on screen.
        const dx = Math.min(Math.max(rawX, 120 - rect.right), window.innerWidth - 120 - rect.left)
        const dy = Math.min(Math.max(rawY, -rect.top), window.innerHeight - 56 - rect.top)
        applyOffset(overlay, panel, start.x + dx, start.y + dy)
      }
      const stop = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        document.body.classList.remove('dialog-moving')
      }
      document.body.classList.add('dialog-moving')
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    }

    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const overlay = target?.closest<HTMLElement>('[data-movable-dialog]')
      if (!target || !overlay || target.closest(INTERACTIVE)) return
      const panel = dialogPanel(overlay)
      if (!panel || !dialogHandle(panel, target) || !offsets.get(panel)) return
      applyOffset(overlay, panel, 0, 0)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('dblclick', onDoubleClick, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('dblclick', onDoubleClick, true)
    }
  }, [])

  return null
}
