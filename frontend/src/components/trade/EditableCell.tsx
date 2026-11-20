"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { parseAmountText, sanitizeTypedNumber } from "@/lib/tradeNumbers";

type CellType = "text" | "number" | "select" | "date";

// A table cell that turns into an input when clicked: Enter or leaving the
// cell saves, Esc cancels. Numbers refuse anything that is not a number.
export function EditableCell({
  value,
  display,
  type = "text",
  options = [],
  label,
  align,
  disabled,
  onSave,
}: {
  value: string;
  display?: ReactNode;
  type?: CellType;
  options?: string[];
  label: string;
  align?: "right";
  disabled?: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    input?.focus();
    if (input instanceof HTMLInputElement) input.select();
  }, [editing]);

  const shown = display ?? (value || "-");
  if (disabled) {
    return <span className={align === "right" ? "block text-right" : undefined}>{shown}</span>;
  }

  const commit = async (next: string) => {
    setEditing(false);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    let clean = next.trim();
    if (type === "number") {
      const parsed = parseAmountText(clean);
      if (parsed === null) return;
      clean = parsed || "0";
      if (Number(clean) === Number(value || 0)) return;
    } else if (clean === value.trim()) {
      return;
    }
    setSaving(true);
    try {
      await onSave(clean);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          // A select closed with Esc never reaches commit, so the flag would
          // otherwise swallow the next change.
          cancelledRef.current = false;
          setDraft(value);
          setEditing(true);
        }}
        disabled={saving}
        title={`点击修改${label}`}
        aria-label={`修改${label}`}
        className={`group/cell -mx-1.5 flex min-h-8 w-[calc(100%+0.75rem)] items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-sky-50 hover:ring-1 hover:ring-sky-200 ${align === "right" ? "justify-end text-right" : ""}`}
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" /> : shown}
      </button>
    );
  }

  const keyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      (event.currentTarget as HTMLElement).blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelledRef.current = true;
      (event.currentTarget as HTMLElement).blur();
    }
  };

  if (type === "select") {
    const choices = options.includes(value) || !value ? options : [value, ...options];
    return (
      <select
        ref={(element) => {
          inputRef.current = element;
        }}
        value={draft}
        aria-label={label}
        onChange={(event) => {
          setDraft(event.target.value);
          void commit(event.target.value);
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={keyDown}
        className="h-8 w-full rounded-md border border-sky-300 bg-white px-1.5 text-xs outline-none ring-2 ring-sky-100"
      >
        {choices.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      ref={(element) => {
        inputRef.current = element;
      }}
      type={type === "date" ? "date" : "text"}
      value={draft}
      inputMode={type === "number" ? "decimal" : undefined}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        if (type !== "number") {
          setDraft(event.target.value);
          return;
        }
        const clean = sanitizeTypedNumber(event.target.value);
        if (clean === null) {
          setInvalid(true);
          window.setTimeout(() => setInvalid(false), 900);
          return;
        }
        setDraft(clean);
      }}
      onPaste={(event) => {
        if (type !== "number") return;
        event.preventDefault();
        const parsed = parseAmountText(event.clipboardData.getData("text"));
        if (parsed === null) {
          setInvalid(true);
          window.setTimeout(() => setInvalid(false), 900);
        } else {
          setDraft(parsed);
        }
      }}
      onBlur={(event) => void commit(event.currentTarget.value)}
      onKeyDown={keyDown}
      className={`h-8 w-full min-w-16 rounded-md border bg-white px-1.5 text-sm outline-none ring-2 ${invalid ? "border-rose-400 ring-rose-100" : "border-sky-300 ring-sky-100"} ${align === "right" ? "text-right tabular-nums" : ""}`}
    />
  );
}
