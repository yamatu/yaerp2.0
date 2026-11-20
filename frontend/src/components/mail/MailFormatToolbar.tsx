"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ChevronDown,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListOrdered,
  Redo2,
  RemoveFormatting,
  SeparatorHorizontal,
  Strikethrough,
  Underline,
  Undo2,
} from "lucide-react";

export const MAIL_FONTS = [
  { label: "微软雅黑", value: "'Microsoft YaHei', 微软雅黑, sans-serif" },
  { label: "宋体", value: "SimSun, 宋体, serif" },
  { label: "黑体", value: "SimHei, 黑体, sans-serif" },
  { label: "楷体", value: "KaiTi, 楷体, serif" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Verdana", value: "Verdana, Geneva, sans-serif" },
  { label: "Courier New", value: "'Courier New', Courier, monospace" },
];

export const MAIL_FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];

const PALETTE = [
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff",
  "#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff",
  "#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc",
  "#cc4125", "#e06666", "#f6b26b", "#ffd966", "#93c47d", "#76a5af", "#6d9eeb", "#6fa8dc", "#8e7cc3", "#c27ba0",
  "#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3c78d8", "#3d85c6", "#674ea7", "#a64d79",
];

/** Commands whose on/off state is shown on the toolbar. */
const STATE_COMMANDS = [
  "bold",
  "italic",
  "underline",
  "strikeThrough",
  "insertOrderedList",
  "insertUnorderedList",
  "justifyLeft",
  "justifyCenter",
  "justifyRight",
] as const;

type ActiveState = Partial<Record<(typeof STATE_COMMANDS)[number], boolean>>;

export interface MailFormatActions {
  /** Runs a document.execCommand inside the editor at the saved caret. */
  exec: (command: string, value?: string) => void;
  /** Sets an exact pixel font size on the selection. */
  fontSize: (px: number) => void;
  /** Whether the caret is inside the editor (toolbar state is only read then). */
  hasFocus: () => boolean;
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      // Keep the selection in the editor.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${active ? "bg-sky-100 text-sky-700" : "text-slate-600 hover:bg-slate-100"}`}
    >
      {children}
    </button>
  );
}

