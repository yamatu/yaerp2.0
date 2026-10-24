"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowRightLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Layers,
  List,
  Lock,
  MessageCircle,
  Palette,
  PencilLine,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import type { Sheet } from "@/types";

export type SheetStateAction =
  "lock" | "unlock" | "archive" | "unarchive" | "hide" | "unhide";

const TAB_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#0ea5e9",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#64748b",
];

const TAB_DRAG_MIME = "application/x-yaerp-sheet-tab";

interface Props {
  /** Every sheet the user receives, in workbook order (admins also get hidden ones). */
  sheets: Sheet[];
  activeSheetId: number | null;
  tabColors: Record<string, string>;
  canManage: boolean;
  isAdmin: boolean;
  busy: boolean;
  importState: { active: boolean; uploading: boolean; progress: number };
  dropHandlers: {
    onDragEnter: React.DragEventHandler<HTMLDivElement>;
    onDragOver: React.DragEventHandler<HTMLDivElement>;
    onDragLeave: React.DragEventHandler<HTMLDivElement>;
    onDrop: React.DragEventHandler<HTMLDivElement>;
  };
  onOpen: (sheet: Sheet) => void;
  onInsert: (after: Sheet | null) => void;
  onRename: (sheet: Sheet, name: string) => Promise<boolean>;
  onDelete: (sheets: Sheet[]) => void;
  /** beforeId: undefined places the copy right after the source, null at the end. */
  onDuplicate: (sheet: Sheet, beforeId?: number | null) => void;
  onReorder: (orderedIds: number[]) => void;
  onColor: (sheets: Sheet[], color: string) => void;
  onState: (sheets: Sheet[], action: SheetStateAction) => void;
  onShare: (sheet: Sheet) => void;
  /** Opens the AI summary generator on this sheet. */
  onAnalyze?: (sheet: Sheet) => void;
}

interface MenuState {
  targetIds: number[];
  x: number;
  y: number;
  view: "main" | "color" | "unhide";
}

function sheetLabel(sheet: Sheet, index: number) {
  return sheet.name?.trim() || `工作表 ${index + 1}`;
}

function inputWidth(value: string) {
  let width = 2;
  for (const char of value) width += char.charCodeAt(0) > 255 ? 2 : 1;
  return `${Math.min(Math.max(width, 6), 40)}ch`;
}

/**
 * Spreadsheet-style sheet tabs along the bottom of the workbook, with a
 * WPS/Excel-like right-click menu, inline rename and drag reordering.
 */
