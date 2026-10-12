"use client";

import { Check, EyeOff, Globe2, Lock, MoreHorizontal, Star } from "lucide-react";
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ItemIcon } from "./ItemIcon";
import { formatShortDate, type BrowserItem } from "./types";
import type { useBrowserInteractions } from "./useBrowserInteractions";

type Interactions = ReturnType<typeof useBrowserInteractions>;

interface FileIconViewProps {
  items: BrowserItem[];
  interactions: Interactions;
  selectMode: boolean;
  coarsePointer: boolean;
  dropTargetKey: string | null;
  draggingKeys: ReadonlySet<string>;
  dragActive: boolean;
  selectedKeys: string[];
  onSelectionChange: (keys: string[]) => void;
}

interface Band {
  originX: number;
  originY: number;
  x: number;
  y: number;
  base: string[];
}

/**
 * "桌面" icon view: Explorer-style icons with multi-select (Ctrl/Shift click,
 * rubber band), keyboard navigation, context menu, long-press and drag-to-folder.
 */
export function FileIconView({
  items,
  interactions,
  selectMode,
  coarsePointer,
  dropTargetKey,
  draggingKeys,
  dragActive,
  selectedKeys,
  onSelectionChange,
}: FileIconViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [band, setBand] = useState<Band | null>(null);
  const bandMovedRef = useRef(false);
  const { selectedSet, getItemProps, getMoreButtonProps, getCheckboxProps, containerProps } =
    interactions;

  const updateBand = (next: Band) => {
    setBand(next);
    const left = Math.min(next.originX, next.x);
    const right = Math.max(next.originX, next.x);
    const top = Math.min(next.originY, next.y);
    const bottom = Math.max(next.originY, next.y);
    const hits: string[] = [];
    interactions.elementsRef.current.forEach((element, key) => {
      const rect = element.getBoundingClientRect();
      if (rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom)
        hits.push(key);
    });
    onSelectionChange(Array.from(new Set([...next.base, ...hits])));
  };

  const handleBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("[data-item-key]")) return;
    event.preventDefault();
    containerRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    bandMovedRef.current = false;
    setBand({
      originX: event.clientX,
      originY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      base: event.ctrlKey || event.metaKey || event.shiftKey ? selectedKeys : [],
    });
  };

  const handleBackgroundPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!band) return;
    if (
      !bandMovedRef.current &&
      Math.abs(event.clientX - band.originX) < 4 &&
      Math.abs(event.clientY - band.originY) < 4
    )
      return;
    bandMovedRef.current = true;
    updateBand({ ...band, x: event.clientX, y: event.clientY });
  };

  const finishBand = () => {
    if (!band) return;
    if (!bandMovedRef.current && band.base.length === 0) onSelectionChange([]);
    setBand(null);
  };

  const containerRect = containerRef.current?.getBoundingClientRect();
  const showChecks = selectMode || selectedKeys.length > 1;

  return (
    <div
      ref={containerRef}
      {...containerProps}
      aria-label="工作簿与文件夹"
      tabIndex={-1}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handleBackgroundPointerMove}
      onPointerUp={finishBand}
      onPointerCancel={finishBand}
      className="relative grid min-h-[240px] select-none grid-cols-3 content-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50/70 p-2 outline-none sm:grid-cols-4 md:min-h-[320px] md:grid-cols-[repeat(auto-fill,minmax(116px,1fr))] md:gap-2 md:p-3"
    >
      {items.map((item, index) => {
        const selected = selectedSet.has(item.key);
        const dropActive = dropTargetKey === item.key;
        const dragging = draggingKeys.has(item.key);
        const itemProps = getItemProps(item, index);
        return (
          <div
            key={item.key}
            {...itemProps}
            className={`group relative flex min-h-[124px] cursor-default flex-col items-center rounded-lg border px-1.5 pb-2 pt-3 text-center outline-none transition [-webkit-touch-callout:none] focus-visible:ring-2 focus-visible:ring-sky-400 md:min-h-[132px] ${
              dropActive
                ? "border-sky-400 bg-sky-100 ring-2 ring-sky-300"
                : selected
                  ? "border-sky-300 bg-sky-50 shadow-sm"
                  : dragActive && item.kind === "folder" && item.canDrop
                    ? "border-dashed border-sky-300 bg-white"
                    : "border-transparent hover:border-slate-200 hover:bg-white active:bg-white"
            } ${dragging || item.busy ? "opacity-50" : ""} ${item.dimmed ? "opacity-70" : ""}`}
          >
            <span className="relative">
              <ItemIcon item={item} size="lg" />
              <span className="absolute -bottom-1 -right-2 flex gap-0.5">
                {item.locked && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-white ring-2 ring-white" title="已锁定">
                    <Lock className="h-2.5 w-2.5" />
                  </span>
                )}
                {item.hidden && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-500 text-white ring-2 ring-white" title="不可见">
                    <EyeOff className="h-2.5 w-2.5" />
                  </span>
                )}
                {item.isPublic && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-white ring-2 ring-white" title="公共">
                    <Globe2 className="h-2.5 w-2.5" />
                  </span>
                )}
              </span>
              {item.pinned && (
                <Star className="absolute -left-2 -top-1 h-4 w-4 fill-amber-400 text-amber-400 drop-shadow" aria-label="已收藏" />
              )}
            </span>
            <span
              className="mt-2.5 line-clamp-2 w-full break-all text-xs font-medium leading-[18px] text-slate-800"
              title={item.name}
            >
              {item.name}
            </span>
            <span className="mt-0.5 w-full truncate text-[11px] leading-4 text-slate-400">
              {item.kind === "folder"
                ? item.shared
                  ? `共享 · ${item.ownerName || "他人"}`
                  : item.canDrop
                    ? "文件夹"
                    : "只读文件夹"
                : formatShortDate(item.updatedAt) || item.typeLabel}
            </span>

            <button
              {...getCheckboxProps(item)}
              className={`absolute left-0.5 top-0.5 flex h-10 w-10 items-start justify-start p-1.5 transition ${
                showChecks || selected
                  ? "opacity-100"
                  : coarsePointer
                    ? "pointer-events-none opacity-0"
                    : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-md border transition ${
                  selected
                    ? "border-sky-600 bg-sky-600 text-white"
                    : "border-slate-300 bg-white/95 text-transparent hover:border-sky-400"
                }`}
              >
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
              </span>
            </button>
            <button
              {...getMoreButtonProps(item)}
              className={`absolute right-0.5 top-0.5 flex h-10 w-10 items-start justify-end p-1.5 transition ${
                coarsePointer
                  ? selectMode
                    ? "pointer-events-none opacity-0"
                    : "opacity-100"
                  : selected
                    ? "opacity-100"
                    : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              }`}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white/95 text-slate-500 shadow-sm ring-1 ring-slate-200 hover:text-slate-900">
                <MoreHorizontal className="h-4 w-4" />
              </span>
            </button>
          </div>
        );
      })}

      {band && bandMovedRef.current && containerRect && (
        <div
          className="pointer-events-none absolute z-10 rounded-sm border border-sky-400 bg-sky-400/15"
          style={{
            left: Math.min(band.originX, band.x) - containerRect.left,
            top: Math.min(band.originY, band.y) - containerRect.top,
            width: Math.abs(band.x - band.originX),
            height: Math.abs(band.y - band.originY),
          }}
        />
      )}
    </div>
  );
}
