"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";

import api from "@/lib/api";
import type {
  TradeBossBreakdown,
  TradeBossOrderSummary,
  TradeBossPeriod,
  TradeBossPeriodSummary,
  TradeBossReport,
  TradeBossTrendPoint,
} from "@/types";

function money(currency: string, value: number) {
  return `${currency} ${Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function cny(value: number) {
  return money("CNY", value);
}

function percent(value: number) {
  return `${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
}

function compact(value: number) {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${+(value / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${+(value / 1e4).toFixed(1)}万`;
  return `${+value.toFixed(0)}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function niceStep(raw: number) {
  if (raw <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * power >= raw) return factor * power;
  }
  return 10 * power;
}

function profitTone(value: number) {
  return value < 0 ? "text-rose-600" : "text-emerald-700";
}

type Delta = { text: string; up: boolean; good: boolean } | null;

function relativeDelta(current: number, previous: number, higherIsBetter = true): Delta {
  if (previous === 0) return null;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  if (!Number.isFinite(change)) return null;
  const up = change >= 0;
  return { text: `${up ? "+" : ""}${change.toFixed(1)}%`, up, good: up === higherIsBetter };
}

function pointDelta(current: number, previous: number): Delta {
  const change = current - previous;
  const up = change >= 0;
  return { text: `${up ? "+" : ""}${change.toFixed(1)} 个点`, up, good: up };
}

const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

export function TradeBossPanel({ onOpenOrder }: { onOpenOrder: (orderID: number) => void }) {
  const today = new Date();
  const [period, setPeriod] = useState<TradeBossPeriod>("month");
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [report, setReport] = useState<TradeBossReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setSelectedKey(null);
    const query = new URLSearchParams({ period, year: String(year) });
    if (period === "month") query.set("month", String(month));
    api
      .get<TradeBossReport>(`/trade/boss-report?${query}`)
      .then((response) => {
        if (cancelled) return;
        if (response.code !== 0 || !response.data) throw new Error(response.message || "加载老板面板失败");
        setReport(response.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "加载老板面板失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, year, month, reloadKey]);

  const years = [...new Set([today.getFullYear(), year, ...(report?.available_years || [])])].sort(
    (a, b) => b - a,
  );

  const isFutureMonth = (candidateYear: number, candidateMonth: number) =>
    candidateYear > today.getFullYear() ||
    (candidateYear === today.getFullYear() && candidateMonth > today.getMonth() + 1);

  const selectYear = (value: number) => {
    setYear(value);
    if (isFutureMonth(value, month)) setMonth(today.getMonth() + 1);
  };

  const shift = (step: number) => {
    if (period === "year") {
      selectYear(year + step);
      return;
    }
    const next = new Date(year, month - 1 + step, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth() + 1);
  };

  const nextDisabled =
    period === "year" ? year >= today.getFullYear() : isFutureMonth(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1);

  const goToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth() + 1);
  };

  const openMonth = (monthNumber: number) => {
    setPeriod("month");
    setMonth(monthNumber);
  };

  const exportExcel = async () => {
    if (!report) return;
    const XLSX = await import("xlsx");
    const s = report.summary;
    const workbook = XLSX.utils.book_new();
    const overview = [
      ["报表期间", `${report.label}（${report.start_date} 至 ${report.end_date}）`],
      ["已完成订单", s.completed_orders],
      ["已核算订单", s.finalized_orders],
      ["待核算订单", s.incomplete_orders],
      ["盈利订单", s.profitable_orders],
      ["亏损订单", s.loss_orders],
      ["销售额 CNY", s.revenue_cny],
      ["商品收入 CNY", s.goods_revenue_cny],
      ["运费收入 CNY", s.freight_revenue_cny],
      ["手续费收入 CNY", s.fee_revenue_cny],
      ["产品成本 CNY", s.product_cost_cny],
      ["实际运费 CNY", s.freight_cost_cny],
      ["附加成本 CNY", s.additional_cost_cny],
      ["总成本 CNY", s.total_cost_cny],
      ["利润 CNY", s.profit_amount_cny],
      ["利润率 %", s.profit_margin],
      ["平均单利润 CNY", s.average_profit_cny],
      [`${report.previous_label} 利润 CNY`, report.previous.profit_amount_cny],
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(overview), "概览");
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        report.trend.map((point) => ({
          [report.period === "year" ? "月份" : "日期"]: point.key,
          完成订单: point.completed_orders,
          已核算: point.finalized_orders,
          "销售额 CNY": point.revenue_cny,
          "成本 CNY": point.total_cost_cny,
          "利润 CNY": point.profit_amount_cny,
          "利润率 %": point.profit_margin,
        })),
      ),
      report.period === "year" ? "月度趋势" : "每日趋势",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        report.orders.map((order) => ({
          完成日期: formatDate(order.completed_at),
          订单号: order.order_no,
          标题: order.title,
          客户: order.customer_name,
          业务员: order.owner_name,
          币种: order.currency,
          销售额: order.revenue,
          总成本: order.total_cost,
          利润: order.profit_amount,
          "利润率 %": order.profit_margin,
          "销售额 CNY": order.finalized ? order.revenue_cny : "",
          "利润 CNY": order.finalized ? order.profit_amount_cny : "",
          状态: order.finalized ? "已核算" : `待核算：${order.warnings.join("；")}`,
        })),
      ),
      "订单明细",
    );
    const breakdownSheet = (rows: TradeBossBreakdown[], name: string, withQuantity = false) =>
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(
          rows.map((row) => ({
            [name]: row.label,
            订单数: row.orders,
            ...(withQuantity ? { 数量: row.quantity || 0 } : {}),
            "销售额 CNY": row.revenue_cny,
            "成本 CNY": row.cost_cny,
            "利润 CNY": row.profit_amount_cny,
            "利润率 %": row.profit_margin,
          })),
        ),
        `${name}排行`,
      );
    breakdownSheet(report.customers, "客户");
    breakdownSheet(report.owners, "业务员");
    breakdownSheet(report.products, "产品", true);
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        report.currencies.map((currency) => ({
          币种: currency.currency,
          订单数: currency.order_count,
          商品收入: currency.goods_revenue,
          报价运费: currency.freight_revenue,
          产品成本: currency.product_cost,
          附加成本: currency.additional_cost,
          实际运费: currency.actual_freight_cost,
          利润: currency.profit_amount,
          "利润率 %": currency.profit_margin,
        })),
      ),
      "分币种",
    );
    XLSX.writeFile(workbook, `老板报表-${report.label}.xlsx`);
  };

  return (
    <div className="space-y-4 bg-slate-50/60 p-3 md:p-4">
      <section className="rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex rounded-md bg-slate-100 p-0.5">
            {(
              [
                ["month", "月报"],
                ["year", "年报"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setPeriod(value)}
                className={`h-8 rounded px-4 text-sm font-medium ${period === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => shift(-1)}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50"
              title={period === "year" ? "上一年" : "上个月"}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <select
              value={year}
              onChange={(event) => selectYear(Number(event.target.value))}
              className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm font-semibold"
            >
              {years.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate} 年
                </option>
              ))}
            </select>
            {period === "month" && (
              <select
                value={month}
                onChange={(event) => setMonth(Number(event.target.value))}
                className="h-8 rounded-md border border-slate-200 bg-white px-2 text-sm font-semibold"
              >
                {MONTHS.map((candidate) => (
                  <option key={candidate} value={candidate} disabled={isFutureMonth(year, candidate)}>
                    {candidate} 月
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => shift(1)}
              disabled={nextDisabled}
              className="flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              title={period === "year" ? "下一年" : "下个月"}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            onClick={goToday}
            className="h-8 rounded-md border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50"
          >
            {period === "year" ? "今年" : "本月"}
          </button>
          <div className="ml-auto flex items-center gap-2">
            {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
            <button
              type="button"
              onClick={() => setReloadKey((value) => value + 1)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-sm text-slate-600 hover:bg-slate-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </button>
            <button
              type="button"
              onClick={() => void exportExcel()}
              disabled={!report}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-slate-900 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              导出 Excel
            </button>
          </div>
        </div>
        {period === "month" && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {MONTHS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                disabled={isFutureMonth(year, candidate)}
                onClick={() => setMonth(candidate)}
                className={`h-7 min-w-[52px] rounded-md px-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-35 ${candidate === month ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
              >
                {candidate} 月
              </button>
            ))}
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      )}

      {!report ? (
        !error && (
          <div className="flex h-64 items-center justify-center text-sm text-slate-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载经营数据...
          </div>
        )
      ) : (
        <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
          <KpiCards report={report} />
          <TrendSection
            report={report}
            selectedKey={selectedKey}
            onSelect={(point, index) => {
              if (report.period === "year") openMonth(index + 1);
              else setSelectedKey((current) => (current === point.key ? null : point.key));
            }}
          />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <CompositionSection summary={report.summary} />
            <OrderStatusSection report={report} />
          </div>
          <RankingSection report={report} />
          {report.period === "year" && <YearTable report={report} onOpenMonth={openMonth} />}
          <CurrencySection report={report} />
          <OrdersSection
            report={report}
            selectedKey={selectedKey}
            onClearSelected={() => setSelectedKey(null)}
            onOpenOrder={onOpenOrder}
          />
        </div>
      )}
    </div>
  );
}

