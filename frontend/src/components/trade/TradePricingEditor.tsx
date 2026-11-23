"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Save, Trash2, UserPlus, X } from "lucide-react";
import api from "@/lib/api";
import { CustomerCombobox } from "@/components/trade/CustomerCombobox";
import { CurrencyCombobox } from "@/components/trade/CurrencyCombobox";
import { amountValue, parseAmountText, sanitizeTypedNumber } from "@/lib/tradeNumbers";
import { tradeActiveItems } from "@/lib/tradeItems";
import { todayInputDate } from "@/lib/tradeSettlement";
import type { TradeCustomer, TradeOrder, TradeSupplier } from "@/types";

type ColumnKey = "sku" | "quantity" | "sales_price" | "freight_amount" | "purchase_price" | "supplier_name";

export interface PricingLine {
  key: string;
  order_item_id: number;
  product_name: string;
  specification: string;
  unit: string;
  purchase_currency: string;
  sku: string;
  quantity: string;
  sales_price: string;
  freight_amount: string;
  purchase_price: string;
  supplier_name: string;
}

interface GridColumn {
  key: ColumnKey;
  label: string;
  numeric: boolean;
  width: string;
}

// Header words recognised when a pasted block starts with a title row. More
// specific words come first: "采购单价" must not count as the selling "单价".
const HEADER_ALIASES: Array<[ColumnKey, string[]]> = [
  ["purchase_price", ["采购单价", "采购价", "成本", "进价", "进货价", "cost"]],
  ["supplier_name", ["供应商", "厂家", "工厂", "supplier", "vendor"]],
  ["freight_amount", ["运费", "邮费", "freight", "shipping"]],
  ["quantity", ["数量", "qty", "quantity", "pcs"]],
  ["sales_price", ["售价", "单价", "价格", "报价", "销售价", "price"]],
  ["sku", ["sku", "型号", "产品", "品名", "料号", "货号", "编码", "model", "part", "product"]],
];

let lineCounter = 0;

function newPricingLine(patch: Partial<PricingLine> = {}): PricingLine {
  lineCounter += 1;
  return {
    key: `line-${Date.now()}-${lineCounter}`,
    order_item_id: 0,
    product_name: "",
    specification: "",
    unit: "件",
    purchase_currency: "CNY",
    sku: "",
    quantity: "",
    sales_price: "",
    freight_amount: "",
    purchase_price: "",
    supplier_name: "",
    ...patch,
  };
}

function lineUsed(line: PricingLine) {
  return Boolean(
    line.sku.trim() || line.quantity || line.sales_price || line.freight_amount || line.purchase_price || line.supplier_name.trim(),
  );
}

function linePayload(line: PricingLine) {
  return {
    order_item_id: line.order_item_id,
    sku: line.sku.trim(),
    product_name: line.product_name.trim(),
    specification: line.specification.trim(),
    quantity: amountValue(line.quantity),
    unit: line.unit.trim() || "件",
    sales_price: amountValue(line.sales_price),
    freight_amount: amountValue(line.freight_amount),
    supplier_name: line.supplier_name.trim(),
    purchase_currency: line.purchase_currency.trim().toUpperCase() || "CNY",
    purchase_price: amountValue(line.purchase_price),
  };
}

function validateLines(lines: PricingLine[]) {
  const used = lines.filter(lineUsed);
  if (!used.length) return "请至少填写一个产品";
  for (const [index, line] of lines.entries()) {
    if (!lineUsed(line)) continue;
    if (!line.sku.trim()) return `第 ${index + 1} 行缺少 SKU`;
    if (amountValue(line.quantity) <= 0) return `第 ${index + 1} 行请填写数量`;
  }
  return "";
}

const RATE_KEY_PREFIX = "yaerp:trade:last-rate:";

function rememberedRate(currency: string) {
  if (typeof window === "undefined" || currency === "CNY") return "";
  return window.localStorage.getItem(RATE_KEY_PREFIX + currency) || "";
}

function rememberRate(currency: string, rate: string) {
  if (currency !== "CNY" && amountValue(rate) > 0)
    window.localStorage.setItem(RATE_KEY_PREFIX + currency, String(amountValue(rate)));
}

function money(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function splitClipboard(text: string): string[][] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/, "")
    .split("\n")
    .map((row) => row.split("\t").map((cell) => cell.trim().replace(/^"([\s\S]*)"$/, "$1")));
}

