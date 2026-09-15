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
  emptyHint = "该文件类型暂不支持在线预览，请下载后查看。",
  zIndexClass = "z-[110]",
}: FilePreviewModalProps) {
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
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

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (kind !== "image" || zoom <= MIN_ZOOM) return;
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPan({ x: drag.originX + (event.clientX - drag.startX), y: drag.originY + (event.clientY - drag.startY) });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
      className={`fixed inset-0 flex flex-col bg-slate-950/80 backdrop-blur-sm ${zIndexClass}`}
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
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2.5 text-white sm:px-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="min-w-0 flex-1 basis-40">
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

        <div className="flex w-full flex-wrap items-center justify-end gap-1 sm:w-auto">
          {canNavigate && (
            <>
              <button
                type="button"
                onClick={() => go(-1)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
                title="上一个（←）"
                aria-label="上一个文件"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => go(1)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
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
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
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
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
                title="放大（+）"
                aria-label="放大图片"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={resetView}
                disabled={!zoomed && pan.x === 0 && pan.y === 0}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
                title="适应窗口（0）"
                aria-label="适应窗口"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </>
          )}
          {headerActions}
          {item.url && (
            <a
              href={item.url}
              download={item.name}
              onClick={(event) => event.stopPropagation()}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-3 text-sm font-semibold text-slate-800 transition hover:bg-slate-100"
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
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
              title="在新窗口打开"
              aria-label="在新窗口打开"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white"
            title="关闭（Esc）"
            aria-label="关闭预览"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
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
              className="max-h-full max-w-full select-none object-contain transition-transform duration-75"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            />
            {imageState === "loading" && (
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
    </div>
  );
}
