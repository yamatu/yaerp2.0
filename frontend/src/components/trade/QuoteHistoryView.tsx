"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ImageOff,
  Loader2,
  Lock,
  Search,
  X,
} from "lucide-react";
import api from "@/lib/api";
import type {
  TradeCustomer,
  TradeItemImage,
  TradeQuoteHistory,
  TradeQuoteHistoryRecord,
} from "@/types";

const STATUS_LABELS: Record<string, string> = {
  sent: "已报价",
  negotiating: "客户议价",
  accepted: "客户接受",
  rejected: "客户拒绝",
  superseded: "已被新一轮替代",
};

const STATUS_STYLES: Record<string, string> = {
  sent: "bg-sky-50 text-sky-700",
  negotiating: "bg-amber-50 text-amber-700",
  accepted: "bg-emerald-50 text-emerald-700",
  rejected: "bg-rose-50 text-rose-700",
  superseded: "bg-slate-100 text-slate-500",
};

interface ProductGroup {
  key: string;
  sku: string;
  specification: string;
  images: TradeItemImage[];
  records: TradeQuoteHistoryRecord[];
  latest: TradeQuoteHistoryRecord;
  minPrice: number;
  maxPrice: number;
  sameCurrency: boolean;
  customerCount: number;
  acceptedCount: number;
}

function money(currency: string, value: number) {
  if (!Number.isFinite(value)) return "-";
  return `${currency || ""} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`.trim();
}

function percent(value: number) {
  return `${(Number.isFinite(value) ? value : 0).toFixed(1)}%`;
}

function dateText(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleDateString("zh-CN");
}

function groupRecords(records: TradeQuoteHistoryRecord[]): ProductGroup[] {
  const groups = new Map<string, TradeQuoteHistoryRecord[]>();
  for (const record of records) {
    const sku = (record.sku || record.product_name || "").trim();
    const key = sku.toUpperCase();
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(record);
    groups.set(key, list);
  }
  return Array.from(groups.entries())
    .map(([key, list]) => {
      const sorted = [...list].sort((left, right) => right.quoted_at.localeCompare(left.quoted_at));
      const latest = sorted[0];
      const currencies = new Set(sorted.map((record) => record.currency));
      const prices = sorted.filter((record) => record.currency === latest.currency).map((record) => record.unit_price);
      const imageMap = new Map<number, TradeItemImage>();
      for (const record of sorted) {
        for (const image of record.images || []) {
          if (!imageMap.has(image.attachment_id)) imageMap.set(image.attachment_id, image);
        }
      }
      const images = Array.from(imageMap.values()).sort((left, right) =>
        left.source === right.source ? 0 : left.source === "inspection" ? -1 : 1,
      );
      return {
        key,
        sku: (latest.sku || latest.product_name).trim(),
        specification: sorted.find((record) => record.specification)?.specification || "",
        images,
        records: sorted,
        latest,
        minPrice: Math.min(...prices),
        maxPrice: Math.max(...prices),
        sameCurrency: currencies.size === 1,
        customerCount: new Set(sorted.map((record) => record.customer_id || record.customer_name)).size,
        acceptedCount: sorted.filter((record) => record.status === "accepted").length,
      };
    })
    .sort((left, right) => right.latest.quoted_at.localeCompare(left.latest.quoted_at));
}

interface QuoteHistoryViewProps {
  customers: TradeCustomer[];
  onOpenOrder: (orderID: number) => void;
}

