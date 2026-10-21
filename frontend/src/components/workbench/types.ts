import type { LucideIcon } from "lucide-react";

export type BrowserItemKind = "folder" | "workbook";

export type BadgeTone = "amber" | "slate" | "emerald" | "sky" | "rose" | "violet";

export interface BrowserBadge {
  label: string;
  tone: BadgeTone;
  icon?: LucideIcon;
}

/**
 * A folder or workbook as rendered by the workbench file views. The page maps
 * API resources into this shape so the icon view and the list view share the
 * same selection, keyboard, drag-and-drop and context-menu behaviour.
 */
export interface BrowserItem {
  key: string;
  kind: BrowserItemKind;
  id: number;
  name: string;
  description?: string;
  ownerName?: string;
  typeLabel: string;
  createdAt?: string;
  updatedAt?: string;
  badges: BrowserBadge[];
  pinned: boolean;
  /** Workbook that the current user may move (drag source). */
  canDrag: boolean;
  /** Whether a dragged workbook may be moved into another folder. */
  canMove?: boolean;
  /** Folder that accepts dropped workbooks. */
  canDrop: boolean;
  /** Workbook imported from an Excel file (has a downloadable source). */
  excelSource?: boolean;
  /** Folder shared to the current user by someone else. */
  shared?: boolean;
  locked?: boolean;
  hidden?: boolean;
  isPublic?: boolean;
  busy?: boolean;
  dimmed?: boolean;
  groupLabel?: string;
}

export interface WorkbenchAction {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
  separatorBefore?: boolean;
}

export interface MenuPoint {
  x: number;
  y: number;
}

export const BADGE_TONE_CLASS: Record<BadgeTone, string> = {
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  slate: "border-slate-200 bg-slate-100 text-slate-600",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
  sky: "border-sky-200 bg-sky-50 text-sky-700",
  rose: "border-rose-200 bg-rose-50 text-rose-700",
  violet: "border-violet-200 bg-violet-50 text-violet-700",
};

export function formatShortDate(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }
  return date.toLocaleDateString("zh-CN");
}

export function formatDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
