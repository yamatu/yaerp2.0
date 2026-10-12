"use client";

import { Loader2, RefreshCw } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useRef,
  useState,
  type ReactNode,
  type TouchEvent,
} from "react";

const TRIGGER_DISTANCE = 64;
const MAX_PULL = 96;

interface PullToRefreshProps {
  onRefresh: () => Promise<unknown> | void;
  /** Disable the gesture (e.g. on desktop or while selecting). */
  enabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Scroll container with a touch pull-to-refresh gesture. The browser's own
 * overscroll (which would reload the whole page) is disabled via `app-scroll`.
 */
const PullToRefresh = forwardRef<HTMLDivElement, PullToRefreshProps>(
  function PullToRefresh({ onRefresh, enabled = true, className = "", children }, forwardedRef) {
    const innerRef = useRef<HTMLDivElement | null>(null);
    const startRef = useRef<{ y: number; x: number; active: boolean } | null>(null);
    const [pull, setPull] = useState(0);
    const [refreshing, setRefreshing] = useState(false);

    const setRefs = useCallback(
      (node: HTMLDivElement | null) => {
        innerRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
      if (!enabled || refreshing || event.touches.length !== 1) return;
      const node = innerRef.current;
      if (!node || node.scrollTop > 0) {
        startRef.current = null;
        return;
      }
      const touch = event.touches[0];
      startRef.current = { y: touch.clientY, x: touch.clientX, active: false };
    };

    const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
      const start = startRef.current;
      if (!start) return;
      const touch = event.touches[0];
      const dy = touch.clientY - start.y;
      const dx = touch.clientX - start.x;
      if (!start.active) {
        // Only a clearly vertical, downward drag from the very top counts.
        if (dy < 6 || Math.abs(dx) > Math.abs(dy)) {
          if (Math.abs(dx) > 8 || dy < -4) startRef.current = null;
          return;
        }
        if ((innerRef.current?.scrollTop ?? 0) > 0) {
          startRef.current = null;
          return;
        }
        start.active = true;
      }
      // Rubber-band feel: the indicator moves slower than the finger.
      setPull(Math.min(MAX_PULL, Math.max(0, dy * 0.5)));
    };

    const finish = async () => {
      const start = startRef.current;
      startRef.current = null;
      if (!start?.active) return;
      if (pull >= TRIGGER_DISTANCE * 0.75) {
        setRefreshing(true);
        setPull(48);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
          setPull(0);
        }
      } else {
        setPull(0);
      }
    };

    const progress = Math.min(1, pull / (TRIGGER_DISTANCE * 0.75));

    return (
      <div className="relative min-h-0 flex-1">
        <div
          aria-hidden={!refreshing && pull === 0}
          className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
          style={{
            transform: `translateY(${Math.max(0, pull - 40)}px)`,
            opacity: pull > 4 || refreshing ? 1 : 0,
            transition: startRef.current?.active ? "none" : "transform 180ms ease, opacity 180ms ease",
          }}
        >
          <span className="mt-1 flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-sky-600 shadow-md">
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw
                className="h-4 w-4"
                style={{ transform: `rotate(${progress * 270}deg)`, opacity: 0.4 + progress * 0.6 }}
              />
            )}
          </span>
        </div>
        <div
          ref={setRefs}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={() => void finish()}
          onTouchCancel={() => void finish()}
          className={`app-scroll h-full overflow-y-auto ${className}`}
          style={{
            transform: pull ? `translateY(${pull * 0.6}px)` : undefined,
            transition: startRef.current?.active ? "none" : "transform 180ms ease",
          }}
        >
          {children}
        </div>
      </div>
    );
  },
);

export default PullToRefresh;