function headerKey(cell: string): ColumnKey | null {
  const text = cell.trim().toLowerCase();
  if (!text) return null;
  for (const [key, aliases] of HEADER_ALIASES) {
    if (aliases.some((alias) => text.includes(alias))) return key;
  }
  return null;
}

/** Payment fee: a plain amount, or a percentage of goods + freight. */
function feeAmount(text: string, base: number) {
  const trimmed = text.trim();
  if (trimmed.endsWith("%")) return (base * amountValue(trimmed.slice(0, -1))) / 100;
  return amountValue(trimmed);
}

// Esc closes the dialog unless focus sits in another dialog opened on top, a
// dropdown inside it is open (that Esc only closes the dropdown), or the
// window was moved aside and the user is working in the page behind it.
// Capture phase, so the dropdown is still open when this runs.
function useEscape(onEscape: () => void, disabled: boolean) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || disabled || event.isComposing) return;
      const dialog = dialogRef.current;
      const active = document.activeElement;
      const outside = active && active !== document.body && !dialog?.contains(active);
      if (outside && active.closest('[role="dialog"], [data-movable-dialog]')) return;
      if (outside && dialog?.closest('[data-floating="true"]')) return;
      if (dialog?.querySelector('[aria-expanded="true"]')) return;
      onEscape();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onEscape, disabled]);
  return dialogRef;
}

const fieldClass =
  "h-9 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-sm outline-none focus:border-slate-400";

