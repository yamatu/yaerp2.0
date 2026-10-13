"use client";

import { useMemo, useState } from "react";
import { Calculator, Loader2, RotateCcw, Scale, ShieldCheck, X } from "lucide-react";
import { tradeItemUnavailable } from "@/lib/tradeItems";
import type { TradeCustomerQuoteRound, TradeOrder, TradeOrderItem } from "@/types";

const DEFAULT_MARGIN_PERCENT = 15;

interface LineDraft {
  order_item_id: number;
  line_no: number;
  sku: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price: string;
  margin: string;
  freight: string;
  weight: string;
  selected: boolean;
  /** The line no longer follows the shared markup. */
  custom: boolean;
}

interface Draft {
  currency: string;
  exchange_rate_cny: string;
  default_margin: string;
  freight_mode: "customer_forwarder" | "quoted";
  status: "draft" | "sent";
  customer_feedback: string;
  notes: string;
  freight_per_kg: string;
  lines: LineDraft[];
}

export interface CustomerQuoteRoundPayload {
  currency: string;
  exchange_rate_cny: number;
  profit_margin_percent: number;
  freight_mode: "customer_forwarder" | "quoted";
  freight_amount: number;
  status: "draft" | "sent";
  customer_feedback: string;
  notes: string;
  items: Array<{
    order_item_id: number;
    unit_price: number;
    margin_percent: number;
    freight_amount: number;
    weight_kg: number;
    declined: boolean;
  }>;
}

interface Props {
  order: TradeOrder;
  source?: TradeCustomerQuoteRound;
  canUsePurchasePricing: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (payload: CustomerQuoteRoundPayload) => void;
  onError: (message: string) => void;
}

