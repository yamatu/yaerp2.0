"use client";

import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Calculator, ClipboardPaste, Loader2, RotateCcw, Scale, Send, ShieldCheck, X } from "lucide-react";
import { tradeItemUnavailable } from "@/lib/tradeItems";
import {
  CUSTOMER_QUOTE_IMPORT_COLUMNS,
  parseCustomerQuoteText,
  parsePastedNumber,
  splitPastedLine,
  type ParsedCustomerQuoteRow,
} from "@/lib/customerQuoteImport";
import type { TradeCustomerQuoteRound, TradeOrder, TradeOrderItem } from "@/types";

const DEFAULT_MARGIN_PERCENT = 15;

type ValueField = "margin" | "unit_price" | "weight" | "freight";
type LineValues = Partial<Record<ValueField, string>>;

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
  /** The line no longer follows the shared markup. */
  custom: boolean;
}

interface Draft {
  currency: string;
  exchange_rate_cny: string;
  default_margin: string;
  freight_mode: "customer_forwarder" | "quoted";
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
  /** Earlier round whose prices seed a new round. */
  source?: TradeCustomerQuoteRound;
  /** Unfinished round edited in place. */
  editing?: TradeCustomerQuoteRound;
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
const num = (text: string) => {
  const value = Number(text || 0);
  return Number.isFinite(value) ? value : 0;
};

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
  return cost > 0 && margin.trim() !== "" ? String(roundUp2(cost * (1 + Math.max(0, num(margin)) / 100))) : "";
}

function marginFromPrice(cost: number, price: string) {
  const value = num(price);
  return cost > 0 && value > 0 ? String(round2((value / cost - 1) * 100)) : "";
}

function initialDraft(order: TradeOrder, base: TradeCustomerQuoteRound | undefined, canPrice: boolean): Draft {
  const currency = base?.currency || order.currency || "USD";
  const rate =
    (base?.exchange_rate_cny || 0) > 0
      ? String(base?.exchange_rate_cny)
      : order.quote_exchange_rate_cny > 0
        ? String(order.quote_exchange_rate_cny)
        : currency === "CNY"
          ? "1"
          : "";
  const defaultMargin = String(base ? base.profit_margin_percent || 0 : canPrice ? DEFAULT_MARGIN_PERCENT : 0);
  const lines = (order.items || [])
    .filter((item) => !tradeItemUnavailable(item))
    .map((item): LineDraft => {
      const previous = base?.items.find((candidate) => candidate.order_item_id === item.id);
      const cost = canPrice ? unitCostInQuote(item, currency, rate) : 0;
      const margin = previous?.margin_percent ? String(previous.margin_percent) : defaultMargin;
      const price = previous?.unit_price ? String(previous.unit_price) : previous ? "" : priceFromMargin(cost, margin);
      return {
        order_item_id: item.id,
        line_no: item.line_no,
        sku: item.sku,
        product_name: item.product_name,
        quantity: item.quantity,
        unit: item.unit,
        unit_price: price,
        margin: previous?.unit_price && !previous.margin_percent ? marginFromPrice(cost, price) || margin : margin,
        freight: previous?.freight_amount ? String(previous.freight_amount) : "",
        weight: previous?.weight_kg ? String(previous.weight_kg) : "",
        custom: Boolean(previous?.margin_percent && String(previous.margin_percent) !== defaultMargin),
      };
    });
  return {
    currency,
    exchange_rate_cny: rate,
    default_margin: defaultMargin,
    freight_mode: base?.freight_mode || order.freight_mode || "customer_forwarder",
    customer_feedback: base?.customer_feedback || "",
    notes: base?.notes || "",
    freight_per_kg: "",
    lines,
  };
}

