"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";

const LINE_WARNING = /^第 (\d+) 行(.+)$/;
const COLLAPSED_GROUPS = 2;

function lineRanges(lines: number[]) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const start = sorted[index];
    let end = start;
    while (sorted[index + 1] === end + 1) end = sorted[++index];
    parts.push(end - start >= 2 ? `${start}–${end}` : end > start ? `${start}、${end}` : String(start));
  }
  return parts.join("、");
}

/**
 * "第 N 行尚未录入对客报价" for every line drowned the profit panel. Line
 * warnings with the same text are merged into one entry listing the lines, and
 * the list stays collapsed to a summary until it is opened.
 */
export function groupProfitWarnings(warnings: string[]) {
  const groups: Array<{ text: string; lines: number[] }> = [];
  const byText = new Map<string, { text: string; lines: number[] }>();
  for (const warning of warnings) {
    const match = warning.match(LINE_WARNING);
    if (!match) {
      groups.push({ text: warning, lines: [] });
      continue;
    }
    const text = match[2].trim();
    let group = byText.get(text);
    if (!group) {
      group = { text, lines: [] };
      byText.set(text, group);
      groups.push(group);
    }
    group.lines.push(Number(match[1]));
  }
  return groups.map((group) =>
    group.lines.length === 0 ? group.text : `${group.text}：第 ${lineRanges(group.lines)} 行（共 ${new Set(group.lines).size} 行）`,
  );
}

export function ProfitWarnings({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false);
  const grouped = useMemo(() => groupProfitWarnings(warnings), [warnings]);
  if (grouped.length === 0) return null;
  const shown = open ? grouped : grouped.slice(0, COLLAPSED_GROUPS);
  const collapsible = grouped.length > COLLAPSED_GROUPS || grouped.some((text) => text.length > 80);
  return (
    <div className="text-xs" data-profit-warnings>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={!collapsible}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left font-semibold text-amber-800 disabled:cursor-default"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">待补提示 {warnings.length} 条</span>
        {collapsible && (
          <span className="inline-flex items-center gap-0.5 font-medium text-slate-500">
            {open ? "收起" : "展开全部"}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </span>
        )}
      </button>
      <ul className="mt-1.5 space-y-1 pl-5">
        {shown.map((text) => (
          <li key={text} className={`list-disc text-amber-700 ${open ? "" : "truncate"}`}>
            {text}
          </li>
        ))}
        {!open && grouped.length > COLLAPSED_GROUPS && (
          <li className="list-none text-slate-400">还有 {grouped.length - COLLAPSED_GROUPS} 类提示…</li>
        )}
      </ul>
    </div>
  );
}
