"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { getCurrencyCodes, getCurrencyLabel } from "@/lib/currencies";

interface CurrencyComboboxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

interface CurrencyOption {
  code: string;
  chineseName: string;
  englishName: string;
  label: string;
  searchText: string;
}

function displayName(code: string, locale: string) {
  try {
    const DisplayNames = (
      Intl as unknown as { DisplayNames?: typeof Intl.DisplayNames }
    ).DisplayNames;
    return DisplayNames
      ? new DisplayNames([locale], { type: "currency" }).of(code) || ""
      : "";
  } catch {
    return "";
  }
}

const CURRENCY_OPTIONS: CurrencyOption[] = getCurrencyCodes().map((code) => {
  const chineseName = displayName(code, "zh-CN");
  const englishName = displayName(code, "en");
  return {
    code,
    chineseName,
    englishName,
    label: getCurrencyLabel(code),
    searchText: `${code} ${chineseName} ${englishName}`.toLocaleLowerCase(),
  };
});

export function CurrencyCombobox({
  value,
  onChange,
  placeholder = "搜索币种名称或代码",
  className = "",
}: CurrencyComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value || "");

  useEffect(() => {
    if (!open) setQuery(value || "");
  }, [open, value]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword || keyword === value.toLocaleLowerCase())
      return CURRENCY_OPTIONS.slice(0, 80);
    return CURRENCY_OPTIONS.filter((option) =>
      option.searchText.includes(keyword),
    ).slice(0, 80);
  }, [query, value]);

  const commitTypedCode = () => {
    const code = query.trim().toUpperCase();
    if (CURRENCY_OPTIONS.some((option) => option.code === code)) onChange(code);
    setQuery(
      CURRENCY_OPTIONS.some((option) => option.code === code) ? code : value,
    );
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onFocus={(event) => {
            setOpen(true);
            event.currentTarget.select();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitTypedCode();
            }
            if (event.key === "Escape") {
              setQuery(value);
              setOpen(false);
            }
          }}
          onBlur={() =>
            window.setTimeout(() => {
              if (!rootRef.current?.matches(":focus-within")) commitTypedCode();
            }, 0)
          }
          placeholder={placeholder}
          className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-9 text-sm outline-none focus:border-slate-400"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
        />
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center text-slate-400"
          title="选择币种"
        >
          <ChevronDown
            className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {open && (
        <div className="absolute z-[120] mt-1 max-h-64 w-full min-w-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-slate-400">
              没有匹配的币种
            </div>
          ) : (
            filtered.map((option) => (
              <button
                key={option.code}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.code);
                  setQuery(option.code);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50"
              >
                <span className="w-10 shrink-0 text-sm font-semibold text-slate-800">
                  {option.code}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-700">
                    {option.chineseName || option.label}
                  </span>
                  {option.englishName && (
                    <span className="block truncate text-xs text-slate-400">
                      {option.englishName}
                    </span>
                  )}
                </span>
                {value === option.code && (
                  <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function CurrencySearchEnhancer() {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const isCurrencyInput = (
      target: EventTarget | null,
    ): target is HTMLInputElement =>
      target instanceof HTMLInputElement &&
      target.getAttribute("list") === "trade-currency-options";
    const updateRect = () => setRect(input?.getBoundingClientRect() || null);
    const focus = (event: FocusEvent) => {
      if (!isCurrencyInput(event.target)) return;
      setInput(event.target);
      setQuery(event.target.value);
      setRect(event.target.getBoundingClientRect());
    };
    const change = (event: Event) => {
      const currentInput = input;
      if (currentInput && event.target === currentInput) {
        setQuery(currentInput.value);
        setRect(currentInput.getBoundingClientRect());
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.target !== input) return;
      if (event.key === "Escape") setInput(null);
    };
    const blur = (event: FocusEvent) => {
      if (event.target !== input) return;
      window.setTimeout(() => {
        if (document.activeElement !== input) setInput(null);
      }, 120);
    };
    document.addEventListener("focusin", focus);
    document.addEventListener("input", change);
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusout", blur);
    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);
    return () => {
      document.removeEventListener("focusin", focus);
      document.removeEventListener("input", change);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusout", blur);
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [input]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword || /^[a-z]{3}$/i.test(keyword)) {
      const exact = CURRENCY_OPTIONS.filter((option) =>
        option.code.toLocaleLowerCase().includes(keyword),
      );
      const rest = CURRENCY_OPTIONS.filter(
        (option) =>
          !exact.includes(option) && option.searchText.includes(keyword),
      );
      return [...exact, ...rest].slice(0, 80);
    }
    return CURRENCY_OPTIONS.filter((option) =>
      option.searchText.includes(keyword),
    ).slice(0, 80);
  }, [query]);

  if (!input || !rect || typeof document === "undefined") return null;

  const choose = (code: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, code);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    input.select();
    setQuery(code);
    setInput(null);
  };

  return createPortal(
    <div
      className="fixed z-[150] max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-2xl"
      style={{
        left: Math.max(8, rect.left),
        top: rect.bottom + 4,
        width: Math.max(260, rect.width),
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {filtered.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-slate-400">
          没有匹配的币种
        </div>
      ) : (
        filtered.map((option) => (
          <button
            key={option.code}
            type="button"
            onClick={() => choose(option.code)}
            className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-slate-50"
          >
            <span className="w-10 shrink-0 text-sm font-semibold text-slate-800">
              {option.code}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-slate-700">
                {option.chineseName || option.label}
              </span>
              {option.englishName && (
                <span className="block truncate text-xs text-slate-400">
                  {option.englishName}
                </span>
              )}
            </span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}
