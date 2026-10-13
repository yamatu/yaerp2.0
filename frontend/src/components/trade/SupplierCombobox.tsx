"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Search, X } from "lucide-react";
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

// ── Inline variant for table rows ────────────────────────────────────────────

interface SupplierInlineSelectProps {
  suppliers: TradeSupplier[];
  value: number;
  onChange: (supplierID: number, supplier?: TradeSupplier) => void;
  onCreateSupplier?: (name: string) => void;
}

export function SupplierInlineSelect({
  suppliers,
  value,
  onChange,
  onCreateSupplier,
}: SupplierInlineSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [remoteSuppliers, setRemoteSuppliers] = useState<TradeSupplier[] | null>(null);

  const selected = suppliers.find((s) => s.id === value);

  // Close on outside click
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  // Auto-focus input when dropdown opens
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Remote search with debounce
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
    if (!keyword) return source.slice(0, 80);
    return source
      .filter((s) =>
        [s.supplier_code, s.name, s.company_name, s.contact_name, s.phone]
          .some((f) => f?.toLocaleLowerCase().includes(keyword)),
      )
      .slice(0, 80);
  }, [query, remoteSuppliers, suppliers]);

  const pick = (supplier: TradeSupplier) => {
    onChange(supplier.id, supplier);
    setOpen(false);
    setQuery("");
  };

  const clear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(0);
    setQuery("");
  };

  // When the input is focused directly, switch to edit mode
  const handleInputFocus = () => {
    if (!open) {
      setQuery(selected?.name ?? "");
      setOpen(true);
    }
  };

  const showCreate = onCreateSupplier && query.trim() && filtered.length === 0 && !loading;

  return (
    <div ref={rootRef} className="relative w-full">
      {/* Trigger: shows selected name or a plain text input for quick search */}
      <div className="flex h-8 items-center rounded-md border border-slate-200 bg-white focus-within:border-sky-400">
        <input
          ref={inputRef}
          value={open ? query : (selected?.name ?? "")}
          placeholder="搜索供应商"
          className="min-w-0 flex-1 bg-transparent px-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
          onFocus={handleInputFocus}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setOpen(false); setQuery(""); }
            if (e.key === "Enter" && filtered.length === 1) { pick(filtered[0]); }
            if (e.key === "Enter" && showCreate && query.trim()) {
              onCreateSupplier!(query.trim());
              setOpen(false);
              setQuery("");
            }
          }}
        />
        {loading && <Loader2 className="mr-1.5 h-3 w-3 shrink-0 animate-spin text-slate-400" />}
        {selected && !open && (
          <button
            type="button"
            tabIndex={-1}
            onClick={clear}
            className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700"
            title="清除"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        {!selected && !open && (
          <ChevronDown className="mr-1.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
        )}
      </div>

      {open && (
        <div className="absolute left-0 top-full z-[130] mt-0.5 w-64 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && !showCreate && (
              <div className="px-3 py-5 text-center text-xs text-slate-400">
                {query.trim() ? "没有匹配的供应商" : "输入名称搜索"}
              </div>
            )}
            {filtered.map((supplier) => (
              <button
                key={supplier.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(supplier)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-800">
                    {supplier.name}
                  </span>
                  {(supplier.company_name || supplier.supplier_code) && (
                    <span className="block truncate text-[11px] text-slate-400">
                      {[supplier.supplier_code, supplier.company_name].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </span>
                {value === supplier.id && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                )}
              </button>
            ))}
            {showCreate && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onCreateSupplier!(query.trim());
                  setOpen(false);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-left text-sm font-medium text-sky-600 hover:bg-sky-50"
              >
                <span className="text-sky-500">+</span>
                新增「{query.trim()}」
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
