"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Maximize2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useHistoryLayer } from "@/hooks/useMobileGestures";

export type FilePreviewKind = "image" | "pdf" | "other";

export interface FilePreviewItem {
  /** Stable identity, used as the React key and to detect item changes. */
  key: string;
  name: string;
  /** Missing while the caller is still fetching the bytes. */
  url?: string;
  mimeType?: string;
  size?: number;
  /** Small caption shown next to the file name, e.g. uploader or date. */
  meta?: string;
}

export interface FilePreviewModalProps {
  items: FilePreviewItem[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Extra buttons rendered before the shared actions, e.g. delete. */
  headerActions?: ReactNode;
  /** Extra file specific actions rendered in a bar under the stage. */
  footer?: ReactNode;
  /** Dims the stage while the caller runs a blocking action, e.g. rotate + save. */
  dimmed?: boolean;
  /** Inline error shown above the footer, e.g. a failed rotate/save. */
  errorMessage?: ReactNode;
  /** Hide the built in download button when the caller renders its own. */
  showDownload?: boolean;
  /** Clicking the empty space around the file closes the viewer. */
  closeOnBackdropClick?: boolean;
  emptyHint?: string;
  /** Overlay stacking class; raise it when the viewer opens above a dialog. */
  zIndexClass?: string;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.5;

export function filePreviewKind(
  item: Pick<FilePreviewItem, "mimeType" | "name">,
): FilePreviewKind {
  const mime = (item.mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  const name = (item.name || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/.test(name)) return "image";
  if (/\.pdf$/.test(name)) return "pdf";
  return "other";
}

export function formatPreviewSize(size?: number) {
  if (!size || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function FilePreviewModal({
  items,
  index,
  onIndexChange,
  onClose,
  headerActions,
  footer,
  dimmed = false,
  errorMessage,
  showDownload = true,
  closeOnBackdropClick = true,
  emptyHint = "该文件类型暂不支持在线预览，请下载后查看。",
  zIndexClass = "z-[110]",
}: FilePreviewModalProps) {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  // A pan gesture ends with a click event; that click must not close the viewer.
  const dragMovedRef = useRef(false);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ startDistance: number; startZoom: number } | null>(null);
  const swipeRef = useRef<{ startX: number; startY: number; axis: "x" | "y" | null } | null>(null);
  const lastTapRef = useRef({ time: 0, x: 0, y: 0 });
  const [swipe, setSwipe] = useState({ x: 0, y: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  // Held in a ref as well so repeated arrow presses (key repeat, or two keys in
  // the same frame) never navigate from a stale index.
  const indexRef = useRef(index);

  const safeIndex = items.length === 0 ? -1 : Math.min(Math.max(index, 0), items.length - 1);
  const item = safeIndex >= 0 ? items[safeIndex] : null;
  const kind = item ? filePreviewKind(item) : "other";
  const sizeLabel = formatPreviewSize(item?.size);
  const canNavigate = items.length > 1;

  const resetView = useCallback(() => {
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (!canNavigate || safeIndex < 0) return;
      const next = (indexRef.current + delta + items.length) % items.length;
      indexRef.current = next;
      resetView();
      onIndexChange(next);
    },
    [canNavigate, items.length, onIndexChange, resetView, safeIndex],
  );

  useEffect(() => {
    indexRef.current = safeIndex;
  }, [safeIndex]);

  // Switching files always restarts from "fit", even when the caller reuses the
  // same component instance.
  useEffect(() => {
    resetView();
    setImageState("loading");
  }, [item?.key, resetView]);

  useEffect(() => {
    if (!item?.url || kind !== "image") {
      setImageState(item?.url ? "ready" : "loading");
      return;
    }
    setImageState("loading");
  }, [item?.url, kind]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        go(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        go(1);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP));
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP));
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        resetView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, onClose, resetView]);

  // The phone back button closes the viewer instead of leaving the page.
  useHistoryLayer(true, onClose);

  // Keep the page behind the viewer from scrolling while it is open.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Ctrl/plain wheel zoom for images; registered natively so preventDefault works.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || kind !== "image") return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((current) => {
        const next = current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
        return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [kind, item?.key]);

  useEffect(() => {
    if (zoom <= MIN_ZOOM) setPan({ x: 0, y: 0 });
  }, [zoom]);

  // Touch gestures: one finger swipes between files (or pans when zoomed),
  // two fingers pinch-zoom, a double tap toggles zoom and pulling the image
  // down closes the viewer. Mouse users keep drag-to-pan while zoomed.
  const releasePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const pointerDistance = () => {
    const [first, second] = [...pointersRef.current.values()];
    if (!first || !second) return 0;
    return Math.hypot(first.x - second.x, first.y - second.y);
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (kind !== "image") return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers (tests, some pens) cannot always be captured.
    }
    if (pointersRef.current.size === 2) {
      // A second finger turns any swipe or pan into a pinch.
      dragRef.current = null;
      setSwipe({ x: 0, y: 0 });
      pinchRef.current = { startDistance: pointerDistance() || 1, startZoom: zoom };
      dragMovedRef.current = true;
      setDragging(true);
      return;
    }
    if (pointersRef.current.size > 2) return;
    dragMovedRef.current = false;
    if (zoom > MIN_ZOOM) {
      dragRef.current = { startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y };
      setDragging(true);
      return;
    }
    if (event.pointerType !== "mouse") {
      swipeRef.current = { startX: event.clientX, startY: event.clientY, axis: null };
    }
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size >= 2) {
      const next = (pinch.startZoom * pointerDistance()) / pinch.startDistance;
      setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragMovedRef.current = true;
      setPan({ x: drag.originX + dx, y: drag.originY + dy });
      return;
    }
    const swipe = swipeRef.current;
    if (!swipe) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    if (!swipe.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      swipe.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      dragMovedRef.current = true;
      setDragging(true);
    }
    if (swipe.axis === "x") {
      // Rubber band when there is nothing to swipe to.
      setSwipe({ x: canNavigate ? dx : dx * 0.25, y: 0 });
    } else {
      setSwipe({ x: 0, y: Math.max(0, dy) });
    }
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const tracked = pointersRef.current.delete(event.pointerId);
    releasePointer(event);
    if (!tracked) return;

