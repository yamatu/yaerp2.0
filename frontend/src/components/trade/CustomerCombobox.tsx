"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import api from "@/lib/api";
import type { TradeCustomer } from "@/types";

interface CustomerComboboxProps {
  customers: TradeCustomer[];
  value: number;
  onChange: (customerID: number, customer: TradeCustomer) => void;
}

export function CustomerCombobox({
  customers,
  value,
  onChange,
}: CustomerComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [remoteCustomers, setRemoteCustomers] = useState<
    TradeCustomer[] | null
  >(null);
  const [selectedCache, setSelectedCache] = useState<TradeCustomer | null>(
    null,
  );
  const selected =
    customers.find((customer) => customer.id === value) ||
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
    const customer = customers.find((item) => item.id === value);
    if (customer) setSelectedCache(customer);
    else if (!value) setSelectedCache(null);
  }, [customers, value]);

  useEffect(() => {
    const keyword = query.trim();
    if (!open || !keyword) {
      setRemoteCustomers(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await api.get<TradeCustomer[]>(
          `/trade/customers?search=${encodeURIComponent(keyword)}`,
        );
        if (!cancelled && response.code === 0)
          setRemoteCustomers(response.data || []);
      } catch {
        if (!cancelled) setRemoteCustomers([]);
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
    const source = remoteCustomers || customers;
    if (!keyword) return source.slice(0, 100);
    return source
      .filter((customer) =>
        [
          customer.customer_code,
          customer.name,
          customer.company_name,
          customer.contact_name,
          customer.phone,
          customer.email,
          customer.whatsapp_chat_name,
        ].some((field) => field?.toLocaleLowerCase().includes(keyword)),
      )
      .slice(0, 100);
  }, [customers, query, remoteCustomers]);

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
            ? `${selected.name} · ${selected.company_name || selected.customer_code}`
            : "搜索并选择客户"}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute z-[140] mt-1 w-full min-w-80 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl">
          <label className="flex h-10 items-center gap-2 border-b border-slate-200 px-3 text-slate-400">
            <Search className="h-4 w-4 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
              }}
              placeholder="客户、公司、联系人、电话或编号"
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
                没有匹配的客户
              </div>
            ) : (
              filtered.map((customer) => (
                <button
                  key={customer.id}
                  type="button"
                  onClick={() => {
                    setSelectedCache(customer);
                    onChange(customer.id, customer);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {customer.name}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {[
                        customer.customer_code,
                        customer.company_name,
                        customer.contact_name || customer.phone,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  {value === customer.id && (
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
