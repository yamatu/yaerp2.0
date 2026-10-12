"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ResponsiveDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Prevent closing while a request is running. */
  busy?: boolean;
  /** Remove body padding (lists that manage their own spacing). */
  flush?: boolean;
}

const SIZE_CLASS = {
  sm: "md:max-w-sm",
  md: "md:max-w-md",
  lg: "md:max-w-2xl",
};

let openDialogCount = 0;

/**
 * Bottom sheet on phones, centered modal from `md` up. Rendered in a portal so
 * it always covers the sticky header and the mobile tab bar.
 */
export function ResponsiveDialog({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  size = "md",
  busy = false,
  flush = false,
}: ResponsiveDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [mounted, setMounted] = useState(false);

  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    openDialogCount += 1;
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKey);
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      if (panel.contains(document.activeElement)) return;
      const autofocus = panel.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
      (autofocus || panel).focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleKey);
      openDialogCount = Math.max(0, openDialogCount - 1);
      if (openDialogCount === 0) document.body.style.overflow = "";
      if (previousFocus && document.contains(previousFocus))
        previousFocus.focus?.({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) setDragOffset(0);
  }, [open]);

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[85] flex items-end justify-center md:items-center md:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="absolute inset-0 bg-slate-950/40 backdrop-blur-[2px]"
        onClick={() => {
          if (!busy) onClose();
        }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        style={dragOffset ? { transform: `translateY(${dragOffset}px)` } : undefined}
        className={`relative flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl outline-none md:max-h-[85vh] md:rounded-lg md:border md:border-slate-200 md:pb-0 ${SIZE_CLASS[size]}`}
      >
        <div
          className="flex touch-none justify-center pb-1 pt-2 md:hidden"
          onPointerDown={(event) => {
            dragStartRef.current = event.clientY;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragStartRef.current === null) return;
            setDragOffset(Math.max(0, event.clientY - dragStartRef.current));
          }}
          onPointerUp={() => {
            const shouldClose = dragOffset > 80 && !busy;
            dragStartRef.current = null;
            setDragOffset(0);
            if (shouldClose) onClose();
          }}
          onPointerCancel={() => {
            dragStartRef.current = null;
            setDragOffset(0);
          }}
        >
          <span className="h-1 w-10 rounded-full bg-slate-300" />
        </div>
        <div className="flex items-start gap-3 border-b border-slate-200 px-4 pb-3 pt-1 md:pt-3">
          {icon && (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
              {icon}
            </div>
          )}
          <div className="min-w-0 flex-1 py-0.5">
            <h2 id={titleId} className="truncate text-base font-semibold text-slate-900">
              {title}
            </h2>
            {description && (
              <div className="mt-0.5 text-xs leading-5 text-slate-500">{description}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="-mr-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40 md:h-9 md:w-9"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${flush ? "" : "px-4 py-4"}`}>
          {children}
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/60 px-4 py-3 [&>*]:max-md:h-11 [&>*]:max-md:flex-1">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export const dialogPrimaryButton =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50";
export const dialogSecondaryButton =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
export const dialogDangerButton =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50";
export const dialogInput =
  "h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-base text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100 md:h-10 md:text-sm";
