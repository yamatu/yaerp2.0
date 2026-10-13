"use client";

import {
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  LayoutGrid,
  Loader2,
  Move,
  MoveDiagonal2,
  Printer,
  RotateCcw,
  Save,
  Tag,
  X,
} from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import api from "@/lib/api";
import { encodeCode128B } from "@/lib/code128";
import { consumeReturnTarget } from "@/lib/returnNavigation";
import { tradeActiveItems } from "@/lib/tradeItems";
import type { TradeOrder, TradeOrderItem, TradePackingGroup } from "@/types";

type PaperPreset = "A4" | "A5" | "LETTER" | "CUSTOM";
type Orientation = "portrait" | "landscape";
type LayoutMode = "printer" | "sheet";

interface LabelOptions {
  mode: LayoutMode;
  showOrderNo: boolean;
  showCustomer: boolean;
  showDestination: boolean;
  showSpec: boolean;
  showCartonNo: boolean;
  showDimensions: boolean;
  showBarcode: boolean;
  footerText: string;
}

interface PrintableLabel {
  key: string;
  entries: Array<{ item: TradeOrderItem; quantity: number }>;
  group?: TradePackingGroup;
  cartonNo: number;
  cartonTotal: number;
}

const MM_TO_PX = 96 / 25.4;
const OPTIONS_KEY = "yaerp:trade:label-options:v1";
const PAPER_PRESETS: Record<
  Exclude<PaperPreset, "CUSTOM">,
  { label: string; width: number; height: number }
> = {
  A4: { label: "A4", width: 210, height: 297 },
  A5: { label: "A5", width: 148, height: 210 },
  LETTER: { label: "Letter", width: 215.9, height: 279.4 },
};
const LABEL_SIZE_PRESETS: Array<[number, number]> = [
  [100, 150],
  [100, 100],
  [100, 70],
  [100, 60],
  [80, 50],
  [70, 40],
  [60, 40],
  [50, 30],
];
const DEFAULT_OPTIONS: LabelOptions = {
  mode: "printer",
  showOrderNo: true,
  showCustomer: true,
  showDestination: true,
  showSpec: true,
  showCartonNo: true,
  showDimensions: true,
  showBarcode: true,
  footerText: "MADE IN CHINA",
};
const OPTION_TOGGLES: Array<[keyof LabelOptions, string]> = [
  ["showOrderNo", "业务单号"],
  ["showCustomer", "客户名称"],
  ["showDestination", "目的地"],
  ["showSpec", "规格说明"],
  ["showCartonNo", "箱号 C/NO"],
  ["showDimensions", "箱规与毛重"],
  ["showBarcode", "SKU 条码"],
];

function numberOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function readOptions(): LabelOptions {
  if (typeof window === "undefined") return DEFAULT_OPTIONS;
  try {
    const raw = window.localStorage.getItem(OPTIONS_KEY);
    return raw ? { ...DEFAULT_OPTIONS, ...JSON.parse(raw) } : DEFAULT_OPTIONS;
  } catch {
    return DEFAULT_OPTIONS;
  }
}

function itemCode(item: TradeOrderItem) {
  return item.sku?.trim() || item.product_name?.trim() || `LINE-${item.line_no}`;
}

function Barcode({ value, heightMM }: { value: string; heightMM: number }) {
  const encoded = encodeCode128B(value);
  if (!encoded) return null;
  return (
    <svg
      viewBox={`0 0 ${encoded.modules} 40`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: `${heightMM}mm`, display: "block" }}
      aria-label={`条码 ${value}`}
    >
      {encoded.bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y={0} width={bar.width} height={40} fill="#000" />
      ))}
    </svg>
  );
}

