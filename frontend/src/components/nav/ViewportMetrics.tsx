'use client'

import { useEffect } from 'react'

/** Keyboards are taller than this; smaller differences are browser chrome. */
const KEYBOARD_THRESHOLD = 120

/**
 * Publishes the *visual* viewport as CSS variables (`--vv-top`, `--vv-height`,
 * `--keyboard-inset`) and toggles `body.keyboard-open`.
 *
 * Mobile browsers keep `position: fixed; bottom: 0` anchored to the layout
 * viewport, so an on-screen keyboard covers inputs in full-screen sheets. Sheets
 * sized with these variables shrink to the area that is actually visible.
 */
export default function ViewportMetrics() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    let frame = 0

    const apply = () => {
      frame = 0
      const height = viewport.height
      const top = viewport.offsetTop
      const inset = Math.max(0, window.innerHeight - height - top)
      root.style.setProperty('--vv-height', `${Math.round(height)}px`)
      root.style.setProperty('--vv-top', `${Math.round(top)}px`)
      root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`)
      const editing = document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select, [contenteditable="true"]')
      document.body.classList.toggle('keyboard-open', inset > KEYBOARD_THRESHOLD && editing)
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(apply)
    }

    apply()
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    window.addEventListener('focusin', schedule)
    window.addEventListener('focusout', schedule)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      window.removeEventListener('focusin', schedule)
      window.removeEventListener('focusout', schedule)
      document.body.classList.remove('keyboard-open')
      root.style.removeProperty('--vv-height')
      root.style.removeProperty('--vv-top')
      root.style.removeProperty('--keyboard-inset')
    }
  }, [])

  return null
}
