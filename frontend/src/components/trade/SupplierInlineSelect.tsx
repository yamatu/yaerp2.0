"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";
import api from "@/lib/api";
import type { TradeSupplier } from "@/types";

interface SupplierInlineSelectProps {
  suppliers: TradeSupplier[];
  value: number;
  /** A supplier typed by name that does not exist yet; created on save. */
  pendingName?: string;
  onChange: (supplierID: number, supplier?: TradeSupplier) => void;
  onUseName: (name: string) => void;
}

const MAX_RESULTS = 60;
const DROPDOWN_HEIGHT = 240;

function matches(supplier: TradeSupplier, keyword: string) {
  return [supplier.supplier_code, supplier.name, supplier.company_name, supplier.contact_name, supplier.phone].some(
    (field) => field?.toLocaleLowerCase().includes(keyword),
  );
}

/**
 * Type-ahead supplier input for table rows: type a name, pick a suggestion
 * with the mouse or the arrow keys + Enter, or keep the typed name as a new
 * supplier. The list is positioned `fixed` so the table's scroll container
 * never clips it.
 */
export function SupplierInlineSelect({ suppliers, value, pendingName = "", onChange, onUseName }: SupplierInlineSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [remote, setRemote] = useState<TradeSupplier[] | null>(null);
  const [selectedCache, setSelectedCache] = useState<TradeSupplier | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null);

  const selected = suppliers.find((supplier) => supplier.id === value) || (selectedCache?.id === value ? selectedCache : undefined);
  const display = selected?.name || (value ? "" : pendingName);

  // Leaving the field keeps what was typed: an exact match is picked,
  // anything else becomes a new supplier name.
  const commitRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !listRef.current?.contains(target)) commitRef.current();
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const above = window.innerHeight - rect.bottom < DROPDOWN_HEIGHT + 12 && rect.top > DROPDOWN_HEIGHT + 12;
      setPosition({ left: rect.left, top: above ? rect.top - 2 : rect.bottom + 2, width: Math.max(rect.width, 260), above });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    const keyword = query.trim();
    if (!open || !keyword) {
      setRemote(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await api.get<TradeSupplier[]>(`/trade/suppliers?search=${encodeURIComponent(keyword)}`);
        if (!cancelled && response.code === 0) setRemote(response.data || []);
      } catch {
        if (!cancelled) setRemote(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const keyword = query.trim().toLocaleLowerCase();
  const results = useMemo(() => {
    if (!keyword) return suppliers.slice(0, MAX_RESULTS);
    const seen = new Set<number>();
    const merged: TradeSupplier[] = [];
    for (const supplier of [...suppliers.filter((item) => matches(item, keyword)), ...(remote || [])]) {
      if (seen.has(supplier.id)) continue;
      seen.add(supplier.id);
      merged.push(supplier);
    }
    // Names starting with what was typed come first.
    merged.sort((a, b) => Number(!a.name.toLocaleLowerCase().startsWith(keyword)) - Number(!b.name.toLocaleLowerCase().startsWith(keyword)));
    return merged.slice(0, MAX_RESULTS);
  }, [keyword, remote, suppliers]);
  const exact = results.some(
    (supplier) => supplier.name.trim().toLocaleLowerCase() === keyword || supplier.company_name?.trim().toLocaleLowerCase() === keyword,
  );
  const canUseName = Boolean(keyword) && !exact;
  const optionCount = results.length + (canUseName ? 1 : 0);

  useEffect(() => setActive(0), [keyword, remote]);

  const pick = (supplier: TradeSupplier) => {
    setSelectedCache(supplier);
    onChange(supplier.id, supplier);
    setOpen(false);
    setQuery("");
  };
  const useName = () => {
    onUseName(query.trim());
    setOpen(false);
    setQuery("");
  };
  const choose = (index: number) => {
    if (index < results.length) pick(results[index]);
    else if (canUseName) useName();
  };
  commitRef.current = () => {
    const typed = query.trim();
    if (!typed || typed === display) {
      setOpen(false);
      setQuery("");
      return;
    }
    const match = results.find(
      (supplier) => supplier.name.trim().toLocaleLowerCase() === keyword || supplier.company_name?.trim().toLocaleLowerCase() === keyword,
    );
    if (match) pick(match);
    else useName();
  };

  return (
    <div ref={rootRef} className="relative w-full">
      <div className={`flex h-8 items-center rounded-md border bg-white focus-within:border-sky-400 ${!value && pendingName ? "border-amber-300" : "border-slate-200"}`}>
        <input
          ref={inputRef}
          value={open ? query : display}
          placeholder="输入供应商名称"
          className="min-w-0 flex-1 bg-transparent px-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
          onFocus={() => {
            setQuery(display);
            setOpen(true);
            requestAnimationFrame(() => inputRef.current?.select());
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" && optionCount) {
              event.preventDefault();
              setActive((current) => (current + 1) % optionCount);
            } else if (event.key === "ArrowUp" && optionCount) {
              event.preventDefault();
              setActive((current) => (current - 1 + optionCount) % optionCount);
            } else if (event.key === "Enter" && open && optionCount) {
              event.preventDefault();
              choose(active);
            } else if (event.key === "Escape") {
              setOpen(false);
              setQuery("");
            } else if (event.key === "Tab" && open) {
              commitRef.current();
            }
          }}
        />
        {!value && pendingName && !open && (
          <span className="mr-1 shrink-0 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-700" title="保存时自动新增该供应商">
            新
          </span>
        )}
        {loading && <Loader2 className="mr-1.5 h-3 w-3 shrink-0 animate-spin text-slate-400" />}
        {(value > 0 || pendingName) && !open && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onChange(0)}
            className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700"
            title="清除供应商"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {open && position && (
        <div
          ref={listRef}
          className="fixed z-[200] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl"
          style={{
            left: position.left,
            width: position.width,
            ...(position.above ? { bottom: window.innerHeight - position.top } : { top: position.top }),
          }}
        >
          <div className="overflow-y-auto py-1" style={{ maxHeight: DROPDOWN_HEIGHT }}>
            {results.length === 0 && !canUseName && (
              <div className="px-3 py-4 text-center text-xs text-slate-400">{keyword ? "没有匹配的供应商" : "输入名称搜索供应商"}</div>
            )}
            {results.map((supplier, index) => (
              <button
                key={supplier.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(supplier)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${index === active ? "bg-sky-50" : ""}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-800">{supplier.name}</span>
                  {(supplier.company_name && supplier.company_name !== supplier.name) || supplier.supplier_code ? (
                    <span className="block truncate text-[11px] text-slate-400">
                      {[supplier.supplier_code, supplier.company_name !== supplier.name ? supplier.company_name : ""].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </span>
                {value === supplier.id && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
              </button>
            ))}
            {canUseName && (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(results.length)}
                onClick={useName}
                className={`flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm text-amber-700 ${active === results.length ? "bg-amber-50" : ""}`}
              >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  新供应商「{query.trim()}」<span className="text-xs text-amber-600/80">保存时自动新增</span>
                </span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
