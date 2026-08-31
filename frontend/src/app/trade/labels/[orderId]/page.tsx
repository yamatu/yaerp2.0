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
  Move,
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
  key: string;
  entries: Array<{ item: TradeOrderItem; quantity: number }>;
  copyIndex: number;
  totalCopies: number;
  groupNo?: number;
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
  const [offsetXMM, setOffsetXMM] = useState(10);
  const [offsetYMM, setOffsetYMM] = useState(10);
  const [selectedItemIDs, setSelectedItemIDs] = useState<number[]>([]);
  const [copies, setCopies] = useState<Record<number, number>>({});
  const [selectedGroupIDs, setSelectedGroupIDs] = useState<number[]>([]);
  const [groupCopies, setGroupCopies] = useState<Record<number, number>>({});
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
        setOffsetXMM(
          numberOr(loaded.label_offset_x_mm, loaded.label_margin_left_mm || 10),
        );
        setOffsetYMM(
          numberOr(loaded.label_offset_y_mm, loaded.label_margin_top_mm || 10),
        );
        const items = loaded.items || [];
        setSelectedItemIDs(items.map((item) => item.id));
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
    widthMM,
  ]);

  useEffect(() => {
    if (layout.capacity <= 0) return;
    setStartSlot((current) => clamp(current, 0, layout.capacity - 1));
  }, [layout.capacity]);

  const printableItems = useMemo(() => {
    if (!order) return [];
    const groups = order.packing_groups || [];
    if (groups.length > 0) {
      const itemByID = new Map(
        (order.items || []).map((item) => [item.id, item]),
      );
      return groups.flatMap((group) => {
        if (!selectedGroupIDs.includes(group.id)) return [];
        const entries = (group.items || []).flatMap((entry) => {
          const item = itemByID.get(entry.order_item_id);
          return item ? [{ item, quantity: entry.quantity }] : [];
        });
        if (entries.length === 0) return [];
        const totalCopies = clamp(
          Math.round(groupCopies[group.id] || group.copies || 1),
          1,
          500,
        );
        return Array.from({ length: totalCopies }, (_, copyIndex) => ({
          key: `group-${group.id}-${copyIndex}`,
          entries,
          copyIndex,
          totalCopies,
          groupNo: group.group_no,
        }));
      });
    }
    return (order.items || []).flatMap((item) => {
      if (!selectedItemIDs.includes(item.id)) return [];
      const totalCopies = clamp(Math.round(copies[item.id] || 1), 1, 500);
      return Array.from(
        { length: totalCopies },
        (_, copyIndex) => ({
          key: `item-${item.id}-${copyIndex}`,
          entries: [
            {
              item,
              quantity: item.packed_quantity || item.quantity,
            },
          ],
          copyIndex,
          totalCopies,
        }),
      );
    });
  }, [copies, groupCopies, order, selectedGroupIDs, selectedItemIDs]);

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
      return "标签起点或页边距超过了纸张可用范围。";
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
    offsetXMM,
    offsetYMM,
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
    setOffsetXMM(10);
    setOffsetYMM(10);
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
          offset_x_mm: offsetXMM,
          offset_y_mm: offsetYMM,
        },
      );
      if (response.code !== 0 || !response.data) {
        throw new Error(response.message || "保存标签排版失败");
      }
      setOrder(response.data);
      setNotice("纸张、标签尺寸和自由起始位置已保存。");
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

  const beginLabelDrag = (
    event: ReactPointerEvent<HTMLElement>,
    slotIndex: number,
  ) => {
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
      const maxX = Math.max(
        0,
        pageWidthMM - marginRightMM - widthMM - columnOffset,
      );
      const maxY = Math.max(
        0,
        pageHeightMM - marginBottomMM - heightMM - rowOffset,
      );
      setOffsetXMM(
        Math.round(
          clamp(startOffsetX + (moveEvent.clientX - startX) / scale, 0, maxX) *
            2,
        ) / 2,
      );
      setOffsetYMM(
        Math.round(
          clamp(startOffsetY + (moveEvent.clientY - startY) / scale, 0, maxY) *
            2,
        ) / 2,
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

  const renderLabel = (
    entry: PrintableLabel,
    key: string,
    preview = false,
    resizable = false,
    slotIndex = 0,
  ) => {
    const { entries, copyIndex, totalCopies } = entry;
    return (
      <article
        key={key}
        onPointerDown={
          preview && resizable
            ? (event) => beginLabelDrag(event, slotIndex)
            : undefined
        }
        className={`trade-label-cell relative h-full w-full overflow-hidden border-[0.35mm] border-black bg-white text-black ${resizable ? "touch-none cursor-grab ring-[0.8mm] ring-sky-400 ring-offset-[0.6mm] active:cursor-grabbing" : ""}`}
      >
        <div className="flex h-full w-full items-center justify-center overflow-hidden">
          <div
            className="flex h-full w-full flex-col p-[4mm]"
            style={{
              transform: `scale(${contentScale})`,
              transformOrigin: "center",
            }}
          >
            <div>
              <div className="text-[9px] font-semibold uppercase">
                {order?.order_no}
              </div>
              <div className="mt-[1mm] truncate text-[16px] font-bold leading-tight">
                {order?.customer_name}
              </div>
              <div className="mt-[0.5mm] flex items-center justify-between gap-[2mm] text-[9px]">
                <span className="min-w-0 truncate">{order?.customer_company}</span>
                {entry.groupNo && (
                  <span className="shrink-0 font-semibold">BOX {entry.groupNo}</span>
                )}
              </div>
            </div>
            <div className="mt-[2mm] min-h-0 flex-1 overflow-hidden border-y-[0.45mm] border-black py-[1mm]">
              <div className="grid grid-cols-[1fr_auto] gap-[2mm] text-[7px] font-semibold uppercase">
                <span>SKU / Product</span>
                <span>Quantity</span>
              </div>
              <div className="mt-[0.5mm] space-y-[0.65mm]">
                {entries.map(({ item, quantity }) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-[2mm]"
                    style={{
                      fontSize:
                        entries.length > 8
                          ? "7px"
                          : entries.length > 4
                            ? "9px"
                            : "11px",
                      lineHeight: 1.05,
                    }}
                  >
                    <span className="min-w-0">
                      <strong className="block truncate">
                        {item.sku || `LINE-${item.line_no}`}
                      </strong>
                      <span className="block truncate text-[0.75em] font-normal">
                        {[item.product_name, item.specification]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <strong className="shrink-0 tabular-nums">
                      {quantity} {item.unit}
                    </strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-[1mm] flex items-end justify-between text-[8px]">
              <span>{entry.groupNo ? `PACKING GROUP ${entry.groupNo}` : "SKU LABEL"}</span>
              <span className="font-semibold tabular-nums">
                {copyIndex + 1}/{totalCopies}
              </span>
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
          position: "relative",
          overflow: "hidden",
          breakAfter:
            !preview && pageIndex < printablePages.length - 1 ? "page" : "auto",
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
                left: `${offsetXMM + column * (widthMM + gapXMM)}mm`,
                top: `${offsetYMM + row * (heightMM + gapYMM)}mm`,
                width: `${widthMM}mm`,
                height: `${heightMM}mm`,
              }}
            >
              {renderLabel(
                entry,
                `${pageIndex}-${slotIndex}-${entry.key}`,
                preview,
                preview && pageIndex === 0 && slotIndex === firstFilledSlot,
                slotIndex,
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const previewPages = printablePages.slice(0, 6);
  const marginFields: Array<{
    label: string;
    value: number;
    setValue: (value: number) => void;
  }> = [
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
                  在纸面拖动首张标签，右下角拖动调整尺寸。
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
                  可在右侧 A4 预览中直接拖动首张标签到任意位置。
                </p>
              </div>
              <Move className="h-4 w-4 shrink-0 text-sky-600" />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-sky-100 bg-sky-50/60 p-2.5">
              <label className="text-[11px] font-medium text-slate-600">
                横向位置 X / mm
                <input
                  type="number"
                  min="0"
                  max={Math.max(0, pageWidthMM - widthMM)}
                  step="0.5"
                  value={offsetXMM}
                  onChange={(event) =>
                    setOffsetXMM(
                      clamp(
                        Number(event.target.value),
                        0,
                        Math.max(0, pageWidthMM - widthMM),
                      ),
                    )
                  }
                  className="mt-1 h-8 w-full rounded-md border border-sky-200 bg-white px-2 text-xs"
                />
              </label>
              <label className="text-[11px] font-medium text-slate-600">
                纵向位置 Y / mm
                <input
                  type="number"
                  min="0"
                  max={Math.max(0, pageHeightMM - heightMM)}
                  step="0.5"
                  value={offsetYMM}
                  onChange={(event) =>
                    setOffsetYMM(
                      clamp(
                        Number(event.target.value),
                        0,
                        Math.max(0, pageHeightMM - heightMM),
                      ),
                    )
                  }
                  className="mt-1 h-8 w-full rounded-md border border-sky-200 bg-white px-2 text-xs"
                />
              </label>
              <div className="col-span-2 flex items-center justify-between text-[10px] text-sky-700">
                <span>当前起点：{offsetXMM.toFixed(1)}, {offsetYMM.toFixed(1)} mm</span>
                <span>第 {startSlot + 1} 格开始</span>
              </div>
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
              <h3 className="text-sm font-semibold">
                {(order?.packing_groups || []).length > 0
                  ? "装箱标签"
                  : "标签内容"}
              </h3>
              <button
                type="button"
                onClick={() => {
                  if ((order?.packing_groups || []).length > 0) {
                    setSelectedGroupIDs(
                      selectedGroupIDs.length ===
                        (order?.packing_groups || []).length
                        ? []
                        : (order?.packing_groups || []).map(
                            (group) => group.id,
                          ),
                    );
                    return;
                  }
                  setSelectedItemIDs(
                    selectedItemIDs.length === (order?.items || []).length
                      ? []
                      : (order?.items || []).map((item) => item.id),
                  );
                }}
                className="text-xs font-medium text-sky-700"
              >
                {(order?.packing_groups || []).length > 0
                  ? selectedGroupIDs.length ===
                    (order?.packing_groups || []).length
                    ? "取消全选"
                    : "全选"
                  : selectedItemIDs.length === (order?.items || []).length
                    ? "取消全选"
                    : "全选"}
              </button>
            </div>
            <div className="mt-2 max-h-[45vh] space-y-2 overflow-y-auto pr-1">
              {(order?.packing_groups || []).length > 0
                ? (order?.packing_groups || []).map((group) => {
                    const selected = selectedGroupIDs.includes(group.id);
                    return (
                      <div
                        key={group.id}
                        className={`rounded-lg border p-2.5 ${selected ? "border-orange-200 bg-orange-50" : "border-slate-200"}`}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedGroupIDs((current) =>
                              selected
                                ? current.filter((id) => id !== group.id)
                                : [...current, group.id],
                            )
                          }
                          className="flex w-full items-start gap-2 text-left"
                        >
                          <span
                            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selected ? "border-orange-600 bg-orange-600 text-white" : "border-slate-300"}`}
                          >
                            {selected && <Check className="h-3 w-3" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold">
                              箱组 {group.group_no} · {group.copies} 箱
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                              {(group.items || [])
                                .map(
                                  (item) =>
                                    `${item.sku || item.product_name} × ${item.quantity}`,
                                )
                                .join("、")}
                            </span>
                          </span>
                        </button>
                        <label className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                          打印箱数
                          <input
                            type="number"
                            min="1"
                            max="500"
                            value={groupCopies[group.id] || group.copies || 1}
                            onChange={(event) =>
                              setGroupCopies((current) => ({
                                ...current,
                                [group.id]: clamp(
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
                  })
                : (order?.items || []).map((item) => {
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