function PricingGrid({
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
  const gridRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState("");
  const [rejected, setRejected] = useState<string | null>(null);
  const columns = useMemo<GridColumn[]>(
    () => [
      { key: "sku", label: "SKU", numeric: false, width: "min-w-[180px]" },
      { key: "quantity", label: "数量", numeric: true, width: "w-24" },
      { key: "sales_price", label: `售价（${currency}）`, numeric: true, width: "w-32" },
      { key: "freight_amount", label: `运费（${currency}）`, numeric: true, width: "w-28" },
      ...(showCost
        ? ([
            { key: "purchase_price", label: "采购单价（CNY）", numeric: true, width: "w-32" },
            { key: "supplier_name", label: "供应商（选填）", numeric: false, width: "w-36" },
          ] as GridColumn[])
        : []),
    ],
    [currency, showCost],
  );

  // A row added by Enter renders a frame or two later.
  const focusCell = (row: number, column: number, attempts = 6) => {
    window.requestAnimationFrame(() => {
      const cell = gridRef.current?.querySelector<HTMLInputElement>(`[data-cell="${row}:${column}"]`);
      if (!cell) {
        if (attempts > 0) focusCell(row, column, attempts - 1);
        return;
      }
      cell.focus();
      cell.select();
    });
  };

  const setCell = (row: number, key: ColumnKey, value: string) =>
    onChange(lines.map((line, index) => (index === row ? { ...line, [key]: value } : line)));

  const reject = (row: number, column: GridColumn, raw: string) => {
    setRejected(`${row}:${column.key}`);
    setNotice(`第 ${row + 1} 行「${column.label}」只能填数字，「${raw.slice(0, 20)}」没有填入。`);
    window.setTimeout(() => setRejected(null), 900);
  };

  const pasteBlock = (row: number, columnIndex: number, text: string) => {
    let rows = splitClipboard(text);
    let mapping: Array<ColumnKey | null> = columns.slice(columnIndex).map((column) => column.key);
    const headerKeys = rows[0]?.map(headerKey) || [];
    if (rows.length > 1 && headerKeys.filter(Boolean).length >= 2) {
      mapping = headerKeys.map((key) => (key && columns.some((column) => column.key === key) ? key : null));
      rows = rows.slice(1);
    }
    const next = [...lines];
    const problems: string[] = [];
    rows.forEach((cells, offset) => {
      const target = row + offset;
      if (!next[target]) next[target] = newPricingLine();
      const line = { ...next[target] };
      cells.forEach((raw, cellIndex) => {
        const key = mapping[cellIndex];
        if (!key) return;
        const column = columns.find((item) => item.key === key)!;
        if (!column.numeric) {
          line[key] = raw;
          return;
        }
        const parsed = parseAmountText(raw);
        if (parsed === null) problems.push(`第 ${target + 1} 行${column.label}「${raw.slice(0, 16)}」`);
        else line[key] = parsed;
      });
      next[target] = line;
    });
    onChange(next);
    setNotice(
      problems.length
        ? `已粘贴 ${rows.length} 行；以下内容不是数字，没有填入：${problems.slice(0, 4).join("、")}${problems.length > 4 ? ` 等 ${problems.length} 处` : ""}`
        : `已粘贴 ${rows.length} 行。`,
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, row: number, column: number) => {
    if (event.nativeEvent.isComposing) return;
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    if (event.key === "Enter" || (event.key === "ArrowDown" && !event.altKey)) {
      event.preventDefault();
      const down = event.key === "Enter" && event.shiftKey ? row - 1 : row + 1;
      if (down < 0) return;
      if (down >= lines.length) {
        if (!lineUsed(lines[row])) return;
        onChange([...lines, newPricingLine()]);
      }
      focusCell(down, column);
    } else if (event.key === "ArrowUp" && row > 0) {
      event.preventDefault();
      focusCell(row - 1, column);
    } else if (event.key === "ArrowLeft" && atStart && column > 0) {
      event.preventDefault();
      focusCell(row, column - 1);
    } else if (event.key === "ArrowRight" && atEnd && column < columns.length - 1) {
      event.preventDefault();
      focusCell(row, column + 1);
    }
  };

  const remove = (row: number) => {
    const next = lines.filter((_, index) => index !== row);
    onChange(next.length ? next : [newPricingLine()]);
  };

  const missingPrice = lines
    .map((line, index) => (lineUsed(line) && amountValue(line.sales_price) <= 0 ? index + 1 : 0))
    .filter(Boolean);

  return (
    <div>
      <div ref={gridRef} className="overflow-x-auto rounded-lg border border-slate-300" data-pricing-grid>
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead className="bg-slate-100 text-left text-xs text-slate-600">
            <tr>
              <th className="w-9 border-b border-r border-slate-300 px-2 py-1.5 text-center">#</th>
              {columns.map((column) => (
                <th key={column.key} className={`${column.width} border-b border-r border-slate-300 px-2 py-1.5 font-semibold`}>
                  {column.label}
                </th>
              ))}
              <th className="w-28 border-b border-r border-slate-300 px-2 py-1.5 text-right font-semibold">小计（{currency}）</th>
              <th className="w-9 border-b border-slate-300" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, row) => {
              const subtotal = amountValue(line.quantity) * amountValue(line.sales_price) + amountValue(line.freight_amount);
              return (
                <tr key={line.key} data-pricing-line className="group">
                  <td className="border-b border-r border-slate-200 bg-slate-50 px-2 text-center text-xs text-slate-400">{row + 1}</td>
                  {columns.map((column, columnIndex) => {
                    const value = line[column.key];
                    const flagged = rejected === `${row}:${column.key}`;
                    const priceMissing = column.key === "sales_price" && lineUsed(line) && amountValue(value) <= 0;
                    return (
                      <td
                        key={column.key}
                        className={`border-b border-r border-slate-200 p-0 ${flagged ? "bg-rose-100" : priceMissing ? "bg-amber-50" : ""}`}
                      >
                        <input
                          value={value}
                          data-cell={`${row}:${columnIndex}`}
                          inputMode={column.numeric ? "decimal" : undefined}
                          list={column.key === "supplier_name" ? "trade-pricing-suppliers" : undefined}
                          aria-label={`第 ${row + 1} 行${column.label.replace(/（.*）/, "")}`}
                          aria-invalid={flagged || undefined}
                          onChange={(event) => {
                            if (!column.numeric) {
                              setCell(row, column.key, event.target.value);
                              return;
                            }
                            const clean = sanitizeTypedNumber(event.target.value);
                            if (clean === null) reject(row, column, event.target.value);
                            else setCell(row, column.key, clean);
                          }}
                          onPaste={(event) => {
                            const text = event.clipboardData.getData("text");
                            if (/[\t\n]/.test(text.replace(/\n+$/, ""))) {
                              event.preventDefault();
                              pasteBlock(row, columnIndex, text);
                              return;
                            }
                            if (!column.numeric) return;
                            event.preventDefault();
                            const parsed = parseAmountText(text);
                            if (parsed === null) reject(row, column, text);
                            else setCell(row, column.key, parsed);
                          }}
                          onKeyDown={(event) => onKeyDown(event, row, columnIndex)}
                          placeholder={row === 0 && column.key === "sku" ? "可直接粘贴 Excel 多行多列" : undefined}
                          className={`h-9 w-full min-w-0 bg-transparent px-2 outline-none focus:bg-sky-50 focus:ring-2 focus:ring-inset focus:ring-sky-400 ${column.numeric ? "text-right tabular-nums" : ""}`}
                        />
                      </td>
                    );
                  })}
                  <td className="border-b border-r border-slate-200 bg-slate-50 px-2 text-right tabular-nums text-slate-600">
                    {subtotal.toFixed(2)}
                  </td>
                  <td className="border-b border-slate-200 text-center">
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => remove(row)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded text-slate-300 hover:bg-rose-50 hover:text-rose-600 group-hover:text-slate-400"
                      title="删除这一行"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => {
            onChange([...lines, newPricingLine()]);
            focusCell(lines.length, 0);
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-dashed border-slate-300 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
        >
          <Plus className="h-3.5 w-3.5" />
          添加一行
        </button>
        <span className="text-xs text-slate-400">回车/方向键切换格子；从 Excel 复制带表头的多列会自动对应字段。</span>
      </div>
      {notice && (
        <div role="status" className="mt-2 rounded-lg bg-slate-100 px-3 py-1.5 text-xs text-slate-600">
          {notice}
        </div>
      )}
      {missingPrice.length > 0 && (
        <div className="mt-2 text-xs text-amber-700">
          第 {missingPrice.slice(0, 8).join("、")} 行还没有填售价，保存后利润会少算。
        </div>
      )}
    </div>
  );
}

function ProfitSummary({
  lines,
  currency,
  rate,
  fee,
  showCost,
}: {
  lines: PricingLine[];
  currency: string;
  rate: number;
  fee: number;
  showCost: boolean;
}) {
  const result = useMemo(() => {
    const cnyRate = currency === "CNY" ? 1 : rate;
    let goods = 0;
    let freight = 0;
    let costCNY = 0;
    let costKnown = true;
    for (const line of lines.filter(lineUsed)) {
      const quantity = amountValue(line.quantity);
      goods += quantity * amountValue(line.sales_price);
      freight += amountValue(line.freight_amount);
      const purchase = quantity * amountValue(line.purchase_price);
      if (amountValue(line.purchase_price) <= 0) costKnown = false;
      if (line.purchase_currency === "CNY") costCNY += purchase;
      else if (line.purchase_currency === currency && cnyRate > 0) costCNY += purchase * cnyRate;
      else costKnown = false;
    }
    const total = goods + freight + fee;
    const totalCNY = cnyRate > 0 ? total * cnyRate : 0;
    const profitCNY = totalCNY - costCNY;
    return {
      goods,
      freight,
      total,
      totalCNY,
      costCNY,
      profitCNY,
      margin: totalCNY > 0 ? (profitCNY / totalCNY) * 100 : 0,
      costKnown,
      rateMissing: cnyRate <= 0,
    };
  }, [lines, currency, rate, fee]);

  const cell = "rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200";
  return (
    <div className="grid gap-2 rounded-lg bg-slate-50 p-2 text-sm sm:grid-cols-3 lg:grid-cols-6" data-profit-preview>
      <div className={cell}>
        <div className="text-xs text-slate-500">产品金额</div>
        <div className="font-semibold tabular-nums">{money(result.goods, currency)}</div>
      </div>
      <div className={cell}>
        <div className="text-xs text-slate-500">运费 + 手续费</div>
        <div className="font-semibold tabular-nums">{money(result.freight + fee, currency)}</div>
      </div>
      <div className={cell}>
        <div className="text-xs text-slate-500">客户付款合计</div>
        <div className="font-semibold tabular-nums" data-payment-total>
          {money(result.total, currency)}
        </div>
        {currency !== "CNY" && (
          <div className="text-xs text-slate-400 tabular-nums">
            {result.rateMissing ? "填写汇率后换算人民币" : `≈ ${money(result.totalCNY, "CNY")}`}
          </div>
        )}
      </div>
      {showCost && (
        <>
          <div className={cell}>
            <div className="text-xs text-slate-500">采购成本</div>
            <div className="font-semibold tabular-nums">{money(result.costCNY, "CNY")}</div>
            {!result.costKnown && <div className="text-xs text-amber-600">有产品没填采购价</div>}
          </div>
          <div className={cell}>
            <div className="text-xs text-slate-500">利润（人民币）</div>
            <div
              data-profit-value
              className={`font-semibold tabular-nums ${result.profitCNY < 0 ? "text-rose-600" : "text-emerald-700"}`}
            >
              {result.rateMissing ? "请填写汇率" : money(result.profitCNY, "CNY")}
            </div>
          </div>
          <div className={cell}>
            <div className="text-xs text-slate-500">利润率</div>
            <div className="font-semibold tabular-nums">{result.rateMissing ? "-" : `${result.margin.toFixed(1)}%`}</div>
          </div>
        </>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  allowPercent,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowPercent?: boolean;
}) {
  const [error, setError] = useState(false);
  const accept = (raw: string, pasted: boolean) => {
    const percent = allowPercent && /[%％]\s*$/.test(raw);
    const body = percent ? raw.replace(/[%％]\s*$/, "") : raw;
    const clean = pasted ? parseAmountText(body) : sanitizeTypedNumber(body);
    if (clean === null) {
      setError(true);
      window.setTimeout(() => setError(false), 900);
      return;
    }
    onChange(percent ? `${clean}%` : clean);
  };
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-slate-500">{label}</span>
      <input
        value={value}
        disabled={disabled}
        inputMode="decimal"
        aria-label={label}
        aria-invalid={error || undefined}
        onChange={(event) => accept(event.target.value, false)}
        onPaste={(event) => {
          event.preventDefault();
          accept(event.clipboardData.getData("text"), true);
        }}
        placeholder={placeholder}
        className={`${fieldClass} disabled:bg-slate-50 disabled:text-slate-400 ${error ? "border-rose-400 bg-rose-50" : ""}`}
      />
    </label>
  );
}

function OrderMoneyFields({
  currency,
  rate,
  fee,
  feeBase,
  paymentMethod,
  onCurrencyChange,
  onRateChange,
  onFeeChange,
  onPaymentMethodChange,
}: {
  currency: string;
  rate: string;
  fee: string;
  feeBase: number;
  paymentMethod: string;
  onCurrencyChange: (value: string) => void;
  onRateChange: (value: string) => void;
  onFeeChange: (value: string) => void;
  onPaymentMethodChange: (value: string) => void;
}) {
  return (
    <>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">售价币种</span>
        <CurrencyCombobox value={currency} onChange={onCurrencyChange} />
      </label>
      <NumberField
        label={`汇率（1 ${currency} = ? CNY）`}
        value={currency === "CNY" ? "1" : rate}
        disabled={currency === "CNY"}
        onChange={onRateChange}
        placeholder="例如 7.1"
      />
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-slate-500">付款方式</span>
        <input
          value={paymentMethod}
          list="trade-payment-options"
          onChange={(event) => onPaymentMethodChange(event.target.value)}
          placeholder="PayPal / T/T 电汇"
          aria-label="付款方式"
          className={fieldClass}
        />
      </label>
      <div>
        <NumberField
          label={`手续费（${currency}，可填 4.4%）`}
          value={fee}
          onChange={onFeeChange}
          placeholder="PayPal 等收的手续费"
          allowPercent
        />
        {fee.trim().endsWith("%") && (
          <div className="mt-0.5 text-[11px] text-slate-400">= {money(feeAmount(fee, feeBase), currency)}</div>
        )}
      </div>
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

function goodsAndFreight(lines: PricingLine[]) {
  return lines
    .filter(lineUsed)
    .reduce((sum, line) => sum + amountValue(line.quantity) * amountValue(line.sales_price) + amountValue(line.freight_amount), 0);
}

function DialogFrame({
  title,
  subtitle,
  dialogRef,
  onClose,
  footer,
  children,
  zIndex,
}: {
  title: string;
  subtitle: React.ReactNode;
  dialogRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
  zIndex: string;
}) {
  return (
    <div data-movable-dialog className={`fixed inset-0 ${zIndex} flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4`}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-label={title}
        className="flex max-h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
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
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">{footer}</div>
      </div>
    </div>
  );
}

function SaveButtons({ saving, label, onCancel, onSave }: { saving: boolean; label: string; onCancel: () => void; onSave: () => void }) {
  return (
    <>
      <button type="button" onClick={onCancel} className="h-9 rounded-lg border border-slate-200 px-4 text-sm">
        取消
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {label}
      </button>
    </>
  );
}

function ErrorBox({ message }: { message: string }) {
  if (!message) return null;
  return <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{message}</div>;
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
  const [fee, setFee] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [dealDate, setDealDate] = useState(() => todayInputDate());
  const [shippingAddress, setShippingAddress] = useState("");
  const [lines, setLines] = useState<PricingLine[]>(() => [newPricingLine(), newPricingLine(), newPricingLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const close = useCallback(() => onClose(), [onClose]);
  const dialogRef = useEscape(close, saving);
  const base = goodsAndFreight(lines);

  const submit = async () => {
    if (!customerID) {
      setError("请选择客户");
      return;
    }
    if (!dealDate) {
      setError("请填写成交日期");
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
      const response = await api.post<TradeOrder>("/trade/orders", {
        customer_id: customerID,
        title: title.trim(),
        currency,
        exchange_rate_cny: currency === "CNY" ? 1 : amountValue(rate),
        payment_fee_amount: feeAmount(fee, base),
        payment_method: paymentMethod.trim(),
        notes: notes.trim(),
        deal_date: dealDate,
        shipping_address: shippingAddress.trim(),
        confirmed: true,
        items: lines.filter(lineUsed).map((line) => {
          const payload = linePayload(line);
          return {
            sku: payload.sku,
            product_name: payload.product_name,
            specification: payload.specification,
            quantity: payload.quantity,
            unit: payload.unit,
            sales_price: payload.sales_price,
            freight_amount: payload.freight_amount,
            supplier_name: payload.supplier_name,
            purchase_currency: payload.purchase_currency,
            purchase_price: payload.purchase_price,
          };
        }),
      });
      if (response.code !== 0 || !response.data) throw new Error(response.message || "录入成交订单失败");
      rememberRate(currency, rate);
      await onCreated(response.data);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "录入成交订单失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogFrame
      title="录入成交订单"
      subtitle="客户付款 = 产品金额 + 每个产品的运费 + 手续费；利润按人民币自动计算。"
      dialogRef={dialogRef}
      onClose={close}
      zIndex="z-[61]"
      footer={<SaveButtons saving={saving} label="保存成交订单" onCancel={close} onSave={() => void submit()} />}
    >
      <SupplierOptions suppliers={suppliers} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="block text-sm lg:col-span-2">
          <span className="mb-1 flex items-center justify-between text-xs font-medium text-slate-500">
            客户
            {onCreateCustomer && (
              <button type="button" onClick={onCreateCustomer} className="inline-flex items-center gap-1 text-sky-700 hover:underline">
                <UserPlus className="h-3 w-3" />
                新客户
              </button>
            )}
          </span>
          <CustomerCombobox customers={customers} value={customerID} onChange={(id) => setCustomerID(id)} />
        </div>
        <label className="block text-sm lg:col-span-1">
          <span className="mb-1 block text-xs font-medium text-slate-500">订单标题（选填）</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="不填自动生成" className={fieldClass} />
        </label>
        <OrderMoneyFields
          currency={currency}
          rate={rate}
          fee={fee}
          feeBase={base}
          paymentMethod={paymentMethod}
          onCurrencyChange={(value) => {
            const next = value.trim().toUpperCase() || "USD";
            setCurrency(next);
            setRate(rememberedRate(next));
          }}
          onRateChange={setRate}
          onFeeChange={setFee}
          onPaymentMethodChange={setPaymentMethod}
        />
      </div>
      <PricingGrid lines={lines} onChange={setLines} currency={currency} showCost={showCost} />
      <ProfitSummary lines={lines} currency={currency} rate={amountValue(rate)} fee={feeAmount(fee, base)} showCost={showCost} />
      <div className="grid gap-3 sm:grid-cols-[180px_1fr_1fr]">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">成交日期（合同日期）</span>
          <input type="date" value={dealDate} onChange={(event) => setDealDate(event.target.value)} className={fieldClass} />
          <span className="mt-0.5 block text-[11px] text-slate-400">按这个日期计入月度账期</span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">收货地址（选填）</span>
          <textarea
            value={shippingAddress}
            onChange={(event) => setShippingAddress(event.target.value)}
            rows={2}
            placeholder="收件人、街道、城市、邮编、国家"
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-slate-400"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-slate-500">备注（选填）</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:border-slate-400"
          />
        </label>
      </div>
      <ErrorBox message={error} />
    </DialogFrame>
  );
}

export function OrderPricingModal({
  order,
  suppliers,
  convert,
  showCost,
  onClose,
  onSaved,
}: {
  order: TradeOrder;
  suppliers: TradeSupplier[];
  convert: boolean;
  showCost: boolean;
  onClose: () => void;
  onSaved: (order: TradeOrder, convert: boolean) => void | Promise<void>;
}) {
  const initialCurrency = (order.currency || "USD").toUpperCase();
  const [currency, setCurrency] = useState(initialCurrency);
  const [rate, setRate] = useState(() =>
    order.quote_exchange_rate_cny > 0 ? String(order.quote_exchange_rate_cny) : rememberedRate(initialCurrency),
  );
  const [fee, setFee] = useState(() => ((order.payment_fee_amount || 0) > 0 ? String(order.payment_fee_amount) : ""));
  const [paymentMethod, setPaymentMethod] = useState(order.payment_method || "");
  const [lines, setLines] = useState<PricingLine[]>(() => {
    const items = tradeActiveItems(order.items || []);
    const loaded = items.map((item) =>
      newPricingLine({
        order_item_id: item.id,
        sku: item.sku || item.product_name,
        product_name: item.product_name,
        specification: item.specification,
        quantity: item.quantity ? String(item.quantity) : "",
        unit: item.unit || "件",
        sales_price: item.quoted_price ? String(item.quoted_price) : "",
        freight_amount: item.freight_amount ? String(item.freight_amount) : "",
        supplier_name: item.supplier_name || "",
        purchase_currency: (item.purchase_currency || "CNY").toUpperCase(),
        purchase_price: item.purchase_price ? String(item.purchase_price) : "",
      }),
    );
    return [...loaded, newPricingLine()];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const close = useCallback(() => onClose(), [onClose]);
  const dialogRef = useEscape(close, saving);
  const base = goodsAndFreight(lines);
  const title = convert ? "转为成交订单" : "编辑售价与成本";

  const submit = async () => {
    const message = validateLines(lines);
    if (message) {
      setError(message);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const used = lines.filter(lineUsed);
      const kept = new Set(used.map((line) => line.order_item_id).filter(Boolean));
      const removed = tradeActiveItems(order.items || [])
        .map((item) => item.id)
        .filter((id) => !kept.has(id));
      const response = await api.put<TradeOrder>(`/trade/orders/${order.id}/pricing`, {
        currency,
        exchange_rate_cny: currency === "CNY" ? 1 : amountValue(rate),
        payment_fee_amount: feeAmount(fee, base),
        payment_method: paymentMethod.trim(),
        items: used.map(linePayload),
        removed_item_ids: removed,
      });
      if (response.code !== 0 || !response.data) throw new Error(response.message || "保存售价与成本失败");
      rememberRate(currency, rate);
      await onSaved(response.data, convert);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存售价与成本失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogFrame
      title={title}
      subtitle={
        <>
          {order.order_no} · {order.customer_name}
          {convert ? " · 删除客户没有购买的产品，核对售价和成本后保存。" : ""}
        </>
      }
      dialogRef={dialogRef}
      onClose={close}
      zIndex="z-[80]"
      footer={<SaveButtons saving={saving} label={convert ? "保存并转为成交" : "保存"} onCancel={close} onSave={() => void submit()} />}
    >
      <SupplierOptions suppliers={suppliers} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <OrderMoneyFields
          currency={currency}
          rate={rate}
          fee={fee}
          feeBase={base}
          paymentMethod={paymentMethod}
          onCurrencyChange={(value) => {
            const next = value.trim().toUpperCase() || "USD";
            setCurrency(next);
            if (next !== currency) setRate(rememberedRate(next));
          }}
          onRateChange={setRate}
          onFeeChange={setFee}
          onPaymentMethodChange={setPaymentMethod}
        />
      </div>
      <PricingGrid lines={lines} onChange={setLines} currency={currency} showCost={showCost} />
      <ProfitSummary lines={lines} currency={currency} rate={amountValue(rate)} fee={feeAmount(fee, base)} showCost={showCost} />
      <ErrorBox message={error} />
    </DialogFrame>
  );
}