function KpiCards({ report }: { report: TradeBossReport }) {
  const s = report.summary;
  const p = report.previous;
  const compareLabel = report.period === "year" ? "较上年" : "较上月";
  const cards: Array<{ label: string; value: string; sub: string; delta: Delta; tone?: string }> = [
    {
      label: "利润（人民币）",
      value: cny(s.profit_amount_cny),
      sub: `${report.previous_label}：${cny(p.profit_amount_cny)}`,
      delta: relativeDelta(s.profit_amount_cny, p.profit_amount_cny),
      tone: profitTone(s.profit_amount_cny),
    },
    {
      label: "销售额",
      value: cny(s.revenue_cny),
      sub: `${report.previous_label}：${cny(p.revenue_cny)}`,
      delta: relativeDelta(s.revenue_cny, p.revenue_cny),
    },
    {
      label: "总成本",
      value: cny(s.total_cost_cny),
      sub: `${report.previous_label}：${cny(p.total_cost_cny)}`,
      delta: relativeDelta(s.total_cost_cny, p.total_cost_cny, false),
    },
    {
      label: "利润率",
      value: percent(s.profit_margin),
      sub: `${report.previous_label}：${percent(p.profit_margin)}`,
      delta: p.finalized_orders > 0 ? pointDelta(s.profit_margin, p.profit_margin) : null,
    },
    {
      label: "完成订单",
      value: `${s.completed_orders} 单`,
      sub: `已核算 ${s.finalized_orders} · 待核算 ${s.incomplete_orders}`,
      delta: relativeDelta(s.completed_orders, p.completed_orders),
    },
    {
      label: "平均单利润",
      value: cny(s.average_profit_cny),
      sub: `进行中 ${report.active_orders} 单（${compact(report.active_revenue_cny)} 待完成）`,
      delta: relativeDelta(s.average_profit_cny, p.average_profit_cny),
    },
  ];
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-2 xl:grid-cols-6">
      {cards.map((card) => (
        <div key={card.label} className="bg-white px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
            <span>{card.label}</span>
            {card.delta && (
              <span
                className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold ${card.delta.good ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-600"}`}
                title={compareLabel}
              >
                {card.delta.up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {card.delta.text}
              </span>
            )}
          </div>
          <div className={`mt-1 truncate text-lg font-semibold tabular-nums ${card.tone || "text-slate-900"}`}>
            {card.value}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-slate-400">{card.sub}</div>
        </div>
      ))}
    </div>
  );
}

const CHART = { width: 960, height: 280, left: 64, right: 16, top: 16, bottom: 34 };

function TrendSection({
  report,
  selectedKey,
  onSelect,
}: {
  report: TradeBossReport;
  selectedKey: string | null;
  onSelect: (point: TradeBossTrendPoint, index: number) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [showCumulative, setShowCumulative] = useState(report.period === "month");
  const points = report.trend;
  const cumulative = useMemo(() => {
    let sum = 0;
    return points.map((point) => (sum += point.profit_amount_cny));
  }, [points]);

  const values = points.flatMap((point) => [point.revenue_cny, point.total_cost_cny, point.profit_amount_cny]);
  if (showCumulative) values.push(...cumulative);
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  const step = niceStep((rawMax - rawMin || 1) / 4);
  const maxValue = Math.max(step, Math.ceil(rawMax / step) * step);
  const minValue = Math.floor(rawMin / step) * step;
  const ticks: number[] = [];
  for (let value = minValue; value <= maxValue + step / 2; value += step) ticks.push(value);

  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const slot = plotWidth / Math.max(points.length, 1);
  const barWidth = Math.min(16, slot * 0.32);
  const y = (value: number) => CHART.top + ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  const x = (index: number) => CHART.left + slot * index + slot / 2;
  const zero = y(0);
  const path = (series: number[]) =>
    series.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");

  const active = hovered !== null ? points[hovered] : null;
  const hasData = points.some((point) => point.completed_orders > 0);
  const best = points.reduce<TradeBossTrendPoint | null>(
    (top, point) => (point.finalized_orders > 0 && (!top || point.profit_amount_cny > top.profit_amount_cny) ? point : top),
    null,
  );
  const activeSlots = points.filter((point) => point.finalized_orders > 0).length;
  const unit = report.period === "year" ? "月" : "天";
  const now = new Date();
  const todayKey =
    report.period === "year"
      ? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
      : formatDate(now.toISOString());
  const elapsedSlots = points.filter((point) => point.key <= todayKey).length || points.length;

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">
            {report.label} {report.period === "year" ? "月度" : "每日"}经营趋势
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {report.start_date} 至 {report.end_date}，按订单完成日期归属；金额只含成本、汇率完整的订单。
            {report.period === "year" ? "点击柱子查看该月月报。" : "点击某天可筛选下方订单。"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-sky-500" />
            销售额
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-slate-400" />
            成本
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 bg-emerald-500" />
            利润
          </span>
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showCumulative}
              onChange={(event) => setShowCumulative(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span className="h-0.5 w-4 border-t-2 border-dashed border-violet-500" />
            累计利润
          </label>
        </div>
      </div>
      <div className="grid gap-px border-b border-slate-100 bg-slate-100 text-xs sm:grid-cols-3">
        <div className="bg-white px-4 py-2">
          <span className="text-slate-400">有利润入账的{unit}数：</span>
          <span className="font-semibold tabular-nums">
            {activeSlots} / {points.length}
          </span>
        </div>
        <div className="bg-white px-4 py-2">
          <span className="text-slate-400">利润最高：</span>
          <span className="font-semibold">
            {best ? `${best.label} · ${cny(best.profit_amount_cny)}` : "—"}
          </span>
        </div>
        <div className="bg-white px-4 py-2">
          <span className="text-slate-400">
            平均每{unit}利润{elapsedSlots < points.length ? `（已过 ${elapsedSlots} ${unit}）` : ""}：
          </span>
          <span className="font-semibold tabular-nums">{cny(report.summary.profit_amount_cny / elapsedSlots)}</span>
        </div>
      </div>
      <div className="relative overflow-x-auto px-2 py-3">
        <div className="relative min-w-[720px]">
          <svg
            viewBox={`0 0 ${CHART.width} ${CHART.height}`}
            className="h-auto w-full select-none"
            onMouseLeave={() => setHovered(null)}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={CHART.left}
                  x2={CHART.width - CHART.right}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke={tick === 0 ? "#94a3b8" : "#e2e8f0"}
                  strokeDasharray={tick === 0 ? undefined : "3 3"}
                />
                <text x={CHART.left - 8} y={y(tick) + 4} textAnchor="end" className="fill-slate-400 text-[11px]">
                  {compact(tick)}
                </text>
              </g>
            ))}
            {points.map((point, index) => {
              const center = x(index);
              const selected = selectedKey === point.key;
              const revenueTop = y(Math.max(0, point.revenue_cny));
              const costTop = y(Math.max(0, point.total_cost_cny));
              return (
                <g key={point.key}>
                  {(hovered === index || selected) && (
                    <rect
                      x={CHART.left + slot * index}
                      y={CHART.top}
                      width={slot}
                      height={plotHeight}
                      fill={selected ? "#e0f2fe" : "#f1f5f9"}
                    />
                  )}
                  {point.revenue_cny > 0 && (
                    <rect
                      x={center - barWidth - 1}
                      y={revenueTop}
                      width={barWidth}
                      height={Math.max(1.5, zero - revenueTop)}
                      rx={2}
                      className="fill-sky-500"
                    />
                  )}
                  {point.total_cost_cny > 0 && (
                    <rect
                      x={center + 1}
                      y={costTop}
                      width={barWidth}
                      height={Math.max(1.5, zero - costTop)}
                      rx={2}
                      className="fill-slate-400"
                    />
                  )}
                  {point.completed_orders > point.finalized_orders && (
                    <circle cx={center} cy={zero - 6} r={2.5} className="fill-amber-500" />
                  )}
                  {(report.period === "year" || points.length <= 16 || index % 2 === 0 || index === points.length - 1) && (
                    <text
                      x={center}
                      y={CHART.height - CHART.bottom + 18}
                      textAnchor="middle"
                      className={`text-[11px] ${selected ? "fill-sky-700 font-semibold" : "fill-slate-500"}`}
                    >
                      {report.period === "year" ? point.label : index + 1}
                    </text>
                  )}
                </g>
              );
            })}
            {showCumulative && (
              <path d={path(cumulative)} fill="none" stroke="#8b5cf6" strokeWidth={2} strokeDasharray="5 4" />
            )}
            <path d={path(points.map((point) => point.profit_amount_cny))} fill="none" stroke="#10b981" strokeWidth={2} />
            {points.map((point, index) =>
              point.finalized_orders > 0 ? (
                <circle
                  key={point.key}
                  cx={x(index)}
                  cy={y(point.profit_amount_cny)}
                  r={hovered === index ? 4.5 : 3}
                  fill={point.profit_amount_cny < 0 ? "#f43f5e" : "#10b981"}
                  stroke="#fff"
                  strokeWidth={1.5}
                />
              ) : null,
            )}
            {points.map((point, index) => (
              <rect
                key={point.key}
                x={CHART.left + slot * index}
                y={CHART.top}
                width={slot}
                height={plotHeight + CHART.bottom}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHovered(index)}
                onClick={() => onSelect(point, index)}
              />
            ))}
            {!hasData && (
              <text x={CHART.width / 2} y={CHART.height / 2} textAnchor="middle" className="fill-slate-400 text-[13px]">
                {report.label} 没有已完成的订单
              </text>
            )}
          </svg>
          {active && hovered !== null && (
            <div
              className="pointer-events-none absolute top-1 z-10 w-56 rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-lg"
              style={{
                left: `${(x(hovered) / CHART.width) * 100}%`,
                transform:
                  hovered < points.length / 4
                    ? "translateX(8px)"
                    : hovered > (points.length * 3) / 4
                      ? "translateX(calc(-100% - 8px))"
                      : "translateX(-50%)",
              }}
            >
              <div className="mb-1 font-semibold text-slate-800">
                {report.period === "year" ? `${report.year}年${active.label}` : active.key}
              </div>
              <TooltipRow label="完成订单" value={`${active.completed_orders} 单（已核算 ${active.finalized_orders}）`} />
              <TooltipRow label="销售额" value={cny(active.revenue_cny)} />
              <TooltipRow label="成本" value={cny(active.total_cost_cny)} />
              <TooltipRow label="利润" value={cny(active.profit_amount_cny)} tone={profitTone(active.profit_amount_cny)} />
              <TooltipRow label="利润率" value={percent(active.profit_margin)} />
              <TooltipRow label="累计利润" value={cny(cumulative[hovered])} />
              {active.completed_orders > active.finalized_orders && (
                <div className="mt-1 text-[11px] text-amber-600">
                  {active.completed_orders - active.finalized_orders} 单待补成本/汇率，未计入金额
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function TooltipRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="text-slate-400">{label}</span>
      <span className={`font-medium tabular-nums ${tone || "text-slate-700"}`}>{value}</span>
    </div>
  );
}

function StackedBar({
  total,
  parts,
}: {
  total: number;
  parts: Array<{ label: string; value: number; color: string }>;
}) {
  return (
    <div className="flex h-7 w-full overflow-hidden rounded bg-slate-100">
      {parts.map((part) =>
        part.value > 0 && total > 0 ? (
          <div
            key={part.label}
            className={part.color}
            style={{ width: `${Math.min(100, (part.value / total) * 100)}%` }}
            title={`${part.label}：${cny(part.value)}（${percent((part.value / total) * 100)}）`}
          />
        ) : null,
      )}
    </div>
  );
}

function CompositionSection({ summary: s }: { summary: TradeBossPeriodSummary }) {
  const scale = Math.max(s.revenue_cny, s.total_cost_cny, 1);
  const otherRevenue = s.revenue_cny - s.goods_revenue_cny - s.freight_revenue_cny - s.fee_revenue_cny;
  const revenueParts = [
    { label: "商品收入", value: s.goods_revenue_cny, color: "bg-sky-500" },
    { label: "运费收入", value: s.freight_revenue_cny, color: "bg-cyan-400" },
    { label: "手续费收入", value: s.fee_revenue_cny, color: "bg-indigo-400" },
    ...(Math.abs(otherRevenue) >= 0.01
      ? [{ label: "订单总额调整", value: otherRevenue, color: "bg-sky-200" }]
      : []),
  ];
  const costParts = [
    { label: "产品成本", value: s.product_cost_cny, color: "bg-slate-500" },
    { label: "实际运费", value: s.freight_cost_cny, color: "bg-orange-400" },
    { label: "附加成本", value: s.additional_cost_cny, color: "bg-amber-300" },
  ];
  const freightProfit = s.freight_revenue_cny - s.freight_cost_cny;
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold">利润构成</h3>
        <p className="mt-0.5 text-xs text-slate-400">
          {s.finalized_orders} 单已核算订单，按各订单报价汇率折算人民币。
        </p>
      </div>
      <div className="space-y-4 px-4 py-4">
        {[
          { title: "销售额", total: s.revenue_cny, parts: revenueParts },
          { title: "总成本", total: s.total_cost_cny, parts: costParts },
        ].map((row) => (
          <div key={row.title}>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="font-semibold text-slate-700">{row.title}</span>
              <span className="font-semibold tabular-nums text-slate-900">{cny(row.total)}</span>
            </div>
            <div style={{ width: `${Math.max(2, (row.total / scale) * 100)}%` }}>
              <StackedBar total={row.total} parts={row.parts} />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
              {row.parts.map((part) => (
                <span key={part.label} className="inline-flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-sm ${part.color}`} />
                  {part.label}
                  <span className="font-medium tabular-nums text-slate-700">{cny(part.value)}</span>
                  {row.total > 0 && <span className="text-slate-400">{percent((part.value / row.total) * 100)}</span>}
                </span>
              ))}
            </div>
          </div>
        ))}
        <div className="grid gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 text-xs sm:grid-cols-3">
          <div className="bg-white px-3 py-2">
            <div className="text-slate-400">净利润</div>
            <div className={`mt-0.5 text-sm font-semibold tabular-nums ${profitTone(s.profit_amount_cny)}`}>
              {cny(s.profit_amount_cny)}
            </div>
          </div>
          <div className="bg-white px-3 py-2">
            <div className="text-slate-400">商品毛利（商品收入 − 产品成本）</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">
              {cny(s.goods_revenue_cny - s.product_cost_cny)}
            </div>
          </div>
          <div className="bg-white px-3 py-2">
            <div className="text-slate-400">运费利润</div>
            <div className={`mt-0.5 text-sm font-semibold tabular-nums ${profitTone(freightProfit)}`}>{cny(freightProfit)}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function OrderStatusSection({ report }: { report: TradeBossReport }) {
  const s = report.summary;
  const even = Math.max(0, s.finalized_orders - s.profitable_orders - s.loss_orders);
  const slices = [
    { label: "盈利", value: s.profitable_orders, color: "#10b981" },
    { label: "亏损", value: s.loss_orders, color: "#f43f5e" },
    { label: "持平", value: even, color: "#94a3b8" },
    { label: "待核算", value: s.incomplete_orders, color: "#f59e0b" },
  ];
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold">订单盈亏分布</h3>
        <p className="mt-0.5 text-xs text-slate-400">{report.label} 完成的订单</p>
      </div>
      <div className="flex flex-wrap items-center gap-6 px-4 py-4">
        <svg viewBox="0 0 140 140" className="h-36 w-36 shrink-0 -rotate-90">
          <circle cx={70} cy={70} r={radius} fill="none" stroke="#f1f5f9" strokeWidth={18} />
          {total > 0 &&
            slices.map((slice) => {
              const length = (slice.value / total) * circumference;
              const element = (
                <circle
                  key={slice.label}
                  cx={70}
                  cy={70}
                  r={radius}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth={18}
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={-offset}
                >
                  <title>{`${slice.label} ${slice.value} 单`}</title>
                </circle>
              );
              offset += length;
              return element;
            })}
          <text x={70} y={66} textAnchor="middle" transform="rotate(90 70 70)" className="fill-slate-900 text-[22px] font-semibold">
            {total}
          </text>
          <text x={70} y={86} textAnchor="middle" transform="rotate(90 70 70)" className="fill-slate-400 text-[11px]">
            完成订单
          </text>
        </svg>
        <div className="min-w-[160px] flex-1 space-y-2 text-sm">
          {slices.map((slice) => (
            <div key={slice.label} className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-slate-600">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: slice.color }} />
                {slice.label}
              </span>
              <span className="tabular-nums">
                <span className="font-semibold">{slice.value}</span>
                <span className="ml-1.5 text-xs text-slate-400">
                  {total > 0 ? percent((slice.value / total) * 100) : "0%"}
                </span>
              </span>
            </div>
          ))}
          <div className="border-t border-slate-100 pt-2 text-xs text-slate-500">
            进行中 <span className="font-semibold text-slate-700">{report.active_orders}</span> 单，完成后计入当月利润
          </div>
        </div>
      </div>
    </section>
  );
}

type RankTab = "customers" | "owners" | "products";

function RankingSection({ report }: { report: TradeBossReport }) {
  const [tab, setTab] = useState<RankTab>("customers");
  const rows = report[tab];
  const maxProfit = Math.max(1, ...rows.map((row) => Math.abs(row.profit_amount_cny)));
  const tabs: Array<[RankTab, string]> = [
    ["customers", "客户"],
    ["owners", "业务员"],
    ["products", "产品 SKU"],
  ];
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">利润排行 Top 10</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            {report.label} 已核算订单；产品利润只算商品收入减采购成本，不含运费和附加成本。
          </p>
        </div>
        <div className="inline-flex rounded-md bg-slate-100 p-0.5">
          {tabs.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`h-7 rounded px-3 text-xs font-medium ${tab === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs text-slate-400">该期间暂无已核算订单</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="w-10 px-4 py-2.5">#</th>
                <th className="px-4 py-2.5">{tabs.find(([value]) => value === tab)?.[1]}</th>
                <th className="px-4 py-2.5 text-right">订单数</th>
                {tab === "products" && <th className="px-4 py-2.5 text-right">数量</th>}
                <th className="px-4 py-2.5 text-right">销售额</th>
                <th className="w-[32%] px-4 py-2.5">利润</th>
                <th className="px-4 py-2.5 text-right">利润率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.key} className="border-t border-slate-100">
                  <td className="px-4 py-2.5 text-xs text-slate-400">{index + 1}</td>
                  <td className="max-w-64 truncate px-4 py-2.5 font-medium" title={row.label}>
                    {row.label}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.orders}</td>
                  {tab === "products" && (
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {(row.quantity || 0).toLocaleString("zh-CN")}
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-right tabular-nums">{cny(row.revenue_cny)}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={`h-full rounded-full ${row.profit_amount_cny < 0 ? "bg-rose-400" : "bg-emerald-500"}`}
                          style={{ width: `${(Math.abs(row.profit_amount_cny) / maxProfit) * 100}%` }}
                        />
                      </div>
                      <span className={`w-32 text-right text-xs font-semibold tabular-nums ${profitTone(row.profit_amount_cny)}`}>
                        {cny(row.profit_amount_cny)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{percent(row.profit_margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function YearTable({ report, onOpenMonth }: { report: TradeBossReport; onOpenMonth: (month: number) => void }) {
  const s = report.summary;
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold">{report.label} 年度报表</h3>
        <p className="mt-0.5 text-xs text-slate-400">点击某个月份进入该月月报。</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="px-4 py-2.5">月份</th>
              <th className="px-4 py-2.5 text-right">完成 / 已核算</th>
              <th className="px-4 py-2.5 text-right">销售额</th>
              <th className="px-4 py-2.5 text-right">成本</th>
              <th className="px-4 py-2.5 text-right">利润</th>
              <th className="px-4 py-2.5 text-right">利润率</th>
              <th className="px-4 py-2.5 text-right">占全年利润</th>
            </tr>
          </thead>
          <tbody>
            {report.trend.map((point, index) => (
              <tr
                key={point.key}
                onClick={() => onOpenMonth(index + 1)}
                className="cursor-pointer border-t border-slate-100 hover:bg-sky-50/60"
              >
                <td className="px-4 py-2.5 font-semibold text-sky-700">{point.label}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {point.completed_orders} / {point.finalized_orders}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{cny(point.revenue_cny)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{cny(point.total_cost_cny)}</td>
                <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${profitTone(point.profit_amount_cny)}`}>
                  {cny(point.profit_amount_cny)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{percent(point.profit_margin)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">
                  {s.profit_amount_cny !== 0 ? percent((point.profit_amount_cny / s.profit_amount_cny) * 100) : "—"}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
              <td className="px-4 py-2.5">全年合计</td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {s.completed_orders} / {s.finalized_orders}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{cny(s.revenue_cny)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{cny(s.total_cost_cny)}</td>
              <td className={`px-4 py-2.5 text-right tabular-nums ${profitTone(s.profit_amount_cny)}`}>
                {cny(s.profit_amount_cny)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">{percent(s.profit_margin)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">100%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CurrencySection({ report }: { report: TradeBossReport }) {
  if (report.currencies.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h3 className="text-sm font-semibold">分币种经营汇总</h3>
        <p className="mt-0.5 text-xs text-slate-400">原币分别展示，不直接混加。</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              {["币种", "订单数", "商品收入", "报价运费", "产品成本", "附加成本", "实际运费", "运费利润", "利润", "利润率"].map(
                (label, index) => (
                  <th key={label} className={`px-4 py-2.5 ${index > 0 ? "text-right" : ""}`}>
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {report.currencies.map((currency) => (
              <tr key={currency.currency} className="border-t border-slate-100">
                <td className="px-4 py-2.5 font-semibold">{currency.currency}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{currency.order_count}</td>
                {[
                  currency.goods_revenue,
                  currency.freight_revenue,
                  currency.product_cost,
                  currency.additional_cost,
                  currency.actual_freight_cost,
                ].map((value, index) => (
                  <td key={index} className="px-4 py-2.5 text-right tabular-nums">
                    {money(currency.currency, value)}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-violet-700">
                  {money(currency.currency, currency.freight_profit)}
                </td>
                <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${profitTone(currency.profit_amount)}`}>
                  {money(currency.currency, currency.profit_amount)}
                </td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{percent(currency.profit_margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type OrderFilter = "all" | "profit" | "loss" | "pending";
type OrderSort = "date" | "profit_desc" | "profit_asc" | "margin";

function matchesOrderFilter(order: TradeBossOrderSummary, filter: OrderFilter) {
  switch (filter) {
    case "profit":
      return order.finalized && order.profit_amount_cny > 0;
    case "loss":
      return order.finalized && order.profit_amount_cny < 0;
    case "pending":
      return !order.finalized;
    default:
      return true;
  }
}

function sortOrders(orders: TradeBossOrderSummary[], sort: OrderSort) {
  // Orders still waiting for cost data sink to the bottom of profit sorts.
  const profitOr = (order: TradeBossOrderSummary, fallback: number) =>
    order.finalized ? order.profit_amount_cny : fallback;
  switch (sort) {
    case "profit_desc":
      return [...orders].sort((a, b) => profitOr(b, -Infinity) - profitOr(a, -Infinity));
    case "profit_asc":
      return [...orders].sort((a, b) => profitOr(a, Infinity) - profitOr(b, Infinity));
    case "margin":
      return [...orders].sort((a, b) => b.profit_margin - a.profit_margin);
    default:
      return orders;
  }
}

function OrdersSection({
  report,
  selectedKey,
  onClearSelected,
  onOpenOrder,
}: {
  report: TradeBossReport;
  selectedKey: string | null;
  onClearSelected: () => void;
  onOpenOrder: (orderID: number) => void;
}) {
  const [filter, setFilter] = useState<OrderFilter>("all");
  const [sort, setSort] = useState<OrderSort>("date");
  const inScope = useMemo(
    () => report.orders.filter((order) => !selectedKey || formatDate(order.completed_at) === selectedKey),
    [report.orders, selectedKey],
  );
  const rows = useMemo(
    () => sortOrders(inScope.filter((order) => matchesOrderFilter(order, filter)), sort),
    [inScope, filter, sort],
  );
  const filters: Array<[OrderFilter, string]> = [
    ["all", "全部"],
    ["profit", "盈利"],
    ["loss", "亏损"],
    ["pending", "待核算"],
  ];
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">{report.label} 完成订单明细</h3>
          <p className="mt-0.5 text-xs text-slate-400">待核算订单缺少成本或汇率，补全后自动计入利润。点击订单查看详情。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedKey && (
            <button
              type="button"
              onClick={onClearSelected}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-sky-50 px-2 text-xs font-medium text-sky-700 hover:bg-sky-100"
            >
              仅 {selectedKey}
              <X className="h-3 w-3" />
            </button>
          )}
          <div className="inline-flex rounded-md bg-slate-100 p-0.5">
            {filters.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`h-7 rounded px-2.5 text-xs font-medium ${filter === value ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}
              >
                {label} {inScope.filter((order) => matchesOrderFilter(order, value)).length}
              </button>
            ))}
          </div>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as OrderSort)}
            className="h-7 rounded-md border border-slate-200 bg-white px-2 text-xs"
          >
            <option value="date">按完成时间</option>
            <option value="profit_desc">利润从高到低</option>
            <option value="profit_asc">利润从低到高</option>
            <option value="margin">利润率从高到低</option>
          </select>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs text-slate-400">没有符合条件的订单</div>
      ) : (
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full min-w-[1080px] text-sm">
            <thead className="sticky top-0 z-[1] bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5">完成日期</th>
                <th className="px-4 py-2.5">订单</th>
                <th className="px-4 py-2.5">客户 / 业务员</th>
                <th className="px-4 py-2.5 text-right">销售额</th>
                <th className="px-4 py-2.5 text-right">总成本</th>
                <th className="px-4 py-2.5 text-right">利润（原币）</th>
                <th className="px-4 py-2.5 text-right">人民币利润</th>
                <th className="px-4 py-2.5 text-right">利润率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((order) => (
                <tr
                  key={order.id}
                  className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                  onClick={() => onOpenOrder(order.id)}
                >
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-slate-500">
                    {formatDate(order.completed_at)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-slate-900">{order.order_no}</div>
                    <div className="mt-0.5 max-w-64 truncate text-xs text-slate-400">{order.title}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div>{order.customer_name}</div>
                    <div className="mt-0.5 text-xs text-slate-400">{order.owner_name}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{money(order.currency, order.revenue)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{money(order.currency, order.total_cost)}</td>
                  <td className={`px-4 py-2.5 text-right font-semibold tabular-nums ${profitTone(order.profit_amount)}`}>
                    {money(order.currency, order.profit_amount)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                    {order.finalized ? (
                      <span className={profitTone(order.profit_amount_cny)}>{cny(order.profit_amount_cny)}</span>
                    ) : (
                      <span className="text-amber-600" title={order.warnings.join("\n")}>
                        待核算
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{percent(order.profit_margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