    if (pinchRef.current) {
      if (pointersRef.current.size >= 2) return;
      pinchRef.current = null;
      const remaining = [...pointersRef.current.values()][0];
      if (remaining && zoom > MIN_ZOOM) {
        dragRef.current = { startX: remaining.x, startY: remaining.y, originX: pan.x, originY: pan.y };
        return;
      }
      setDragging(false);
      return;
    }

    if (dragRef.current) {
      dragRef.current = null;
      setDragging(false);
      return;
    }

    const swipe = swipeRef.current;
    swipeRef.current = null;
    setDragging(false);
    if (!swipe) return;
    const dx = event.clientX - swipe.startX;
    const dy = event.clientY - swipe.startY;
    setSwipe({ x: 0, y: 0 });
    if (swipe.axis === "x") {
      const threshold = Math.min(80, (stageRef.current?.clientWidth || 400) * 0.18);
      if (canNavigate && Math.abs(dx) > threshold) go(dx < 0 ? 1 : -1);
      return;
    }
    if (swipe.axis === "y") {
      if (dy > 110) onClose();
      return;
    }
    // A plain tap: two of them in quick succession toggle zoom.
    const now = Date.now();
    const lastTap = lastTapRef.current;
    if (now - lastTap.time < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30) {
      lastTapRef.current = { time: 0, x: 0, y: 0 };
      dragMovedRef.current = true;
      if (zoom > MIN_ZOOM) resetView();
      else setZoom(2.5);
      return;
    }
    lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
  };

  const cancelDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    releasePointer(event);
    if (pointersRef.current.size > 0) return;
    pinchRef.current = null;
    dragRef.current = null;
    swipeRef.current = null;
    setSwipe({ x: 0, y: 0 });
    setDragging(false);
  };

  // A PDF rendered in the iframe takes keyboard focus, which would swallow the
  // Escape / arrow shortcuts. Moving the pointer back onto the viewer chrome
  // hands focus back to the page.
  const reclaimFocus = useCallback(() => {
    const active = document.activeElement;
    if (active && active.tagName === "IFRAME") {
      (active as HTMLElement).blur();
    }
  }, []);

  const zoomed = zoom > MIN_ZOOM;
  const metaParts = useMemo(
    () => [item?.meta, sizeLabel].filter((value): value is string => Boolean(value && value.trim())),
    [item?.meta, sizeLabel],
  );

  if (!item) return null;

  return (
    <div
      className={`fixed inset-0 flex flex-col overscroll-contain bg-black sm:bg-slate-950/80 sm:backdrop-blur-sm ${zIndexClass}`}
      onClick={() => {
        if (!dragging) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${item.name}`}
      onPointerMove={reclaimFocus}
      onPointerDown={reclaimFocus}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-white sm:flex-wrap sm:px-4 sm:py-2.5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="min-w-0 flex-1 pl-1 sm:basis-40 sm:pl-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{item.name}</span>
            {canNavigate && (
              <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[11px] tabular-nums text-white/70">
                {safeIndex + 1} / {items.length}
              </span>
            )}
          </div>
          {metaParts.length > 0 && (
            <div className="mt-0.5 truncate text-xs text-white/60">{metaParts.join(" · ")}</div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-0.5 sm:w-auto sm:flex-wrap sm:gap-1">
          {canNavigate && (
            <>
              <button
                type="button"
                onClick={() => go(-1)}
                className="hidden h-9 w-9 sm:inline-flex items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
                title="上一个（←）"
                aria-label="上一个文件"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                className="hidden h-9 w-9 sm:inline-flex items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
                title="下一个（→）"
                aria-label="下一个文件"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          )}
          {kind === "image" && (
            <>
              <button
                type="button"
                onClick={() => setZoom((current) => Math.max(MIN_ZOOM, current - ZOOM_STEP))}
                disabled={!zoomed}
                className="hidden h-9 w-9 sm:inline-flex items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
                title="缩小（-）"
                aria-label="缩小图片"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <span className="hidden w-12 shrink-0 text-center text-xs tabular-nums text-white/70 sm:inline">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((current) => Math.min(MAX_ZOOM, current + ZOOM_STEP))}
                disabled={zoom >= MAX_ZOOM}
                className="hidden h-9 w-9 sm:inline-flex items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
                title="放大（+）"
                aria-label="放大图片"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={resetView}
                disabled={!zoomed && pan.x === 0 && pan.y === 0}
                className={`${zoomed ? "inline-flex" : "hidden sm:inline-flex"} h-10 w-10 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30 sm:h-9 sm:w-9`}
                title="适应窗口（0）"
                aria-label="适应窗口"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </>
          )}
          {headerActions}
          {item.url && showDownload && (
            <a
              href={item.url}
              download={item.name}
              onClick={(event) => event.stopPropagation()}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-100 sm:h-9"
              title="下载文件"
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">下载</span>
            </a>
          )}
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white sm:h-9 sm:w-9"
              title="在新窗口打开"
              aria-label="在新窗口打开"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white sm:h-9 sm:w-9"
            title="关闭（Esc）"
            aria-label="关闭预览"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className={`relative min-h-0 flex-1 overflow-hidden ${kind === "image" ? "touch-none select-none" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          if (!closeOnBackdropClick) return;
          if (dragMovedRef.current) {
            dragMovedRef.current = false;
            return;
          }
          // Clicks that land on the image, the PDF frame or the toolbar keep the
          // viewer open; clicks on the surrounding space close it.
          const target = event.target as HTMLElement | null;
          if (target && target.closest("img,iframe,a,button,video")) return;
          onClose();
        }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onDoubleClick={() => (zoomed ? resetView() : setZoom(2))}
        style={{ cursor: kind === "image" && zoomed ? (dragging ? "grabbing" : "grab") : "default" }}
      >
        {!item.url && (kind === "image" || kind === "pdf") ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-white/70">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-sm">正在加载预览...</span>
          </div>
        ) : kind === "image" ? (
          <div className="flex h-full w-full items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.url}
              alt={item.name}
              draggable={false}
              onLoad={() => setImageState("ready")}
              onError={() => setImageState("error")}
              className={`max-h-full max-w-full select-none object-contain ${
                dimmed ? "opacity-60" : ""
              } ${
                // No transform transition while panning, otherwise the drag lags
                // behind the pointer.
                dragging ? "transition-opacity duration-150" : "transition-[transform,opacity] duration-100"
              }`}
              style={{
                transform: `translate(${pan.x + swipe.x}px, ${pan.y + swipe.y}px) scale(${zoom * (swipe.y > 0 ? Math.max(0.75, 1 - swipe.y / 900) : 1)})`,
                opacity: swipe.y > 0 ? Math.max(0.35, 1 - swipe.y / 400) : undefined,
              }}
            />
            {(imageState === "loading" || dimmed) && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-white/70" />
              </div>
            )}
          </div>
        ) : kind === "pdf" ? (
          <iframe src={item.url} title={item.name} className="h-full w-full bg-white" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-white/75">
            <FileText className="h-10 w-10 text-white/50" />
            <div className="text-sm">{emptyHint}</div>
          </div>
        )}
        {imageState === "error" && item.url && kind === "image" && (
          <div className="absolute inset-x-0 bottom-4 mx-auto flex w-fit items-center gap-2 rounded-lg bg-rose-500/25 px-3 py-2 text-xs text-rose-100">
            <AlertTriangle className="h-3.5 w-3.5" />
            图片加载失败，请尝试下载后查看。
          </div>
        )}
      </div>

      {errorMessage && (
        <div
          className="flex shrink-0 items-center gap-2 border-t border-rose-400/20 bg-rose-500/20 px-3 py-2 text-xs text-rose-100 sm:px-4"
          onClick={(event) => event.stopPropagation()}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{errorMessage}</span>
        </div>
      )}

      {footer && (
        <div
          className="flex shrink-0 flex-wrap items-center gap-2 border-t border-white/10 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 text-white sm:px-4 sm:py-2 [&_button]:min-h-10 [&_button]:min-w-10 sm:[&_button]:min-h-0 sm:[&_button]:min-w-0 [&_select]:min-h-10 sm:[&_select]:min-h-0"
          onClick={(event) => event.stopPropagation()}
        >
          {footer}
        </div>
      )}
    </div>
  );
}
