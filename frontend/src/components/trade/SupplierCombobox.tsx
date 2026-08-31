"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import api from "@/lib/api";
import type { TradeSupplier } from "@/types";

interface SupplierComboboxProps {
  suppliers: TradeSupplier[];
  value: number;
  onChange: (supplierID: number, supplier: TradeSupplier) => void;
}

export function SupplierCombobox({
  suppliers,
  value,
  onChange,
}: SupplierComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [remoteSuppliers, setRemoteSuppliers] = useState<
    TradeSupplier[] | null
  >(null);
  const [selectedCache, setSelectedCache] = useState<TradeSupplier | null>(
    null,
  );
  const selected =
    suppliers.find((supplier) => supplier.id === value) ||
    (selectedCache?.id === value ? selectedCache : undefined);

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

  useEffect(() => {
    const supplier = suppliers.find((item) => item.id === value);
    if (supplier) setSelectedCache(supplier);
    else if (!value) setSelectedCache(null);
  }, [suppliers, value]);

  useEffect(() => {
    const keyword = query.trim();
    if (!open || !keyword) {
      setRemoteSuppliers(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await api.get<TradeSupplier[]>(
          `/trade/suppliers?search=${encodeURIComponent(keyword)}`,
        );
        if (!cancelled && response.code === 0)
          setRemoteSuppliers(response.data || []);
      } catch {
        if (!cancelled) setRemoteSuppliers([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    const source = remoteSuppliers || suppliers;
    if (!keyword) return source.slice(0, 100);
    return source
      .filter((supplier) =>
        [
          supplier.supplier_code,
          supplier.name,
          supplier.company_name,
          supplier.contact_name,
          supplier.phone,
          supplier.whatsapp,
          supplier.country,
        ].some((field) => field?.toLocaleLowerCase().includes(keyword)),
      )
      .slice(0, 100);
  }, [query, remoteSuppliers, suppliers]);

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
        className="flex h-10 w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-left text-sm outline-none hover:border-slate-300"
        aria-expanded={open}
      >
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <span
          className={`min-w-0 flex-1 truncate ${selected ? "text-slate-800" : "text-slate-400"}`}
        >
          {selected
            ? `${selected.name} · ${selected.company_name || selected.supplier_code}`
            : "搜索并选择供应商"}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute z-[130] mt-1 w-full min-w-72 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
          <label className="flex h-10 items-center gap-2 border-b border-slate-200 px-3 text-slate-400">
            <Search className="h-4 w-4 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              placeholder="名称、公司、编号、联系人或电话"
              className="min-w-0 flex-1 text-sm text-slate-800 outline-none"
            />
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <span className="text-[11px] text-slate-400">
                {filtered.length}
              </span>
            )}
          </label>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-slate-400">
                没有匹配的供应商
              </div>
            ) : (
              filtered.map((supplier) => (
                <button
                  key={supplier.id}
                  type="button"
                  onClick={() => {
                    setSelectedCache(supplier);
                    onChange(supplier.id, supplier);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {supplier.name}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {[
                        supplier.supplier_code,
                        supplier.company_name,
                        supplier.contact_name || supplier.phone,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  {value === supplier.id && (
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
