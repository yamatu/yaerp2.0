"use client";

import { useMemo, useState } from "react";
import { Ban, ClipboardPaste, Copy, Loader2, Plus, RotateCcw, Trash2, Wand2, X } from "lucide-react";
import { SupplierCombobox } from "@/components/trade/SupplierCombobox";
import { SupplierInlineSelect } from "@/components/trade/SupplierInlineSelect";
import {
  SUPPLIER_QUOTE_IMPORT_COLUMNS,
  parseSupplierQuoteText,
  type ParsedQuoteRow,
} from "@/lib/supplierQuoteImport";
import { tradeItemUnavailable, tradeItemUnavailableReason } from "@/lib/tradeItems";
import type { TradeOrder, TradeSupplier } from "@/types";

export interface SupplierQuoteDraft {
  order_item_id: number;
  supplier_id: number;
  /** Typed supplier that does not exist yet; the server creates it on save. */
  supplier_name: string;
  currency: string;
  unit_price: string;
  moq: string;
  lead_time_days: string;
  valid_until: string;
  notes: string;
}

export interface TradeItemAvailabilityChange {
  order_item_id: number;
  unavailable: boolean;
  reason: string;
}

export const LEAD_TIME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "2", label: "1-2 天" },
  { value: "3", label: "2-3 天" },
  { value: "4", label: "3-4 天" },
  { value: "7", label: "5-7 天" },
  { value: "10", label: "8-10 天" },
  { value: "15", label: "13-15 天" },
  { value: "30", label: "28-30 天" },
];

function formatInputDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function supplierQuoteDraftForItem(itemID: number): SupplierQuoteDraft {
  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + 30);
  return {
    order_item_id: itemID,
    supplier_id: 0,
    supplier_name: "",
    currency: "CNY",
    unit_price: "",
    moq: "",
    lead_time_days: "3",
    valid_until: formatInputDate(validUntil),
    notes: "",
  };
}

export function hasDraftSupplier(draft: SupplierQuoteDraft) {
  return draft.supplier_id > 0 || draft.supplier_name.trim() !== "";
}

export function isFilledSupplierQuote(draft: SupplierQuoteDraft) {
  return draft.order_item_id > 0 && hasDraftSupplier(draft) && Number(draft.unit_price) > 0;
}

function isBlankDraft(draft: SupplierQuoteDraft) {
  return !hasDraftSupplier(draft) && !draft.unit_price.trim();
}

type Availability = Record<number, { unavailable: boolean; reason: string }>;
type Tab = "all" | "pending" | "recorded" | "unavailable";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "all", label: "全部" },
  { key: "pending", label: "未录入报价" },
  { key: "recorded", label: "已录入报价" },
  { key: "unavailable", label: "无法报价" },
];

interface SupplierQuoteBatchModalProps {
  order: TradeOrder;
  suppliers: TradeSupplier[];
  drafts: SupplierQuoteDraft[];
  onChange: (drafts: SupplierQuoteDraft[]) => void;
  editing: boolean;
  saving: boolean;
  canAddItems: boolean;
  defaultCurrency: (supplier?: TradeSupplier) => string;
  onAddItems: () => void;
  onCreateSupplier: () => void;
  onClose: () => void;
  onSave: (availability: TradeItemAvailabilityChange[]) => void;
}

