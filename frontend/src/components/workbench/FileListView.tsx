"use client";

import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Download,
  Minus,
  MoreHorizontal,
  Star,
  Users,
} from "lucide-react";
import { Fragment } from "react";
import { ItemIcon } from "./ItemIcon";
import {
  BADGE_TONE_CLASS,
  formatDateTime,
  formatShortDate,
  type BrowserItem,
} from "./types";
import type { useBrowserInteractions } from "./useBrowserInteractions";

type Interactions = ReturnType<typeof useBrowserInteractions>;
export type WorkbenchSortKey = "updated_at" | "created_at" | "name" | "type";

interface FileListViewProps {
  items: BrowserItem[];
  interactions: Interactions;
  selectMode: boolean;
  coarsePointer: boolean;
  dropTargetKey: string | null;
  draggingKeys: ReadonlySet<string>;
  dragActive: boolean;
  selectedKeys: string[];
  onSelectionChange: (keys: string[]) => void;
  grouped: boolean;
  sortBy: WorkbenchSortKey;
  sortOrder: "asc" | "desc";
  onSort: (key: WorkbenchSortKey) => void;
  onOpen: (item: BrowserItem) => void;
  onDownload: (item: BrowserItem) => void;
  downloadingId: number | null;
}

const ROW_GRID =
  "md:grid md:grid-cols-[32px_minmax(0,1fr)_112px_132px] lg:grid-cols-[32px_minmax(0,1fr)_minmax(150px,240px)_150px_132px] xl:grid-cols-[32px_minmax(0,1fr)_minmax(160px,260px)_150px_110px_132px]";

