'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'

/** Phones and small tablets: the layout the bottom tab bar is shown for. */
export const MOBILE_QUERY = '(max-width: 767px)'
/** Touch-first devices, regardless of the screen width. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)'

export function matchesMedia(query: string) {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
}

export function useMediaQuery(query: string, serverValue = false) {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined
      const media = window.matchMedia(query)
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    () => matchesMedia(query),
    () => serverValue,
  )
}

/* -------------------------------------------------------------------------- */
/* History layers: stacked screens and sheets that close with the back button  */
/* -------------------------------------------------------------------------- */

interface HistoryLayer {
  id: number
  close: () => void
}

const historyLayers: HistoryLayer[] = []
let nextHistoryLayerId = 1
let ignoredPops = 0
let historyListenerInstalled = false
// History changes are batched per tick: a layer closing from the UI and another
// opening in the same render (e.g. "close search panel, open conversation")
// simply reuse the entry instead of racing back() against pushState().
let pendingEntryDelta = 0
let entryFlushTimer: number | null = null
let releaseHref = ''

function scheduleEntryChange(delta: number) {
  pendingEntryDelta += delta
  if (entryFlushTimer !== null) return
  entryFlushTimer = window.setTimeout(() => {
    entryFlushTimer = null
    const change = pendingEntryDelta
    pendingEntryDelta = 0
    if (change > 0) {
      for (let index = 0; index < change; index += 1) window.history.pushState(window.history.state, '')
    } else if (change < 0) {
      // The layer closed because the app navigated elsewhere (a link inside a
      // sheet): going back now would undo that navigation.
      if (releaseHref && window.location.href !== releaseHref) return
      ignoredPops += 1
      window.history.go(change)
    }
  }, 0)
}

function claimEntry() {
  scheduleEntryChange(1)
}

function releaseEntry(href: string) {
  releaseHref = href
  scheduleEntryChange(-1)
}

function installHistoryListener() {
  if (historyListenerInstalled || typeof window === 'undefined') return
  historyListenerInstalled = true
  window.addEventListener('popstate', () => {
    if (ignoredPops > 0) {
      ignoredPops -= 1
      return
    }
    const layer = historyLayers.pop()
    layer?.close()
  })
}

/**
 * Pushes a history entry while `open` is true so the browser / Android back
 * button closes the layer instead of leaving the page. Closing the layer from
 * the UI removes the entry again. Layers stack: back always closes the most
 * recently opened one.
 */
export function useHistoryLayer(open: boolean, onClose: () => void, enabled = true) {
  const onCloseRef = useRef(onClose)
  const layerIdRef = useRef<number | null>(null)
  const hrefRef = useRef('')

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (typeof window === 'undefined') return
    installHistoryListener()
    if (open && enabled && layerIdRef.current === null) {
      const id = nextHistoryLayerId++
      layerIdRef.current = id
      hrefRef.current = window.location.href
      historyLayers.push({
        id,
        close: () => {
          layerIdRef.current = null
          onCloseRef.current()
        },
      })
      claimEntry()
      return
    }
    if ((!open || !enabled) && layerIdRef.current !== null) {
      const id = layerIdRef.current
      layerIdRef.current = null
      const index = historyLayers.findIndex((layer) => layer.id === id)
      if (index >= 0) {
        historyLayers.splice(index, 1)
        releaseEntry(hrefRef.current)
      }
    }
  }, [enabled, open])

  // Unmounting while open (a viewer rendered conditionally by its parent) drops
  // the entry as well, unless the app navigated to another URL meanwhile.
  useEffect(() => () => {
    const id = layerIdRef.current
    if (id === null) return
    layerIdRef.current = null
    const index = historyLayers.findIndex((layer) => layer.id === id)
    if (index < 0) return
    historyLayers.splice(index, 1)
    releaseEntry(hrefRef.current)
  }, [])
}

/* -------------------------------------------------------------------------- */
/* Long press                                                                  */
/* -------------------------------------------------------------------------- */

export interface LongPressPoint {
  x: number
  y: number
}

