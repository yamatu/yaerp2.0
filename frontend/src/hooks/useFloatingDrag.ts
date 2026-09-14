'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react'

export interface FloatingDragPosition {
  x: number
  y: number
}

interface FloatingDragOrigin {
  left: number
  top: number
  width: number
  height: number
}

interface FloatingDragOptions {
  /** Element that is moved. Its own CSS positioning decides the coordinate space. */
  elementRef: RefObject<HTMLElement | null>
  /**
   * Optional positioned ancestor. When provided the stored coordinates are
   * relative to it (use together with `position: absolute`). Without it the
   * coordinates are viewport based (use together with `position: fixed`).
   */
  containerRef?: RefObject<HTMLElement | null>
  /** When false the handle is inert, e.g. while a widget is hidden. */
  enabled?: boolean
  /** Skip drags that start on an interactive child such as a button. */
  ignoreInteractive?: boolean
  /** Restored position (e.g. from storage). Falls back to the CSS default. */
  initialPosition?: FloatingDragPosition | null
}

interface FloatingDragState {
  pointerId: number
  originX: number
  originY: number
  startLeft: number
  startTop: number
  moved: boolean
}

const DRAG_THRESHOLD = 4

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Turns a floating element into a draggable widget. The widget keeps its CSS
 * default position until the user actually drags it, after which explicit
 * coordinates are applied. A real drag swallows the trailing click so dragging
 * a button does not also fire its action.
 */
export function useFloatingDrag({
  elementRef,
  containerRef,
  enabled = true,
  ignoreInteractive = true,
  initialPosition = null,
}: FloatingDragOptions) {
  const [position, setPosition] = useState<FloatingDragPosition | null>(initialPosition)
  const [dragging, setDragging] = useState(false)
  const stateRef = useRef<FloatingDragState | null>(null)
  const suppressClickRef = useRef(false)

  const readOrigin = useCallback((): FloatingDragOrigin => {
    const container = containerRef?.current
    if (container) {
      const rect = container.getBoundingClientRect()
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  }, [containerRef])

  const clampPosition = useCallback(
    (x: number, y: number): FloatingDragPosition => {
      const element = elementRef.current
      const origin = readOrigin()
      const width = element?.offsetWidth ?? 0
      const height = element?.offsetHeight ?? 0
      return {
        x: clamp(x, 0, Math.max(0, origin.width - width)),
        y: clamp(y, 0, Math.max(0, origin.height - height)),
      }
    },
    [elementRef, readOrigin]
  )

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0) return
      if (ignoreInteractive) {
        const target = event.target as HTMLElement | null
        if (target?.closest('button, a, input, textarea, select, [role="button"]')) return
      }
      const element = elementRef.current
      if (!element) return

      const rect = element.getBoundingClientRect()
      const origin = readOrigin()
      stateRef.current = {
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        startLeft: rect.left - origin.left,
        startTop: rect.top - origin.top,
        moved: false,
      }
      suppressClickRef.current = false
      setDragging(true)
      setPosition(clampPosition(rect.left - origin.left, rect.top - origin.top))
    },
    [clampPosition, elementRef, enabled, ignoreInteractive, readOrigin]
  )

  useEffect(() => {
    if (!dragging) return

    const handleMove = (event: PointerEvent) => {
      const state = stateRef.current
      if (!state || event.pointerId !== state.pointerId) return
      const deltaX = event.clientX - state.originX
      const deltaY = event.clientY - state.originY
      if (!state.moved && Math.abs(deltaX) < DRAG_THRESHOLD && Math.abs(deltaY) < DRAG_THRESHOLD) {
        return
      }
      state.moved = true
      setPosition(clampPosition(state.startLeft + deltaX, state.startTop + deltaY))
    }

    const handleEnd = (event: PointerEvent) => {
      const state = stateRef.current
      if (!state || event.pointerId !== state.pointerId) return
      suppressClickRef.current = state.moved
      stateRef.current = null
      setDragging(false)
      if (state.moved) {
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 320)
      }
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
    }
  }, [clampPosition, dragging])

  // Keep a dragged widget inside its bounds when the viewport shrinks.
  useEffect(() => {
    if (!position) return
    const handleResize = () => setPosition((current) => (current ? clampPosition(current.x, current.y) : current))
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [clampPosition, position])

  // Clamp a restored position so a widget saved on a larger screen stays visible.
  useEffect(() => {
    setPosition((current) =>
      current ? clampPosition(current.x, current.y) : current,
    )
  }, [clampPosition])

  const handleClickCapture = useCallback((event: ReactMouseEvent) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const style: CSSProperties | undefined = position
    ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' }
    : undefined

  const handleProps = {
    onPointerDown: startDrag,
    onClickCapture: handleClickCapture,
  }

  const reset = useCallback(() => setPosition(null), [])

  return { position, dragging, handleProps, style, reset }
}
