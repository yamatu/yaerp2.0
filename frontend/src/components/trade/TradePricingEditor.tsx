"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Save, Trash2, UserPlus, X } from "lucide-react";
import api from "@/lib/api";
import { CustomerCombobox } from "@/components/trade/CustomerCombobox";
import { CurrencyCombobox } from "@/components/trade/CurrencyCombobox";
import { tradeActiveItems } from "@/lib/tradeItems";
import type { TradeCustomer, TradeOrder, TradeSupplier } from "@/types";

export interface PricingLine {
  key: string;
  order_item_id: number;
  sku: string;
  product_name: string;
  specification: string;
  quantity: string;
  unit: string;
  sales_price: string;
  supplier_name: string;
  purchase_currency: string;
  purchase_price: string;
}

let lineCounter = 0;

function newPricingLine(patch: Partial<PricingLine> = {}): PricingLine {
  lineCounter += 1;
  return {
    key: `line-${Date.now()}-${lineCounter}`,
    order_item_id: 0,
    sku: "",
    product_name: "",
    specification: "",
    quantity: "",
    unit: "件",
    sales_price: "",
    supplier_name: "",
    purchase_currency: "CNY",
    purchase_price: "",
    ...patch,
  };
}

function numberValue(value: string) {
  const parsed = Number(value.replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function lineFilled(line: PricingLine) {
  return Boolean(line.sku.trim() || line.product_name.trim());
}

function linePayload(line: PricingLine) {
  return {
    order_item_id: line.order_item_id,
    sku: line.sku.trim(),
    product_name: line.product_name.trim(),
    specification: line.specification.trim(),
    quantity: numberValue(line.quantity),
    unit: line.unit.trim() || "件",
    sales_price: numberValue(line.sales_price),
    supplier_name: line.supplier_name.trim(),
    purchase_currency: line.purchase_currency.trim().toUpperCase() || "CNY",
    purchase_price: numberValue(line.purchase_price),
  };
}

function validateLines(lines: PricingLine[]) {
  const filled = lines.filter(lineFilled);
  if (!filled.length) return "请至少填写一个产品的 SKU 或名称";
  const index = lines.findIndex(
    (line) => lineFilled(line) && numberValue(line.quantity) <= 0,
  );
  if (index >= 0) return `第 ${index + 1} 行请填写数量`;
  return "";
}

const RATE_KEY_PREFIX = "yaerp:trade:last-rate:";

function rememberedRate(currency: string) {
  if (typeof window === "undefined" || currency === "CNY") return "";
  return window.localStorage.getItem(RATE_KEY_PREFIX + currency) || "";
}

function rememberRate(currency: string, rate: string) {
  if (currency !== "CNY" && numberValue(rate) > 0)
    window.localStorage.setItem(RATE_KEY_PREFIX + currency, rate.trim());
}

function money(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Columns pasted from Excel: SKU, 数量, 售价, 采购价, 供应商.
function pastedLines(text: string): PricingLine[] {
  return text
    .split(/\r?\n/)
    .map((row) => row.split("\t"))
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map(([sku = "", quantity = "", sales = "", purchase = "", supplier = ""]) =>
      newPricingLine({
        sku: sku.trim(),
        quantity: quantity.trim(),
        sales_price: sales.trim(),
        purchase_price: purchase.trim(),
        supplier_name: supplier.trim(),
      }),
    );
}

// Esc closes the dialog unless focus sits in another dialog opened on top or
// a dropdown inside it is open (that Esc only closes the dropdown). Capture
// phase, so the dropdown is still open when this runs.
function useEscape(onEscape: () => void, disabled: boolean) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || disabled || event.isComposing) return;
      const active = document.activeElement;
      if (active && active !== document.body && !dialogRef.current?.contains(active)) return;
      if (dialogRef.current?.querySelector('[aria-expanded="true"]')) return;
      onEscape();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onEscape, disabled]);
  return dialogRef;
}

const inputClass =
  "h-9 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-sm outline-none focus:border-slate-400";

