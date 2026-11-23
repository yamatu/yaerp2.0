"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Image as ImageIcon, Loader2, Upload, X } from "lucide-react";
import api from "@/lib/api";
import { CustomerCombobox } from "@/components/trade/CustomerCombobox";
import { amountValue, sanitizeTypedNumber } from "@/lib/tradeNumbers";
import { formatSettlementMonth } from "@/lib/tradeSettlement";
import type {
  TradeCustomer,
  TradeOrderSheetImportResult,
  TradeOrderSheetPreview,
  TradeOrderSheetRow,
  User,
} from "@/types";

const inputClass =
  "h-8 w-full rounded-md border border-slate-200 bg-white px-1.5 text-sm tabular-nums outline-none focus:border-slate-400";

type RowEdit = {
  import: boolean;
  deal_date: string;
  goods_amount: string;
  payment_fee: string;
  freight_amount: string;
  actual_freight_cny: string;
};

function editFor(row: TradeOrderSheetRow): RowEdit {
  const text = (value: number) => (value ? String(value) : "");
  return {
    import: !row.skip,
    deal_date: row.deal_date,
    goods_amount: text(row.goods_amount),
    payment_fee: text(row.payment_fee),
    freight_amount: text(row.freight_amount),
    actual_freight_cny: text(row.actual_freight_cny),
  };
}

