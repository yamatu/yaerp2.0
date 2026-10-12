"use client";

import { useMemo, useState } from "react";
import { Copy, Loader2, Plus, Trash2, Wand2, X } from "lucide-react";
import { SupplierCombobox } from "@/components/trade/SupplierCombobox";
import type { TradeOrder, TradeSupplier } from "@/types";

export interface SupplierQuoteDraft {
  order_item_id: number;
  supplier_id: number;
  currency: string;
  unit_price: string;
  moq: string;
  lead_time_days: string;
  valid_until: string;
  notes: string;
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

export function isFilledSupplierQuote(draft: SupplierQuoteDraft) {
  return draft.order_item_id > 0 && draft.supplier_id > 0 && Number(draft.unit_price) > 0;
}

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
  onSave: () => void;
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
  const [bulkSupplierID, setBulkSupplierID] = useState(0);
  const [bulkCurrency, setBulkCurrency] = useState("");
  const [bulkLeadTime, setBulkLeadTime] = useState("");
  const [bulkValidUntil, setBulkValidUntil] = useState("");
  const itemByID = useMemo(
    () => new Map((order.items || []).map((item) => [item.id, item])),
    [order.items],
  );
  const filledCount = drafts.filter(isFilledSupplierQuote).length;

  const update = (index: number, patch: Partial<SupplierQuoteDraft>) =>
    onChange(drafts.map((draft, draftIndex) => (draftIndex === index ? { ...draft, ...patch } : draft)));

  const applyBulk = (onlyEmpty: boolean) => {
    const supplier = suppliers.find((candidate) => candidate.id === bulkSupplierID);
    onChange(
      drafts.map((draft) => {
        if (onlyEmpty && draft.supplier_id) return draft;
        return {
          ...draft,
          supplier_id: bulkSupplierID || draft.supplier_id,
          currency: bulkCurrency || (supplier ? defaultCurrency(supplier) : draft.currency),
          lead_time_days: bulkLeadTime || draft.lead_time_days,
          valid_until: bulkValidUntil || draft.valid_until,
        };
      }),
    );
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4">
      <div className="flex max-h-[94vh] w-full max-w-7xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">{editing ? "修改供应商报价" : "录入供应商报价"}</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {order.order_no} · 所有产品一次列出；只保存填写了供应商和单价的行，未报价的产品可以稍后再补。
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
                    title="新增供应商"
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
                应用到全部行
              </button>
              <button
                type="button"
                onClick={() => applyBulk(true)}
                className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                仅填空白行
              </button>
              {canAddItems && (
                <button
                  type="button"
                  onClick={onAddItems}
                  className="ml-auto inline-flex h-10 items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加产品
                </button>
              )}
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[1080px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-white text-left text-xs text-slate-500 shadow-[0_1px_0_#e2e8f0]">
              <tr>
                <th className="w-10 px-2 py-2 text-center">#</th>
                <th className="min-w-[180px] px-2 py-2">SKU / 询价数量</th>
                <th className="min-w-[170px] px-2 py-2">供应商</th>
                <th className="w-20 px-2 py-2">币种</th>
                <th className="w-28 px-2 py-2">单价</th>
                <th className="w-24 px-2 py-2">MOQ</th>
                <th className="w-28 px-2 py-2">交期</th>
                <th className="w-36 px-2 py-2">有效期</th>
                <th className="min-w-[140px] px-2 py-2">备注</th>
                <th className="w-20 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {drafts.map((draft, index) => {
                const item = itemByID.get(draft.order_item_id);
                const repeated = index > 0 && drafts[index - 1].order_item_id === draft.order_item_id;
                const filled = isFilledSupplierQuote(draft);
                return (
                  <tr
                    key={index}
                    className={`border-t border-slate-100 align-middle ${filled ? "bg-emerald-50/40" : ""}`}
                  >
                    <td className="px-2 py-1.5 text-center text-xs font-semibold text-slate-400">
                      {repeated ? "" : item?.line_no || index + 1}
                    </td>
                    <td className="px-2 py-1.5">
                      {editing ? (
                        <select
                          value={draft.order_item_id}
                          onChange={(event) => update(index, { order_item_id: Number(event.target.value) })}
                          className="h-8 w-full rounded-md border border-slate-200 bg-white px-2"
                        >
                          {(order.items || []).map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.line_no}. {candidate.sku || candidate.product_name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className={repeated ? "pl-3 text-slate-400" : ""}>
                          <div className="font-medium text-slate-800">
                            {repeated ? "↳ 同 SKU 另一家" : item?.sku || item?.product_name || "-"}
                          </div>
                          {!repeated && item && (
                            <div className="text-xs text-slate-400">
                              {item.quantity} {item.unit}
                              {item.specification ? ` · ${item.specification}` : ""}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={draft.supplier_id}
                        onChange={(event) => {
                          const supplier = suppliers.find((candidate) => candidate.id === Number(event.target.value));
                          update(index, {
                            supplier_id: Number(event.target.value),
                            currency: supplier ? defaultCurrency(supplier) : draft.currency,
                          });
                        }}
                        className="h-8 w-full rounded-md border border-slate-200 bg-white px-2"
                      >
                        <option value={0}>选择供应商</option>
                        {suppliers.map((supplier) => (
                          <option key={supplier.id} value={supplier.id}>
                            {supplier.name}
                          </option>
                        ))}
                      </select>
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
                    <td className="px-2 py-1.5">
                      {!editing && (
                        <div className="flex justify-end gap-0.5">
                          <button
                            type="button"
                            onClick={() =>
                              onChange([
                                ...drafts.slice(0, index + 1),
                                { ...draft, supplier_id: 0, unit_price: "", moq: "", notes: "" },
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
                            disabled={drafts.length === 1}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-rose-500 hover:bg-rose-50 disabled:opacity-30"
                            title="移除这一行"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
          <span className="text-xs text-slate-500">
            已填写 <strong className="text-slate-800">{filledCount}</strong> / {drafts.length} 行
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-lg border border-slate-200 px-4 text-sm"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || filledCount === 0}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              保存 {filledCount} 条报价
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