export default function TradeLabelPrintPage() {
  const params = useParams<{ orderId: string }>();
  const router = useRouter();
  const orderID = Number(params.orderId);
  const [order, setOrder] = useState<TradeOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [options, setOptions] = useState<LabelOptions>(DEFAULT_OPTIONS);
  const [paperPreset, setPaperPreset] = useState<PaperPreset>("A4");
  const [paperWidthMM, setPaperWidthMM] = useState(210);
  const [paperHeightMM, setPaperHeightMM] = useState(297);
  const [orientation, setOrientation] = useState<Orientation>("portrait");
  const [widthMM, setWidthMM] = useState(100);
  const [heightMM, setHeightMM] = useState(60);
  const [marginTopMM, setMarginTopMM] = useState(10);
  const [marginRightMM, setMarginRightMM] = useState(10);
  const [marginBottomMM, setMarginBottomMM] = useState(10);
  const [marginLeftMM, setMarginLeftMM] = useState(10);
  const [gapXMM, setGapXMM] = useState(3);
  const [gapYMM, setGapYMM] = useState(3);
  const [contentScale, setContentScale] = useState(1);
  const [startSlot, setStartSlot] = useState(0);
  const [offsetXMM, setOffsetXMM] = useState(10);
  const [offsetYMM, setOffsetYMM] = useState(10);
  const [selectedItemIDs, setSelectedItemIDs] = useState<number[]>([]);
  const [copies, setCopies] = useState<Record<number, number>>({});
  const [selectedGroupIDs, setSelectedGroupIDs] = useState<number[]>([]);
  const [groupCopies, setGroupCopies] = useState<Record<number, number>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setOptions(readOptions());
  }, []);

  const updateOptions = (patch: Partial<LabelOptions>) => {
    setOptions((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      } catch {
        // Private browsing can reject storage; the options still apply now.
      }
      return next;
    });
  };

  useEffect(() => {
    if (!Number.isInteger(orderID) || orderID <= 0) {
      setError("无效的业务单编号。");
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const response = await api.get<TradeOrder>(`/trade/orders/${orderID}`);
        if (response.code !== 0 || !response.data) {
          throw new Error(response.message || "加载标签数据失败");
        }
        const loaded = response.data;
        setOrder(loaded);
        setWidthMM(numberOr(loaded.label_width_mm, 100));
        setHeightMM(numberOr(loaded.label_height_mm, 60));
        setPaperWidthMM(numberOr(loaded.label_paper_width_mm, 210));
        setPaperHeightMM(numberOr(loaded.label_paper_height_mm, 297));
        setOrientation(
          loaded.label_orientation === "landscape" ? "landscape" : "portrait",
        );
        const loadedPreset = String(loaded.label_paper_size || "A4").toUpperCase();
        setPaperPreset(
          loadedPreset === "A4" || loadedPreset === "A5" || loadedPreset === "LETTER"
            ? loadedPreset
            : "CUSTOM",
        );
        setMarginTopMM(numberOr(loaded.label_margin_top_mm, 10));
        setMarginRightMM(numberOr(loaded.label_margin_right_mm, 10));
        setMarginBottomMM(numberOr(loaded.label_margin_bottom_mm, 10));
        setMarginLeftMM(numberOr(loaded.label_margin_left_mm, 10));
        setGapXMM(numberOr(loaded.label_gap_x_mm, 3));
        setGapYMM(numberOr(loaded.label_gap_y_mm, 3));
        setContentScale(clamp(numberOr(loaded.label_content_scale, 1), 0.5, 1.8));
        setStartSlot(Math.max(0, numberOr(loaded.label_start_slot, 0)));
        setOffsetXMM(numberOr(loaded.label_offset_x_mm, loaded.label_margin_left_mm || 10));
        setOffsetYMM(numberOr(loaded.label_offset_y_mm, loaded.label_margin_top_mm || 10));
        const items = loaded.items || [];
        setSelectedItemIDs(tradeActiveItems(items).map((item) => item.id));
        setCopies(
          Object.fromEntries(
            items.map((item) => [item.id, Math.max(1, item.carton_count || 1)]),
          ),
        );
        const groups = loaded.packing_groups || [];
        setSelectedGroupIDs(groups.map((group) => group.id));
        setGroupCopies(
          Object.fromEntries(
            groups.map((group) => [group.id, Math.max(1, group.copies || 1)]),
          ),
        );
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "加载标签数据失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [orderID]);

  const printerMode = options.mode === "printer";
  const pageWidthMM = printerMode
    ? widthMM
    : orientation === "landscape"
      ? paperHeightMM
      : paperWidthMM;
  const pageHeightMM = printerMode
    ? heightMM
    : orientation === "landscape"
      ? paperWidthMM
      : paperHeightMM;
  const effectiveOffsetX = printerMode ? 0 : offsetXMM;
  const effectiveOffsetY = printerMode ? 0 : offsetYMM;
  const effectiveStartSlot = printerMode ? 0 : startSlot;

  const layout = useMemo(() => {
    if (printerMode) {
      return { usableWidth: widthMM, usableHeight: heightMM, columns: 1, rows: 1, capacity: 1 };
    }
    const usableWidth = pageWidthMM - offsetXMM - marginRightMM;
    const usableHeight = pageHeightMM - offsetYMM - marginBottomMM;
    const columns =
      usableWidth > 0 && widthMM > 0
        ? Math.floor((usableWidth + gapXMM) / (widthMM + gapXMM))
        : 0;
    const rows =
      usableHeight > 0 && heightMM > 0
        ? Math.floor((usableHeight + gapYMM) / (heightMM + gapYMM))
        : 0;
    return {
      usableWidth,
      usableHeight,
      columns: Math.max(0, columns),
      rows: Math.max(0, rows),
      capacity: Math.max(0, columns * rows),
    };
  }, [
    gapXMM,
    gapYMM,
    heightMM,
    marginBottomMM,
    marginRightMM,
    offsetXMM,
    offsetYMM,
    pageHeightMM,
    pageWidthMM,
    printerMode,
    widthMM,
  ]);

  useEffect(() => {
    if (printerMode || layout.capacity <= 0) return;
    setStartSlot((current) => clamp(current, 0, layout.capacity - 1));
  }, [layout.capacity, printerMode]);

  const printableItems = useMemo<PrintableLabel[]>(() => {
    if (!order) return [];
    const groups = order.packing_groups || [];
    const labels: Array<Omit<PrintableLabel, "cartonNo" | "cartonTotal">> = [];
    if (groups.length > 0) {
      const itemByID = new Map((order.items || []).map((item) => [item.id, item]));
      for (const group of groups) {
        if (!selectedGroupIDs.includes(group.id)) continue;
        const entries = (group.items || []).flatMap((entry) => {
          const item = itemByID.get(entry.order_item_id);
          return item ? [{ item, quantity: entry.quantity }] : [];
        });
        if (entries.length === 0) continue;
        const total = clamp(Math.round(groupCopies[group.id] || group.copies || 1), 1, 500);
        for (let copy = 0; copy < total; copy += 1) {
          labels.push({ key: `group-${group.id}-${copy}`, entries, group });
        }
      }
    } else {
      for (const item of order.items || []) {
        if (!selectedItemIDs.includes(item.id)) continue;
        const total = clamp(Math.round(copies[item.id] || 1), 1, 500);
        const perCarton =
          item.carton_count > 0
            ? Math.round(((item.packed_quantity || item.quantity) / item.carton_count) * 100) / 100
            : item.packed_quantity || item.quantity;
        for (let copy = 0; copy < total; copy += 1) {
          labels.push({
            key: `item-${item.id}-${copy}`,
            entries: [{ item, quantity: perCarton }],
          });
        }
      }
    }
    return labels.map((label, index) => ({
      ...label,
      cartonNo: index + 1,
      cartonTotal: labels.length,
    }));
  }, [copies, groupCopies, order, selectedGroupIDs, selectedItemIDs]);

  const printablePages = useMemo(() => {
    if (layout.capacity <= 0 || printableItems.length === 0) return [];
    const pages: Array<Array<PrintableLabel | null>> = [];
    let itemIndex = 0;
    let pageIndex = 0;
    while (itemIndex < printableItems.length) {
      const slots = Array<PrintableLabel | null>(layout.capacity).fill(null);
      const firstSlot = pageIndex === 0 ? effectiveStartSlot : 0;
      for (
        let slotIndex = firstSlot;
        slotIndex < layout.capacity && itemIndex < printableItems.length;
        slotIndex += 1
      ) {
        slots[slotIndex] = printableItems[itemIndex];
        itemIndex += 1;
      }
      pages.push(slots);
      pageIndex += 1;
    }
    return pages;
  }, [effectiveStartSlot, layout.capacity, printableItems]);

  const previewScale = useMemo(() => {
    const rawWidth = pageWidthMM * MM_TO_PX;
    const rawHeight = pageHeightMM * MM_TO_PX;
    if (printerMode) return clamp(Math.min(340 / rawWidth, 360 / rawHeight), 0.3, 1.6);
    return clamp(Math.min(860 / rawWidth, 690 / rawHeight), 0.18, 1);
  }, [pageHeightMM, pageWidthMM, printerMode]);

  const layoutError = useMemo(() => {
    if (widthMM < 20 || heightMM < 15) return "标签宽度不能小于 20mm，高度不能小于 15mm。";
    if (printerMode) return "";
    if (paperWidthMM < 50 || paperHeightMM < 50) return "纸张宽高不能小于 50mm。";
    if (layout.usableWidth <= 0 || layout.usableHeight <= 0)
      return "标签起点或页边距超过了纸张可用范围。";
    if (layout.capacity <= 0) return "当前标签尺寸无法排入纸张，请缩小标签或边距。";
    return "";
  }, [heightMM, layout, paperHeightMM, paperWidthMM, printerMode, widthMM]);

  const choosePaperPreset = (preset: PaperPreset) => {
    setPaperPreset(preset);
    if (preset === "CUSTOM") return;
    const paper = PAPER_PRESETS[preset];
    setPaperWidthMM(paper.width);
    setPaperHeightMM(paper.height);
  };

  const resetLayout = () => {
    choosePaperPreset("A4");
    setOrientation("portrait");
    setWidthMM(100);
    setHeightMM(60);
    setMarginTopMM(10);
    setMarginRightMM(10);
    setMarginBottomMM(10);
    setMarginLeftMM(10);
    setGapXMM(3);
    setGapYMM(3);
    setContentScale(1);
    setStartSlot(0);
    setOffsetXMM(10);
    setOffsetYMM(10);
    updateOptions(DEFAULT_OPTIONS);
  };

  const saveLayout = async () => {
    if (!order || layoutError) return;
    setSaving(true);
    setError("");
    try {
      const response = await api.put<TradeOrder>(`/trade/orders/${order.id}/label-settings`, {
        width_mm: widthMM,
        height_mm: heightMM,
        paper_size: paperPreset,
        paper_width_mm: paperWidthMM,
        paper_height_mm: paperHeightMM,
        orientation,
        margin_top_mm: marginTopMM,
        margin_right_mm: marginRightMM,
        margin_bottom_mm: marginBottomMM,
        margin_left_mm: marginLeftMM,
        gap_x_mm: gapXMM,
        gap_y_mm: gapYMM,
        content_scale: contentScale,
        start_slot: startSlot,
        offset_x_mm: offsetXMM,
        offset_y_mm: offsetYMM,
      });
      if (response.code !== 0 || !response.data) {
        throw new Error(response.message || "保存标签排版失败");
      }
      setOrder(response.data);
      setNotice("标签尺寸和排版已保存；显示内容会记在本机浏览器中。");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存标签排版失败");
    } finally {
      setSaving(false);
    }
  };

  const beginLabelResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = widthMM;
    const startHeight = heightMM;
    const ratio = startWidth / startHeight;
    const maxWidth = Math.max(20, layout.usableWidth);
    const maxHeight = Math.max(15, layout.usableHeight);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";

    const handleMove = (moveEvent: PointerEvent) => {
      const scale = Math.max(0.1, previewScale * MM_TO_PX);
      let nextWidth = clamp(startWidth + (moveEvent.clientX - startX) / scale, 20, maxWidth);
      let nextHeight = clamp(startHeight + (moveEvent.clientY - startY) / scale, 15, maxHeight);
      if (moveEvent.shiftKey && ratio > 0) {
        const widthMovement = Math.abs(moveEvent.clientX - startX);
        const heightMovement = Math.abs(moveEvent.clientY - startY);
        if (widthMovement >= heightMovement) {
          nextHeight = clamp(nextWidth / ratio, 15, maxHeight);
        } else {
          nextWidth = clamp(nextHeight * ratio, 20, maxWidth);
        }
      }
      setWidthMM(Math.round(nextWidth * 2) / 2);
      setHeightMM(Math.round(nextHeight * 2) / 2);
    };
    const handleEnd = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
  };

  const beginLabelDrag = (event: ReactPointerEvent<HTMLElement>, slotIndex: number) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffsetX = offsetXMM;
    const startOffsetY = offsetYMM;
    const column = slotIndex % Math.max(1, layout.columns);
    const row = Math.floor(slotIndex / Math.max(1, layout.columns));
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";

    const handleMove = (moveEvent: PointerEvent) => {
      const scale = Math.max(0.1, previewScale * MM_TO_PX);
      const columnOffset = column * (widthMM + gapXMM);
      const rowOffset = row * (heightMM + gapYMM);
      const maxX = Math.max(0, pageWidthMM - marginRightMM - widthMM - columnOffset);
      const maxY = Math.max(0, pageHeightMM - marginBottomMM - heightMM - rowOffset);
      setOffsetXMM(
        Math.round(clamp(startOffsetX + (moveEvent.clientX - startX) / scale, 0, maxX) * 2) / 2,
      );
      setOffsetYMM(
        Math.round(clamp(startOffsetY + (moveEvent.clientY - startY) / scale, 0, maxY) * 2) / 2,
      );
    };
    const handleEnd = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      setNotice("标签起始位置已调整，点击“保存排版”后长期保留。");
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleEnd);
  };

  // All type sizes are in mm so a label prints identically at any preview zoom.
  const baseFontMM = clamp(Math.min(heightMM, widthMM * 0.8) / 15, 2, 6) * contentScale;
  const destination = [order?.destination_country, order?.destination_port]
    .map((value) => value?.trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(" · ");

  const renderLabel = (
    entry: PrintableLabel,
    key: string,
    preview = false,
    resizable = false,
    slotIndex = 0,
  ) => {
    const { entries, group } = entry;
    const single = entries.length === 1;
    const code = single ? itemCode(entries[0].item) : "";
    const skuFont = single
      ? Math.min(baseFontMM * 2.6, ((widthMM - 6) / Math.max(code.length, 5)) * 1.7)
      : baseFontMM;
    const barcodeHeight = clamp(heightMM * 0.16, 5, 18);
    const showBarcode =
      options.showBarcode && single && heightMM >= 35 && Boolean(encodeCode128B(code));
    const dimensions =
      options.showDimensions && group
        ? [
            group.length_cm && group.width_cm && group.height_cm
              ? `${group.length_cm}×${group.width_cm}×${group.height_cm} CM`
              : "",
            group.weight_kg ? `G.W. ${group.weight_kg} KG` : "",
          ]
            .filter(Boolean)
            .join("  ")
        : options.showDimensions && single && entries[0].item.gross_weight > 0
          ? `G.W. ${entries[0].item.gross_weight} KG`
          : "";
    const headerLeft: ReactNode[] = [];
    if (options.showCustomer && order?.customer_name)
      headerLeft.push(
        <div key="customer" className="truncate font-bold" style={{ fontSize: `${baseFontMM * 1.15}mm` }}>
          {order.customer_name}
        </div>,
      );
    if (options.showOrderNo && order?.order_no)
      headerLeft.push(
        <div key="order" className="truncate" style={{ fontSize: `${baseFontMM * 0.8}mm` }}>
          PO / {order.order_no}
        </div>,
      );

    return (
      <article
        key={key}
        onPointerDown={preview && resizable ? (event) => beginLabelDrag(event, slotIndex) : undefined}
        className={`trade-label-cell relative h-full w-full overflow-hidden border-[0.3mm] border-black bg-white text-black ${resizable ? "touch-none cursor-grab ring-[0.8mm] ring-sky-400 ring-offset-[0.6mm] active:cursor-grabbing" : ""}`}
        style={{ fontFamily: "Arial, 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif" }}
      >
        <div className="flex h-full w-full flex-col p-[2.5mm]" style={{ gap: `${baseFontMM * 0.35}mm`, lineHeight: 1.15 }}>
          {(headerLeft.length > 0 || options.showCartonNo) && (
            <div className="flex items-start justify-between" style={{ gap: "2mm" }}>
              <div className="min-w-0">{headerLeft}</div>
              {options.showCartonNo && (
                <div
                  className="shrink-0 border-[0.3mm] border-black px-[1.2mm] py-[0.4mm] text-center font-bold tabular-nums"
                  style={{ fontSize: `${baseFontMM * 0.95}mm` }}
                >
                  <div style={{ fontSize: `${baseFontMM * 0.6}mm` }} className="font-semibold">C/NO</div>
                  {entry.cartonNo}/{entry.cartonTotal}
                </div>
              )}
            </div>
          )}

          {single ? (
            <div className="flex min-h-0 flex-1 flex-col justify-center border-y-[0.4mm] border-black" style={{ paddingBlock: "1mm" }}>
              <div style={{ fontSize: `${baseFontMM * 0.6}mm` }} className="font-semibold">SKU</div>
              <div
                className="font-black"
                style={{
                  fontSize: `${skuFont}mm`,
                  lineHeight: 1.05,
                  wordBreak: "break-all",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {code}
              </div>
              {options.showSpec &&
                (entries[0].item.specification || (entries[0].item.product_name !== code && entries[0].item.product_name)) && (
                  <div className="truncate" style={{ fontSize: `${baseFontMM * 0.85}mm` }}>
                    {[entries[0].item.product_name !== code ? entries[0].item.product_name : "", entries[0].item.specification]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              <div className="flex items-baseline justify-between" style={{ marginTop: "0.8mm", gap: "2mm" }}>
                <span style={{ fontSize: `${baseFontMM * 0.75}mm` }} className="font-semibold">QTY</span>
                <span className="font-black tabular-nums" style={{ fontSize: `${baseFontMM * 1.7}mm` }}>
                  {entries[0].quantity} {entries[0].item.unit?.toUpperCase()}
                </span>
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-hidden border-y-[0.4mm] border-black" style={{ paddingBlock: "0.8mm" }}>
              <div
                className="flex justify-between font-semibold"
                style={{ fontSize: `${baseFontMM * 0.6}mm` }}
              >
                <span>SKU · {entries.length} ITEMS</span>
                <span>QTY</span>
              </div>
              {entries.map(({ item, quantity }) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between"
                  style={{
                    gap: "2mm",
                    fontSize: `${baseFontMM * (entries.length > 8 ? 0.7 : entries.length > 4 ? 0.85 : 1.05)}mm`,
                  }}
                >
                  <strong className="min-w-0" style={{ wordBreak: "break-all" }}>
                    {itemCode(item)}
                  </strong>
                  <strong className="shrink-0 tabular-nums">
                    {quantity} {item.unit?.toUpperCase()}
                  </strong>
                </div>
              ))}
            </div>
          )}

          {showBarcode && (
            <div>
              <Barcode value={code} heightMM={barcodeHeight} />
            </div>
          )}

          {(dimensions || (options.showDestination && destination) || options.footerText) && (
            <div className="flex items-end justify-between" style={{ gap: "2mm", fontSize: `${baseFontMM * 0.75}mm` }}>
              <div className="min-w-0">
                {dimensions && <div className="truncate font-semibold">{dimensions}</div>}
                {options.footerText && <div className="truncate">{options.footerText}</div>}
              </div>
              {options.showDestination && destination && (
                <div className="max-w-[55%] truncate text-right font-semibold">TO: {destination}</div>
              )}
            </div>
          )}
        </div>
        {preview && resizable && (
          <button
            type="button"
            onPointerDown={beginLabelResize}
            className="absolute bottom-0 right-0 z-20 flex h-[7mm] w-[7mm] touch-none items-center justify-center border-l border-t border-sky-500 bg-sky-500 text-white shadow-sm hover:bg-sky-600"
            title="拖动调整标签宽高；按住 Shift 等比例缩放"
            aria-label="拖动调整标签大小"
          >
            <MoveDiagonal2 className="h-[3.5mm] w-[3.5mm]" />
          </button>
        )}
      </article>
    );
  };

  const renderSheet = (slots: Array<PrintableLabel | null>, pageIndex: number, preview: boolean) => {
    const firstFilledSlot = slots.findIndex(Boolean);
    return (
      <div
        key={`${preview ? "preview" : "print"}-${pageIndex}`}
        className="trade-print-sheet bg-white"
        style={{
          width: `${pageWidthMM}mm`,
          height: `${pageHeightMM}mm`,
          boxSizing: "border-box",
          position: "relative",
          overflow: "hidden",
          breakAfter: !preview && pageIndex < printablePages.length - 1 ? "page" : "auto",
        }}
      >
        {slots.map((entry, slotIndex) => {
          if (!entry) return null;
          const column = slotIndex % layout.columns;
          const row = Math.floor(slotIndex / layout.columns);
          return (
            <div
              key={`${pageIndex}-${slotIndex}-${entry.key}`}
              style={{
                position: "absolute",
                left: `${effectiveOffsetX + column * (widthMM + gapXMM)}mm`,
                top: `${effectiveOffsetY + row * (heightMM + gapYMM)}mm`,
                width: `${widthMM}mm`,
                height: `${heightMM}mm`,
              }}
            >
              {renderLabel(
                entry,
                `${pageIndex}-${slotIndex}-${entry.key}`,
                preview,
                preview && !printerMode && pageIndex === 0 && slotIndex === firstFilledSlot,
                slotIndex,
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const previewPages = printablePages.slice(0, printerMode ? 24 : 6);
  const marginFields: Array<{ label: string; value: number; setValue: (value: number) => void }> = [
    {
      label: "上",
      value: marginTopMM,
      setValue: (value) => {
        setMarginTopMM(value);
        setOffsetYMM(value);
      },
    },
    { label: "右", value: marginRightMM, setValue: setMarginRightMM },
    { label: "下", value: marginBottomMM, setValue: setMarginBottomMM },
    {
      label: "左",
      value: marginLeftMM,
      setValue: (value) => {
        setMarginLeftMM(value);
        setOffsetXMM(value);
      },
    },
  ];
  const hasGroups = (order?.packing_groups || []).length > 0;

  return (
    <AuthGuard>
      <style>{`
        @page { size: ${pageWidthMM}mm ${pageHeightMM}mm; margin: 0; }
        #trade-label-print { display: none; }
        @media print {
          html, body { margin: 0 !important; padding: 0 !important; background: white !important; }
          .trade-label-screen { display: none !important; }
          #trade-label-print { display: block !important; }
          .trade-print-sheet { margin: 0 !important; box-shadow: none !important; }
          * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      <div className="trade-label-screen min-h-screen bg-slate-100 text-slate-900">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
          <div className="mx-auto flex min-h-16 max-w-[1500px] items-center justify-between gap-3 px-3 py-2 md:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => router.push(consumeReturnTarget("/trade"))}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                title="返回外贸业务中心"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold">SKU 箱唛标签</h1>
                <p className="truncate text-xs text-slate-400">
                  {order ? `${order.order_no} · ${order.customer_name}` : "正在读取业务单"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              disabled={printableItems.length === 0 || printablePages.length === 0 || Boolean(layoutError)}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
              title="按当前排版打印"
            >
              <Printer className="h-4 w-4" />
              打印 {printableItems.length} 张{!printerMode && ` / ${printablePages.length} 页`}
            </button>
          </div>
        </header>

        <main className="mx-auto grid max-w-[1500px] gap-4 p-3 lg:grid-cols-[380px_minmax(0,1fr)] lg:p-5">
          <aside className="space-y-3 self-start lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
            <section className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">排版方式</h2>
                <button
                  type="button"
                  onClick={resetLayout}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs text-slate-500 hover:bg-slate-50"
                  title="恢复默认排版"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  默认
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {(
                  [
                    ["printer", "标签打印机", "每张纸一个标签（热敏/不干胶卷标）"],
                    ["sheet", "A4 拼版", "一张普通纸排多个标签"],
                  ] as const
                ).map(([mode, label, hint]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => updateOptions({ mode })}
                    className={`rounded-lg border p-2.5 text-left ${options.mode === mode ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 hover:bg-slate-50"}`}
                  >
                    <div className="text-sm font-semibold">{label}</div>
                    <div className={`mt-0.5 text-[11px] leading-4 ${options.mode === mode ? "text-slate-300" : "text-slate-400"}`}>
                      {hint}
                    </div>
                  </button>
                ))}
              </div>

              <h3 className="mt-4 text-xs font-semibold text-slate-600">标签尺寸（宽 × 高 mm）</h3>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {LABEL_SIZE_PRESETS.map(([width, height]) => (
                  <button
                    key={`${width}x${height}`}
                    type="button"
                    onClick={() => {
                      setWidthMM(width);
                      setHeightMM(height);
                    }}
                    className={`h-7 rounded-md border px-2 text-xs tabular-nums ${widthMM === width && heightMM === height ? "border-sky-500 bg-sky-50 font-semibold text-sky-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                  >
                    {width}×{height}
                  </button>
                ))}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="text-xs font-medium text-slate-600">
                  宽度/mm
                  <input
                    type="number"
                    min="20"
                    max="300"
                    step="0.5"
                    value={widthMM}
                    onChange={(event) => setWidthMM(Number(event.target.value))}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  高度/mm
                  <input
                    type="number"
                    min="15"
                    max="300"
                    step="0.5"
                    value={heightMM}
                    onChange={(event) => setHeightMM(Number(event.target.value))}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                  />
                </label>
              </div>
              {printerMode && (
                <p className="mt-2 rounded-lg bg-sky-50 px-3 py-2 text-[11px] leading-5 text-sky-800">
                  打印时在浏览器打印对话框中选择标签打印机，纸张尺寸选 {widthMM}×{heightMM}mm，边距选“无”，缩放 100%。
                </p>
              )}
            </section>

            {!printerMode && (
              <section className="rounded-lg border border-slate-200 bg-white p-4">
                <h2 className="text-sm font-semibold">纸张与位置</h2>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="text-xs font-medium text-slate-600">
                    纸张
                    <select
                      value={paperPreset}
                      onChange={(event) => choosePaperPreset(event.target.value as PaperPreset)}
                      className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
                    >
                      <option value="A4">A4</option>
                      <option value="A5">A5</option>
                      <option value="LETTER">Letter</option>
                      <option value="CUSTOM">自定义</option>
                    </select>
                  </label>
                  <div className="text-xs font-medium text-slate-600">
                    方向
                    <div className="mt-1 grid h-9 grid-cols-2 rounded-lg border border-slate-200 p-0.5">
                      {(
                        [
                          ["portrait", "纵向"],
                          ["landscape", "横向"],
                        ] as const
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setOrientation(value)}
                          className={`rounded-md text-xs font-semibold ${orientation === value ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {paperPreset === "CUSTOM" && (
                    <>
                      <label className="text-xs font-medium text-slate-600">
                        纸宽/mm
                        <input
                          type="number"
                          min="50"
                          max="500"
                          step="0.1"
                          value={paperWidthMM}
                          onChange={(event) => setPaperWidthMM(Number(event.target.value))}
                          className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                        />
                      </label>
                      <label className="text-xs font-medium text-slate-600">
                        纸高/mm
                        <input
                          type="number"
                          min="50"
                          max="500"
                          step="0.1"
                          value={paperHeightMM}
                          onChange={(event) => setPaperHeightMM(Number(event.target.value))}
                          className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                        />
                      </label>
                    </>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-6 gap-2">
                  {marginFields.map(({ label, value, setValue }) => (
                    <label key={label} className="text-[11px] font-medium text-slate-500">
                      {label}边距
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.5"
                        value={value}
                        onChange={(event) => setValue(Number(event.target.value))}
                        className="mt-1 h-8 w-full rounded-md border border-slate-200 px-1.5 text-xs"
                      />
                    </label>
                  ))}
                  <label className="text-[11px] font-medium text-slate-500">
                    横间距
                    <input
                      type="number"
                      min="0"
                      max="50"
                      step="0.5"
                      value={gapXMM}
                      onChange={(event) => setGapXMM(Number(event.target.value))}
                      className="mt-1 h-8 w-full rounded-md border border-slate-200 px-1.5 text-xs"
                    />
                  </label>
                  <label className="text-[11px] font-medium text-slate-500">
                    纵间距
                    <input
                      type="number"
                      min="0"
                      max="50"
                      step="0.5"
                      value={gapYMM}
                      onChange={(event) => setGapYMM(Number(event.target.value))}
                      className="mt-1 h-8 w-full rounded-md border border-slate-200 px-1.5 text-xs"
                    />
                  </label>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-xs font-semibold text-slate-700">起始标签位</h3>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      用过半张的标签纸时，从空白格开始；也可在预览中拖动首张标签。
                    </p>
                  </div>
                  <Move className="h-4 w-4 shrink-0 text-sky-600" />
                </div>
                {layout.capacity > 0 && (
                  <div
                    className="mt-2 grid max-h-36 gap-1 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-2"
                    style={{ gridTemplateColumns: `repeat(${layout.columns}, 34px)`, justifyContent: "start" }}
                  >
                    {Array.from({ length: layout.capacity }, (_, index) => (
                      <button
                        key={index}
                        type="button"
                        onClick={() => setStartSlot(index)}
                        className={`flex h-7 items-center justify-center rounded border text-[10px] font-semibold ${index === startSlot ? "border-sky-500 bg-sky-500 text-white" : index < startSlot ? "border-slate-200 bg-slate-200 text-slate-400" : "border-slate-300 bg-white text-slate-500 hover:border-sky-300"}`}
                        title={`从第 ${index + 1} 格开始打印`}
                      >
                        {index + 1}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-2 text-[11px] text-slate-500">
                  起点 X {offsetXMM.toFixed(1)} / Y {offsetYMM.toFixed(1)} mm · 每页 {layout.columns} 列 × {layout.rows} 行
                </div>
              </section>
            )}

            <section className="rounded-lg border border-slate-200 bg-white p-4">
              <h2 className="text-sm font-semibold">标签内容</h2>
              <div className="mt-3 grid grid-cols-2 gap-1.5">
                {OPTION_TOGGLES.map(([key, label]) => {
                  const checked = Boolean(options[key]);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => updateOptions({ [key]: !checked } as Partial<LabelOptions>)}
                      className={`flex h-8 items-center gap-2 rounded-md border px-2 text-xs ${checked ? "border-sky-200 bg-sky-50 text-sky-800" : "border-slate-200 text-slate-500"}`}
                    >
                      <span
                        className={`flex h-3.5 w-3.5 items-center justify-center rounded border ${checked ? "border-sky-600 bg-sky-600 text-white" : "border-slate-300"}`}
                      >
                        {checked && <Check className="h-2.5 w-2.5" />}
                      </span>
                      {label}
                    </button>
                  );
                })}
              </div>
              <label className="mt-3 block text-xs font-medium text-slate-600">
                底部文字
                <input
                  value={options.footerText}
                  onChange={(event) => updateOptions({ footerText: event.target.value })}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                  placeholder="例如 MADE IN CHINA"
                />
              </label>
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-600">字号</span>
                  <span className="tabular-nums text-slate-500">{Math.round(contentScale * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="1.8"
                  step="0.05"
                  value={contentScale}
                  onChange={(event) => setContentScale(Number(event.target.value))}
                  className="mt-1 w-full accent-slate-900"
                />
              </div>

              {layoutError && (
                <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  {layoutError}
                </p>
              )}
              <button
                type="button"
                onClick={() => void saveLayout()}
                disabled={saving || Boolean(layoutError)}
                className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                保存排版
              </button>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{hasGroups ? "按装箱组合打印" : "按 SKU 打印"}</h2>
                <button
                  type="button"
                  onClick={() => {
                    if (hasGroups) {
                      const all = (order?.packing_groups || []).map((group) => group.id);
                      setSelectedGroupIDs(selectedGroupIDs.length === all.length ? [] : all);
                      return;
                    }
                    const all = (order?.items || []).map((item) => item.id);
                    setSelectedItemIDs(selectedItemIDs.length === all.length ? [] : all);
                  }}
                  className="text-xs font-medium text-sky-700"
                >
                  {(hasGroups
                    ? selectedGroupIDs.length === (order?.packing_groups || []).length
                    : selectedItemIDs.length === (order?.items || []).length)
                    ? "取消全选"
                    : "全选"}
                </button>
              </div>
              {!hasGroups && (
                <p className="mt-1 text-[11px] text-slate-400">份数默认等于箱数，每张标签数量 = 装箱数 ÷ 箱数。</p>
              )}
              <div className="mt-2 max-h-[45vh] space-y-1.5 overflow-y-auto pr-1">
                {hasGroups
                  ? (order?.packing_groups || []).map((group) => {
                      const selected = selectedGroupIDs.includes(group.id);
                      return (
                        <div
                          key={group.id}
                          className={`flex items-center gap-2 rounded-lg border p-2 ${selected ? "border-orange-200 bg-orange-50" : "border-slate-200"}`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedGroupIDs((current) =>
                                selected ? current.filter((id) => id !== group.id) : [...current, group.id],
                              )
                            }
                            className="flex min-w-0 flex-1 items-start gap-2 text-left"
                          >
                            <span
                              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? "border-orange-600 bg-orange-600 text-white" : "border-slate-300"}`}
                            >
                              {selected && <Check className="h-3 w-3" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-semibold">箱组 {group.group_no}</span>
                              <span className="block truncate text-[11px] text-slate-400">
                                {(group.items || [])
                                  .map((item) => `${item.sku || item.product_name} × ${item.quantity}`)
                                  .join("、")}
                              </span>
                            </span>
                          </button>
                          <input
                            type="number"
                            min="1"
                            max="500"
                            value={groupCopies[group.id] || group.copies || 1}
                            onChange={(event) =>
                              setGroupCopies((current) => ({
                                ...current,
                                [group.id]: clamp(Number(event.target.value) || 1, 1, 500),
                              }))
                            }
                            className="h-7 w-16 rounded-md border border-slate-200 bg-white px-2 text-right text-xs"
                            title="打印箱数"
                          />
                          <span className="text-[11px] text-slate-400">箱</span>
                        </div>
                      );
                    })
                  : (order?.items || []).map((item) => {
                      const selected = selectedItemIDs.includes(item.id);
                      return (
                        <div
                          key={item.id}
                          className={`flex items-center gap-2 rounded-lg border p-2 ${selected ? "border-sky-200 bg-sky-50" : "border-slate-200"}`}
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedItemIDs((current) =>
                                selected ? current.filter((id) => id !== item.id) : [...current, item.id],
                              )
                            }
                            className="flex min-w-0 flex-1 items-start gap-2 text-left"
                          >
                            <span
                              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? "border-sky-600 bg-sky-600 text-white" : "border-slate-300"}`}
                            >
                              {selected && <Check className="h-3 w-3" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-xs font-semibold">{itemCode(item)}</span>
                              <span className="block text-[11px] text-slate-400">
                                {item.packed_quantity || item.quantity} {item.unit}
                              </span>
                            </span>
                          </button>
                          <input
                            type="number"
                            min="1"
                            max="500"
                            value={copies[item.id] || 1}
                            onChange={(event) =>
                              setCopies((current) => ({
                                ...current,
                                [item.id]: clamp(Number(event.target.value) || 1, 1, 500),
                              }))
                            }
                            className="h-7 w-16 rounded-md border border-slate-200 bg-white px-2 text-right text-xs"
                            title="打印份数"
                          />
                          <span className="text-[11px] text-slate-400">张</span>
                        </div>
                      );
                    })}
              </div>
            </section>
          </aside>

          <section className="min-w-0">
            {(error || notice) && (
              <div
                className={`mb-3 flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}
              >
                <span>{error || notice}</span>
                <button
                  type="button"
                  onClick={() => {
                    setError("");
                    setNotice("");
                  }}
                  title="关闭提示"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
              <div className="flex items-center gap-2">
                {printerMode ? (
                  <Tag className="h-4 w-4 text-slate-500" />
                ) : (
                  <LayoutGrid className="h-4 w-4 text-slate-500" />
                )}
                <div>
                  <h2 className="text-sm font-semibold">打印预览</h2>
                  <p className="text-xs text-slate-400">
                    {printableItems.length} 张标签
                    {!printerMode && ` · ${printablePages.length} 页 · ${pageWidthMM.toFixed(1)} × ${pageHeightMM.toFixed(1)} mm`}
                    {printerMode && ` · ${widthMM} × ${heightMM} mm`}
                  </p>
                </div>
              </div>
              {printablePages.length > previewPages.length && (
                <span className="text-xs text-slate-400">
                  仅预览前 {previewPages.length} {printerMode ? "张" : "页"}，打印会输出全部。
                </span>
              )}
            </div>

            <div className="min-h-[560px] overflow-auto rounded-lg border border-slate-200 bg-slate-200/70 p-4">
              {loading ? (
                <div className="flex h-80 items-center justify-center text-sm text-slate-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载标签...
                </div>
              ) : printableItems.length === 0 ? (
                <div className="flex h-80 items-center justify-center text-sm text-slate-500">
                  请在左侧选择需要打印的 SKU
                </div>
              ) : layoutError ? (
                <div className="flex h-80 items-center justify-center text-sm text-rose-600">{layoutError}</div>
              ) : (
                <div className={printerMode ? "flex flex-wrap items-start gap-4" : "flex min-w-max flex-col items-start gap-5"}>
                  {previewPages.map((slots, pageIndex) => (
                    <div key={pageIndex}>
                      <div className="mb-1.5 text-xs font-medium text-slate-500">
                        {printerMode ? `第 ${pageIndex + 1} 张` : `第 ${pageIndex + 1} 页`}
                      </div>
                      <div
                        className="overflow-hidden shadow-lg"
                        style={{
                          width: `${pageWidthMM * MM_TO_PX * previewScale}px`,
                          height: `${pageHeightMM * MM_TO_PX * previewScale}px`,
                        }}
                      >
                        <div style={{ transform: `scale(${previewScale})`, transformOrigin: "top left" }}>
                          {renderSheet(slots, pageIndex, true)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </main>
      </div>

      <div id="trade-label-print">
        {printablePages.map((slots, pageIndex) => renderSheet(slots, pageIndex, false))}
      </div>
    </AuthGuard>
  );
}