export default function SheetTabBar(props: Props) {
  const {
    sheets,
    activeSheetId,
    tabColors,
    canManage,
    isAdmin,
    busy,
    importState,
  } = props;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pointerTypeRef = useRef("mouse");
  const renameDoneRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameStartedAtRef = useRef(0);
  const renameSelectPendingRef = useRef(false);
  const userPointerAtRef = useRef(0);
  const [selection, setSelection] = useState<number[]>([]);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [moveSource, setMoveSource] = useState<Sheet | null>(null);
  const [moveBeforeId, setMoveBeforeId] = useState<number | null>(null);
  const [moveCopy, setMoveCopy] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [listQuery, setListQuery] = useState("");
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropMark, setDropMark] = useState<{ id: number; side: "before" | "after" } | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const tabs = useMemo(
    () => sheets.filter((sheet) => !sheet.is_hidden || sheet.id === activeSheetId),
    [activeSheetId, sheets],
  );
  const hiddenSheets = useMemo(
    () => sheets.filter((sheet) => sheet.is_hidden && sheet.id !== activeSheetId),
    [activeSheetId, sheets],
  );
  const indexOf = useCallback(
    (id: number) => sheets.findIndex((sheet) => sheet.id === id),
    [sheets],
  );

  useEffect(() => {
    setSelection((current) => {
      const next = current.filter((id) => tabs.some((tab) => tab.id === id));
      return next.length === current.length ? current : next;
    });
  }, [tabs]);

  const updateOverflow = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setOverflow({
      left: scroller.scrollLeft > 1,
      right: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [tabs.length, updateOverflow]);

  useEffect(() => {
    if (activeSheetId === null) return;
    const tab = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-sheet-tab="${activeSheetId}"]`,
    );
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateOverflow();
  }, [activeSheetId, tabs.length, updateOverflow]);

  useEffect(() => {
    if (!menu && !listOpen) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu && !menuRef.current?.contains(target)) setMenu(null);
      if (listOpen && !listRef.current?.contains(target)) setListOpen(false);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenu(null);
      setListOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside, true);
    window.addEventListener("keydown", closeOnKey);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside, true);
      window.removeEventListener("keydown", closeOnKey);
    };
  }, [listOpen, menu]);

  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;
  // Ctrl + PageUp / PageDown switch sheets, as in Excel and WPS.
  useEffect(() => {
    const switchSheet = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || renamingId !== null) return;
      if (event.key !== "PageUp" && event.key !== "PageDown") return;
      const current = tabs.findIndex((tab) => tab.id === activeSheetId);
      const next = tabs[current + (event.key === "PageUp" ? -1 : 1)];
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenRef.current(next);
    };
    window.addEventListener("keydown", switchSheet, true);
    return () => window.removeEventListener("keydown", switchSheet, true);
  }, [activeSheetId, renamingId, tabs]);

  const startRename = (sheet: Sheet) => {
    if (!canManage) return;
    setMenu(null);
    renameDoneRef.current = false;
    renameStartedAtRef.current = Date.now();
    renameSelectPendingRef.current = true;
    setRenamingId(sheet.id);
    setRenameValue(sheet.name || "");
  };

  // Renaming ends on Enter, Escape or a click elsewhere, not on blur: opening
  // the tab mounts its editor, which takes focus right after the double-click.
  useEffect(() => {
    if (renamingId === null) return;
    const commitOnOutsidePress = (event: PointerEvent) => {
      userPointerAtRef.current = Date.now();
      if (renameInputRef.current?.contains(event.target as Node)) return;
      const sheet = sheets.find((item) => item.id === renamingId);
      if (sheet) void finishRename(sheet, true);
    };
    document.addEventListener("pointerdown", commitOnOutsidePress, true);
    return () => document.removeEventListener("pointerdown", commitOnOutsidePress, true);
  });

  const finishRename = async (sheet: Sheet, commit: boolean) => {
    if (renameDoneRef.current) return;
    const name = renameValue.trim();
    if (!commit || !name || name === sheet.name) {
      renameDoneRef.current = true;
      setRenamingId(null);
      return;
    }
    renameDoneRef.current = true;
    const saved = await props.onRename(sheet, name);
    if (saved) setRenamingId(null);
    else renameDoneRef.current = false;
  };

  const openMenuAt = (sheet: Sheet, x: number, y: number) => {
    const grouped = selection.length > 1 && selection.includes(sheet.id);
    if (!grouped && selection.length > 0) setSelection([]);
    setListOpen(false);
    setMenu({ targetIds: grouped ? selection : [sheet.id], x, y, view: "main" });
  };

  const handleTabClick = (event: React.MouseEvent, sheet: Sheet) => {
    if (renamingId === sheet.id) return;
    if (event.ctrlKey || event.metaKey) {
      setSelection((current) => {
        const base = current.length ? current : activeSheetId !== null ? [activeSheetId] : [];
        return base.includes(sheet.id)
          ? base.filter((id) => id !== sheet.id)
          : [...base, sheet.id];
      });
      return;
    }
    if (event.shiftKey && activeSheetId !== null) {
      const from = tabs.findIndex((tab) => tab.id === activeSheetId);
      const to = tabs.findIndex((tab) => tab.id === sheet.id);
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelection(tabs.slice(start, end + 1).map((tab) => tab.id));
      return;
    }
    if (selection.length) setSelection([]);
    if (sheet.id !== activeSheetId) {
      props.onOpen(sheet);
    } else if (pointerTypeRef.current !== "mouse") {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(sheet, rect.left, rect.top);
    }
  };

  const reorderTo = (movingIds: number[], beforeId: number | null) => {
    const rest = tabs.map((tab) => tab.id).filter((id) => !movingIds.includes(id));
    const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
    rest.splice(at < 0 ? rest.length : at, 0, ...movingIds);
    const current = tabs.map((tab) => tab.id);
    if (rest.every((id, index) => id === current[index])) return;
    props.onReorder(rest);
  };

  const handleDrop = (event: React.DragEvent, target: Sheet) => {
    if (dragId === null) return;
    event.preventDefault();
    const side = dropMark?.id === target.id ? dropMark.side : "before";
    if (dragId !== target.id) {
      const targetIndex = tabs.findIndex((tab) => tab.id === target.id);
      const beforeTab = side === "before" ? target : tabs[targetIndex + 1];
      reorderTo([dragId], beforeTab ? beforeTab.id : null);
    }
    setDragId(null);
    setDropMark(null);
  };

  const scrollTabs = (direction: -1 | 1) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollBy({ left: direction * Math.max(160, scroller.clientWidth * 0.6), behavior: "smooth" });
  };

  const menuTargets = menu
    ? sheets.filter((sheet) => menu.targetIds.includes(sheet.id))
    : [];
  const single = menuTargets.length === 1 ? menuTargets[0] : null;
  const runMenu = (action: () => void) => {
    setMenu(null);
    action();
  };

  const menuItem = (
    key: string,
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    options: { danger?: boolean; disabled?: boolean; hint?: string; submenu?: boolean } = {},
  ) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      disabled={options.disabled || busy}
      title={options.hint}
      onClick={onClick}
      className={`flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-40 ${options.danger ? "text-rose-600 hover:bg-rose-50" : "text-slate-700 hover:bg-slate-100"}`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-slate-400">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {options.submenu && <ChevronRight className="h-3.5 w-3.5 text-slate-400" />}
    </button>
  );
  const divider = (key: string) => <div key={key} className="my-1 h-px bg-slate-100" />;

  const renderMainMenu = () => {
    const items: React.ReactNode[] = [];
    if (single) {
      if (canManage) {
        items.push(
          menuItem("insert", <Plus className="h-4 w-4" />, "插入工作表", () => runMenu(() => props.onInsert(single))),
          menuItem("delete", <Trash2 className="h-4 w-4" />, "删除工作表", () => runMenu(() => props.onDelete([single])), {
            danger: true,
            disabled: sheets.length <= 1,
            hint: sheets.length <= 1 ? "工作簿至少保留一个工作表" : undefined,
          }),
          menuItem("copy", <Copy className="h-4 w-4" />, "创建副本", () => runMenu(() => props.onDuplicate(single))),
          menuItem("move", <ArrowRightLeft className="h-4 w-4" />, "移动或复制…", () =>
            runMenu(() => {
              const next = tabs[tabs.findIndex((tab) => tab.id === single.id) + 1];
              setMoveSource(single);
              setMoveBeforeId(next ? next.id : null);
              setMoveCopy(false);
            }),
          ),
        );
      }
      if (isAdmin) {
        items.push(divider("d-hide"));
        items.push(
          single.is_hidden
            ? menuItem("unhide-self", <Eye className="h-4 w-4" />, "取消隐藏", () => runMenu(() => props.onState([single], "unhide")))
            : menuItem("hide", <EyeOff className="h-4 w-4" />, "隐藏工作表", () => runMenu(() => props.onState([single], "hide")), {
                disabled: tabs.length <= 1,
                hint: tabs.length <= 1 ? "至少保留一个可见的工作表" : undefined,
              }),
        );
        if (hiddenSheets.length > 0) {
          items.push(
            menuItem("unhide", <Eye className="h-4 w-4" />, `取消隐藏（${hiddenSheets.length}）`, () =>
              setMenu((current) => current && { ...current, view: "unhide" }), { submenu: true }),
          );
        }
      }
      if (canManage) {
        items.push(divider("d-name"));
        items.push(
          menuItem("rename", <PencilLine className="h-4 w-4" />, "重命名", () => startRename(single)),
          menuItem("color", <Palette className="h-4 w-4" />, "工作表标签颜色", () =>
            setMenu((current) => current && { ...current, view: "color" }), { submenu: true }),
        );
      }
      if (isAdmin) {
        items.push(
          menuItem(
            "lock",
            single.is_locked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />,
            single.is_locked ? "取消保护工作表" : "保护工作表",
            () => runMenu(() => props.onState([single], single.is_locked ? "unlock" : "lock")),
            { hint: "保护后仅管理员可以修改" },
          ),
          menuItem(
            "archive",
            single.is_archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />,
            single.is_archived ? "取消归档" : "归档工作表",
            () => runMenu(() => props.onState([single], single.is_archived ? "unarchive" : "archive")),
          ),
        );
      }
      items.push(divider("d-share"));
      if (props.onAnalyze) {
        const analyze = props.onAnalyze;
        items.push(menuItem("analyze", <Sparkles className="h-4 w-4" />, "AI 分析此工作表", () => runMenu(() => analyze(single))));
      }
      items.push(
        menuItem("share", <MessageCircle className="h-4 w-4" />, "分享工作表（WhatsApp）", () => runMenu(() => props.onShare(single))),
      );
      if (tabs.length > 1) {
        items.push(
          menuItem("select-all", <Layers className="h-4 w-4" />, "选定全部工作表", () =>
            runMenu(() => setSelection(tabs.map((tab) => tab.id)))),
        );
      }
      return items;
    }

    items.push(
      <div key="group" className="border-b border-slate-100 px-3 pb-2 pt-1.5">
        <div className="text-xs font-semibold text-slate-800">已选定 {menuTargets.length} 个工作表</div>
        <div className="mt-0.5 truncate text-[11px] text-slate-400">
          {menuTargets.map((sheet) => sheet.name).join("、")}
        </div>
      </div>,
    );
    if (canManage) {
      const deletesAll = menuTargets.length >= sheets.length;
      items.push(
        menuItem("delete", <Trash2 className="h-4 w-4" />, `删除 ${menuTargets.length} 个工作表`, () => runMenu(() => props.onDelete(menuTargets)), {
          danger: true,
          disabled: deletesAll,
          hint: deletesAll ? "工作簿至少保留一个工作表" : undefined,
        }),
        menuItem("color", <Palette className="h-4 w-4" />, "工作表标签颜色", () =>
          setMenu((current) => current && { ...current, view: "color" }), { submenu: true }),
      );
    }
    if (isAdmin) {
      const hidesAll = menuTargets.length >= tabs.length;
      items.push(
        divider("d-state"),
        menuItem("hide", <EyeOff className="h-4 w-4" />, "隐藏工作表", () => runMenu(() => props.onState(menuTargets, "hide")), {
          disabled: hidesAll,
          hint: hidesAll ? "至少保留一个可见的工作表" : undefined,
        }),
        menuItem("lock", <Lock className="h-4 w-4" />, "保护工作表", () => runMenu(() => props.onState(menuTargets, "lock"))),
        menuItem("unlock", <Unlock className="h-4 w-4" />, "取消保护工作表", () => runMenu(() => props.onState(menuTargets, "unlock"))),
        menuItem("archive", <Archive className="h-4 w-4" />, "归档工作表", () => runMenu(() => props.onState(menuTargets, "archive"))),
        menuItem("unarchive", <ArchiveRestore className="h-4 w-4" />, "取消归档", () => runMenu(() => props.onState(menuTargets, "unarchive"))),
      );
    }
    items.push(
      divider("d-ungroup"),
      menuItem("ungroup", <X className="h-4 w-4" />, "取消组合工作表", () => runMenu(() => setSelection([]))),
    );
    return items;
  };

  const backHeader = (title: string) => (
    <button
      type="button"
      onClick={() => setMenu((current) => current && { ...current, view: "main" })}
      className="flex h-9 w-full items-center gap-1.5 border-b border-slate-100 px-2 text-left text-xs font-semibold text-slate-600 hover:bg-slate-50"
    >
      <ChevronLeft className="h-4 w-4" />
      {title}
    </button>
  );

  const renderColorMenu = () => {
    const current = single ? tabColors[String(single.id)] : undefined;
    return (
      <>
        {backHeader("工作表标签颜色")}
        <div className="grid grid-cols-5 gap-2 p-3">
          {TAB_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              disabled={busy}
              onClick={() => runMenu(() => props.onColor(menuTargets, color))}
              className={`h-7 w-7 rounded-md border-2 transition hover:scale-110 ${current === color ? "border-slate-900" : "border-white shadow-[0_0_0_1px_rgba(15,23,42,0.12)]"}`}
              style={{ background: color }}
              aria-label={`标签颜色 ${color}`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-slate-100 px-3 py-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => runMenu(() => props.onColor(menuTargets, ""))}
            className="h-8 flex-1 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50"
          >
            无颜色
          </button>
          <label className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-50">
            其他颜色
            <input
              type="color"
              className="sr-only"
              defaultValue={current || "#0ea5e9"}
              onChange={(event) => {
                const color = event.target.value;
                runMenu(() => props.onColor(menuTargets, color));
              }}
            />
          </label>
        </div>
      </>
    );
  };

  const renderUnhideMenu = () => (
    <>
      {backHeader("取消隐藏")}
      <div className="max-h-64 overflow-y-auto py-1">
        {hiddenSheets.map((sheet) =>
          menuItem(`unhide-${sheet.id}`, <EyeOff className="h-4 w-4" />, sheetLabel(sheet, indexOf(sheet.id)), () =>
            runMenu(() => props.onState([sheet], "unhide"))),
        )}
      </div>
    </>
  );

  const filteredList = useMemo(() => {
    const needle = listQuery.trim().toLocaleLowerCase();
    return needle
      ? sheets.filter((sheet) => sheet.name.toLocaleLowerCase().includes(needle))
      : sheets;
  }, [listQuery, sheets]);

  const navButton = "flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 transition hover:bg-slate-200 hover:text-slate-900 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div
      className="relative flex shrink-0 items-stretch border-t border-slate-200 bg-slate-100 pb-[env(safe-area-inset-bottom)] text-[13px]"
      data-sheet-tab-bar
      {...props.dropHandlers}
    >
      <div className="flex shrink-0 items-center gap-0.5 border-r border-slate-200 px-1">
        <div ref={listRef} className="relative">
          <button
            type="button"
            className={navButton}
            onClick={() => {
              setMenu(null);
              setListQuery("");
              setListOpen((open) => !open);
            }}
            title="全部工作表"
            aria-label="全部工作表"
            aria-expanded={listOpen}
          >
            <List className="h-4 w-4" />
          </button>
          {listOpen && (
            <div className="absolute bottom-full left-0 z-[95] mb-2 flex max-h-[min(60vh,26rem)] w-64 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
              {sheets.length > 8 && (
                <label className="relative block border-b border-slate-100 p-2">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    value={listQuery}
                    onChange={(event) => setListQuery(event.target.value)}
                    placeholder="搜索工作表"
                    className="h-8 w-full rounded-md border border-slate-200 bg-slate-50 pl-7 pr-2 text-sm outline-none focus:border-sky-300 focus:bg-white"
                  />
                </label>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                {filteredList.map((sheet) => {
                  const active = sheet.id === activeSheetId;
                  const color = tabColors[String(sheet.id)];
                  return (
                    <button
                      key={sheet.id}
                      type="button"
                      onClick={() => {
                        setListOpen(false);
                        if (!active) props.onOpen(sheet);
                      }}
                      className={`flex h-9 w-full items-center gap-2 px-3 text-left text-sm ${active ? "bg-emerald-50 font-semibold text-emerald-700" : "text-slate-700 hover:bg-slate-50"}`}
                    >
                      <span className="h-3 w-1 shrink-0 rounded-full" style={{ background: color || "transparent" }} />
                      <span className="min-w-0 flex-1 truncate">{sheetLabel(sheet, indexOf(sheet.id))}</span>
                      {sheet.is_hidden && <EyeOff className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
                      {sheet.is_locked && <Lock className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
                    </button>
                  );
                })}
                {filteredList.length === 0 && (
                  <div className="px-3 py-6 text-center text-xs text-slate-400">没有匹配的工作表</div>
                )}
              </div>
            </div>
          )}
        </div>
        <button type="button" className={`${navButton} hidden sm:flex`} onClick={() => scrollTabs(-1)} disabled={!overflow.left} title="向左滚动" aria-label="向左滚动工作表标签">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button type="button" className={`${navButton} hidden sm:flex`} onClick={() => scrollTabs(1)} disabled={!overflow.right} title="向右滚动" aria-label="向右滚动工作表标签">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="工作表"
        onScroll={updateOverflow}
        className="flex min-w-0 items-stretch overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((sheet) => {
          const index = indexOf(sheet.id);
          const label = sheetLabel(sheet, index);
          const active = sheet.id === activeSheetId;
          const grouped = selection.length > 1 && selection.includes(sheet.id);
          const color = tabColors[String(sheet.id)];
          const renaming = renamingId === sheet.id;
          return (
            <div
              key={sheet.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              data-sheet-tab={sheet.id}
              draggable={canManage && !renaming && !busy}
              title={label}
              onPointerDown={(event) => {
                pointerTypeRef.current = event.pointerType;
              }}
              onClick={(event) => handleTabClick(event, sheet)}
              onDoubleClick={() => startRename(sheet)}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenuAt(sheet, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (event.key === "F2") startRename(sheet);
              }}
              onDragStart={(event) => {
                event.dataTransfer.setData(TAB_DRAG_MIME, String(sheet.id));
                event.dataTransfer.effectAllowed = "move";
                setDragId(sheet.id);
              }}
              onDragOver={(event) => {
                if (dragId === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const rect = event.currentTarget.getBoundingClientRect();
                const side = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
                if (dropMark?.id !== sheet.id || dropMark.side !== side) setDropMark({ id: sheet.id, side });
              }}
              onDrop={(event) => handleDrop(event, sheet)}
              onDragEnd={() => {
                setDragId(null);
                setDropMark(null);
              }}
              className={`group relative -mt-px flex h-9 max-w-[14rem] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r border-slate-200 px-3 transition-colors ${
                active
                  ? "z-10 border-t border-t-white bg-white font-semibold text-emerald-700"
                  : grouped
                    ? "bg-white/80 text-slate-800"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
              } ${dragId === sheet.id ? "opacity-40" : ""}`}
              style={color && !active ? { background: `${color}1f` } : undefined}
            >
              {color && <span className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px]" style={{ background: color }} />}
              {active && !color && <span className="pointer-events-none absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-emerald-600" />}
              {grouped && <span className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-sky-500" />}
              {dropMark?.id === sheet.id && dragId !== sheet.id && (
                <span className={`pointer-events-none absolute inset-y-1 w-0.5 rounded bg-emerald-600 ${dropMark.side === "before" ? "-left-px" : "-right-px"}`} />
              )}
              {sheet.is_hidden && <EyeOff className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-label="已隐藏" />}
              {sheet.is_locked && <Lock className="h-3 w-3 shrink-0 text-amber-500" aria-label="已保护" />}
              {sheet.is_archived && <Archive className="h-3 w-3 shrink-0 text-slate-400" aria-label="已归档" />}
              {renaming ? (
                <input
                  ref={renameInputRef}
                  value={renameValue}
                  autoFocus
                  onFocus={(event) => {
                    if (!renameSelectPendingRef.current) return;
                    renameSelectPendingRef.current = false;
                    event.currentTarget.select();
                  }}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") void finishRename(sheet, true);
                    if (event.key === "Escape") void finishRename(sheet, false);
                  }}
                  onBlur={() => {
                    if (renameDoneRef.current) return;
                    const userMovedAway = Date.now() - userPointerAtRef.current < 400;
                    const justStarted = Date.now() - renameStartedAtRef.current < 5000;
                    if (!userMovedAway && justStarted) {
                      window.setTimeout(() => renameInputRef.current?.focus(), 0);
                    }
                  }}
                  maxLength={100}
                  aria-label="工作表名称"
                  className="h-6 rounded border border-emerald-500 bg-white px-1 text-[13px] font-normal text-slate-900 outline-none ring-2 ring-emerald-100"
                  style={{ width: inputWidth(renameValue) }}
                />
              ) : (
                <span className="truncate">{label}</span>
              )}
              {active && !renaming && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openMenuAt(sheet, rect.left, rect.top);
                  }}
                  className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  title="工作表操作"
                  aria-label={`工作表「${label}」的操作`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {canManage && (
        <button
          type="button"
          onClick={() => props.onInsert(null)}
          disabled={busy}
          className="flex h-9 w-9 shrink-0 items-center justify-center text-slate-500 transition hover:bg-slate-200 hover:text-slate-900 disabled:opacity-40"
          title="新建工作表"
          aria-label="新建工作表"
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
      <div className="min-w-4 flex-1" />
      <div className="hidden shrink-0 items-center px-3 text-xs text-slate-400 lg:flex">
        {selection.length > 1 ? `已选定 ${selection.length} 个工作表` : `${tabs.length} 个工作表`}
      </div>

      {(importState.active || importState.uploading) && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center gap-3 border-2 border-dashed border-sky-300 bg-sky-50/95 text-xs font-semibold text-sky-800">
          <FileSpreadsheet className="h-4 w-4" />
          {importState.uploading ? `正在导入 Excel… ${importState.progress}%` : "松开鼠标，把 Excel 导入为新工作表"}
        </div>
      )}

      {menu && menuTargets.length > 0 && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[95] w-56 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-2xl"
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 232)),
            bottom: Math.max(8, window.innerHeight - menu.y + 4),
            maxHeight: Math.max(160, menu.y - 12),
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {menu.view === "color" ? renderColorMenu() : menu.view === "unhide" ? renderUnhideMenu() : renderMainMenu()}
        </div>
      )}

      {moveSource && (
        <div
          className="fixed inset-0 z-[96] flex items-center justify-center bg-slate-950/40 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMoveSource(null);
          }}
        >
          <div className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl" role="dialog" aria-label="移动或复制工作表">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-900">移动或复制工作表</div>
              <button type="button" onClick={() => setMoveSource(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="关闭">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-2 px-4 py-3">
              <div className="text-xs text-slate-500">
                将「<span className="font-semibold text-slate-700">{moveSource.name}</span>」放到下列工作表之前：
              </div>
              <div className="max-h-60 overflow-y-auto rounded-lg border border-slate-200">
                {[...tabs.filter((tab) => tab.id !== moveSource.id), null].map((tab) => {
                  const id = tab ? tab.id : null;
                  const checked = moveBeforeId === id;
                  return (
                    <button
                      key={id ?? "end"}
                      type="button"
                      onClick={() => setMoveBeforeId(id)}
                      className={`flex h-9 w-full items-center px-3 text-left text-sm ${checked ? "bg-emerald-50 font-semibold text-emerald-700" : "text-slate-700 hover:bg-slate-50"}`}
                    >
                      {tab ? sheetLabel(tab, indexOf(tab.id)) : "（移至最后）"}
                    </button>
                  );
                })}
              </div>
              <label className="flex items-center gap-2 pt-1 text-sm text-slate-700">
                <input type="checkbox" checked={moveCopy} onChange={(event) => setMoveCopy(event.target.checked)} className="h-4 w-4 accent-emerald-600" />
                建立副本
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
              <button type="button" onClick={() => setMoveSource(null)} className="h-9 rounded-lg border border-slate-200 px-4 text-sm text-slate-600 hover:bg-slate-50">
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  const source = moveSource;
                  setMoveSource(null);
                  if (moveCopy) props.onDuplicate(source, moveBeforeId);
                  else reorderTo([source.id], moveBeforeId);
                }}
                className="h-9 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