function money(value: number, currency: string) {
  return `${currency} ${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function OrderSheetImportModal({
  customers,
  users,
  canAssignOwner,
  currentUserId,
  onClose,
  onImported,
}: {
  customers: TradeCustomer[];
  users: User[];
  canAssignOwner: boolean;
  currentUserId?: number;
  onClose: () => void;
  onImported: (month: string) => void | Promise<void>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<TradeOrderSheetPreview | null>(null);
  const [edits, setEdits] = useState<Record<number, RowEdit>>({});
  const [month, setMonth] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [rate, setRate] = useState("");
  const [ownerId, setOwnerId] = useState(0);
  const [sharedCustomer, setSharedCustomer] = useState(false);
  const [sharedCustomerId, setSharedCustomerId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TradeOrderSheetImportResult | null>(null);
  const busy = loading || applying;

  const loadPreview = async (picked: File, sheet = "") => {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", picked);
      if (sheet) form.append("sheet", sheet);
      const response = await api.form<TradeOrderSheetPreview>("/trade/order-sheet-import/preview", form);
      if (response.code !== 0 || !response.data) throw new Error(response.message || "读取表格失败");
      const data = response.data;
      setFile(picked);
      setPreview(data);
      setMonth(data.settlement_month);
      setCurrency(data.currency || "USD");
      setRate(data.exchange_rate > 0 ? String(data.exchange_rate) : "");
      setEdits(Object.fromEntries(data.rows.map((row) => [row.row_number, editFor(row)])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取表格失败");
    } finally {
      setLoading(false);
    }
  };

  const updateRow = (rowNumber: number, patch: Partial<RowEdit>) =>
    setEdits((current) => ({ ...current, [rowNumber]: { ...current[rowNumber], ...patch } }));

  const selectedRows = useMemo(
    () => (preview?.rows || []).filter((row) => !row.existing_order_no && edits[row.row_number]?.import),
    [edits, preview],
  );
  const totals = useMemo(() => {
    let goods = 0;
    let paid = 0;
    selectedRows.forEach((row) => {
      const edit = edits[row.row_number];
      const rowGoods = amountValue(edit.goods_amount);
      goods += rowGoods;
      paid += rowGoods + amountValue(edit.payment_fee) + amountValue(edit.freight_amount);
    });
    return { goods, paid };
  }, [edits, selectedRows]);
  const rateValue = currency === "CNY" ? 1 : amountValue(rate);
  // Rows a "select all" may tick: not imported before and with an amount.
  const selectableRows = (preview?.rows || []).filter(
    (row) => !row.existing_order_no && amountValue(edits[row.row_number]?.goods_amount || "") > 0,
  );

  const apply = async () => {
    if (!file || !preview) return;
    if (!month) {
      setError("请选择账期月份");
      return;
    }
    if (rateValue <= 0) {
      setError(`请填写结汇汇率：1 ${currency} 兑多少人民币`);
      return;
    }
    if (sharedCustomer && !sharedCustomerId) {
      setError("请选择要归入的客户");
      return;
    }
    if (selectedRows.length === 0) {
      setError("没有勾选要导入的订单");
      return;
    }
    const invalid = selectedRows.find((row) => {
      const edit = edits[row.row_number];
      return !edit.deal_date || amountValue(edit.goods_amount) <= 0;
    });
    if (invalid) {
      setError(`第 ${invalid.row_number} 行缺少合同日期或订单金额`);
      return;
    }
    setApplying(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append(
        "payload",
        JSON.stringify({
          sheet: preview.sheet,
          settlement_month: month,
          currency,
          exchange_rate: rateValue,
          owner_id: ownerId,
          customer_id: sharedCustomer ? sharedCustomerId : 0,
          rows: selectedRows.map((row) => {
            const edit = edits[row.row_number];
            return {
              row_number: row.row_number,
              import: true,
              deal_date: edit.deal_date,
              goods_amount: amountValue(edit.goods_amount),
              payment_fee: amountValue(edit.payment_fee),
              freight_amount: amountValue(edit.freight_amount),
              actual_freight_cny: amountValue(edit.actual_freight_cny),
            };
          }),
        }),
      );
      const response = await api.form<TradeOrderSheetImportResult>("/trade/order-sheet-import/apply", form);
      if (response.code !== 0 || !response.data) throw new Error(response.message || "导入失败");
      setResult(response.data);
      if (response.data.created > 0) await onImported(month);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "导入失败");
    } finally {
      setApplying(false);
    }
  };

  const ownerChoices = users.filter((user) => user.id !== currentUserId);

  return (
    <div data-movable-dialog className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4">
      <div role="dialog" aria-label="导入月度订单表" className="flex max-h-[95vh] w-full max-w-[1400px] flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="font-semibold">导入月度订单表</h2>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              {preview
                ? `${preview.file_name} · 工作表「${preview.sheet}」 · ${preview.rows.length} 行`
                : "选择业务员每月的外贸工作表（.xlsx），每行一单：客户、合同日期、金额、运费、地址、物流单号和打包照片会一起导入。"}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={applying} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = "";
              if (picked) void loadPreview(picked);
            }}
          />
          {!preview && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              className="flex h-44 w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-200 text-sm text-slate-500 hover:border-slate-400 hover:bg-slate-50 disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
              {loading ? "正在读取表格和图片..." : "点击选择 Excel 文件"}
              <span className="text-xs text-slate-400">.xls 旧格式请先在 Excel 中另存为 .xlsx</span>
            </button>
          )}

          {preview && result && <ImportResult result={result} />}

          {preview && !result && (
            <>
              <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">账期月份</span>
                  <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} className={inputClass} />
                  <span className="mt-0.5 block text-[11px] text-slate-400">
                    {preview.settlement_month_source === "filename" ? "按文件名识别" : "按合同日期推算"}，这些订单都计入 {month ? formatSettlementMonth(month) : "该月"}
                  </span>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">售价币种</span>
                  <input
                    value={currency}
                    onChange={(event) => setCurrency(event.target.value.trim().toUpperCase() || "USD")}
                    className={inputClass}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-slate-500">结汇汇率（1 {currency} = ? CNY）</span>
                  <input
                    value={currency === "CNY" ? "1" : rate}
                    disabled={currency === "CNY"}
                    onChange={(event) => {
                      const next = sanitizeTypedNumber(event.target.value);
                      if (next !== null) setRate(next);
                    }}
                    placeholder="例如 6.6"
                    inputMode="decimal"
                    className={`${inputClass} ${rateValue <= 0 ? "border-amber-400 bg-amber-50" : ""}`}
                  />
                  <span className={`mt-0.5 block text-[11px] ${preview.exchange_rate > 0 ? "text-slate-400" : "font-medium text-amber-700"}`}>
                    {preview.exchange_rate > 0 ? `表格中的汇率 ${preview.exchange_rate}` : "表格里没有汇率，请手动填写"}
                  </span>
                </label>
                {canAssignOwner && ownerChoices.length > 0 ? (
                  <label className="block text-sm">
                    <span className="mb-1 block text-xs font-medium text-slate-500">新客户归属业务员</span>
                    <select value={ownerId} onChange={(event) => setOwnerId(Number(event.target.value))} className={inputClass}>
                      <option value={0}>我自己</option>
                      {ownerChoices.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.username}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div />
                )}
                {preview.sheets.length > 1 && (
                  <label className="block text-sm">
                    <span className="mb-1 block text-xs font-medium text-slate-500">工作表</span>
                    <select
                      value={preview.sheet}
                      onChange={(event) => file && void loadPreview(file, event.target.value)}
                      className={inputClass}
                    >
                      {preview.sheets.map((sheet) => (
                        <option key={sheet} value={sheet}>
                          {sheet}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="sm:col-span-2 lg:col-span-5">
                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <label className="inline-flex items-center gap-2">
                      <input type="radio" checked={!sharedCustomer} onChange={() => setSharedCustomer(false)} />
                      按表格中的客户名称（已有客户自动匹配，没有的自动新建）
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input type="radio" checked={sharedCustomer} onChange={() => setSharedCustomer(true)} />
                      全部归到同一个客户（例如代发货的经销商）
                    </label>
                  </div>
                  {sharedCustomer && (
                    <div className="mt-2 max-w-md">
                      <CustomerCombobox customers={customers} value={sharedCustomerId} onChange={(id) => setSharedCustomerId(id)} />
                      <span className="mt-0.5 block text-[11px] text-slate-400">表格里的客户名称会保留在订单标题里，作为收货人</span>
                    </div>
                  )}
                </div>
              </div>

              {preview.warnings.length > 0 && (
                <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {preview.warnings.map((warning) => (
                    <div key={warning} className="flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      {warning}
                    </div>
                  ))}
                </div>
              )}

              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[1180px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr>
                      <th className="w-10 px-2 py-2">
                        <input
                          type="checkbox"
                          aria-label="全选"
                          checked={selectableRows.length > 0 && selectableRows.every((row) => edits[row.row_number]?.import)}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setEdits((current) => {
                              const next = { ...current };
                              selectableRows.forEach((row) => {
                                next[row.row_number] = { ...next[row.row_number], import: checked };
                              });
                              return next;
                            });
                          }}
                        />
                      </th>
                      <th className="px-2 py-2">行</th>
                      <th className="px-2 py-2">客户</th>
                      <th className="w-36 px-2 py-2">合同日期</th>
                      <th className="w-24 px-2 py-2">货款</th>
                      <th className="w-20 px-2 py-2">手续费</th>
                      <th className="w-20 px-2 py-2">运费</th>
                      <th className="w-28 px-2 py-2">实际运费 ¥</th>
                      <th className="px-2 py-2">物流单号</th>
                      <th className="px-2 py-2">照片</th>
                      <th className="px-2 py-2">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row) => {
                      const edit = edits[row.row_number];
                      if (!edit) return null;
                      const locked = Boolean(row.existing_order_no);
                      return (
                        <tr key={row.row_number} className={`border-t border-slate-100 align-top ${edit.import && !locked ? "" : "bg-slate-50/70 text-slate-400"}`}>
                          <td className="px-2 py-2">
                            <input
                              type="checkbox"
                              aria-label={`导入第 ${row.row_number} 行`}
                              checked={edit.import && !locked}
                              disabled={locked}
                              onChange={(event) => updateRow(row.row_number, { import: event.target.checked })}
                            />
                          </td>
                          <td className="px-2 py-2 tabular-nums">{row.row_number}</td>
                          <td className="max-w-56 px-2 py-2">
                            <div className="font-medium text-slate-800">{row.customer_label}</div>
                            {sharedCustomer ? (
                              <div className="text-[11px] text-slate-400">收货人</div>
                            ) : row.matched_customer_id ? (
                              <div className="text-[11px] text-emerald-700">已有客户：{row.matched_customer_name}</div>
                            ) : (
                              <div className="text-[11px] text-sky-700">新建客户{row.country ? `（${row.country}）` : ""}</div>
                            )}
                            {row.shipping_address && (
                              <div className="mt-0.5 truncate text-[11px] text-slate-400" title={row.shipping_address}>
                                {row.shipping_address.split("\n")[0]}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <input type="date" value={edit.deal_date} disabled={locked} onChange={(event) => updateRow(row.row_number, { deal_date: event.target.value })} className={inputClass} />
                          </td>
                          {(["goods_amount", "payment_fee", "freight_amount", "actual_freight_cny"] as const).map((key) => (
                            <td key={key} className="px-2 py-2">
                              <input
                                value={edit[key]}
                                disabled={locked}
                                inputMode="decimal"
                                onChange={(event) => {
                                  const next = sanitizeTypedNumber(event.target.value);
                                  if (next !== null) updateRow(row.row_number, { [key]: next });
                                }}
                                className={inputClass}
                              />
                              {key === "actual_freight_cny" && row.actual_freight_note && (
                                <div className="mt-0.5 text-[11px] text-amber-700" title="表格里写的是文字，没有金额">
                                  {row.actual_freight_note}
                                </div>
                              )}
                            </td>
                          ))}
                          <td className="px-2 py-2 text-xs">
                            {row.tracking_numbers.length > 0 ? (
                              row.tracking_numbers.map((number) => (
                                <div key={number} className="font-mono">
                                  {number}
                                </div>
                              ))
                            ) : (
                              <span className="text-slate-400">无</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-xs">
                            {row.images.length > 0 ? (
                              <span className="inline-flex items-center gap-1 text-slate-600" title={row.images.map((image) => image.name).join("\n")}>
                                <ImageIcon className="h-3.5 w-3.5" />
                                {row.images.length}
                              </span>
                            ) : (
                              <span className="text-slate-300">-</span>
                            )}
                          </td>
                          <td className="max-w-60 px-2 py-2 text-xs">
                            {locked ? (
                              <span className="text-slate-500">已导入 {row.existing_order_no}</span>
                            ) : row.skip ? (
                              <span className="text-slate-500">{row.skip_reason}</span>
                            ) : row.problems.length > 0 ? (
                              row.problems.map((problem) => (
                                <div key={problem} className="text-amber-700">
                                  {problem}
                                </div>
                              ))
                            ) : (
                              <span className="text-emerald-700">可导入</span>
                            )}
                            {row.notes && <div className="mt-0.5 text-slate-400">备注：{row.notes}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-slate-600">
            {preview && !result && (
              <>
                已选 <strong>{selectedRows.length}</strong> 单 · 货款 <strong>{money(totals.goods, currency)}</strong> · 客户实付{" "}
                {money(totals.paid, currency)}
                {rateValue > 0 && <> · 结汇约 ¥{(totals.goods * rateValue).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</>}
              </>
            )}
          </div>
          <div className="flex justify-end gap-2">
            {preview && !result && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm disabled:opacity-40"
              >
                <FileSpreadsheet className="h-4 w-4" />
                换一个文件
              </button>
            )}
            <button type="button" onClick={onClose} disabled={applying} className="h-9 rounded-lg border border-slate-200 px-4 text-sm disabled:opacity-40">
              {result ? "完成" : "取消"}
            </button>
            {preview && !result && (
              <button
                type="button"
                onClick={() => void apply()}
                disabled={busy || selectedRows.length === 0}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
              >
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {applying ? "正在导入..." : `导入 ${selectedRows.length} 单`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportResult({ result }: { result: TradeOrderSheetImportResult }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        <CheckCircle2 className="h-4 w-4" />
        新建 {result.created} 单
        {result.skipped > 0 && `，跳过 ${result.skipped} 单（之前已导入）`}
        {result.failed > 0 && `，失败 ${result.failed} 单`}
      </div>
      {result.rows.some((row) => row.status !== "created") && (
        <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {result.rows
            .filter((row) => row.status !== "created")
            .map((row) => (
              <div key={row.row_number} className="flex gap-3 px-3 py-2">
                <span className="w-14 shrink-0 tabular-nums text-slate-500">第 {row.row_number} 行</span>
                <span className={row.status === "failed" ? "text-rose-700" : "text-slate-500"}>
                  {row.order_no ? `${row.order_no} · ` : ""}
                  {row.message}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

export function MonthExchangeRateModal({
  month,
  currencies,
  missingCount,
  onClose,
  onSaved,
}: {
  month: string;
  currencies: string[];
  missingCount: number;
  onClose: () => void;
  onSaved: (updated: number) => void | Promise<void>;
}) {
  const choices = currencies.length > 0 ? currencies : ["USD"];
  const [currency, setCurrency] = useState(choices[0]);
  const [rate, setRate] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(missingCount > 0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    const value = amountValue(rate);
    if (value <= 0) {
      setError("请输入大于零的汇率");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await api.put<{ updated: number }>(`/trade/settlement-months/${month}/exchange-rate`, {
        currency,
        rate: value,
        only_missing: onlyMissing,
      });
      if (response.code !== 0 || !response.data) throw new Error(response.message || "保存失败");
      await onSaved(response.data.updated);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-movable-dialog className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/45 sm:items-center sm:p-4">
      <div role="dialog" aria-label="设置本月结汇汇率" className="w-full max-w-md overflow-hidden rounded-t-lg bg-white shadow-2xl sm:rounded-lg">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="font-semibold">设置 {formatSettlementMonth(month)} 结汇汇率</h2>
            <p className="mt-0.5 text-xs text-slate-500">用于把该月外币订单换算成人民币销售额和利润</p>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-500">币种</span>
              <select value={currency} onChange={(event) => setCurrency(event.target.value)} className={inputClass}>
                {choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-500">1 {currency} = ? CNY</span>
              <input
                value={rate}
                onChange={(event) => {
                  const next = sanitizeTypedNumber(event.target.value);
                  if (next !== null) setRate(next);
                }}
                inputMode="decimal"
                placeholder="例如 6.6"
                className={inputClass}
                autoFocus
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)} />
            只填补还没有汇率的订单{missingCount > 0 ? `（${missingCount} 单）` : ""}
          </label>
          {!onlyMissing && <div className="text-xs text-amber-700">会覆盖该月所有 {currency} 订单已有的汇率</div>}
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
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            应用汇率
          </button>
        </div>
      </div>
    </div>
  );
}