/** "列表" view: compact table on desktop, tappable rows on phones. */
export function FileListView({
  items,
  interactions,
  selectMode,
  coarsePointer,
  dropTargetKey,
  draggingKeys,
  dragActive,
  selectedKeys,
  onSelectionChange,
  grouped,
  sortBy,
  sortOrder,
  onSort,
  onOpen,
  onDownload,
  downloadingId,
}: FileListViewProps) {
  const { selectedSet, getItemProps, getMoreButtonProps, getCheckboxProps, containerProps } =
    interactions;
  const allSelected = items.length > 0 && items.every((item) => selectedSet.has(item.key));
  const someSelected = !allSelected && items.some((item) => selectedSet.has(item.key));
  const showMobileChecks = selectMode;

  const sortHeader = (label: string, sortKey: WorkbenchSortKey, className = "") => (
    <button
      key={sortKey}
      type="button"
      onClick={() => onSort(sortKey)}
      className={`inline-flex items-center gap-1 text-left transition hover:text-slate-900 ${sortBy === sortKey ? "text-slate-800" : ""} ${className}`}
    >
      {label}
      {sortBy === sortKey &&
        (sortOrder === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
    </button>
  );

  let previousGroup: string | undefined;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div
        className={`hidden h-9 items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-500 ${ROW_GRID}`}
      >
        <button
          type="button"
          role="checkbox"
          aria-checked={allSelected ? true : someSelected ? "mixed" : false}
          aria-label="全选"
          onClick={() => onSelectionChange(allSelected ? [] : items.map((item) => item.key))}
          className="flex h-8 w-8 items-center justify-center"
        >
          <span
            className={`flex h-4 w-4 items-center justify-center rounded border ${
              allSelected || someSelected
                ? "border-sky-600 bg-sky-600 text-white"
                : "border-slate-300 bg-white"
            }`}
          >
            {allSelected && <Check className="h-3 w-3" strokeWidth={3} />}
            {someSelected && <Minus className="h-3 w-3" strokeWidth={3} />}
          </span>
        </button>
        {sortHeader("名称", "name")}
        <div className="hidden lg:block">所有者 / 状态</div>
        {sortHeader("修改时间", "updated_at")}
        {sortHeader("创建时间", "created_at", "hidden xl:inline-flex")}
        <div className="text-right">操作</div>
      </div>

      <div {...containerProps} aria-label="工作簿与文件夹列表" className="divide-y divide-slate-100 outline-none">
        {items.map((item, index) => {
          const selected = selectedSet.has(item.key);
          const dropActive = dropTargetKey === item.key;
          const dragging = draggingKeys.has(item.key);
          const groupHeader =
            grouped && item.kind === "workbook" && item.groupLabel !== previousGroup
              ? item.groupLabel
              : undefined;
          if (item.kind === "workbook") previousGroup = item.groupLabel;
          const workbookCount = groupHeader
            ? items.filter((entry) => entry.kind === "workbook" && entry.groupLabel === groupHeader).length
            : 0;
          return (
            <Fragment key={item.key}>
              {groupHeader && (
                <div className="flex h-9 items-center gap-2 bg-slate-50/80 px-3 text-xs font-semibold text-slate-600">
                  <Users className="h-3.5 w-3.5 text-sky-600" />
                  {groupHeader}
                  <span className="rounded-full bg-white px-1.5 py-px text-[11px] font-medium text-slate-400 ring-1 ring-slate-200">
                    {workbookCount}
                  </span>
                </div>
              )}
              <div
                {...getItemProps(item, index)}
                className={`group relative flex min-h-[60px] cursor-default select-none items-center gap-3 px-3 py-2 outline-none transition [-webkit-touch-callout:none] focus-visible:bg-sky-50/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-300 md:min-h-12 ${ROW_GRID} ${
                  dropActive
                    ? "bg-sky-100 ring-2 ring-inset ring-sky-300"
                    : selected
                      ? "bg-sky-50"
                      : dragActive && item.kind === "folder" && item.canDrop
                        ? "bg-sky-50/40"
                        : item.dimmed
                          ? "bg-slate-50/70 text-slate-500 hover:bg-slate-100"
                          : "hover:bg-slate-50 active:bg-slate-100"
                } ${dragging || item.busy ? "opacity-50" : ""}`}
              >
                <button
                  {...getCheckboxProps(item)}
                  className={`${showMobileChecks ? "flex" : "hidden"} h-10 w-8 shrink-0 items-center justify-center md:flex md:h-8`}
                >
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-md border transition md:h-4 md:w-4 md:rounded ${
                      selected
                        ? "border-sky-600 bg-sky-600 text-white"
                        : "border-slate-300 bg-white text-transparent group-hover:border-slate-400"
                    }`}
                  >
                    <Check className="h-3.5 w-3.5 md:h-3 md:w-3" strokeWidth={3} />
                  </span>
                </button>

                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="relative">
                    <ItemIcon item={item} size={coarsePointer ? "md" : "sm"} />
                    {item.pinned && (
                      <Star className="absolute -right-1 -top-1 h-3.5 w-3.5 fill-amber-400 text-amber-400" aria-label="已收藏" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={(event) => {
                        if (event.ctrlKey || event.metaKey || event.shiftKey || selectMode) return;
                        // Touch taps bubble to the row, which already opens the
                        // item and knows how to ignore the click after a long-press.
                        const pointerType = (event.nativeEvent as PointerEvent).pointerType;
                        if (pointerType && pointerType !== "mouse") return;
                        event.stopPropagation();
                        onOpen(item);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                      className="block max-w-full truncate text-left text-[15px] font-medium text-slate-900 hover:text-sky-700 hover:underline md:text-sm"
                      title={item.name}
                    >
                      {item.name}
                    </button>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-slate-500">
                      <span className="md:hidden">{formatShortDate(item.updatedAt) || item.typeLabel}</span>
                      <span className="md:hidden">·</span>
                      <span className="truncate">
                        {item.kind === "folder"
                          ? item.shared
                            ? `共享者：${item.ownerName || "他人"}`
                            : item.canDrop
                              ? "文件夹"
                              : `只读 · ${item.ownerName || ""}`
                          : item.description || item.typeLabel}
                      </span>
                      {item.badges.length > 0 && (
                        <span className="flex shrink-0 gap-1 lg:hidden">
                          {item.badges.map((badge) => {
                            const Icon = badge.icon;
                            return Icon ? (
                              <Icon key={badge.label} className="h-3 w-3 text-slate-400" aria-label={badge.label} />
                            ) : null;
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="hidden min-w-0 flex-wrap items-center gap-1 lg:flex">
                  {item.ownerName && (
                    <span className="max-w-[120px] truncate text-xs text-slate-600">{item.ownerName}</span>
                  )}
                  {item.badges.map((badge) => {
                    const Icon = badge.icon;
                    return (
                      <span
                        key={badge.label}
                        className={`inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium ${BADGE_TONE_CLASS[badge.tone]}`}
                      >
                        {Icon && <Icon className="h-3 w-3" />}
                        {badge.label}
                      </span>
                    );
                  })}
                </div>
                <div className="hidden text-xs tabular-nums text-slate-500 md:block">
                  {formatDateTime(item.updatedAt)}
                </div>
                <div className="hidden text-xs tabular-nums text-slate-500 xl:block">
                  {item.createdAt ? new Date(item.createdAt).toLocaleDateString("zh-CN") : "-"}
                </div>

                <div className="flex shrink-0 items-center justify-end gap-1">
                  {item.kind === "workbook" && (
                    <button
                      type="button"
                      tabIndex={-1}
                      onPointerDown={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDownload(item);
                      }}
                      disabled={downloadingId !== null}
                      className="hidden h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-40 md:inline-flex"
                      title={item.excelSource ? "下载原始 Excel" : "导出 Excel"}
                      aria-label={`${item.excelSource ? "下载原始 Excel" : "导出 Excel"} ${item.name}`}
                    >
                      <Download className={`h-4 w-4 ${downloadingId === item.id ? "animate-pulse" : ""}`} />
                    </button>
                  )}
                  <button
                    type="button"
                    tabIndex={-1}
                    onPointerDown={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(item);
                    }}
                    className="hidden h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-sky-700 transition hover:bg-sky-50 md:inline-flex"
                  >
                    打开
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    {...getMoreButtonProps(item)}
                    className={`inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-800 md:h-8 md:w-8 ${
                      selectMode && coarsePointer ? "invisible" : ""
                    }`}
                  >
                    <MoreHorizontal className="h-5 w-5 md:h-4 md:w-4" />
                  </button>
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