export function QuoteHistoryView({ customers, onOpenOrder }: QuoteHistoryViewProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [customerID, setCustomerID] = useState(0);
  const [acceptedOnly, setAcceptedOnly] = useState(false);
  const [data, setData] = useState<TradeQuoteHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ images: TradeItemImage[]; index: number; title: string } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const query = new URLSearchParams();
    if (debouncedSearch) query.set("search", debouncedSearch);
    if (customerID) query.set("customer_id", String(customerID));
    void api
      .get<TradeQuoteHistory>(`/trade/quote-history?${query.toString()}`)
      .then((response) => {
        if (cancelled) return;
        if (response.code !== 0) throw new Error(response.message || "加载报价历史失败");
        setData(response.data || { can_view_cost: false, records: [] });
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "加载报价历史失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [customerID, debouncedSearch]);

  const canViewCost = Boolean(data?.can_view_cost);
  const groups = useMemo(() => {
    const records = (data?.records || []).filter((record) => !acceptedOnly || record.status === "accepted");
    return groupRecords(records);
  }, [acceptedOnly, data]);

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderDetails = (group: ProductGroup) => (
                  <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3">
                    {group.images.length > 0 && (
                      <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                        {group.images.map((image, index) => (
                          <button
                            key={image.attachment_id}
                            type="button"
                            onClick={() => setViewer({ images: group.images, index, title: group.sku })}
                            className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={image.thumbnail_url || image.url} alt="" loading="lazy" className="h-full w-full object-cover" />
                            <span className="absolute left-0.5 top-0.5 rounded bg-white/90 px-1 text-[10px] text-slate-600">
                              {image.source === "inspection" ? "到货实拍" : "客户询价图"}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                      <table className="w-full min-w-[760px] text-xs">
                        <thead className="bg-slate-50 text-left text-slate-500">
                          <tr>
                            <th className="px-3 py-2">日期</th>
                            <th className="px-3 py-2">客户</th>
                            <th className="px-3 py-2">业务单 / 轮次</th>
                            <th className="px-3 py-2">状态</th>
                            <th className="px-3 py-2 text-right">数量</th>
                            <th className="px-3 py-2 text-right">对客单价</th>
                            {canViewCost && (
                              <>
                                <th className="px-3 py-2">供应商</th>
                                <th className="px-3 py-2 text-right">采购价</th>
                                <th className="px-3 py-2 text-right">加价率</th>
                                <th className="px-3 py-2 text-right">单件利润(¥)</th>
                                <th className="px-3 py-2 text-right">利润率</th>
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {group.records.map((record) => (
                            <tr key={`${record.quote_id}-${record.order_item_id}`} className="border-t border-slate-100">
                              <td className="px-3 py-2 tabular-nums text-slate-500">{dateText(record.quoted_at)}</td>
                              <td className="px-3 py-2">{record.customer_name || <span className="text-slate-400">其他业务员客户</span>}</td>
                              <td className="px-3 py-2">
                                <button
                                  type="button"
                                  onClick={() => onOpenOrder(record.order_id)}
                                  className="font-medium text-sky-700 hover:underline"
                                >
                                  {record.order_no}
                                </button>
                                <span className="ml-1 text-slate-400">第 {record.round_no} 轮</span>
                              </td>
                              <td className="px-3 py-2">
                                <span className={`rounded px-1.5 py-0.5 ${STATUS_STYLES[record.status] || "bg-slate-100"}`}>
                                  {STATUS_LABELS[record.status] || record.status}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {record.quantity} {record.unit}
                              </td>
                              <td className="px-3 py-2 text-right font-semibold tabular-nums text-sky-700">
                                {money(record.currency, record.unit_price)}
                              </td>
                              {canViewCost && (
                                <>
                                  <td className="px-3 py-2">{record.supplier_name || "-"}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {record.purchase_price ? money(record.purchase_currency || "", record.purchase_price) : "-"}
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {record.profit_margin_percent ? percent(record.profit_margin_percent) : "-"}
                                  </td>
                                  <td
                                    className={`px-3 py-2 text-right font-semibold tabular-nums ${(record.unit_profit_cny || 0) < 0 ? "text-rose-600" : "text-emerald-700"}`}
                                  >
                                    {record.cost_complete ? (record.unit_profit_cny || 0).toFixed(2) : "-"}
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {record.cost_complete ? percent(record.profit_margin || 0) : "-"}
                                  </td>
                                </>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
  );

  const detailGroup = detailKey ? groups.find((group) => group.key === detailKey) : undefined;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
        <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm text-slate-500 lg:max-w-md">
          <Search className="h-4 w-4 shrink-0" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索 SKU、规格、业务单号..."
            className="min-w-0 flex-1 outline-none"
          />
        </label>
        {customers.length > 0 && (
          <select
            value={customerID}
            onChange={(event) => setCustomerID(Number(event.target.value))}
            className="h-9 max-w-52 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600"
          >
            <option value={0}>全部客户</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => setAcceptedOnly((current) => !current)}
          className={`h-9 rounded-lg border px-3 text-sm font-medium ${acceptedOnly ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
        >
          仅成交价
        </button>
        <div className="flex h-9 rounded-lg border border-slate-200 p-0.5">
          {(
            [
              ["grid", "图片"],
              ["list", "列表"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              className={`rounded-md px-3 text-sm font-medium ${viewMode === mode ? "bg-slate-900 text-white" : "text-slate-500"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-400">
          {canViewCost ? (
            "管理员视图：含采购成本与利润"
          ) : (
            <>
              <Lock className="h-3.5 w-3.5" />
              显示对客报价（已含利润）
            </>
          )}
        </span>
      </div>

      {error && <div className="m-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

      {loading ? (
        <div className="flex h-56 items-center justify-center text-sm text-slate-400">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          加载报价历史...
        </div>
      ) : groups.length === 0 ? (
        <div className="flex h-56 items-center justify-center text-sm text-slate-400">
          {debouncedSearch || customerID || acceptedOnly ? "没有匹配的报价记录" : "还没有发出过对客报价"}
        </div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {groups.map((group) => {
            const cover = group.images[0];
            const actualPhotos = group.images.filter((image) => image.source === "inspection").length;
            return (
              <button
                key={group.key}
                type="button"
                onClick={() => setDetailKey(group.key)}
                className="group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-left transition hover:border-sky-300 hover:shadow-md active:scale-[0.99]"
              >
                <div className="relative aspect-square w-full overflow-hidden bg-slate-100">
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={cover.thumbnail_url || cover.url}
                      alt={group.sku}
                      loading="lazy"
                      className="h-full w-full object-cover transition group-hover:scale-[1.03]"
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-1 text-slate-300">
                      <ImageOff className="h-8 w-8" />
                      <span className="text-xs">暂无图片</span>
                    </div>
                  )}
                  {cover && (
                    <span
                      className={`absolute left-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${cover.source === "inspection" ? "bg-teal-600 text-white" : "bg-white/90 text-slate-600"}`}
                    >
                      {cover.source === "inspection" ? "到货实拍" : "客户询价图"}
                    </span>
                  )}
                  {group.images.length > 1 && (
                    <span className="absolute bottom-1.5 right-1.5 rounded-md bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                      {actualPhotos > 0 ? `实拍 ${actualPhotos} · ` : ""}共 {group.images.length} 张
                    </span>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-1 p-2.5">
                  <div className="truncate text-sm font-semibold text-slate-900" title={group.sku}>
                    {group.sku}
                  </div>
                  {group.specification && (
                    <div className="truncate text-xs text-slate-400">{group.specification}</div>
                  )}
                  <div className="mt-auto flex items-baseline justify-between gap-2 pt-1">
                    <span className="truncate font-semibold tabular-nums text-sky-700">
                      {money(group.latest.currency, group.latest.unit_price)}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">{group.records.length} 次</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                    <span>{dateText(group.latest.quoted_at)}</span>
                    {canViewCost && group.latest.cost_complete ? (
                      <span className={(group.latest.unit_profit_cny || 0) < 0 ? "text-rose-600" : "text-emerald-700"}>
                        利润 {percent(group.latest.profit_margin || 0)}
                      </span>
                    ) : (
                      <span className={`rounded px-1 ${STATUS_STYLES[group.latest.status] || ""}`}>
                        {STATUS_LABELS[group.latest.status] || group.latest.status}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          <div className="hidden grid-cols-[64px_minmax(180px,1.4fr)_minmax(150px,1fr)_minmax(120px,0.8fr)_90px_minmax(150px,1fr)_28px] gap-3 bg-slate-50 px-4 py-2 text-xs text-slate-500 lg:grid">
            <span>图片</span>
            <span>SKU</span>
            <span>最近报价</span>
            <span>历史区间</span>
            <span>报价次数</span>
            <span>{canViewCost ? "最近成本 / 利润" : "最近客户"}</span>
            <span />
          </div>
          {groups.map((group) => {
            const open = expanded.has(group.key);
            const cover = group.images[0];
            return (
              <div key={group.key}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(group.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggle(group.key);
                    }
                  }}
                  className="grid cursor-pointer grid-cols-[56px_minmax(0,1fr)_24px] items-center gap-3 px-4 py-3 hover:bg-slate-50 lg:grid-cols-[64px_minmax(180px,1.4fr)_minmax(150px,1fr)_minmax(120px,0.8fr)_90px_minmax(150px,1fr)_28px]"
                >
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (cover) setViewer({ images: group.images, index: 0, title: group.sku });
                    }}
                    className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 text-slate-300 lg:h-16 lg:w-16"
                    title={cover ? "查看货物图片" : "暂无图片"}
                  >
                    {cover ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={cover.thumbnail_url || cover.url} alt={group.sku} className="h-full w-full object-cover" />
                    ) : (
                      <ImageOff className="h-5 w-5" />
                    )}
                    {group.images.length > 1 && (
                      <span className="absolute bottom-0.5 right-0.5 rounded bg-slate-900/70 px-1 text-[10px] font-semibold text-white">
                        {group.images.length}
                      </span>
                    )}
                  </button>
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-slate-900">{group.sku}</div>
                    <div className="truncate text-xs text-slate-400">{group.specification || "—"}</div>
                    <div className="mt-1 text-xs text-slate-500 lg:hidden">
                      最近 <strong className="text-sky-700">{money(group.latest.currency, group.latest.unit_price)}</strong> ·{" "}
                      {group.records.length} 次报价
                    </div>
                  </div>
                  <div className="hidden lg:block">
                    <div className="font-semibold tabular-nums text-sky-700">
                      {money(group.latest.currency, group.latest.unit_price)}
                      <span className="ml-1 text-xs font-normal text-slate-400">/ {group.latest.unit}</span>
                    </div>
                    <div className="text-xs text-slate-400">
                      {dateText(group.latest.quoted_at)} ·{" "}
                      <span className={`rounded px-1 ${STATUS_STYLES[group.latest.status] || ""}`}>
                        {STATUS_LABELS[group.latest.status] || group.latest.status}
                      </span>
                    </div>
                  </div>
                  <div className="hidden text-sm tabular-nums text-slate-600 lg:block">
                    {group.minPrice === group.maxPrice
                      ? money(group.latest.currency, group.minPrice)
                      : `${group.minPrice} – ${group.maxPrice}`}
                    {!group.sameCurrency && <div className="text-[11px] text-amber-600">含多币种</div>}
                  </div>
                  <div className="hidden text-sm text-slate-600 lg:block">
                    {group.records.length} 次
                    {group.acceptedCount > 0 && (
                      <div className="text-[11px] text-emerald-600">成交 {group.acceptedCount}</div>
                    )}
                  </div>
                  <div className="hidden min-w-0 text-sm lg:block">
                    {canViewCost ? (
                      <>
                        <div className="truncate tabular-nums text-slate-600">
                          成本 {group.latest.purchase_price ? money(group.latest.purchase_currency || "", group.latest.purchase_price) : "未录入"}
                        </div>
                        <div
                          className={`text-xs tabular-nums ${(group.latest.unit_profit_cny || 0) < 0 ? "text-rose-600" : "text-emerald-700"}`}
                        >
                          {group.latest.cost_complete
                            ? `单件利润 ¥${(group.latest.unit_profit_cny || 0).toFixed(2)} · ${percent(group.latest.profit_margin || 0)}`
                            : "成本或汇率待补"}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="truncate text-slate-600">{group.latest.customer_name || "其他业务员客户"}</div>
                        <div className="text-xs text-slate-400">{group.customerCount} 个客户询过</div>
                      </>
                    )}
                  </div>
                  <span className="text-slate-400">
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </span>
                </div>

                {open && renderDetails(group)}
              </div>
            );
          })}
        </div>
      )}

      {detailGroup && (
        <div
          className="fixed inset-0 z-[110] flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetailKey(null);
          }}
        >
          <div className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-lg">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate font-semibold">{detailGroup.sku}</h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  {detailGroup.specification || "—"} · 最近报价{" "}
                  <strong className="text-sky-700">{money(detailGroup.latest.currency, detailGroup.latest.unit_price)}</strong>
                  {" "}· 共 {detailGroup.records.length} 次报价
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailKey(null)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
                aria-label="关闭"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{renderDetails(detailGroup)}</div>
          </div>
        </div>
      )}

      {viewer && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/80 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setViewer(null);
          }}
        >
          <div className="flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
              <div className="text-sm font-semibold">
                {viewer.title}
                <span className="ml-2 text-xs font-normal text-slate-400">
                  {viewer.index + 1} / {viewer.images.length} ·{" "}
                  {viewer.images[viewer.index]?.source === "inspection" ? "到货 / 质检实拍" : "客户询价图片"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setViewer(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center bg-slate-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={viewer.images[viewer.index]?.url}
                alt={viewer.title}
                className="max-h-[70vh] max-w-full object-contain"
              />
            </div>
            {viewer.images.length > 1 && (
              <div className="flex gap-2 overflow-x-auto border-t border-slate-200 p-2">
                {viewer.images.map((image, index) => (
                  <button
                    key={image.attachment_id}
                    type="button"
                    onClick={() => setViewer((current) => (current ? { ...current, index } : current))}
                    className={`h-14 w-14 shrink-0 overflow-hidden rounded border-2 ${index === viewer.index ? "border-sky-500" : "border-transparent"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.thumbnail_url || image.url} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