function PricingLinesTable({
  lines,
  onChange,
  currency,
  showCost,
}: {
  lines: PricingLine[];
  onChange: (lines: PricingLine[]) => void;
  currency: string;
  showCost: boolean;
}) {
  const update = (key: string, patch: Partial<PricingLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const remove = (key: string) => {
    const next = lines.filter((line) => line.key !== key);
    onChange(next.length ? next : [newPricingLine()]);
  };
  const pasteInto = (index: number, text: string) => {
    const parsed = pastedLines(text);
    if (!parsed.length) return false;
    const next = [...lines];
    next.splice(index, 1, ...parsed.map((line, offset) =>
      offset === 0 ? { ...line, key: lines[index].key, order_item_id: lines[index].order_item_id } : line,
    ));
    onChange(next);
    return true;
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500">
          <tr>
            <th className="w-8 px-2 py-2">#</th>
            <th className="px-2 py-2">SKU / 产品</th>
            <th className="w-24 px-2 py-2">数量</th>
            <th className="w-32 px-2 py-2">售价（{currency}）</th>
            {showCost && <th className="w-32 px-2 py-2">采购单价</th>}
            {showCost && <th className="w-40 px-2 py-2">供应商</th>}
            <th className="w-28 px-2 py-2 text-right">小计</th>
            <th className="w-10 px-2 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {lines.map((line, index) => (
            <tr key={line.key} data-pricing-line>
              <td className="px-2 py-1.5 text-xs text-slate-400">{index + 1}</td>
              <td className="px-2 py-1.5">
                <input
                  value={line.sku}
                  onChange={(event) => update(line.key, { sku: event.target.value })}
                  onPaste={(event) => {
                    const text = event.clipboardData.getData("text");
                    if (/[\t\n]/.test(text.trim()) && pasteInto(index, text))
                      event.preventDefault();
                  }}
                  placeholder="SKU（可从 Excel 粘贴多行）"
                  aria-label={`第 ${index + 1} 行 SKU`}
                  className={inputClass}
                />
                {line.product_name && line.product_name !== line.sku && (
                  <div className="mt-0.5 truncate px-1 text-[11px] text-slate-400">{line.product_name}</div>
                )}
              </td>
              <td className="px-2 py-1.5">
                <input
                  value={line.quantity}
                  inputMode="decimal"
                  onChange={(event) => update(line.key, { quantity: event.target.value })}
                  aria-label={`第 ${index + 1} 行数量`}
                  className={inputClass}
                />
              </td>
              <td className="px-2 py-1.5">
                <input
                  value={line.sales_price}
                  inputMode="decimal"
                  onChange={(event) => update(line.key, { sales_price: event.target.value })}
                  aria-label={`第 ${index + 1} 行售价`}
                  className={inputClass}
                />
              </td>
              {showCost && (
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <input
                      value={line.purchase_price}
                      inputMode="decimal"
                      onChange={(event) => update(line.key, { purchase_price: event.target.value })}
                      aria-label={`第 ${index + 1} 行采购单价`}
                      className={inputClass}
                    />
                    <select
                      value={line.purchase_currency}
                      onChange={(event) => update(line.key, { purchase_currency: event.target.value })}
                      aria-label={`第 ${index + 1} 行采购币种`}
                      className="h-9 shrink-0 rounded-lg border border-slate-200 bg-white px-1 text-xs outline-none"
                    >
                      {Array.from(new Set(["CNY", currency, line.purchase_currency].filter(Boolean))).map(
                        (code) => (
                          <option key={code} value={code}>
                            {code}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                </td>
              )}
              {showCost && (
                <td className="px-2 py-1.5">
                  <input
                    value={line.supplier_name}
                    list="trade-pricing-suppliers"
                    onChange={(event) => update(line.key, { supplier_name: event.target.value })}
                    placeholder="选填"
                    aria-label={`第 ${index + 1} 行供应商`}
                    className={inputClass}
                  />
                </td>
              )}
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">
                {(numberValue(line.quantity) * numberValue(line.sales_price)).toFixed(2)}
              </td>
              <td className="px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => remove(line.key)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  title="删除这一行"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-slate-100 p-2">
        <button
          type="button"
          onClick={() => onChange([...lines, newPricingLine()])}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <Plus className="h-3.5 w-3.5" />
          添加产品
        </button>
      </div>
    </div>
  );
}

function ProfitPreview({
  lines,
  currency,
  rate,
  showCost,
}: {
  lines: PricingLine[];
  currency: string;
  rate: number;
  showCost: boolean;
}) {
  const result = useMemo(() => {
    const cnyRate = currency === "CNY" ? 1 : rate;
    let revenue = 0;
    let costCNY = 0;
    let costKnown = true;
    for (const line of lines.filter(lineFilled)) {
      const quantity = numberValue(line.quantity);
      revenue += quantity * numberValue(line.sales_price);
      const purchase = quantity * numberValue(line.purchase_price);
      if (numberValue(line.purchase_price) <= 0) costKnown = false;
      if (line.purchase_currency === "CNY") costCNY += purchase;
      else if (cnyRate > 0) costCNY += purchase * cnyRate;
      else costKnown = false;
    }
    const revenueCNY = cnyRate > 0 ? revenue * cnyRate : 0;
    const profitCNY = revenueCNY - costCNY;
    return {
      revenue,
      revenueCNY,
      costCNY,
      profitCNY,
      margin: revenueCNY > 0 ? (profitCNY / revenueCNY) * 100 : 0,
      costKnown,
      rateMissing: cnyRate <= 0,
    };
  }, [lines, currency, rate]);

  return (
    <div className="grid gap-2 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-4" data-profit-preview>
      <div>
        <div className="text-xs text-slate-500">销售额</div>
        <div className="font-semibold tabular-nums">{money(result.revenue, currency)}</div>
        {currency !== "CNY" && !result.rateMissing && (
          <div className="text-xs text-slate-400 tabular-nums">≈ {money(result.revenueCNY, "CNY")}</div>
        )}
      </div>
      {showCost && (
        <>
          <div>
            <div className="text-xs text-slate-500">采购成本</div>
            <div className="font-semibold tabular-nums">{money(result.costCNY, "CNY")}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">货物毛利（预估）</div>
            <div
              data-profit-value
              className={`font-semibold tabular-nums ${result.profitCNY < 0 ? "text-rose-600" : "text-emerald-700"}`}
            >
              {result.rateMissing ? "请填写汇率" : money(result.profitCNY, "CNY")}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">毛利率</div>
            <div className="font-semibold tabular-nums">
              {result.rateMissing ? "-" : `${result.margin.toFixed(1)}%`}
            </div>
            {!result.costKnown && <div className="text-xs text-amber-600">部分产品未填采购价</div>}
          </div>
        </>
      )}
    </div>
  );
}

function CurrencyRateFields({
  currency,
  rate,
  onCurrencyChange,
  onRateChange,
}: {
  currency: string;
  rate: string;
  onCurrencyChange: (value: string) => void;
  onRateChange: (value: string) => void;
}) {
  return (
    <>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">售价币种</span>
        <CurrencyCombobox value={currency} onChange={onCurrencyChange} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">
          汇率（1 {currency} = ? CNY）
        </span>
        <input
          value={currency === "CNY" ? "1" : rate}
          disabled={currency === "CNY"}
          inputMode="decimal"
          onChange={(event) => onRateChange(event.target.value)}
          placeholder="例如 7.1"
          aria-label="汇率"
          className={`${inputClass} disabled:bg-slate-50 disabled:text-slate-400`}
        />
      </label>
    </>
  );
}

function SupplierOptions({ suppliers }: { suppliers: TradeSupplier[] }) {
  return (
    <datalist id="trade-pricing-suppliers">
      {suppliers.map((supplier) => (
        <option key={supplier.id} value={supplier.name} />
      ))}
    </datalist>
  );
}

export function ConfirmedOrderModal({
  customers,
  suppliers,
  showCost,
  onClose,
  onCreated,
  onCreateCustomer,
}: {
  customers: TradeCustomer[];
  suppliers: TradeSupplier[];
  showCost: boolean;
  onClose: () => void;
  onCreated: (order: TradeOrder) => void | Promise<void>;
  onCreateCustomer?: () => void;
}) {
  const [customerID, setCustomerID] = useState(0);
  const [title, setTitle] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [rate, setRate] = useState(() => rememberedRate("USD"));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<PricingLine[]>(() => [newPricingLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useEscape(onClose, saving);

  const changeCurrency = (value: string) => {
    const next = value.trim().toUpperCase() || "USD";
    setCurrency(next);
    setRate(rememberedRate(next));
  };

  const submit = async () => {
    if (!customerID) {
      setError("请选择客户");
      return;
    }
    const message = validateLines(lines);
    if (message) {
      setError(message);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const items = lines.filter(lineFilled).map((line) => {
        const payload = linePayload(line);
        return {
          sku: payload.sku,
          product_name: payload.product_name,
          specification: payload.specification,
          quantity: payload.quantity,
          unit: payload.unit,
          sales_price: payload.sales_price,
          supplier_name: payload.supplier_name,
          purchase_currency: payload.purchase_currency,
          purchase_price: payload.purchase_price,
        };
      });
      const response = await api.post<TradeOrder>("/trade/orders", {
        customer_id: customerID,
        title: title.trim(),
        currency,
        exchange_rate_cny: currency === "CNY" ? 1 : numberValue(rate),
        notes: notes.trim(),
        confirmed: true,
        items,
      });
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "录入成交订单失败");
      rememberRate(currency, rate);
      await onCreated(response.data);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "录入成交订单失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[61] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="录入成交订单"
        className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">录入成交订单</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              只录客户已确认并付款的产品，填好售价和采购成本即可自动核算利润。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
            title="关闭（Esc）"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <SupplierOptions suppliers={suppliers} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="block text-sm lg:col-span-1">
              <span className="mb-1 flex items-center justify-between text-xs font-medium text-slate-500">
                客户
                {onCreateCustomer && (
                  <button
                    type="button"
                    onClick={onCreateCustomer}
                    className="inline-flex items-center gap-1 text-sky-700 hover:underline"
                  >
                    <UserPlus className="h-3 w-3" />
                    新客户
                  </button>
                )}
              </span>
              <CustomerCombobox
                customers={customers}
                value={customerID}
                onChange={(id) => setCustomerID(id)}
              />
            </div>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-500">订单标题（选填）</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="不填自动生成"
                className={inputClass}
              />
            </label>
            <CurrencyRateFields
              currency={currency}
              rate={rate}
              onCurrencyChange={changeCurrency}
              onRateChange={setRate}
            />
          </div>
          <PricingLinesTable lines={lines} onChange={setLines} currency={currency} showCost={showCost} />
          <ProfitPreview lines={lines} currency={currency} rate={numberValue(rate)} showCost={showCost} />
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">备注（选填）</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={2}
              className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-slate-400"
            />
          </label>
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button type="button" onClick={onClose} className="h-9 rounded-lg border border-slate-200 px-4 text-sm">
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存成交订单
          </button>
        </div>
      </div>
    </div>
  );
}

export function OrderPricingModal({
  order,
  suppliers,
  convert,
  onClose,
  onSaved,
}: {
  order: TradeOrder;
  suppliers: TradeSupplier[];
  convert: boolean;
  onClose: () => void;
  onSaved: (order: TradeOrder, convert: boolean) => void | Promise<void>;
}) {
  const initialCurrency = (order.currency || "USD").toUpperCase();
  const [currency, setCurrency] = useState(initialCurrency);
  const [rate, setRate] = useState(() =>
    order.quote_exchange_rate_cny > 0 ? String(order.quote_exchange_rate_cny) : rememberedRate(initialCurrency),
  );
  const [lines, setLines] = useState<PricingLine[]>(() => {
    const items = tradeActiveItems(order.items || []);
    return items.length
      ? items.map((item) =>
          newPricingLine({
            order_item_id: item.id,
            sku: item.sku || item.product_name,
            product_name: item.product_name,
            specification: item.specification,
            quantity: item.quantity ? String(item.quantity) : "",
            unit: item.unit || "件",
            sales_price: item.quoted_price ? String(item.quoted_price) : "",
            supplier_name: item.supplier_name || "",
            purchase_currency: (item.purchase_currency || "CNY").toUpperCase(),
            purchase_price: item.purchase_price ? String(item.purchase_price) : "",
          }),
        )
      : [newPricingLine()];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useEscape(onClose, saving);

  const submit = async () => {
    const message = validateLines(lines);
    if (message) {
      setError(message);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const kept = new Set(lines.map((line) => line.order_item_id).filter(Boolean));
      const removed = tradeActiveItems(order.items || [])
        .map((item) => item.id)
        .filter((id) => !kept.has(id));
      const response = await api.put<TradeOrder>(`/trade/orders/${order.id}/pricing`, {
        currency,
        exchange_rate_cny: currency === "CNY" ? 1 : numberValue(rate),
        items: lines.filter(lineFilled).map(linePayload),
        removed_item_ids: removed,
      });
      if (response.code !== 0 || !response.data)
        throw new Error(response.message || "保存售价与成本失败");
      rememberRate(currency, rate);
      await onSaved(response.data, convert);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存售价与成本失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={convert ? "转为成交订单" : "编辑售价与成本"}
        className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">{convert ? "转为成交订单" : "编辑售价与成本"}</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {order.order_no} · {order.customer_name}
              {convert ? " · 删除客户没有购买的产品，核对售价和成本后保存。" : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
            title="关闭（Esc）"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <SupplierOptions suppliers={suppliers} />
          <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
            <CurrencyRateFields
              currency={currency}
              rate={rate}
              onCurrencyChange={(value) => {
                const next = value.trim().toUpperCase() || "USD";
                setCurrency(next);
                if (next !== currency) setRate(rememberedRate(next));
              }}
              onRateChange={setRate}
            />
          </div>
          <PricingLinesTable lines={lines} onChange={setLines} currency={currency} showCost />
          <ProfitPreview lines={lines} currency={currency} rate={numberValue(rate)} showCost />
          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button type="button" onClick={onClose} className="h-9 rounded-lg border border-slate-200 px-4 text-sm">
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {convert ? "保存并转为成交" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