export function SupplierQuoteBatchModal({
  order,
  suppliers,
  drafts,
  onChange,
  editing,
  saving,
  canAddItems,
  defaultCurrency,
  onAddItems,
  onCreateSupplier,
  onClose,
  onSave,
}: SupplierQuoteBatchModalProps) {
  const items = useMemo(() => order.items || [], [order.items]);
  const itemByID = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const initialAvailability = useMemo(() => {
    const result: Availability = {};
    for (const item of items) result[item.id] = { unavailable: tradeItemUnavailable(item), reason: tradeItemUnavailableReason(item) };
    return result;
  }, [items]);
  const [availability, setAvailability] = useState<Availability>(initialAvailability);
  const savedQuoteCount = useMemo(() => {
    const counts = new Map<number, number>();
    for (const quote of order.supplier_quotes || []) counts.set(quote.order_item_id, (counts.get(quote.order_item_id) || 0) + 1);
    return counts;
  }, [order.supplier_quotes]);

  const [bulkSupplierID, setBulkSupplierID] = useState(0);
  const [bulkCurrency, setBulkCurrency] = useState("");
  const [bulkLeadTime, setBulkLeadTime] = useState("");
  const [bulkValidUntil, setBulkValidUntil] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  // Membership of the open tab is frozen when it is chosen: a row must not
  // vanish from "未录入" while its price is being typed.
  const [tabItems, setTabItems] = useState<Set<number> | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const isUnavailable = (itemID: number) => Boolean(availability[itemID]?.unavailable);
  const itemStatus = (itemID: number): Exclude<Tab, "all"> => {
    if (isUnavailable(itemID)) return "unavailable";
    if ((savedQuoteCount.get(itemID) || 0) > 0) return "recorded";
    return drafts.some((draft) => draft.order_item_id === itemID && isFilledSupplierQuote(draft)) ? "recorded" : "pending";
  };
  const counts = { all: items.length, pending: 0, recorded: 0, unavailable: 0 };
  for (const item of items) counts[itemStatus(item.id)] += 1;

  const chooseTab = (next: Tab) => {
    setTab(next);
    setTabItems(next === "all" ? null : new Set(items.filter((item) => itemStatus(item.id) === next).map((item) => item.id)));
  };
  const rowVisible = (draft: SupplierQuoteDraft) => editing || !tabItems || tabItems.has(draft.order_item_id);

  const activeDrafts = drafts.filter((draft) => !isUnavailable(draft.order_item_id));
  const filledCount = activeDrafts.filter(isFilledSupplierQuote).length;
  const newSupplierNames = new Set(
    activeDrafts.filter((draft) => isFilledSupplierQuote(draft) && !draft.supplier_id).map((draft) => draft.supplier_name.trim().toLowerCase()),
  );
  const availabilityChanges: TradeItemAvailabilityChange[] = editing
    ? []
    : items
        .filter((item) => {
          const before = initialAvailability[item.id];
          const after = availability[item.id];
          return before && after && (before.unavailable !== after.unavailable || (after.unavailable && before.reason !== after.reason.trim()));
        })
        .map((item) => ({ order_item_id: item.id, unavailable: availability[item.id].unavailable, reason: availability[item.id].reason.trim() }));

  const update = (index: number, patch: Partial<SupplierQuoteDraft>) =>
    onChange(drafts.map((draft, draftIndex) => (draftIndex === index ? { ...draft, ...patch } : draft)));

  const setItemAvailability = (itemID: number, unavailable: boolean, reason?: string) =>
    setAvailability((current) => ({
      ...current,
      [itemID]: { unavailable, reason: reason ?? current[itemID]?.reason ?? "" },
    }));

  const applyBulk = (onlyEmpty: boolean) => {
    const supplier = suppliers.find((candidate) => candidate.id === bulkSupplierID);
    onChange(
      drafts.map((draft) => {
        if (!rowVisible(draft) || isUnavailable(draft.order_item_id)) return draft;
        if (onlyEmpty && hasDraftSupplier(draft)) return draft;
        return {
          ...draft,
          supplier_id: bulkSupplierID || draft.supplier_id,
          supplier_name: bulkSupplierID ? "" : draft.supplier_name,
          currency: bulkCurrency || (supplier ? defaultCurrency(supplier) : draft.currency),
          lead_time_days: bulkLeadTime || draft.lead_time_days,
          valid_until: bulkValidUntil || draft.valid_until,
        };
      }),
    );
  };

  const parsed = useMemo(
    () => (importOpen && importText.trim() ? parseSupplierQuoteText(importText, items, suppliers) : null),
    [importOpen, importText, items, suppliers],
  );
  const importable = (parsed?.rows || []).filter((row) => !row.error);

  const applyImport = (rows: ParsedQuoteRow[]) => {
    const next = [...drafts];
    const nextAvailability = { ...availability };
    for (const row of rows) {
      if (!row.item) continue;
      const itemID = row.item.id;
      if (row.unavailable) {
        nextAvailability[itemID] = { unavailable: true, reason: row.reason };
        continue;
      }
      nextAvailability[itemID] = { unavailable: false, reason: nextAvailability[itemID]?.reason || "" };
      const supplier = row.supplierID ? suppliers.find((candidate) => candidate.id === row.supplierID) : undefined;
      const patch: Partial<SupplierQuoteDraft> = {
        supplier_id: row.supplierID,
        supplier_name: row.supplierID ? "" : row.supplierName,
        currency: row.currency || (supplier ? defaultCurrency(supplier) : "CNY"),
        unit_price: row.unitPrice,
        moq: row.moq,
        notes: row.notes,
        ...(row.leadTime ? { lead_time_days: row.leadTime } : {}),
        ...(row.validUntil ? { valid_until: row.validUntil } : {}),
      };
      const blank = next.findIndex((draft) => draft.order_item_id === itemID && isBlankDraft(draft));
      if (blank >= 0) {
        next[blank] = { ...next[blank], ...patch };
        continue;
      }
      let last = -1;
      next.forEach((draft, index) => {
        if (draft.order_item_id === itemID) last = index;
      });
      const base = last >= 0 ? next[last] : supplierQuoteDraftForItem(itemID);
      const row_draft: SupplierQuoteDraft = { ...supplierQuoteDraftForItem(itemID), lead_time_days: base.lead_time_days, valid_until: base.valid_until, ...patch };
      if (last >= 0) next.splice(last + 1, 0, row_draft);
      else next.push(row_draft);
    }
    onChange(next);
    setAvailability(nextAvailability);
    setImportOpen(false);
    setImportText("");
    chooseTab("all");
  };

  const firstRowOfItem = new Set<number>();
  const rows = drafts.map((draft, index) => {
    const first = !firstRowOfItem.has(draft.order_item_id);
    firstRowOfItem.add(draft.order_item_id);
    return { draft, index, first };
  });
  const visibleRows = rows.filter(({ draft, first }) => rowVisible(draft) && (!isUnavailable(draft.order_item_id) || first));
  const canSave = !saving && (filledCount > 0 || availabilityChanges.length > 0);

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4">
      <div className="flex max-h-[94vh] w-full max-w-7xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">{editing ? "修改供应商报价" : "录入供应商报价"}</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {order.order_no} · 供应商直接输入名称，已有的会自动提示，没有的保存时自动新增；没有货源的产品可标记「无法报价」。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!editing && (
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-64 text-xs font-medium text-slate-600">
                统一供应商
                <div className="mt-1 flex gap-1.5">
                  <div className="min-w-0 flex-1">
                    <SupplierCombobox
                      suppliers={suppliers}
                      value={bulkSupplierID}
                      onChange={(supplierID, supplier) => {
                        setBulkSupplierID(supplierID);
                        setBulkCurrency(defaultCurrency(supplier));
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={onCreateSupplier}
                    className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white"
                    title="新增供应商（填写完整资料）"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <label className="w-24 text-xs font-medium text-slate-600">
                币种
                <input
                  list="trade-currency-options"
                  value={bulkCurrency}
                  onChange={(event) => setBulkCurrency(event.target.value.toUpperCase())}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-2 uppercase outline-none"
                  placeholder="CNY"
                />
              </label>
              <label className="w-28 text-xs font-medium text-slate-600">
                交期
                <select
                  value={bulkLeadTime}
                  onChange={(event) => setBulkLeadTime(event.target.value)}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-2"
                >
                  <option value="">不修改</option>
                  {LEAD_TIME_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="w-36 text-xs font-medium text-slate-600">
                有效期至
                <input
                  type="date"
                  value={bulkValidUntil}
                  onChange={(event) => setBulkValidUntil(event.target.value)}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-2"
                />
              </label>
              <button
                type="button"
                onClick={() => applyBulk(false)}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-semibold text-white hover:bg-slate-700"
              >
                <Wand2 className="h-3.5 w-3.5" />
                应用到当前列表
              </button>
              <button
                type="button"
                onClick={() => applyBulk(true)}
                className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                仅填空白行
              </button>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => setImportOpen((current) => !current)}
                  className={`inline-flex h-10 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${importOpen ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"}`}
                >
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  批量导入
                </button>
                {canAddItems && (
                  <button
                    type="button"
                    onClick={onAddItems}
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    添加产品
                  </button>
                )}
              </div>
            </div>

            {importOpen && (
              <div className="mt-3 rounded-lg border border-sky-200 bg-white p-3" data-supplier-quote-import>
                <div className="text-xs text-slate-600">
                  从 Excel / WPS 复制后直接粘贴，每行一条报价。可带表头（列顺序随意），不带表头时按顺序：
                  <span className="font-semibold text-slate-800"> {SUPPLIER_QUOTE_IMPORT_COLUMNS.join(" · ")}</span>
                  。产品按 SKU 或品名匹配；供应商按名称匹配，没有的保存时自动新增；单价或状态写「无法报价 / 缺货 / 停产」即标记无法报价。
                </div>
                <textarea
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  placeholder={"SKU\t供应商\t单价\t币种\tMOQ\t交期\t有效期\t备注\nA-001\t华强电子\t12.5\tCNY\t100\t7\t2026-12-31\t含税\nA-002\t\t无法报价"}
                  className="mt-2 h-32 w-full resize-y rounded-md border border-slate-200 p-2 font-mono text-xs outline-none focus:border-sky-400"
                />
                {parsed && (
                  <div className="mt-2 max-h-48 overflow-auto rounded-md border border-slate-100">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                        <tr>
                          <th className="px-2 py-1">行</th>
                          <th className="px-2 py-1">产品</th>
                          <th className="px-2 py-1">供应商</th>
                          <th className="px-2 py-1 text-right">单价</th>
                          <th className="px-2 py-1">交期 / 有效期</th>
                          <th className="px-2 py-1">结果</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.rows.map((row) => (
                          <tr key={row.source} className={`border-t border-slate-100 ${row.error ? "bg-rose-50/60" : ""}`}>
                            <td className="px-2 py-1 text-slate-400">{row.source}</td>
                            <td className="px-2 py-1">{row.item ? row.item.sku || row.item.product_name : row.itemText || "-"}</td>
                            <td className="px-2 py-1">
                              {row.unavailable ? (
                                <span className="text-slate-400">-</span>
                              ) : (
                                <>
                                  {row.supplierName || "-"}
                                  {row.supplierIsNew && <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-700">新</span>}
                                </>
                              )}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums">{row.unavailable ? "-" : `${row.currency || ""} ${row.unitPrice}`}</td>
                            <td className="px-2 py-1 text-slate-500">{[row.leadTime && `${row.leadTime} 天`, row.validUntil].filter(Boolean).join(" · ") || "-"}</td>
                            <td className="px-2 py-1">
                              {row.error ? (
                                <span className="text-rose-600">{row.error}</span>
                              ) : row.unavailable ? (
                                <span className="text-amber-700">无法报价：{row.reason}</span>
                              ) : (
                                <span className="text-emerald-700">可导入</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-500">
                    {parsed
                      ? `${parsed.headerDetected ? "已识别表头 · " : ""}共 ${parsed.rows.length} 行，可导入 ${importable.length} 行${parsed.rows.length - importable.length ? `，${parsed.rows.length - importable.length} 行有问题将跳过` : ""}`
                      : "粘贴后会先预览，确认无误再导入到下方表格。"}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setImportOpen(false);
                        setImportText("");
                      }}
                      className="h-8 rounded-md border border-slate-200 px-3 text-xs"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={importable.length === 0}
                      onClick={() => applyImport(importable)}
                      className="h-8 rounded-md bg-sky-600 px-3 text-xs font-semibold text-white disabled:opacity-40"
                    >
                      导入 {importable.length} 行到表格
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="按报价状态筛选">
              {TABS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === option.key}
                  onClick={() => chooseTab(option.key)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold ${
                    tab === option.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {option.label}
                  <span className={`rounded-full px-1.5 text-[11px] ${tab === option.key ? "bg-white/20" : "bg-slate-100 text-slate-500"}`}>
                    {counts[option.key]}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[1080px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-white text-left text-xs text-slate-500 shadow-[0_1px_0_#e2e8f0]">
              <tr>
                <th className="w-10 px-2 py-2 text-center">#</th>
                <th className="min-w-[180px] px-2 py-2">SKU / 询价数量</th>
                <th className="min-w-[190px] px-2 py-2">供应商</th>
                <th className="w-20 px-2 py-2">币种</th>
                <th className="w-28 px-2 py-2">单价</th>
                <th className="w-24 px-2 py-2">MOQ</th>
                <th className="w-28 px-2 py-2">交期</th>
                <th className="w-36 px-2 py-2">有效期</th>
                <th className="min-w-[140px] px-2 py-2">备注</th>
                <th className="w-24 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={10} className="h-24 text-center text-sm text-slate-400">
                    {tab === "pending" ? "所有产品都已录入报价或标记无法报价" : "当前分类没有产品"}
                  </td>
                </tr>
              )}
              {visibleRows.map(({ draft, index, first }) => {
                const item = itemByID.get(draft.order_item_id);
                const unavailable = isUnavailable(draft.order_item_id);
                const filled = isFilledSupplierQuote(draft);
                const saved = savedQuoteCount.get(draft.order_item_id) || 0;
                return (
                  <tr
                    key={index}
                    data-quote-row={draft.order_item_id}
                    className={`border-t border-slate-100 align-middle ${unavailable ? "bg-slate-50" : filled ? "bg-emerald-50/40" : ""}`}
                  >
                    <td className="px-2 py-1.5 text-center text-xs font-semibold text-slate-400">{first ? item?.line_no || index + 1 : ""}</td>
                    <td className="px-2 py-1.5">
                      {editing ? (
                        <select
                          value={draft.order_item_id}
                          onChange={(event) => update(index, { order_item_id: Number(event.target.value) })}
                          className="h-8 w-full rounded-md border border-slate-200 bg-white px-2"
                        >
                          {items.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.line_no}. {candidate.sku || candidate.product_name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className={first ? "" : "pl-3 text-slate-400"}>
                          <div className={`font-medium ${unavailable ? "text-slate-400 line-through" : "text-slate-800"}`}>
                            {first ? item?.sku || item?.product_name || "-" : "↳ 同 SKU 另一家"}
                          </div>
                          {first && item && (
                            <div className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
                              <span>
                                {item.quantity} {item.unit}
                                {item.specification ? ` · ${item.specification}` : ""}
                              </span>
                              {saved > 0 && (
                                <span className="rounded bg-sky-50 px-1 text-[10px] font-semibold text-sky-700" title="该产品已保存的供应商报价">
                                  已有 {saved} 家
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    {unavailable ? (
                      <td colSpan={7} className="px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 text-xs font-semibold text-amber-800">
                            <Ban className="h-3 w-3" />
                            无法报价
                          </span>
                          <input
                            value={availability[draft.order_item_id]?.reason || ""}
                            onChange={(event) => setItemAvailability(draft.order_item_id, true, event.target.value)}
                            placeholder="原因（选填）：缺货、停产、找不到货源…"
                            maxLength={200}
                            className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-sky-400"
                          />
                        </div>
                      </td>
                    ) : (
                      <>
                        <td className="px-2 py-1.5">
                          <SupplierInlineSelect
                            suppliers={suppliers}
                            value={draft.supplier_id}
                            pendingName={draft.supplier_name}
                            onChange={(supplierID, supplier) =>
                              update(index, {
                                supplier_id: supplierID,
                                supplier_name: "",
                                currency: supplier ? defaultCurrency(supplier) : draft.currency,
                              })
                            }
                            onUseName={(name) => {
                              const match = suppliers.find(
                                (supplier) => supplier.name.trim().toLowerCase() === name.toLowerCase() || supplier.company_name?.trim().toLowerCase() === name.toLowerCase(),
                              );
                              update(index, match ? { supplier_id: match.id, supplier_name: "", currency: defaultCurrency(match) } : { supplier_id: 0, supplier_name: name });
                            }}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            list="trade-currency-options"
                            value={draft.currency}
                            onChange={(event) => update(index, { currency: event.target.value.toUpperCase() })}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 uppercase outline-none focus:border-sky-400"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={draft.unit_price}
                            onChange={(event) => update(index, { unit_price: event.target.value })}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-right tabular-nums outline-none focus:border-sky-400"
                            placeholder="单价"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={draft.moq}
                            onChange={(event) => update(index, { moq: event.target.value })}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 text-right tabular-nums outline-none focus:border-sky-400"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            value={draft.lead_time_days}
                            onChange={(event) => update(index, { lead_time_days: event.target.value })}
                            className="h-8 w-full rounded-md border border-slate-200 bg-white px-2"
                          >
                            {!LEAD_TIME_OPTIONS.some((option) => option.value === draft.lead_time_days) && (
                              <option value={draft.lead_time_days}>{draft.lead_time_days} 天</option>
                            )}
                            {LEAD_TIME_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="date"
                            value={draft.valid_until}
                            onChange={(event) => update(index, { valid_until: event.target.value })}
                            className="h-8 w-full rounded-md border border-slate-200 px-2"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            value={draft.notes}
                            onChange={(event) => update(index, { notes: event.target.value })}
                            className="h-8 w-full rounded-md border border-slate-200 px-2 outline-none focus:border-sky-400"
                          />
                        </td>
                      </>
                    )}
                    <td className="px-2 py-1.5">
                      {!editing && (
                        <div className="flex justify-end gap-0.5">
                          {unavailable ? (
                            <button
                              type="button"
                              onClick={() => setItemAvailability(draft.order_item_id, false)}
                              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold text-sky-700 hover:bg-sky-50"
                              title="恢复为可报价"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                              恢复
                            </button>
                          ) : (
                            <>
                              {first && (
                                <button
                                  type="button"
                                  onClick={() => setItemAvailability(draft.order_item_id, true)}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-amber-600 hover:bg-amber-50"
                                  title="该产品无法报价（缺货、停产、找不到货源）"
                                  aria-label="标记无法报价"
                                >
                                  <Ban className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  onChange([
                                    ...drafts.slice(0, index + 1),
                                    { ...draft, supplier_id: 0, supplier_name: "", unit_price: "", moq: "", notes: "" },
                                    ...drafts.slice(index + 1),
                                  ])
                                }
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
                                title="同一 SKU 再录一家供应商"
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => onChange(drafts.filter((_, draftIndex) => draftIndex !== index))}
                                disabled={drafts.filter((candidate) => candidate.order_item_id === draft.order_item_id).length === 1}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-rose-500 hover:bg-rose-50 disabled:opacity-30"
                                title="移除这一行"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
          <span className="text-xs text-slate-500">
            已填写 <strong className="text-slate-800">{filledCount}</strong> 条报价
            {newSupplierNames.size > 0 && <span className="text-amber-700"> · 将自动新增 {newSupplierNames.size} 个供应商</span>}
            {availabilityChanges.length > 0 && <span className="text-amber-700"> · 无法报价标记变更 {availabilityChanges.length} 项</span>}
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="h-9 rounded-lg border border-slate-200 px-4 text-sm">
              取消
            </button>
            <button
              type="button"
              onClick={() => onSave(availabilityChanges)}
              disabled={!canSave}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {filledCount > 0 ? `保存 ${filledCount} 条报价` : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
