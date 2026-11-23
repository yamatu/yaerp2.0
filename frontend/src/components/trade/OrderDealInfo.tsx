"use client";

import { useState } from "react";
import { CalendarDays, Copy, Loader2, MapPin, Pencil, Save, X } from "lucide-react";
import api from "@/lib/api";
import { formatSettlementMonth, settlementMonthFor } from "@/lib/tradeSettlement";
import type { TradeOrder } from "@/types";

const fieldClass =
  "h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm outline-none focus:border-slate-400";

// Dates come back as 2026-10-26T00:00:00Z; only the calendar day matters.
export function dealDay(value?: string) {
  return value ? value.slice(0, 10) : "";
}

export function formatDealDay(value?: string) {
  const day = dealDay(value);
  return day ? day.replace(/-/g, "/") : "";
}

export function OrderDealInfo({
  order,
  canEdit,
  canSeeAddress,
  startDay,
  onSaved,
}: {
  order: TradeOrder;
  canEdit: boolean;
  canSeeAddress: boolean;
  startDay?: number;
  onSaved: (order: TradeOrder) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const address = order.shipping_address || "";

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the address stays selectable.
    }
  };

  return (
    <div className="grid gap-px border-b border-slate-200 bg-slate-200 sm:grid-cols-[1fr_1fr_2fr]">
      <div className="bg-white px-4 py-3">
        <div className="flex items-center gap-1 text-xs text-slate-400">
          <CalendarDays className="h-3.5 w-3.5" />
          成交日期
        </div>
        <div className="mt-1 text-sm font-semibold">{formatDealDay(order.deal_date) || "未成交"}</div>
      </div>
      <div className="bg-white px-4 py-3">
        <div className="text-xs text-slate-400">账期月份</div>
        <div className="mt-1 flex items-center gap-2 text-sm font-semibold">
          {order.settlement_month ? formatSettlementMonth(order.settlement_month) : "未设置"}
          {canEdit && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-sky-700 hover:bg-sky-50"
            >
              <Pencil className="h-3 w-3" />
              修改
            </button>
          )}
        </div>
      </div>
      <div className="min-w-0 bg-white px-4 py-3">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span className="flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" />
            收货地址
          </span>
          {canSeeAddress && address && (
            <button type="button" onClick={() => void copyAddress()} className="inline-flex items-center gap-1 text-sky-700 hover:underline">
              <Copy className="h-3 w-3" />
              {copied ? "已复制" : "复制"}
            </button>
          )}
        </div>
        <div className="mt-1 whitespace-pre-line break-words text-sm">
          {canSeeAddress ? address || <span className="text-slate-400">未填写</span> : "按岗位隐藏"}
        </div>
      </div>
      {editing && (
        <OrderDealEditor
          order={order}
          startDay={startDay}
          canSeeAddress={canSeeAddress}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            onSaved(saved);
          }}
        />
      )}
    </div>
  );
}

function OrderDealEditor({
  order,
  startDay,
  canSeeAddress,
  onClose,
  onSaved,
}: {
  order: TradeOrder;
  startDay?: number;
  canSeeAddress: boolean;
  onClose: () => void;
  onSaved: (order: TradeOrder) => void;
}) {
  const [dealDate, setDealDate] = useState(dealDay(order.deal_date));
  const autoMonth = dealDate ? settlementMonthFor(new Date(`${dealDate}T00:00:00`), startDay) : "";
  const [month, setMonth] = useState(order.settlement_month || autoMonth);
  const [address, setAddress] = useState(order.shipping_address || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await api.put<TradeOrder>(`/trade/orders/${order.id}/deal`, {
        deal_date: dealDate,
        settlement_month: month,
        ...(canSeeAddress ? { shipping_address: address } : {}),
      });
      if (response.code !== 0 || !response.data) throw new Error(response.message || "保存失败");
      onSaved(response.data);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-movable-dialog className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4">
      <div role="dialog" aria-label="成交日期与账期" className="w-full max-w-lg overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">成交日期与账期</h2>
            <p className="mt-0.5 text-xs text-slate-500">{order.order_no}</p>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-500">成交日期（合同日期）</span>
              <input
                type="date"
                value={dealDate}
                onChange={(event) => {
                  const next = event.target.value;
                  // Follow the date while the month still matches the old date's cycle.
                  if (month === autoMonth && next) setMonth(settlementMonthFor(new Date(`${next}T00:00:00`), startDay));
                  setDealDate(next);
                }}
                className={fieldClass}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-500">计入账期月份</span>
              <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className={fieldClass} />
              {autoMonth && month !== autoMonth && (
                <span className="mt-0.5 block text-[11px] text-amber-600">按成交日期应为 {formatSettlementMonth(autoMonth)}，已手动调整</span>
              )}
            </label>
          </div>
          {canSeeAddress && (
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-500">收货地址</span>
              <textarea
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                rows={4}
                className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-slate-400"
              />
            </label>
          )}
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button type="button" onClick={onClose} className="h-9 rounded-lg border border-slate-200 px-4 text-sm">
            取消
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