export function CustomerQuoteRoundModal({ order, source, editing, canUsePurchasePricing: canPrice, saving, onClose, onSave, onError }: Props) {
  const [draft, setDraft] = useState<Draft>(() => {
    const initial = initialDraft(order, editing || source, canPrice);
    return editing ? initial : { ...initial, notes: "" };
  });
  // Snapshot of the unpriced rows, so a row stays visible while it is typed in.
  const [missingFilter, setMissingFilter] = useState<Set<number> | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const tableRef = useRef<HTMLTableSectionElement>(null);
  const itemByID = useMemo(() => new Map((order.items || []).map((item) => [item.id, item])), [order.items]);
  const quotedFreight = draft.freight_mode === "quoted";
  const editingSent = editing?.status === "sent";
  const cost = (line: LineDraft, next: Pick<Draft, "currency" | "exchange_rate_cny"> = draft) =>
    canPrice ? unitCostInQuote(itemByID.get(line.order_item_id), next.currency, next.exchange_rate_cny) : 0;

  const fields: ValueField[] = [...(canPrice ? (["margin"] as const) : []), "unit_price", "weight", ...(quotedFreight ? (["freight"] as const) : [])];
  const missing = draft.lines.filter((line) => !(num(line.unit_price) > 0));
  const onlyMissing = missingFilter !== null;
  const visibleLines = missingFilter ? draft.lines.filter((line) => missingFilter.has(line.order_item_id)) : draft.lines;
  const filterMissing = (on: boolean) => setMissingFilter(on ? new Set(missing.map((line) => line.order_item_id)) : null);

  const repriceAll = (next: Draft): Draft => ({
    ...next,
    lines: next.lines.map((line) => {
      const price = priceFromMargin(cost(line, next), line.margin);
      return price ? { ...line, unit_price: price } : line;
    }),
  });

  /** Writes typed, pasted or imported values; a price wins over a markup. */
  const withValues = (line: LineDraft, values: LineValues): LineDraft => {
    const next = { ...line };
    const lineCost = cost(line);
    if (values.weight !== undefined) next.weight = values.weight;
    if (values.freight !== undefined) next.freight = values.freight;
    if (values.unit_price !== undefined) {
      next.unit_price = values.unit_price;
      if (lineCost > 0 && values.unit_price !== "") {
        next.margin = marginFromPrice(lineCost, values.unit_price);
        next.custom = true;
      }
    } else if (canPrice && values.margin !== undefined) {
      next.margin = values.margin;
      next.custom = true;
      const price = priceFromMargin(lineCost, values.margin);
      if (price) next.unit_price = price;
    }
    return next;
  };
  const patchLines = (patches: Map<number, LineValues>) =>
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) => (patches.has(line.order_item_id) ? withValues(line, patches.get(line.order_item_id)!) : line)),
    }));
  const setValue = (id: number, field: ValueField, value: string) => patchLines(new Map([[id, { [field]: value }]]));

  // Pasting a block copied from Excel fills the cells to the right and below,
  // the same way a spreadsheet does.
  const pasteCells = (event: ClipboardEvent<HTMLInputElement>, rowIndex: number, field: ValueField) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const grid = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n").map(splitPastedLine);
    const start = fields.indexOf(field);
    const patches = new Map<number, LineValues>();
    grid.forEach((cells, rowOffset) => {
      const line = visibleLines[rowIndex + rowOffset];
      if (!line) return;
      const values: LineValues = {};
      cells.forEach((cell, columnOffset) => {
        const target = fields[start + columnOffset];
        if (!target) return;
        const value = parsePastedNumber(cell);
        if (value !== "" || grid.length === 1) values[target] = value;
      });
      if (Object.keys(values).length) patches.set(line.order_item_id, values);
    });
    patchLines(patches);
    const overflow = rowIndex + grid.length - visibleLines.length;
    if (overflow > 0) onError(`粘贴了 ${grid.length} 行，但从这里往下只有 ${visibleLines.length - rowIndex} 个产品，多出的 ${overflow} 行已忽略。`);
  };

  const moveFocus = (event: KeyboardEvent<HTMLInputElement>, rowIndex: number, field: ValueField) => {
    if (event.key !== "Enter" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const step = event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1;
    const next = tableRef.current?.querySelector<HTMLInputElement>(`[data-cell="${rowIndex + step}:${field}"]`);
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.select();
  };

  const importItems = useMemo(
    () => draft.lines.map(({ order_item_id, line_no, sku, product_name }) => ({ order_item_id, line_no, sku, product_name })),
    [draft.lines],
  );
  const parsed = useMemo(() => (importText.trim() ? parseCustomerQuoteText(importText, importItems) : null), [importText, importItems]);
  const importable = parsed?.rows.filter((row) => !row.error) || [];
  const applyImport = (rows: ParsedCustomerQuoteRow[]) => {
    const patches = new Map<number, LineValues>();
    let hasFreight = false;
    for (const row of rows) {
      if (!row.item) continue;
      const values: LineValues = { ...patches.get(row.item.order_item_id) };
      if (row.unitPrice) values.unit_price = row.unitPrice;
      if (row.margin && canPrice) values.margin = row.margin;
      if (row.weight) values.weight = row.weight;
      if (row.freight) {
        values.freight = row.freight;
        hasFreight = hasFreight || num(row.freight) > 0;
      }
      patches.set(row.item.order_item_id, values);
    }
    if (hasFreight && !quotedFreight) setDraft((current) => ({ ...current, freight_mode: "quoted" }));
    patchLines(patches);
    setImportOpen(false);
    setImportText("");
  };

  const totals = useMemo(() => {
    let goods = 0;
    let freight = 0;
    let weight = 0;
    for (const line of draft.lines) {
      goods += num(line.unit_price) * line.quantity;
      if (quotedFreight) freight += num(line.freight);
      weight += num(line.weight) * line.quantity;
    }
    const total = goods + freight;
    const rate = draft.currency.toUpperCase() === "CNY" ? 1 : num(draft.exchange_rate_cny);
    return { goods, freight, weight, total, totalCNY: total * rate };
  }, [draft, quotedFreight]);

  const applyFreightByWeight = () => {
    const perKg = num(draft.freight_per_kg);
    if (perKg <= 0) return onError("请先填写每公斤运费。");
    if (!draft.lines.some((line) => num(line.weight) > 0)) return onError("请先为要计算运费的产品填写单重。");
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        num(line.weight) > 0 ? { ...line, freight: String(round2(num(line.weight) * line.quantity * perKg)) } : line,
      ),
    }));
  };

  const submit = (status: "draft" | "sent") => {
    if (canPrice && draft.lines.some((line) => num(line.margin) < 0 || num(line.margin) > 1000)) return onError("加价率需要在 0 到 1000 之间。");
    const rate = num(draft.exchange_rate_cny);
    if (status === "sent") {
      if (missing.length > 0) {
        setShowMissing(true);
        filterMissing(true);
        const names = missing.slice(0, 6).map((line) => line.sku || line.product_name || `第 ${line.line_no} 行`);
        return onError(`还有 ${missing.length} 项没填对客单价：${names.join("、")}${missing.length > 6 ? " 等" : ""}。可以先「保存草稿」，填完再发给客户。`);
      }
      if (draft.currency.toUpperCase() !== "CNY" && rate <= 0) return onError(`请填写 1 ${draft.currency} 兑人民币的报价汇率，或先保存草稿。`);
      if (quotedFreight && totals.freight <= 0) return onError("选择我方报价运费后，请为产品填写运费，或先保存草稿。");
    }
    onSave({
      currency: draft.currency.trim().toUpperCase(),
      exchange_rate_cny: draft.currency.toUpperCase() === "CNY" ? 1 : Math.max(0, rate),
      profit_margin_percent: canPrice ? Math.max(0, num(draft.default_margin)) : 0,
      freight_mode: draft.freight_mode,
      freight_amount: quotedFreight ? round2(totals.freight) : 0,
      status,
      customer_feedback: draft.customer_feedback.trim(),
      notes: draft.notes.trim(),
      items: draft.lines.map((line) => ({
        order_item_id: line.order_item_id,
        unit_price: Math.max(0, num(line.unit_price)),
        margin_percent: canPrice ? Math.max(0, num(line.margin)) : 0,
        freight_amount: quotedFreight ? Math.max(0, num(line.freight)) : 0,
        weight_kg: Math.max(0, num(line.weight)),
        declined: false,
      })),
    });
  };

  const inputClass = "h-8 w-full rounded-md border border-slate-200 px-2 text-right tabular-nums outline-none focus:border-sky-400 disabled:bg-slate-50";
  const footerSpan = 3 + fields.length + (canPrice ? 1 : 0) - 1;
  const cellInput = (line: LineDraft, rowIndex: number, field: ValueField, extra: string, placeholder: string, label: string) => (
    <input
      type="text"
      inputMode="decimal"
      data-cell={`${rowIndex}:${field}`}
      value={line[field]}
      onChange={(event) => setValue(line.order_item_id, field, event.target.value.replace(/[^\d.]/g, ""))}
      onPaste={(event) => pasteCells(event, rowIndex, field)}
      onKeyDown={(event) => moveFocus(event, rowIndex, field)}
      onFocus={(event) => event.target.select()}
      className={`${inputClass} ${extra}`}
      placeholder={placeholder}
      aria-label={`${label} ${line.sku || line.product_name}`}
    />
  );

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4" data-customer-quote-modal>
      <div className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">
              {editing ? `编辑第 ${editing.round_no} 轮报价${editing.status === "draft" ? "（草稿）" : ""}` : "新建对客报价"}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {order.order_no} · 这里只填报价，可以随时存草稿；客户确定要哪些产品后，再在「客户接受」里勾选客户下单的产品。
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40" title="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className={`grid gap-3 sm:grid-cols-2 ${canPrice ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
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
                type="text"
                inputMode="decimal"
                disabled={draft.currency === "CNY"}
                value={draft.currency === "CNY" ? "1" : draft.exchange_rate_cny}
                onChange={(event) => {
                  const next = { ...draft, exchange_rate_cny: event.target.value.replace(/[^\d.]/g, "") };
                  setDraft(canPrice ? repriceAll(next) : next);
                }}
                className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 px-3 outline-none disabled:bg-slate-100"
                placeholder={`1 ${draft.currency} = ? CNY（草稿可不填）`}
              />
            </label>
            {canPrice && (
              <label className="text-sm font-medium">
                统一加价率
                <div className="relative mt-1.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={draft.default_margin}
                    onChange={(event) => {
                      const margin = event.target.value.replace(/[^\d.]/g, "");
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
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {canPrice ? (
              <div className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2">
                <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-emerald-800">
                  <Calculator className="h-4 w-4 shrink-0" />
                  改加价率自动算单价，改单价自动反算加价率；单独改过的产品不跟随统一加价率。
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
                  type="text"
                  inputMode="decimal"
                  value={draft.freight_per_kg}
                  onChange={(event) => setDraft((current) => ({ ...current, freight_per_kg: event.target.value.replace(/[^\d.]/g, "") }))}
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

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex gap-1.5" role="tablist" aria-label="按填写状态筛选">
              {[
                [false, `全部 ${draft.lines.length}`],
                [true, `未填价 ${missing.length}`],
              ].map(([value, label]) => (
                <button
                  key={String(value)}
                  type="button"
                  role="tab"
                  aria-selected={onlyMissing === value}
                  onClick={() => filterMissing(value as boolean)}
                  className={`h-8 rounded-full border px-3 text-xs font-semibold ${onlyMissing === value ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  {label as string}
                </button>
              ))}
            </div>
            <span className="text-xs text-slate-400">可直接从 Excel 复制一列或多列，点中单元格粘贴，会向下 / 向右自动填充；回车跳到下一行。</span>
            <button
              type="button"
              onClick={() => setImportOpen((current) => !current)}
              className={`ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${importOpen ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"}`}
            >
              <ClipboardPaste className="h-3.5 w-3.5" />
              按 SKU 批量导入
            </button>
          </div>

          {importOpen && (
            <div className="mt-3 rounded-lg border border-sky-200 bg-white p-3" data-customer-quote-import>
              <div className="text-xs text-slate-600">
                从 Excel / WPS 复制后粘贴，每行一个产品，按 SKU 或品名匹配，顺序不限。可带表头（列顺序随意），不带表头时按顺序：
                <span className="font-semibold text-slate-800"> {CUSTOMER_QUOTE_IMPORT_COLUMNS.join(" · ")}</span>
                。只填了单价也可以，空的列不会覆盖已有数据。
              </div>
              <textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={"SKU\t对客单价\t单重kg\nA-001\t12.5\t0.3\nA-002\t8.8"}
                className="mt-2 h-32 w-full resize-y rounded-md border border-slate-200 p-2 font-mono text-xs outline-none focus:border-sky-400"
              />
              {parsed && (
                <div className="mt-2 max-h-48 overflow-auto rounded-md border border-slate-100">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                      <tr>
                        <th className="px-2 py-1">行</th>
                        <th className="px-2 py-1">产品</th>
                        <th className="px-2 py-1 text-right">单价</th>
                        {canPrice && <th className="px-2 py-1 text-right">加价率</th>}
                        <th className="px-2 py-1 text-right">单重</th>
                        <th className="px-2 py-1 text-right">运费</th>
                        <th className="px-2 py-1">结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.rows.map((row) => (
                        <tr key={row.source} className={`border-t border-slate-100 ${row.error ? "bg-rose-50/60" : ""}`}>
                          <td className="px-2 py-1 text-slate-400">{row.source}</td>
                          <td className="px-2 py-1">{row.item ? row.item.sku || row.item.product_name : row.itemText || "-"}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{row.unitPrice || "-"}</td>
                          {canPrice && <td className="px-2 py-1 text-right tabular-nums">{row.margin ? `${row.margin}%` : "-"}</td>}
                          <td className="px-2 py-1 text-right tabular-nums">{row.weight || "-"}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{row.freight || "-"}</td>
                          <td className="px-2 py-1">{row.error ? <span className="text-rose-600">{row.error}</span> : <span className="text-emerald-700">可导入</span>}</td>
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
                    : "粘贴后会先预览，确认无误再填入下方表格。"}
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

          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">产品</th>
                  <th className="px-2 py-2 text-right">数量</th>
                  {canPrice && <th className="px-2 py-2 text-right">采购成本</th>}
                  {canPrice && <th className="w-24 px-2 py-2 text-right">加价率 %</th>}
                  <th className="w-32 px-2 py-2 text-right">对客单价</th>
                  <th className="w-24 px-2 py-2 text-right">单重 kg</th>
                  {quotedFreight && <th className="w-28 px-2 py-2 text-right">运费</th>}
                  <th className="px-3 py-2 text-right">金额</th>
                </tr>
              </thead>
              <tbody ref={tableRef}>
                {visibleLines.length === 0 && (
                  <tr>
                    <td colSpan={footerSpan + 1} className="px-3 py-8 text-center text-sm text-emerald-700">
                      {missing.length ? "没有符合条件的产品。" : "全部产品都已填好对客单价。"}
                    </td>
                  </tr>
                )}
                {visibleLines.map((line, rowIndex) => {
                  const item = itemByID.get(line.order_item_id);
                  const lineCost = cost(line);
                  const priced = num(line.unit_price) > 0;
                  const amount = num(line.unit_price) * line.quantity + (quotedFreight ? num(line.freight) : 0);
                  return (
                    <tr
                      key={line.order_item_id}
                      data-quote-line={line.sku || line.product_name}
                      className={`border-t border-slate-100 ${showMissing && !priced ? "bg-rose-50/60" : ""}`}
                    >
                      <td className="px-3 py-1.5">
                        <div className="font-medium text-slate-800">{line.sku || line.product_name || `第 ${line.line_no} 行`}</div>
                        {line.product_name && line.product_name !== line.sku && <div className="text-xs text-slate-400">{line.product_name}</div>}
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
                        <td className="px-2 py-1.5" title={line.custom ? "单独设置的加价率" : "跟随统一加价率"}>
                          {cellInput(line, rowIndex, "margin", line.custom ? "border-amber-300 text-amber-800" : "text-emerald-700", "", "加价率")}
                        </td>
                      )}
                      <td className="px-2 py-1.5">
                        {cellInput(line, rowIndex, "unit_price", showMissing && !priced ? "border-rose-300 bg-white" : "", "未填", "对客单价")}
                      </td>
                      <td className="px-2 py-1.5">{cellInput(line, rowIndex, "weight", "", "选填", "单重")}</td>
                      {quotedFreight && <td className="px-2 py-1.5">{cellInput(line, rowIndex, "freight", "", "0", "运费")}</td>}
                      <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-700">{amount > 0 ? money(draft.currency, amount) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-slate-200 bg-slate-50 text-xs">
                {[
                  ["已填对客单价", `${draft.lines.length - missing.length} / ${draft.lines.length} 项${totals.weight > 0 ? ` · 约 ${round2(totals.weight)} kg` : ""}`, missing.length ? "text-amber-700" : "text-emerald-700"],
                  ["全部产品商品金额", money(draft.currency, totals.goods), "text-slate-700"],
                  ["报价运费", quotedFreight ? money(draft.currency, totals.freight) : "客户自有货代", "text-slate-700"],
                  ["报价合计（客户全要时）", money(draft.currency, totals.total), "text-sky-700"],
                  ["折合人民币", totals.totalCNY > 0 ? money("CNY", totals.totalCNY) : "待填写汇率", "text-rose-700"],
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
                placeholder="例如：客户希望总价降低 5%，或只看中其中几个 SKU"
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

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <span className="mr-auto text-xs text-slate-400">
            {editingSent ? "本轮已发给客户，修改后仍保持「已报价」。" : "草稿不需要填全，随时保存；填完后再标记为已向客户报价。"}
          </span>
          <button type="button" onClick={onClose} disabled={saving} className="h-9 rounded-lg border border-slate-200 px-4 text-sm disabled:opacity-40">
            取消
          </button>
          {!editingSent && (
            <button
              type="button"
              onClick={() => submit("draft")}
              disabled={saving}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-sky-200 bg-white px-4 text-sm font-semibold text-sky-700 hover:bg-sky-50 disabled:opacity-40"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              保存草稿
            </button>
          )}
          <button
            type="button"
            onClick={() => submit("sent")}
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-sky-700 px-4 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {editingSent ? "保存修改" : "保存并标记已报价"}
          </button>
        </div>
      </div>
    </div>
  );
}