/**
 * Touch / pen long press. Mouse users keep the native right click. The click
 * that some browsers fire after a long press is swallowed so the pressed item
 * is not also "tapped".
 */
export function useLongPress<T>(onLongPress: (payload: T, point: LongPressPoint) => void, delay = 450) {
  const callbackRef = useRef(onLongPress)
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<LongPressPoint | null>(null)
  const firedAtRef = useRef(0)
  // The finger can stay down well after the press fired; the click that may
  // follow its release must still be ignored.
  const holdingRef = useRef(false)
  const releasedAtRef = useRef(0)

  useEffect(() => {
    callbackRef.current = onLongPress
  }, [onLongPress])

  const release = useCallback(() => {
    if (holdingRef.current) releasedAtRef.current = Date.now()
    holdingRef.current = false
  }, [])

  const clear = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }, [])

  useEffect(() => clear, [clear])

  const bind = useCallback((payload: T) => ({
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType === 'mouse' || !event.isPrimary) return
      clear()
      const point = { x: event.clientX, y: event.clientY }
      startRef.current = point
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        firedAtRef.current = Date.now()
        holdingRef.current = true
        try {
          navigator.vibrate?.(12)
        } catch {
          // Vibration is a nicety only.
        }
        callbackRef.current(payload, point)
      }, delay)
    },
    onPointerMove: (event: ReactPointerEvent) => {
      const start = startRef.current
      if (!start || timerRef.current === null) return
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clear()
    },
    onPointerUp: () => {
      clear()
      release()
    },
    onPointerCancel: () => {
      clear()
      release()
    },
    onClickCapture: (event: ReactMouseEvent) => {
      if (holdingRef.current || Date.now() - releasedAtRef.current < 450 || Date.now() - firedAtRef.current < 700) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
  }), [clear, delay, release])

  /** True during / right after a long press; lets callers ignore the follow-up contextmenu/click. */
  const justLongPressed = useCallback(
    () => holdingRef.current || Date.now() - releasedAtRef.current < 450 || Date.now() - firedAtRef.current < 900,
    [],
  )

  return useMemo(() => ({ bind, justLongPressed }), [bind, justLongPressed])
}

/* -------------------------------------------------------------------------- */
/* Virtual keyboard                                                            */
/* -------------------------------------------------------------------------- */

export interface KeyboardViewport {
  /** Height of the on-screen keyboard (0 when hidden). */
  keyboardInset: number
  /** Visible viewport height while the keyboard is open. */
  height: number
  /** How far the browser scrolled the visual viewport down. */
  offsetTop: number
}

/**
 * Tracks the on-screen keyboard through the VisualViewport API. Mobile
 * browsers shrink only the visual viewport, so full-height layouts use this to
 * keep their composer glued to the top of the keyboard.
 */
export function useKeyboardViewport(enabled = true): KeyboardViewport {
  const [state, setState] = useState<KeyboardViewport>({ keyboardInset: 0, height: 0, offsetTop: 0 })

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !window.visualViewport) return
    const viewport = window.visualViewport
    let frame = 0
    const update = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const inset = Math.max(0, Math.round(window.innerHeight - viewport.height))
        // Pinch-zooming the page also shrinks the visual viewport; only an
        // unscaled viewport losing height means the keyboard is showing.
        const open = inset > 120 && Math.abs(viewport.scale - 1) < 0.02
        setState((current) => {
          const next = open
            ? { keyboardInset: inset, height: Math.round(viewport.height), offsetTop: Math.round(viewport.offsetTop) }
            : { keyboardInset: 0, height: 0, offsetTop: 0 }
          return current.keyboardInset === next.keyboardInset && current.height === next.height && current.offsetTop === next.offsetTop
            ? current
            : next
        })
      })
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      window.cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [enabled])

  return enabled ? state : { keyboardInset: 0, height: 0, offsetTop: 0 }
}

/** Adds a class to <body> while `active` (e.g. `fab-hidden` to hide the AI launcher). */
export function useBodyClass(className: string, active: boolean) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return
    document.body.classList.add(className)
    return () => document.body.classList.remove(className)
  }, [active, className])
}
