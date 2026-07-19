"use client";

import {
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  LayoutGrid,
  Loader2,
  MoveDiagonal2,
  Printer,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import api from "@/lib/api";
import { consumeReturnTarget } from "@/lib/returnNavigation";
import type { TradeOrder, TradeOrderItem } from "@/types";

type PaperPreset = "A4" | "A5" | "LETTER" | "CUSTOM";
type Orientation = "portrait" | "landscape";

interface PrintableLabel {
  item: TradeOrderItem;
  copyIndex: number;
}

const MM_TO_PX = 96 / 25.4;
const PAPER_PRESETS: Record<
  Exclude<PaperPreset, "CUSTOM">,
  { label: string; width: number; height: number }
> = {
  A4: { label: "A4", width: 210, height: 297 },
  A5: { label: "A5", width: 148, height: 210 },
  LETTER: { label: "Letter", width: 215.9, height: 279.4 },
};

function numberOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export default function TradeLabelPrintPage() {
  const params = useParams<{ orderId: string }>();
  const router = useRouter();
  const orderID = Number(params.orderId);
  const [order, setOrder] = useState<TradeOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
  const [selectedItemIDs, setSelectedItemIDs] = useState<number[]>([]);
  const [copies, setCopies] = useState<Record<number, number>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
        const loadedPreset = String(
          loaded.label_paper_size || "A4",
        ).toUpperCase();
        setPaperPreset(
          loadedPreset === "A4" ||
            loadedPreset === "A5" ||
            loadedPreset === "LETTER"
            ? loadedPreset
            : "CUSTOM",
        );
        setMarginTopMM(numberOr(loaded.label_margin_top_mm, 10));
        setMarginRightMM(numberOr(loaded.label_margin_right_mm, 10));
        setMarginBottomMM(numberOr(loaded.label_margin_bottom_mm, 10));
        setMarginLeftMM(numberOr(loaded.label_margin_left_mm, 10));
        setGapXMM(numberOr(loaded.label_gap_x_mm, 3));
        setGapYMM(numberOr(loaded.label_gap_y_mm, 3));
        setContentScale(
          clamp(numberOr(loaded.label_content_scale, 1), 0.5, 1.8),
        );
        setStartSlot(Math.max(0, numberOr(loaded.label_start_slot, 0)));
        const items = loaded.items || [];
        setSelectedItemIDs(items.map((item) => item.id));
        setCopies(
          Object.fromEntries(
            items.map((item) => [item.id, Math.max(1, item.carton_count || 1)]),
          ),
        );
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : "加载标签数据失败",
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [orderID]);

  const pageWidthMM =
    orientation === "landscape" ? paperHeightMM : paperWidthMM;
  const pageHeightMM =
    orientation === "landscape" ? paperWidthMM : paperHeightMM;

  const layout = useMemo(() => {
    const usableWidth = pageWidthMM - marginLeftMM - marginRightMM;
    const usableHeight = pageHeightMM - marginTopMM - marginBottomMM;
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
    marginLeftMM,
    marginRightMM,
    marginTopMM,
    pageHeightMM,
    pageWidthMM,
    widthMM,
  ]);

  useEffect(() => {
    if (layout.capacity <= 0) return;
    setStartSlot((current) => clamp(current, 0, layout.capacity - 1));
  }, [layout.capacity]);

  const printableItems = useMemo(() => {
    if (!order) return [];
    return (order.items || []).flatMap((item) => {
      if (!selectedItemIDs.includes(item.id)) return [];
      return Array.from(
        { length: clamp(Math.round(copies[item.id] || 1), 1, 500) },
        (_, copyIndex) => ({ item, copyIndex }),
      );
    });
  }, [copies, order, selectedItemIDs]);

  const printablePages = useMemo(() => {
    if (layout.capacity <= 0 || printableItems.length === 0) return [];
    const pages: Array<Array<PrintableLabel | null>> = [];
    let itemIndex = 0;
    let pageIndex = 0;
    while (itemIndex < printableItems.length) {
      const slots = Array<PrintableLabel | null>(layout.capacity).fill(null);
      const firstSlot = pageIndex === 0 ? startSlot : 0;
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
  }, [layout.capacity, printableItems, startSlot]);

  const previewScale = useMemo(() => {
    const rawWidth = pageWidthMM * MM_TO_PX;
    const rawHeight = pageHeightMM * MM_TO_PX;
    return clamp(Math.min(860 / rawWidth, 690 / rawHeight), 0.18, 1);
  }, [pageHeightMM, pageWidthMM]);

  const layoutError = useMemo(() => {
    if (paperWidthMM < 50 || paperHeightMM < 50)
      return "纸张宽高不能小于 50mm。";
    if (widthMM < 20 || heightMM < 15)
      return "标签宽度不能小于 20mm，高度不能小于 15mm。";
    if (layout.usableWidth <= 0 || layout.usableHeight <= 0)
      return "页边距超过了纸张可用范围。";
    if (layout.capacity <= 0)
      return "当前标签尺寸无法排入纸张，请缩小标签或边距。";
    return "";
  }, [
    heightMM,
    layout.capacity,
    layout.usableHeight,
    layout.usableWidth,
    paperHeightMM,
    paperWidthMM,
    widthMM,
  ]);

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
  };

  const saveLayout = async () => {
    if (!order || layoutError) return;
    setSaving(true);
    setError("");
    try {
      const response = await api.put<TradeOrder>(
        `/trade/orders/${order.id}/label-settings`,
        {
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
        },
      );
      if (response.code !== 0 || !response.data) {
        throw new Error(response.message || "保存标签排版失败");
      }
      setOrder(response.data);
      setNotice("纸张、标签尺寸和起始位置已保存。");
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "保存标签排版失败",
      );
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
      let nextWidth = clamp(
        startWidth + (moveEvent.clientX - startX) / scale,
        20,
        maxWidth,
      );
      let nextHeight = clamp(
        startHeight + (moveEvent.clientY - startY) / scale,
        15,
        maxHeight,
      );
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

  const renderLabel = (
    entry: PrintableLabel,
    key: string,
    preview = false,
    resizable = false,
  ) => {
    const { item, copyIndex } = entry;
    const cartonSize =
      typeof item.workflow_data?.carton_size === "string"
        ? item.workflow_data.carton_size
        : "";
    return (
      <article
        key={key}
        className={`trade-label-cell relative overflow-hidden border-[0.35mm] border-black bg-white text-black ${resizable ? "ring-[0.8mm] ring-sky-400 ring-offset-[0.6mm]" : ""}`}
      >
        <div className="flex h-full w-full items-center justify-center overflow-hidden">
          <div
            className="flex h-full w-full flex-col justify-between p-[5mm]"
            style={{
              transform: `scale(${contentScale})`,
              transformOrigin: "center",
            }}
          >
            <div>
              <div className="text-[9px] font-semibold uppercase">
                {order?.order_no}
              </div>
              <div className="mt-[1.5mm] truncate text-[17px] font-bold leading-tight">
                {order?.customer_name}
              </div>
              <div className="mt-[0.8mm] truncate text-[10px]">
                {order?.customer_company}
              </div>
            </div>
            <div>
              <div className="border-y-[0.45mm] border-black py-[1.5mm]">
                <div className="text-[8px] uppercase">SKU</div>
                <div className="mt-[0.8mm] break-all text-[21px] font-black leading-none">
                  {item.sku || `LINE-${item.line_no}`}
                </div>
              </div>
              <div className="mt-[1.5mm] flex items-end justify-between gap-[2mm]">
                <div className="min-w-0">
                  <div className="truncate text-[10px] font-semibold">
                    {item.product_name}
                  </div>
                  <div className="mt-[0.5mm] truncate text-[8px]">
                    {[item.specification, cartonSize]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[8px] uppercase">Quantity</div>
                  <div className="text-[19px] font-black leading-none">
                    {item.packed_quantity || item.quantity}
                  </div>
                  <div className="text-[8px]">
                    {item.unit} · {copyIndex + 1}/{copies[item.id] || 1}
                  </div>
                </div>
              </div>
            </div>
          </div>
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

  const renderSheet = (
    slots: Array<PrintableLabel | null>,
    pageIndex: number,
    preview: boolean,
  ) => {
    const firstFilledSlot = slots.findIndex(Boolean);
    return (
      <div
        key={`${preview ? "preview" : "print"}-${pageIndex}`}
        className="trade-print-sheet bg-white"
        style={{
          width: `${pageWidthMM}mm`,
          height: `${pageHeightMM}mm`,
          boxSizing: "border-box",
          padding: `${marginTopMM}mm ${marginRightMM}mm ${marginBottomMM}mm ${marginLeftMM}mm`,
          display: "grid",
          gridTemplateColumns: `repeat(${layout.columns}, ${widthMM}mm)`,
          gridTemplateRows: `repeat(${layout.rows}, ${heightMM}mm)`,
          columnGap: `${gapXMM}mm`,
          rowGap: `${gapYMM}mm`,
          alignContent: "start",
          justifyContent: "start",
          breakAfter:
            !preview && pageIndex < printablePages.length - 1 ? "page" : "auto",
        }}
      >
        {slots.map((entry, slotIndex) =>
          entry ? (
            renderLabel(
              entry,
              `${pageIndex}-${slotIndex}-${entry.item.id}`,
              preview,
              preview && pageIndex === 0 && slotIndex === firstFilledSlot,
            )
          ) : (
            <div key={`${pageIndex}-${slotIndex}`} />
          ),
        )}
      </div>
    );
  };

  const previewPages = printablePages.slice(0, 6);
  const marginFields: Array<{
    label: string;
    value: number;
    setValue: (value: number) => void;
  }> = [
    { label: "上", value: marginTopMM, setValue: setMarginTopMM },
    { label: "右", value: marginRightMM, setValue: setMarginRightMM },
    { label: "下", value: marginBottomMM, setValue: setMarginBottomMM },
    { label: "左", value: marginLeftMM, setValue: setMarginLeftMM },
  ];

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
                <h1 className="truncate text-base font-semibold">
                  SKU 标签打印
                </h1>
                <p className="truncate text-xs text-slate-400">
                  {order
                    ? `${order.order_no} · ${order.customer_name}`
                    : "正在读取业务单"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => window.print()}
              disabled={
                printableItems.length === 0 ||
                printablePages.length === 0 ||
                Boolean(layoutError)
              }
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-40"
              title="按当前纸张排版打印"
            >
              <Printer className="h-4 w-4" />
              打印 {printablePages.length} 页
            </button>
          </div>
        </header>

        <main className="mx-auto grid max-w-[1500px] gap-4 p-3 lg:grid-cols-[360px_minmax(0,1fr)] lg:p-5">
          <aside className="self-start rounded-lg border border-slate-200 bg-white p-4 lg:sticky lg:top-20">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">纸张与标签</h2>
                <p className="mt-0.5 text-xs text-slate-400">
                  先设置纸张，再选择第一张标签的起始位置。
                </p>
              </div>
              <button
                type="button"
                onClick={resetLayout}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                title="恢复 A4 默认排版"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="text-xs font-medium text-slate-600">
                纸张
                <select
                  value={paperPreset}
                  onChange={(event) =>
                    choosePaperPreset(event.target.value as PaperPreset)
                  }
                  className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
                >
                  <option value="A4">A4</option>
                  <option value="A5">A5</option>
                  <option value="LETTER">Letter</option>
                  <option value="CUSTOM">自定义</option>
                </select>
              </label>
              <div className="text-xs font-medium text-slate-600">
                方向
                <div className="mt-1.5 grid h-9 grid-cols-2 rounded-lg border border-slate-200 p-0.5">
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
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="text-xs font-medium text-slate-600">
                纸张宽度/mm
                <input
                  type="number"
                  min="50"
                  max="500"
                  step="0.1"
                  value={paperWidthMM}
                  disabled={paperPreset !== "CUSTOM"}
                  onChange={(event) =>
                    setPaperWidthMM(Number(event.target.value))
                  }
                  className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                纸张高度/mm
                <input
                  type="number"
                  min="50"
                  max="500"
                  step="0.1"
                  value={paperHeightMM}
                  disabled={paperPreset !== "CUSTOM"}
                  onChange={(event) =>
                    setPaperHeightMM(Number(event.target.value))
                  }
                  className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                标签宽度/mm
                <input
                  type="number"
                  min="20"
                  max="300"
                  step="0.5"
                  value={widthMM}
                  onChange={(event) => setWidthMM(Number(event.target.value))}
                  className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                标签高度/mm
                <input
                  type="number"
                  min="15"
                  max="300"
                  step="0.5"
                  value={heightMM}
                  onChange={(event) => setHeightMM(Number(event.target.value))}
                  className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm"
                />
              </label>
            </div>

            <h3 className="mt-5 text-sm font-semibold">页边距与间距</h3>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {marginFields.map(({ label, value, setValue }) => (
                <label
                  key={String(label)}
                  className="text-[11px] font-medium text-slate-500"
                >
                  {label}/mm
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={value}
                    onChange={(event) => setValue(Number(event.target.value))}
                    className="mt-1 h-8 w-full rounded-md border border-slate-200 px-2 text-xs"
                  />
                </label>
              ))}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <label className="text-[11px] font-medium text-slate-500">
                横向间距/mm
                <input
                  type="number"
                  min="0"
                  max="50"
                  step="0.5"
                  value={gapXMM}
                  onChange={(event) => setGapXMM(Number(event.target.value))}
                  className="mt-1 h-8 w-full rounded-md border border-slate-200 px-2 text-xs"
                />
              </label>
              <label className="text-[11px] font-medium text-slate-500">
                纵向间距/mm
                <input
                  type="number"
                  min="0"
                  max="50"
                  step="0.5"
                  value={gapYMM}
                  onChange={(event) => setGapYMM(Number(event.target.value))}
                  className="mt-1 h-8 w-full rounded-md border border-slate-200 px-2 text-xs"
                />
              </label>
            </div>

            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700">内容缩放</span>
                <span className="tabular-nums text-slate-500">
                  {Math.round(contentScale * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0.5"
                max="1.8"
                step="0.05"
                value={contentScale}
                onChange={(event) =>
                  setContentScale(Number(event.target.value))
                }
                className="mt-2 w-full accent-slate-900"
              />
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">起始标签位</h3>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  已用过部分标签纸时，从空白位置开始打印。
                </p>
              </div>
              <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-600">
                第 {startSlot + 1} 格
              </span>
            </div>
            {layout.capacity > 0 && (
              <div
                className="mt-2 grid max-h-40 gap-1 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-2"
                style={{
                  gridTemplateColumns: `repeat(${layout.columns}, 34px)`,
                  justifyContent: "start",
                }}
              >
                {Array.from({ length: layout.capacity }, (_, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => setStartSlot(index)}
                    className={`flex h-8 items-center justify-center rounded border text-[10px] font-semibold ${index === startSlot ? "border-sky-500 bg-sky-500 text-white" : index < startSlot ? "border-slate-200 bg-slate-200 text-slate-400" : "border-slate-300 bg-white text-slate-500 hover:border-sky-300"}`}
                    title={`从第 ${index + 1} 格开始打印`}
                  >
                    {index + 1}
                  </button>
                ))}
              </div>
            )}

            {layoutError ? (
              <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {layoutError}
              </p>
            ) : (
              <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                每页 {layout.columns} 列 × {layout.rows} 行，共{" "}
                {layout.capacity} 个标签位；当前需 {printablePages.length} 页。
              </p>
            )}

            <button
              type="button"
              onClick={() => void saveLayout()}
              disabled={saving || Boolean(layoutError)}
              className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-slate-200 text-sm font-semibold text-slate-700 disabled:opacity-40"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              保存排版
            </button>

            <div className="mt-5 flex items-center justify-between">
              <h3 className="text-sm font-semibold">标签内容</h3>
              <button
                type="button"
                onClick={() =>
                  setSelectedItemIDs(
                    selectedItemIDs.length === (order?.items || []).length
                      ? []
                      : (order?.items || []).map((item) => item.id),
                  )
                }
                className="text-xs font-medium text-sky-700"
              >
                {selectedItemIDs.length === (order?.items || []).length
                  ? "取消全选"
                  : "全选"}
              </button>
            </div>
            <div className="mt-2 max-h-[45vh] space-y-2 overflow-y-auto pr-1">
              {(order?.items || []).map((item) => {
                const selected = selectedItemIDs.includes(item.id);
                return (
                  <div
                    key={item.id}
                    className={`rounded-lg border p-2.5 ${selected ? "border-sky-200 bg-sky-50" : "border-slate-200"}`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedItemIDs((current) =>
                          selected
                            ? current.filter((id) => id !== item.id)
                            : [...current, item.id],
                        )
                      }
                      className="flex w-full items-start gap-2 text-left"
                    >
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? "border-sky-600 bg-sky-600 text-white" : "border-slate-300"}`}
                      >
                        {selected && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold">
                          {item.sku || `第 ${item.line_no} 行`} ·{" "}
                          {item.product_name}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          数量 {item.packed_quantity || item.quantity}{" "}
                          {item.unit}
                        </span>
                      </span>
                    </button>
                    <label className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                      打印份数
                      <input
                        type="number"
                        min="1"
                        max="500"
                        value={copies[item.id] || 1}
                        onChange={(event) =>
                          setCopies((current) => ({
                            ...current,
                            [item.id]: clamp(
                              Number(event.target.value) || 1,
                              1,
                              500,
                            ),
                          }))
                        }
                        className="h-7 w-20 rounded-md border border-slate-200 bg-white px-2 text-right text-xs"
                      />
                    </label>
                  </div>
                );
              })}
            </div>
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
                <LayoutGrid className="h-4 w-4 text-slate-500" />
                <div>
                  <h2 className="text-sm font-semibold">打印预览</h2>
                  <p className="text-xs text-slate-400">
                    {printableItems.length} 张标签 · {printablePages.length} 页
                    · {pageWidthMM.toFixed(1)} × {pageHeightMM.toFixed(1)} mm
                  </p>
                </div>
              </div>
              {printablePages.length > previewPages.length && (
                <span className="text-xs text-slate-400">
                  为保持页面流畅，仅预览前 {previewPages.length}{" "}
                  页，打印会输出全部页面。
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
                  请选择需要打印的 SKU
                </div>
              ) : layoutError ? (
                <div className="flex h-80 items-center justify-center text-sm text-rose-600">
                  {layoutError}
                </div>
              ) : (
                <div className="flex min-w-max flex-col items-start gap-5">
                  {previewPages.map((slots, pageIndex) => (
                    <div key={pageIndex}>
                      <div className="mb-1.5 text-xs font-medium text-slate-500">
                        第 {pageIndex + 1} 页
                      </div>
                      <div
                        className="overflow-hidden shadow-lg"
                        style={{
                          width: `${pageWidthMM * MM_TO_PX * previewScale}px`,
                          height: `${pageHeightMM * MM_TO_PX * previewScale}px`,
                        }}
                      >
                        <div
                          style={{
                            transform: `scale(${previewScale})`,
                            transformOrigin: "top left",
                          }}
                        >
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
        {printablePages.map((slots, pageIndex) =>
          renderSheet(slots, pageIndex, false),
        )}
      </div>
    </AuthGuard>
  );
}
