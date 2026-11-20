"use client";

import { useEffect, useMemo, useState } from "react";
import { Boxes, Loader2, PackagePlus, Save, Trash2, Truck } from "lucide-react";
import api from "@/lib/api";
import { amountValue, sanitizeTypedNumber } from "@/lib/tradeNumbers";
import type { TradeOrder, TradePackingGroup, TradeParcel } from "@/types";

const CARRIERS = ["DHL", "FedEx", "UPS", "TNT", "EMS", "顺丰", "货代"];
const STATUSES = ["未发货", "已发货"];

interface ParcelDraft {
  key: string;
  id: number;
  carrier: string;
  tracking_no: string;
  shipping_status: string;
  ship_date: string;
  actual_freight_currency: string;
  actual_freight_amount: string;
  actual_freight_to_cny_rate: string;
  notes: string;
  /** group_no -> boxes of that packing group in this parcel */
  boxes: Record<number, number>;
}

let draftCounter = 0;

function draftFromParcel(parcel?: TradeParcel): ParcelDraft {
  draftCounter += 1;
  return {
    key: `parcel-${parcel?.id || "new"}-${draftCounter}`,
    id: parcel?.id || 0,
    carrier: parcel?.carrier || "",
    tracking_no: parcel?.tracking_no || "",
    shipping_status: parcel?.shipping_status || "未发货",
    ship_date: parcel?.ship_date?.slice(0, 10) || "",
    actual_freight_currency: parcel?.actual_freight_currency || "CNY",
    actual_freight_amount: parcel?.actual_freight_amount ? String(parcel.actual_freight_amount) : "",
    actual_freight_to_cny_rate:
      parcel?.actual_freight_to_cny_rate && parcel.actual_freight_currency !== "CNY"
        ? String(parcel.actual_freight_to_cny_rate)
        : "",
    notes: parcel?.notes || "",
    boxes: Object.fromEntries((parcel?.boxes || []).map((box) => [box.group_no, box.copies])),
  };
}

function groupLabel(group: TradePackingGroup, skuByItem: Map<number, string>) {
  const size = [group.length_cm, group.width_cm, group.height_cm].every((value) => value > 0)
    ? `${group.length_cm}×${group.width_cm}×${group.height_cm}cm`
    : "";
  const weight = group.weight_kg > 0 ? `${group.weight_kg}kg/箱` : "";
  const contents = group.items
    .map((item) => `${skuByItem.get(item.order_item_id) || item.sku || `第 ${item.line_no} 行`} ×${item.quantity}`)
    .join("，");
  return { title: `箱组 ${group.group_no}`, detail: [size, weight].filter(Boolean).join(" · "), contents };
}

const inputClass =
  "h-9 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-sm outline-none focus:border-sky-400 disabled:bg-slate-50 disabled:text-slate-500";

/**
 * Shipment as parcels: each parcel has a carrier, tracking number, status and
 * freight, and carries some of the packed boxes, e.g. boxes 1-2 by DHL and
 * box 3 by FedEx. Every box must be in a parcel before the order completes.
 */
