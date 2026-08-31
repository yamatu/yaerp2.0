"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, PackageSearch, Search } from "lucide-react";
import type { TradeOrderItem } from "@/types";

interface OrderItemComboboxProps {
  items: TradeOrderItem[];
  value: number;
  onChange: (itemID: number) => void;
}

export function OrderItemCombobox({
  items,
  value,
  onChange,
}: OrderItemComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = items.find((item) => item.id === value);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return items;
    return items.filter((item) =>
      [item.sku, item.product_name, item.specification, String(item.line_no)].some(
        (field) => field?.toLocaleLowerCase().includes(keyword),
      ),
    );
  }, [items, query]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
        className="flex h-10 w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-left text-sm hover:border-slate-300"
      >
        <PackageSearch className="h-4 w-4 shrink-0 text-slate-400" />
        <span className="min-w-0 flex-1 truncate">
          {selected
            ? `${selected.line_no}. ${selected.sku || selected.product_name} · ${selected.product_name}`
            : "搜索并选择产品"}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-[150] mt-1 w-full min-w-80 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
          <label className="flex h-10 items-center gap-2 border-b border-slate-200 px-3 text-slate-400">
            <Search className="h-4 w-4" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="SKU、产品、规格或行号"
              className="min-w-0 flex-1 text-sm text-slate-800 outline-none"
            />
          </label>
          <div className="max-h-60 overflow-y-auto py-1">
            {filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {item.line_no}. {item.sku || item.product_name}
                  </span>
                  <span className="block truncate text-xs text-slate-400">
                    {[item.product_name, item.specification]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {item.id === value && (
                  <Check className="h-4 w-4 text-emerald-600" />
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-slate-400">
                没有匹配的产品
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