const money = (currency: string, value: number) =>
  `${currency} ${Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const roundUp2 = (value: number) => Math.ceil((value - Number.EPSILON) * 100) / 100;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Purchase cost of one unit expressed in the quote currency; 0 when unknown. */
function unitCostInQuote(item: TradeOrderItem | undefined, currency: string, rateText: string) {
  if (!item || item.purchase_price <= 0) return 0;
  const quoteRate = currency.toUpperCase() === "CNY" ? 1 : Number(rateText || 0);
  if (quoteRate <= 0) return 0;
  const purchaseCurrency = item.purchase_currency.trim().toUpperCase();
  let costRateCNY = 0;
  if (purchaseCurrency === "CNY") costRateCNY = 1;
  else if (purchaseCurrency && purchaseCurrency === currency.toUpperCase()) costRateCNY = quoteRate;
  else costRateCNY = Number(item.workflow_data?.cost_exchange_rate || 0);
  if (costRateCNY <= 0) return 0;
  return (item.purchase_price * costRateCNY) / quoteRate;
}

function priceFromMargin(cost: number, margin: string) {
  return cost > 0 ? String(roundUp2(cost * (1 + Math.max(0, Number(margin || 0)) / 100))) : "";
}

function marginFromPrice(cost: number, price: string) {
  const value = Number(price || 0);
  return cost > 0 && value > 0 ? String(round2((value / cost - 1) * 100)) : "";
}

function initialDraft(order: TradeOrder, source: TradeCustomerQuoteRound | undefined, canPrice: boolean): Draft {
  const currency = source?.currency || order.currency || "USD";
  const rate =
    (source?.exchange_rate_cny || 0) > 0
      ? String(source?.exchange_rate_cny)
      : order.quote_exchange_rate_cny > 0
        ? String(order.quote_exchange_rate_cny)
        : currency === "CNY"
          ? "1"
          : "";
  const defaultMargin = String(source ? source.profit_margin_percent || 0 : canPrice ? DEFAULT_MARGIN_PERCENT : 0);
  const lines = (order.items || [])
    .filter((item) => !tradeItemUnavailable(item))
    .map((item): LineDraft => {
      const previous = source?.items.find((candidate) => candidate.order_item_id === item.id);
      const cost = canPrice ? unitCostInQuote(item, currency, rate) : 0;
      const margin = previous?.margin_percent ? String(previous.margin_percent) : defaultMargin;
      const price = previous?.unit_price ? String(previous.unit_price) : priceFromMargin(cost, margin);
      return {
        order_item_id: item.id,
        line_no: item.line_no,
        sku: item.sku,
        product_name: item.product_name,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: price,
        margin: previous ? (previous.margin_percent ? margin : marginFromPrice(cost, price) || margin) : margin,
        freight: previous?.freight_amount ? String(previous.freight_amount) : "",
        weight: previous?.weight_kg ? String(previous.weight_kg) : "",
        selected: !previous?.declined,
        custom: Boolean(previous?.margin_percent && String(previous.margin_percent) !== defaultMargin),
      };
    });
  return {
    currency,
    exchange_rate_cny: rate,
    default_margin: defaultMargin,
    freight_mode: source?.freight_mode || order.freight_mode || "customer_forwarder",
    status: "sent",
    customer_feedback: source?.customer_feedback || "",
    notes: "",
    freight_per_kg: "",
    lines,
  };
}

export function CustomerQuoteRoundModal({ order, source, canUsePurchasePricing: canPrice, saving, onClose, onSave, onError }: Props) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(order, source, canPrice));
  const itemByID = useMemo(() => new Map((order.items || []).map((item) => [item.id, item])), [order.items]);
  const quotedFreight = draft.freight_mode === "quoted";
  const cost = (line: LineDraft, next: Pick<Draft, "currency" | "exchange_rate_cny"> = draft) =>
    canPrice ? unitCostInQuote(itemByID.get(line.order_item_id), next.currency, next.exchange_rate_cny) : 0;

  const repriceAll = (next: Draft): Draft => ({
    ...next,
    lines: next.lines.map((line) => {
      const price = priceFromMargin(cost(line, next), line.margin);
      return price ? { ...line, unit_price: price } : line;
    }),
  });
  const updateLine = (id: number, patch: (line: LineDraft) => Partial<LineDraft>) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.order_item_id === id ? { ...line, ...patch(line) } : line)),
    }));

  const totals = useMemo(() => {
    let goods = 0;
    let freight = 0;
    let weight = 0;
    let allGoods = 0;
    let selected = 0;
    for (const line of draft.lines) {
      const amount = Number(line.unit_price || 0) * line.quantity;
      allGoods += amount;
      if (!line.selected) continue;
      selected += 1;
      goods += amount;
      if (quotedFreight) freight += Number(line.freight || 0);
      weight += Number(line.weight || 0) * line.quantity;
    }
    const total = goods + freight;
    const rate = draft.currency.toUpperCase() === "CNY" ? 1 : Number(draft.exchange_rate_cny || 0);
    return { goods, freight, weight, allGoods, selected, total, totalCNY: total * rate };
  }, [draft, quotedFreight]);
  const allSelected = totals.selected === draft.lines.length;

  const applyFreightByWeight = () => {
    const perKg = Number(draft.freight_per_kg || 0);
    if (perKg <= 0) return onError("请先填写每公斤运费。");
    const withWeight = draft.lines.filter((line) => line.selected && Number(line.weight || 0) > 0).length;
    if (withWeight === 0) return onError("请先为要计算运费的产品填写单重。");
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.selected && Number(line.weight || 0) > 0
          ? { ...line, freight: String(round2(Number(line.weight) * line.quantity * perKg)) }
          : line,
      ),
    }));
  };

  const save = () => {
    if (draft.lines.some((line) => !(Number(line.unit_price) > 0))) return onError("请为本轮所有产品填写大于零的对客单价（客户不买的产品也会保留报价）。");
    if (totals.selected === 0) return onError("请至少勾选一项客户采购的产品。");
    const rate = Number(draft.exchange_rate_cny || 0);
    if (draft.currency.toUpperCase() !== "CNY" && rate <= 0) return onError(`请填写 1 ${draft.currency} 兑人民币的报价汇率。`);
    if (canPrice && draft.lines.some((line) => Number(line.margin || 0) < 0 || Number(line.margin || 0) > 1000))
      return onError("加价率需要在 0 到 1000 之间。");
    if (quotedFreight && totals.freight <= 0) return onError("选择我方报价运费后，请为采购的产品填写运费。");
    onSave({
      currency: draft.currency,
      exchange_rate_cny: draft.currency.toUpperCase() === "CNY" ? 1 : rate,
      profit_margin_percent: canPrice ? Number(draft.default_margin || 0) : 0,
      freight_mode: draft.freight_mode,
      freight_amount: quotedFreight ? round2(totals.freight) : 0,
      status: draft.status,
      customer_feedback: draft.customer_feedback.trim(),
      notes: draft.notes.trim(),
      items: draft.lines.map((line) => ({
        order_item_id: line.order_item_id,
        unit_price: Number(line.unit_price),
        margin_percent: canPrice ? Math.max(0, Number(line.margin || 0)) : 0,
        freight_amount: quotedFreight ? Math.max(0, Number(line.freight || 0)) : 0,
        weight_kg: Math.max(0, Number(line.weight || 0)),
        declined: !line.selected,
      })),
    });
  };

  const inputClass = "h-8 w-full rounded-md border border-slate-200 px-2 text-right tabular-nums outline-none focus:border-sky-400 disabled:bg-slate-50";
  const footerSpan = 4 + (canPrice ? 2 : 0) + (quotedFreight ? 1 : 0);

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4" data-customer-quote-modal>
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">新建对客报价轮次</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {order.order_no} · 每个产品可单独设加价率和运费；全部产品都保留报价并进入报价库，勾选的是客户要买的产品。
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className={`grid gap-3 sm:grid-cols-2 ${canPrice ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
            <label className="text-sm font-medium">
              报价币种
              <input
                list="trade-currency-options"
                value={draft.currency}
                onChange={(event) => {
                  const currency = event.target.value.toUpperCase();
                  setDraft((current) => {
                    const changed = currency !== current.currency;
                    const next: Draft = {
                      ...current,
                      currency,
                      exchange_rate_cny: currency === "CNY" ? "1" : changed ? "" : current.exchange_rate_cny,
                      lines: canPrice && changed ? current.lines.map((line) => ({ ...line, unit_price: "" })) : current.lines,
                    };
                    return canPrice ? repriceAll(next) : next;
                  });
                }}
                className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 uppercase outline-none"
              />
            </label>
            <label className="text-sm font-medium">
              兑人民币汇率
              <input
                type="number"
                min="0"
                step="any"
                disabled={draft.currency === "CNY"}
                value={draft.currency === "CNY" ? "1" : draft.exchange_rate_cny}
                onChange={(event) => {
                  const next = { ...draft, exchange_rate_cny: event.target.value };
                  setDraft(canPrice ? repriceAll(next) : next);
                }}
                className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none disabled:bg-slate-100"
                placeholder={`1 ${draft.currency} = ? CNY`}
              />
            </label>
            {canPrice && (
              <label className="text-sm font-medium">
                统一加价率
                <div className="relative mt-1.5">
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    step="0.1"
                    value={draft.default_margin}
                    onChange={(event) => {
                      const margin = event.target.value;
                      setDraft((current) =>
                        repriceAll({
                          ...current,
                          default_margin: margin,
                          lines: current.lines.map((line) => (line.custom ? line : { ...line, margin })),
                        }),
                      );
                    }}
                    className="h-10 w-full rounded-lg border border-slate-200 px-3 pr-8 outline-none focus:border-sky-400"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-400">%</span>
                </div>
              </label>
            )}
            <label className="text-sm font-medium">
              运费方式
              <select
                value={draft.freight_mode}
                onChange={(event) => setDraft((current) => ({ ...current, freight_mode: event.target.value as Draft["freight_mode"] }))}
                className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3"
              >
                <option value="customer_forwarder">客户自有货代，不报价运费</option>
                <option value="quoted">我方报价运费（按产品分别填写）</option>
              </select>
            </label>
            <label className="text-sm font-medium">
              保存状态
              <select
                value={draft.status}
                onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as Draft["status"] }))}
                className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3"
              >
                <option value="sent">已向客户报价</option>
                <option value="draft">仅保存草稿</option>
              </select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canPrice ? (
              <div className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-emerald-800">
                  <Calculator className="h-4 w-4 shrink-0" />
                  成本自动定价：改加价率自动算单价，改单价自动反算加价率。单独改过的产品不跟随统一加价率。
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) =>
                      repriceAll({ ...current, lines: current.lines.map((line) => ({ ...line, margin: current.default_margin, custom: false })) }),
                    )
                  }
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-emerald-200 bg-white px-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  全部按统一加价率重算
                </button>
              </div>
            ) : (
              <div className="flex flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600">
                <ShieldCheck className="h-4 w-4 shrink-0" />
                手工报价 · 采购成本已按权限隐藏
              </div>
            )}
            {quotedFreight && (
              <div className="flex items-center gap-2 rounded-lg border border-sky-100 bg-sky-50 px-3 py-1.5 text-xs text-sky-800">
                <Scale className="h-4 w-4 shrink-0" />
                按重量算运费：每 kg
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={draft.freight_per_kg}
                  onChange={(event) => setDraft((current) => ({ ...current, freight_per_kg: event.target.value }))}
                  className="h-7 w-20 rounded-md border border-sky-200 bg-white px-2 text-right outline-none"
                  placeholder="0"
                  aria-label="每公斤运费"
                />
                {draft.currency}
                <button type="button" onClick={applyFreightByWeight} className="h-7 rounded-md bg-sky-600 px-2 font-semibold text-white">
                  计算
                </button>
              </div>
            )}
          </div>

          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[920px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(element) => {
                        if (element) element.indeterminate = totals.selected > 0 && !allSelected;
                      }}
                      onChange={() => setDraft((current) => ({ ...current, lines: current.lines.map((line) => ({ ...line, selected: !allSelected })) }))}
                      className="h-4 w-4 accent-sky-700"
                      aria-label="全选客户采购的产品"
                      title="全选 / 全不选"
                    />
                  </th>
                  <th className="px-2 py-2">产品</th>
                  <th className="px-2 py-2 text-right">数量</th>
                  {canPrice && <th className="px-2 py-2 text-right">采购成本</th>}
                  {canPrice && <th className="w-24 px-2 py-2 text-right">加价率 %</th>}
                  <th className="w-32 px-2 py-2 text-right">对客单价</th>
                  <th className="w-24 px-2 py-2 text-right">单重 kg</th>
                  {quotedFreight && <th className="w-28 px-2 py-2 text-right">运费</th>}
                  <th className="px-3 py-2 text-right">金额</th>
                </tr>
              </thead>
              <tbody>
                {draft.lines.map((line) => {
                  const item = itemByID.get(line.order_item_id);
                  const lineCost = cost(line);
                  const amount = Number(line.unit_price || 0) * line.quantity + (quotedFreight ? Number(line.freight || 0) : 0);
                  return (
                    <tr key={line.order_item_id} data-quote-line={line.sku || line.product_name} className={`border-t border-slate-100 ${line.selected ? "" : "bg-slate-50 text-slate-400"}`}>
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={line.selected}
                          onChange={() => updateLine(line.order_item_id, (current) => ({ selected: !current.selected }))}
                          className="h-4 w-4 accent-sky-700"
                          aria-label={`客户采购 ${line.sku || line.product_name}`}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className={`font-medium ${line.selected ? "text-slate-800" : ""}`}>{line.sku || line.product_name || `第 ${line.line_no} 行`}</div>
                        <div className="text-xs text-slate-400">
                          {line.product_name && line.product_name !== line.sku ? line.product_name : ""}
                          {!line.selected && <span className="ml-1 rounded bg-slate-200 px-1 text-[10px] font-semibold text-slate-600">客户不买 · 仍保留报价</span>}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {line.quantity} {line.unit}
                      </td>
                      {canPrice && (
                        <td className="px-2 py-1.5 text-right text-xs tabular-nums text-slate-500">
                          {item && item.purchase_price > 0 ? `${item.purchase_currency || draft.currency} ${item.purchase_price.toLocaleString("zh-CN")}` : "-"}
                          {lineCost > 0 && item?.purchase_currency.toUpperCase() !== draft.currency.toUpperCase() && (
                            <div className="text-[10px] text-slate-400">≈ {money(draft.currency, lineCost)}</div>
                          )}
                        </td>
                      )}
                      {canPrice && (
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            min="0"
                            max="1000"
                            step="0.1"
                            value={line.margin}
                            onChange={(event) => {
                              const margin = event.target.value;
                              updateLine(line.order_item_id, () => ({ margin, custom: true, ...(lineCost > 0 ? { unit_price: priceFromMargin(lineCost, margin) } : {}) }));
                            }}
                            className={`${inputClass} ${line.custom ? "border-amber-300 text-amber-800" : "text-emerald-700"}`}
                            aria-label={`加价率 ${line.sku}`}
                            title={line.custom ? "单独设置的加价率" : "跟随统一加价率"}
                          />
                        </td>
                      )}
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={line.unit_price}
                          onChange={(event) => {
                            const price = event.target.value;
                            updateLine(line.order_item_id, () => ({ unit_price: price, ...(lineCost > 0 ? { margin: marginFromPrice(lineCost, price), custom: true } : {}) }));
                          }}
                          className={inputClass}
                          placeholder="必填"
                          aria-label={`对客单价 ${line.sku}`}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={line.weight}
                          onChange={(event) => updateLine(line.order_item_id, () => ({ weight: event.target.value }))}
                          className={inputClass}
                          placeholder="选填"
                          aria-label={`单重 ${line.sku}`}
                        />
                      </td>
                      {quotedFreight && (
                        <td className="px-2 py-1.5">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={line.freight}
                            onChange={(event) => updateLine(line.order_item_id, () => ({ freight: event.target.value }))}
                            className={inputClass}
                            placeholder="0"
                            aria-label={`运费 ${line.sku}`}
                          />
                        </td>
                      )}
                      <td className={`px-3 py-1.5 text-right font-semibold tabular-nums ${line.selected ? "text-slate-700" : "line-through"}`}>
                        {amount > 0 ? money(draft.currency, amount) : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-slate-200 bg-slate-50 text-xs">
                {[
                  ["客户采购", `${totals.selected} / ${draft.lines.length} 项${totals.weight > 0 ? ` · 约 ${round2(totals.weight)} kg` : ""}`, "text-slate-700"],
                  ["采购商品金额", money(draft.currency, totals.goods), "text-slate-700"],
                  ["报价运费", quotedFreight ? money(draft.currency, totals.freight) : "客户自有货代", "text-slate-700"],
                  ["本轮成交合计", money(draft.currency, totals.total), "text-sky-700"],
                  ["折合人民币", totals.totalCNY > 0 ? money("CNY", totals.totalCNY) : "待填写汇率", "text-rose-700"],
                  ...(totals.selected < draft.lines.length ? [["全部产品报价（含不买的）", money(draft.currency, totals.allGoods), "text-slate-400"]] : []),
                ].map(([label, value, tone]) => (
                  <tr key={label} className="border-t border-slate-200/70">
                    <td colSpan={footerSpan} className="px-3 py-1.5 text-right font-semibold text-slate-500">
                      {label}
                    </td>
                    <td className={`px-3 py-1.5 text-right text-sm font-semibold tabular-nums ${tone}`}>{value}</td>
                  </tr>
                ))}
              </tfoot>
            </table>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium">
              客户反馈或本轮议价依据
              <textarea
                value={draft.customer_feedback}
                onChange={(event) => setDraft((current) => ({ ...current, customer_feedback: event.target.value }))}
                className="mt-1.5 min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none"
                placeholder="例如：客户希望总价降低 5%，或只要其中几个 SKU"
              />
            </label>
            <label className="text-sm font-medium">
              内部备注
              <textarea
                value={draft.notes}
                onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                className="mt-1.5 min-h-20 w-full rounded-lg border border-slate-200 px-3 py-2 outline-none"
                placeholder="利润、审批或报价策略说明，仅内部可见"
              />
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="h-9 rounded-lg border border-slate-200 px-4 text-sm disabled:opacity-40">
            取消
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-700 px-4 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-40"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            保存本轮报价
          </button>
        </div>
      </div>
    </div>
  );
}