export function TradeParcelsPanel({
  order,
  editable,
  onSaved,
}: {
  order: TradeOrder;
  editable: boolean;
  onSaved: (order: TradeOrder) => void | Promise<void>;
}) {
  const showFreight = Boolean(order.access?.can_view_profit);
  const groups = useMemo(() => order.packing_groups || [], [order.packing_groups]);
  const skuByItem = useMemo(
    () => new Map((order.items || []).map((item) => [item.id, item.sku || item.product_name])),
    [order.items],
  );
  const [drafts, setDrafts] = useState<ParcelDraft[]>(() => (order.parcels || []).map(draftFromParcel));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Follow updates from elsewhere (another user, a reload) while not editing.
  useEffect(() => {
    if (!dirty) setDrafts((order.parcels || []).map(draftFromParcel));
  }, [order.parcels, dirty]);

  const assigned = (groupNo: number, except?: string) =>
    drafts.reduce((sum, draft) => (draft.key === except ? sum : sum + (draft.boxes[groupNo] || 0)), 0);
  const totalBoxes = groups.reduce((sum, group) => sum + group.copies, 0);
  const placedBoxes = groups.reduce((sum, group) => sum + Math.min(group.copies, assigned(group.group_no)), 0);

  const change = (key: string, patch: Partial<ParcelDraft>) => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
    setDirty(true);
    setSaved(false);
  };
  const setBoxes = (draft: ParcelDraft, groupNo: number, copies: number) =>
    change(draft.key, { boxes: { ...draft.boxes, [groupNo]: copies } });

  const addParcel = () => {
    const next = draftFromParcel();
    // The first parcel takes every box; later ones start empty.
    if (!drafts.length) for (const group of groups) next.boxes[group.group_no] = group.copies;
    setDrafts((current) => [...current, next]);
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await api.put<TradeOrder>(`/trade/orders/${order.id}/parcels`, {
        parcels: drafts.map((draft) => ({
          id: draft.id,
          carrier: draft.carrier.trim(),
          tracking_no: draft.tracking_no.trim(),
          shipping_status: draft.shipping_status,
          ship_date: draft.ship_date,
          actual_freight_currency: draft.actual_freight_currency.trim().toUpperCase() || "CNY",
          actual_freight_amount: amountValue(draft.actual_freight_amount),
          actual_freight_to_cny_rate:
            draft.actual_freight_currency.toUpperCase() === "CNY" ? 1 : amountValue(draft.actual_freight_to_cny_rate),
          notes: draft.notes.trim(),
          boxes: Object.entries(draft.boxes)
            .filter(([, copies]) => copies > 0)
            .map(([groupNo, copies]) => ({ group_no: Number(groupNo), copies })),
        })),
      });
      if (response.code !== 0 || !response.data) throw new Error(response.message || "保存发货包裹失败");
      setDirty(false);
      setSaved(true);
      setDrafts((response.data.parcels || []).map(draftFromParcel));
      await onSaved(response.data);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存发货包裹失败");
    } finally {
      setSaving(false);
    }
  };

  const numberChange = (draft: ParcelDraft, field: "actual_freight_amount" | "actual_freight_to_cny_rate", raw: string) => {
    const clean = sanitizeTypedNumber(raw);
    if (clean !== null) change(draft.key, { [field]: clean });
  };

  return (
    <section className="mt-4 rounded-lg border border-blue-200 bg-blue-50/40 p-3" data-parcels-panel>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-blue-900">
            <Truck className="h-4 w-4" />
            发货包裹
          </h3>
          <p className="mt-0.5 text-xs text-blue-800/70">
            {groups.length
              ? `共 ${totalBoxes} 箱，已分到包裹 ${placedBoxes} 箱${totalBoxes > placedBoxes ? `，还剩 ${totalBoxes - placedBoxes} 箱` : ""}。不同物流的箱子分成不同包裹。`
              : "还没有装箱分组，可直接按包裹填写物流公司和单号。"}
          </p>
        </div>
        {editable && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addParcel}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-sm font-semibold text-blue-700 hover:bg-blue-50"
            >
              <PackagePlus className="h-4 w-4" />
              添加包裹
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-700 px-3 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {dirty ? "保存发货资料" : saved ? "已保存" : "保存发货资料"}
            </button>
          </div>
        )}
      </div>
      {error && <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
      {!drafts.length && (
        <div className="mt-3 rounded-lg border border-dashed border-blue-200 bg-white py-6 text-center text-sm text-slate-400">
          {editable ? "点「添加包裹」开始登记发货；第一个包裹默认装入全部箱子。" : "还没有登记发货包裹"}
        </div>
      )}
      <datalist id="trade-parcel-carriers">
        {CARRIERS.map((carrier) => (
          <option key={carrier} value={carrier} />
        ))}
      </datalist>
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        {drafts.map((draft, index) => (
          <article key={draft.key} className="rounded-lg border border-slate-200 bg-white p-3" data-parcel>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">包裹 {index + 1}</span>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-medium ${draft.shipping_status === "已发货" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}
                >
                  {draft.shipping_status}
                </span>
              </div>
              {editable && (
                <button
                  type="button"
                  onClick={() => {
                    setDrafts((current) => current.filter((item) => item.key !== draft.key));
                    setDirty(true);
                  }}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  aria-label={`删除包裹 ${index + 1}`}
                  title="删除这个包裹"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="block text-xs text-slate-500">
                物流公司
                <input
                  value={draft.carrier}
                  list="trade-parcel-carriers"
                  disabled={!editable}
                  onChange={(event) => change(draft.key, { carrier: event.target.value })}
                  placeholder="DHL / FedEx"
                  aria-label={`包裹 ${index + 1} 物流公司`}
                  className={`mt-0.5 ${inputClass}`}
                />
              </label>
              <label className="block text-xs text-slate-500 sm:col-span-2">
                物流单号
                <input
                  value={draft.tracking_no}
                  disabled={!editable}
                  onChange={(event) => change(draft.key, { tracking_no: event.target.value })}
                  aria-label={`包裹 ${index + 1} 物流单号`}
                  className={`mt-0.5 ${inputClass}`}
                />
              </label>
              <label className="block text-xs text-slate-500">
                状态
                <select
                  value={draft.shipping_status}
                  disabled={!editable}
                  onChange={(event) => change(draft.key, { shipping_status: event.target.value })}
                  aria-label={`包裹 ${index + 1} 状态`}
                  className={`mt-0.5 ${inputClass}`}
                >
                  {STATUSES.map((status) => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-slate-500">
                发货日期
                <input
                  type="date"
                  value={draft.ship_date}
                  disabled={!editable}
                  onChange={(event) => change(draft.key, { ship_date: event.target.value })}
                  aria-label={`包裹 ${index + 1} 发货日期`}
                  className={`mt-0.5 ${inputClass}`}
                />
              </label>
              {showFreight && (
                <>
                  <label className="block text-xs text-slate-500">
                    实际运费
                    <div className="mt-0.5 flex gap-1">
                      <input
                        value={draft.actual_freight_amount}
                        inputMode="decimal"
                        disabled={!editable}
                        onChange={(event) => numberChange(draft, "actual_freight_amount", event.target.value)}
                        aria-label={`包裹 ${index + 1} 实际运费`}
                        className={`${inputClass} text-right`}
                      />
                      <select
                        value={draft.actual_freight_currency}
                        disabled={!editable}
                        onChange={(event) => change(draft.key, { actual_freight_currency: event.target.value })}
                        aria-label={`包裹 ${index + 1} 运费币种`}
                        className="h-9 shrink-0 rounded-lg border border-slate-200 bg-white px-1 text-xs outline-none"
                      >
                        {Array.from(new Set(["CNY", "USD", "EUR", order.currency, draft.actual_freight_currency].filter(Boolean))).map(
                          (code) => (
                            <option key={code}>{code}</option>
                          ),
                        )}
                      </select>
                    </div>
                  </label>
                  {draft.actual_freight_currency !== "CNY" && (
                    <label className="block text-xs text-slate-500">
                      兑人民币汇率
                      <input
                        value={draft.actual_freight_to_cny_rate}
                        inputMode="decimal"
                        disabled={!editable}
                        onChange={(event) => numberChange(draft, "actual_freight_to_cny_rate", event.target.value)}
                        placeholder="例如 7.1"
                        aria-label={`包裹 ${index + 1} 运费汇率`}
                        className={`mt-0.5 ${inputClass}`}
                      />
                    </label>
                  )}
                </>
              )}
              <label className={`block text-xs text-slate-500 ${showFreight && draft.actual_freight_currency !== "CNY" ? "" : "sm:col-span-2"}`}>
                备注
                <input
                  value={draft.notes}
                  disabled={!editable}
                  onChange={(event) => change(draft.key, { notes: event.target.value })}
                  aria-label={`包裹 ${index + 1} 备注`}
                  className={`mt-0.5 ${inputClass}`}
                />
              </label>
            </div>
            {groups.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 text-xs font-semibold text-slate-600">
                    <Boxes className="h-3.5 w-3.5" />
                    装入的箱子
                  </span>
                  {editable && groups.some((group) => group.copies - assigned(group.group_no) > 0) && (
                    <button
                      type="button"
                      onClick={() =>
                        change(draft.key, {
                          boxes: Object.fromEntries(
                            groups.map((group) => [
                              group.group_no,
                              (draft.boxes[group.group_no] || 0) + Math.max(0, group.copies - assigned(group.group_no)),
                            ]),
                          ),
                        })
                      }
                      className="text-xs font-semibold text-blue-700 hover:underline"
                    >
                      剩余箱子都放进这个包裹
                    </button>
                  )}
                </div>
                <ul className="mt-1.5 divide-y divide-slate-100 rounded-lg border border-slate-100">
                  {groups.map((group) => {
                    const label = groupLabel(group, skuByItem);
                    const mine = draft.boxes[group.group_no] || 0;
                    const max = group.copies - assigned(group.group_no, draft.key);
                    return (
                      <li key={group.group_no} className={`flex items-center gap-2 px-2 py-1.5 ${mine > 0 ? "bg-blue-50/50" : ""}`}>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-slate-800">
                            {label.title}
                            <span className="ml-1.5 text-xs font-normal text-slate-400">
                              {[label.detail, `共 ${group.copies} 箱`].filter(Boolean).join(" · ")}
                            </span>
                          </div>
                          <div className="truncate text-xs text-slate-500" title={label.contents}>
                            {label.contents || "未填写装箱产品"}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            max={max}
                            value={mine || ""}
                            placeholder="0"
                            disabled={!editable}
                            onChange={(event) => {
                              const value = Math.max(0, Math.min(max, Math.floor(Number(event.target.value) || 0)));
                              setBoxes(draft, group.group_no, value);
                            }}
                            aria-label={`包裹 ${index + 1} 箱组 ${group.group_no} 箱数`}
                            className="h-8 w-14 rounded-lg border border-slate-200 px-1.5 text-right text-sm outline-none focus:border-sky-400 disabled:bg-slate-50"
                          />
                          <span className="w-14 text-xs text-slate-400">可放 {max} 箱</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
