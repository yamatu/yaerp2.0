"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { MenuPoint, WorkbenchAction } from "./types";

export interface ActionMenuRequest {
  /** Viewport coordinates for the desktop popover. */
  point: MenuPoint;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions: WorkbenchAction[];
  /** Align the popover's right edge to point.x (for "⋯" buttons). */
  alignEnd?: boolean;
}

interface ActionMenuProps {
  request: ActionMenuRequest | null;
  onClose: () => void;
  /** Render as a bottom sheet (phones / touch). */
  asSheet: boolean;
}

/**
 * Context menu used by every workbench item: a compact popover next to the
 * pointer on desktop, a thumb-friendly action sheet on phones.
 */
export function ActionMenu({ request, onClose, asSheet }: ActionMenuProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !request) return null;
  return createPortal(
    asSheet ? (
      <ActionSheet request={request} onClose={onClose} />
    ) : (
      <ActionPopover request={request} onClose={onClose} />
    ),
    document.body,
  );
}

function runAction(action: WorkbenchAction, onClose: () => void) {
  if (action.disabled) return;
  onClose();
  // Let the menu unmount first so dialogs opened by the action get focus.
  window.setTimeout(() => action.onSelect(), 0);
}

function ActionPopover({
  request,
  onClose,
}: {
  request: ActionMenuRequest;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    let left = request.alignEnd ? request.point.x - rect.width : request.point.x;
    let top = request.point.y;
    if (left + rect.width > window.innerWidth - margin)
      left = window.innerWidth - rect.width - margin;
    if (top + rect.height > window.innerHeight - margin)
      top = Math.max(margin, request.point.y - rect.height);
    setPosition({ left: Math.max(margin, left), top: Math.max(margin, top) });
  }, [request]);

  const positioned = position !== null;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous && document.contains(previous) && document.activeElement === document.body)
        previous.focus?.({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    // The menu is hidden until it has been measured; focus only works after.
    if (!positioned) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      "button[data-menu-item]:not(:disabled)",
    );
    first?.focus({ preventScroll: true });
  }, [positioned]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKey, true);
    const handlePointer = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleClose = () => onClose();
    window.addEventListener("pointerdown", handlePointer, true);
    window.addEventListener("resize", handleClose);
    window.addEventListener("blur", handleClose);
    window.addEventListener("scroll", handleClose, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("pointerdown", handlePointer, true);
      window.removeEventListener("resize", handleClose);
      window.removeEventListener("blur", handleClose);
      window.removeEventListener("scroll", handleClose, true);
    };
  }, [onClose]);

  const moveFocus = (delta: number) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-menu-item]:not(:disabled)",
      ) || [],
    );
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + delta + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={request.title}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(-1);
        }
      }}
      style={{
        left: position?.left ?? request.point.x,
        top: position?.top ?? request.point.y,
        visibility: position ? "visible" : "hidden",
      }}
      className="fixed z-[86] w-60 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-xl"
    >
      <div className="truncate border-b border-slate-100 px-3 pb-1.5 pt-1 text-xs font-medium text-slate-400">
        {request.title}
      </div>
      <div className="max-h-[70vh] overflow-y-auto py-1">
        {request.actions.map((action) => {
          const Icon = action.icon;
          return (
            <div key={action.key}>
              {action.separatorBefore && <div className="my-1 h-px bg-slate-100" />}
              <button
                type="button"
                role="menuitem"
                data-menu-item
                disabled={action.disabled}
                onClick={() => runAction(action, onClose)}
                className={`flex h-9 w-full items-center gap-2.5 px-3 text-left outline-none transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  action.danger
                    ? "text-rose-600 hover:bg-rose-50 focus:bg-rose-50"
                    : "text-slate-700 hover:bg-slate-100 focus:bg-slate-100"
                }`}
              >
                <Icon className={`h-4 w-4 shrink-0 ${action.danger ? "" : "text-slate-400"}`} />
                <span className="min-w-0 flex-1 truncate">{action.label}</span>
                {action.shortcut && (
                  <kbd className="text-[11px] font-medium text-slate-400">{action.shortcut}</kbd>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionSheet({
  request,
  onClose,
}: {
  request: ActionMenuRequest;
  onClose: () => void;
}) {
  // A long-press opens the sheet while the finger is still down; ignore the
  // click that some browsers synthesize when that finger is lifted.
  const openedAtRef = useRef(Date.now());
  const closeFromBackdrop = () => {
    if (Date.now() - openedAtRef.current < 450) return;
    onClose();
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[86] flex items-end" role="presentation">
      <div
        className="absolute inset-0 bg-slate-950/40"
        onClick={closeFromBackdrop}
        onContextMenu={(event) => event.preventDefault()}
        aria-hidden="true"
      />
      <div
        role="menu"
        aria-label={request.title}
        className="relative max-h-[85dvh] w-full overflow-hidden rounded-t-2xl bg-white pb-[env(safe-area-inset-bottom)] shadow-2xl"
      >
        <div className="flex justify-center pb-1 pt-2">
          <span className="h-1 w-10 rounded-full bg-slate-300" />
        </div>
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 pb-3 pt-1">
          {request.icon && (
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-50">
              {request.icon}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold text-slate-900">
              {request.title}
            </div>
            {request.subtitle && (
              <div className="mt-0.5 truncate text-xs text-slate-500">{request.subtitle}</div>
            )}
          </div>
        </div>
        <div className="max-h-[60dvh] overflow-y-auto overscroll-contain py-1">
          {request.actions.map((action) => {
            const Icon = action.icon;
            return (
              <div key={action.key}>
                {action.separatorBefore && <div className="mx-4 my-1 h-px bg-slate-100" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={action.disabled}
                  onClick={() => {
                    if (Date.now() - openedAtRef.current < 450) return;
                    runAction(action, onClose);
                  }}
                  className={`flex h-12 w-full items-center gap-3.5 px-5 text-left text-[15px] transition active:bg-slate-100 disabled:opacity-40 ${
                    action.danger ? "text-rose-600" : "text-slate-800"
                  }`}
                >
                  <Icon className={`h-5 w-5 shrink-0 ${action.danger ? "" : "text-slate-500"}`} />
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="border-t border-slate-100 p-3">
          <button
            type="button"
            onClick={onClose}
            className="h-12 w-full rounded-lg bg-slate-100 text-[15px] font-semibold text-slate-700 active:bg-slate-200"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