function ColorButton({
  label,
  icon,
  current,
  onPick,
}: {
  label: string;
  icon: ReactNode;
  current: string;
  onPick: (color: string) => void;
}) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(null);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const pick = (color: string) => {
    onPick(color);
    setOpen(null);
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={Boolean(open)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setOpen((value) => (value ? null : rect));
        }}
        className="inline-flex h-8 items-center gap-0.5 rounded-md px-1.5 text-slate-600 hover:bg-slate-100"
      >
        <span className="relative inline-flex flex-col items-center">
          {icon}
          <span className="mt-0.5 h-1 w-4 rounded-sm" style={{ backgroundColor: current }} />
        </span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open &&
        // In a portal: the toolbar scrolls sideways on phones and would clip it.
        createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={label}
          className="fixed z-[150] w-[236px] rounded-lg border border-slate-200 bg-white p-2 shadow-xl"
          style={{ left: Math.max(8, Math.min(open.left, window.innerWidth - 244)), top: open.bottom + 4 }}
        >
          <div className="grid grid-cols-10 gap-1">
            {PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                title={color}
                aria-label={`${label} ${color}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(color)}
                className="h-[18px] w-[18px] rounded-sm border border-slate-200 hover:scale-110"
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
          <label className="mt-2 flex cursor-pointer items-center justify-between gap-2 rounded-md px-1 py-1 text-xs text-slate-600 hover:bg-slate-50">
            自定义颜色
            <input
              type="color"
              defaultValue={current}
              onChange={(event) => pick(event.target.value)}
              className="h-6 w-10 cursor-pointer border-0 bg-transparent p-0"
            />
          </label>
        </div>,
        document.body,
      )}
    </div>
  );
}

const divider = <span className="mx-1 h-5 w-px shrink-0 bg-slate-200" aria-hidden />;

/** Formatting bar above the mail body, modelled on Aliyun Mail's editor. */
export default function MailFormatToolbar({ actions }: { actions: MailFormatActions }) {
  const [active, setActive] = useState<ActiveState>({});
  const [textColor, setTextColor] = useState("#ff0000");
  const [backColor, setBackColor] = useState("#ffff00");

  useEffect(() => {
    const read = () => {
      if (!actions.hasFocus()) return;
      const next: ActiveState = {};
      for (const command of STATE_COMMANDS) {
        try {
          next[command] = document.queryCommandState(command);
        } catch {
          next[command] = false;
        }
      }
      setActive(next);
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [actions]);

  const toggle = (command: (typeof STATE_COMMANDS)[number]) => {
    actions.exec(command);
    setActive((current) => ({ ...current, [command]: document.queryCommandState(command) }));
  };

  return (
    <div
      role="toolbar"
      aria-label="正文格式"
      className="flex items-center gap-0.5 overflow-x-auto border-b border-slate-200 bg-slate-50 px-1.5 py-1 [scrollbar-width:none]"
    >
      <ToolButton label="撤销（Ctrl+Z）" onClick={() => actions.exec("undo")}>
        <Undo2 className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="重做（Ctrl+Y）" onClick={() => actions.exec("redo")}>
        <Redo2 className="h-4 w-4" />
      </ToolButton>
      {divider}
      <select
        aria-label="字体"
        title="字体"
        value=""
        onChange={(event) => {
          if (event.target.value) actions.exec("fontName", event.target.value);
        }}
        className="h-8 w-[92px] shrink-0 rounded-md border border-slate-200 bg-white px-1 text-xs text-slate-600 outline-none"
      >
        <option value="">字体</option>
        {MAIL_FONTS.map((font) => (
          <option key={font.label} value={font.value}>
            {font.label}
          </option>
        ))}
      </select>
      <select
        aria-label="字号"
        title="字号"
        value=""
        onChange={(event) => {
          if (event.target.value) actions.fontSize(Number(event.target.value));
        }}
        className="ml-1 h-8 w-[64px] shrink-0 rounded-md border border-slate-200 bg-white px-1 text-xs text-slate-600 outline-none"
      >
        <option value="">字号</option>
        {MAIL_FONT_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}px
          </option>
        ))}
      </select>
      {divider}
      <ToolButton label="加粗（Ctrl+B）" active={active.bold} onClick={() => toggle("bold")}>
        <Bold className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="斜体（Ctrl+I）" active={active.italic} onClick={() => toggle("italic")}>
        <Italic className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="下划线（Ctrl+U）" active={active.underline} onClick={() => toggle("underline")}>
        <Underline className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="删除线" active={active.strikeThrough} onClick={() => toggle("strikeThrough")}>
        <Strikethrough className="h-4 w-4" />
      </ToolButton>
      <ColorButton
        label="文字颜色"
        icon={<Baseline className="h-4 w-4" />}
        current={textColor}
        onPick={(color) => {
          setTextColor(color);
          actions.exec("foreColor", color);
        }}
      />
      <ColorButton
        label="背景颜色"
        icon={<Highlighter className="h-4 w-4" />}
        current={backColor}
        onPick={(color) => {
          setBackColor(color);
          actions.exec("hiliteColor", color);
        }}
      />
      {divider}
      <ToolButton label="左对齐" active={active.justifyLeft} onClick={() => toggle("justifyLeft")}>
        <AlignLeft className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="居中" active={active.justifyCenter} onClick={() => toggle("justifyCenter")}>
        <AlignCenter className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="右对齐" active={active.justifyRight} onClick={() => toggle("justifyRight")}>
        <AlignRight className="h-4 w-4" />
      </ToolButton>
      {divider}
      <ToolButton label="编号列表" active={active.insertOrderedList} onClick={() => toggle("insertOrderedList")}>
        <ListOrdered className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="项目符号列表" active={active.insertUnorderedList} onClick={() => toggle("insertUnorderedList")}>
        <List className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="减少缩进" onClick={() => actions.exec("outdent")}>
        <IndentDecrease className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="增加缩进" onClick={() => actions.exec("indent")}>
        <IndentIncrease className="h-4 w-4" />
      </ToolButton>
      {divider}
      <ToolButton
        label="插入链接"
        onClick={() => {
          const url = window.prompt("链接地址", "https://")?.trim();
          if (!url || url === "https://") return;
          // Only web and mail links; anything else is treated as a host name.
          actions.exec("createLink", /^(https?:\/\/|mailto:)/i.test(url) ? url : `https://${url.replace(/^[a-z][a-z0-9+.-]*:\/*/i, "")}`);
        }}
      >
        <Link className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="分割线" onClick={() => actions.exec("insertHorizontalRule")}>
        <SeparatorHorizontal className="h-4 w-4" />
      </ToolButton>
      <ToolButton label="清除格式" onClick={() => actions.exec("removeFormat")}>
        <RemoveFormatting className="h-4 w-4" />
      </ToolButton>
    </div>
  );
}
