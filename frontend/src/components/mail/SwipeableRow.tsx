"use client";

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from "react";

const LONG_PRESS_MS = 480;
const MOVE_TOLERANCE = 8;

interface GestureState {
  x: number;
  y: number;
  base: number;
  mode: "pending" | "horizontal" | "vertical";
  timer: number;
}

interface SwipeableRowProps {
  /** Whether the trailing actions are revealed. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Buttons revealed behind the row when it is swiped to the left. */
  actions?: ReactNode;
  actionsWidth?: number;
  onLongPress?: () => void;
  /** Touch gestures only run on phones; desktop keeps plain clicks. */
  enabled?: boolean;
  children: ReactNode;
}

/**
 * List row with phone gestures: swipe left to reveal quick actions, long-press
 * to start multi-select. Taps still reach the row's own onClick unless the
 * gesture consumed them.
 */
export default function SwipeableRow({
  open,
  onOpenChange,
  actions,
  actionsWidth = 144,
  onLongPress,
  enabled = true,
  children,
}: SwipeableRowProps) {
  const gestureRef = useRef<GestureState | null>(null);
  const suppressClickRef = useRef(false);
  const [drag, setDrag] = useState<number | null>(null);

  useEffect(
    () => () => {
      if (gestureRef.current) window.clearTimeout(gestureRef.current.timer);
    },
    [],
  );

  const swipeEnabled = enabled && Boolean(actions);
  const offset = drag ?? (open && swipeEnabled ? -actionsWidth : 0);

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (!enabled || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const timer = window.setTimeout(() => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.mode !== "pending") return;
      gesture.mode = "vertical";
      suppressClickRef.current = true;
      try {
        navigator.vibrate?.(12);
      } catch {
        // Vibration is optional.
      }
      onLongPress?.();
    }, LONG_PRESS_MS);
    gestureRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      base: open ? -actionsWidth : 0,
      mode: "pending",
      timer,
    };
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (gesture.mode === "pending") {
      if (Math.abs(dx) < MOVE_TOLERANCE && Math.abs(dy) < MOVE_TOLERANCE) return;
      window.clearTimeout(gesture.timer);
      gesture.mode =
        swipeEnabled && Math.abs(dx) > Math.abs(dy) * 1.2 ? "horizontal" : "vertical";
    }
    if (gesture.mode !== "horizontal") return;
    setDrag(Math.min(0, Math.max(-actionsWidth - 32, gesture.base + dx)));
  };

  const handleTouchEnd = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    window.clearTimeout(gesture.timer);
    if (gesture.mode === "horizontal") {
      const final = drag ?? gesture.base;
      suppressClickRef.current = true;
      setDrag(null);
      onOpenChange(final < -actionsWidth / 2);
    }
  };

  const handleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // A tap on an opened row only closes it.
    if (open && swipeEnabled) {
      event.preventDefault();
      event.stopPropagation();
      onOpenChange(false);
    }
  };

  if (!enabled) return <>{children}</>;

  return (
    <div className="relative overflow-hidden">
      {swipeEnabled && (
        <div
          className="absolute inset-y-0 right-0 flex"
          style={{ width: actionsWidth }}
          aria-hidden={!open}
        >
          {actions}
        </div>
      )}
      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onClickCapture={handleClickCapture}
        className="no-touch-callout relative touch-pan-y bg-white"
        style={{
          transform: offset ? `translateX(${offset}px)` : undefined,
          transition: drag === null ? "transform 200ms ease" : "none",
        }}
      >
        {children}
      </div>
    </div>
  );
}
