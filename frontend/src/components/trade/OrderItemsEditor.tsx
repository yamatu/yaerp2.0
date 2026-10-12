"use client";

import { useRef, useState, type ClipboardEvent } from "react";
import { ClipboardPaste, ImagePlus, Loader2, Plus, Trash2, X } from "lucide-react";
import api from "@/lib/api";
import { preparePhoto } from "@/lib/photoPrepare";

export interface OrderItemImageDraft {
  id: number;
  preview: string;
}

export interface OrderItemDraft {
  sku: string;
  specification: string;
  quantity: string;
  unit: string;
  target_price: string;
  description: string;
  images: OrderItemImageDraft[];
}

const KNOWN_UNITS = [
  "件", "个", "只", "套", "台", "箱", "包", "袋", "米", "卷", "张", "对", "双", "瓶", "盒", "片", "条", "根", "块", "kg", "KG", "千克", "吨",
  "pcs", "PCS", "pc", "PC", "set", "SET", "sets", "SETS", "box", "BOX", "ctn", "CTN", "m", "M", "roll", "ROLL", "pair", "PAIR",
];

export function newOrderItem(): OrderItemDraft {
  return {
    sku: "",
    specification: "",
    quantity: "1",
    unit: "件",
    target_price: "",
    description: "",
    images: [],
  };
}

export function isFilledOrderItem(item: OrderItemDraft) {
  return Boolean(item.sku.trim()) && Number(item.quantity) > 0;
}

export function orderItemPayload(item: OrderItemDraft) {
  const sku = item.sku.trim();
  return {
    sku,
    product_name: sku,
    specification: item.specification.trim(),
    description: item.description.trim(),
    quantity: Number(item.quantity),
    unit: item.unit.trim() || "件",
    target_price: Number(item.target_price || 0),
    image_attachment_ids: item.images.map((image) => image.id),
  };
}

function isNumberToken(value: string) {
  return /^\d+(?:[.,]\d+)?$/.test(value.replace(/[$¥￥€£,]/g, "").trim()) && value.trim() !== "";
}

function toNumberText(value: string) {
  return value.replace(/[$¥￥€£\s]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", ".");
}

// Accepts rows copied from Excel (tab separated) or typed by hand
// ("SKU  数量  单位  目标价  规格"); numbers and units are detected by shape.
export function parsePastedOrderItems(text: string): OrderItemDraft[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      let tokens = line.includes("\t")
        ? line.split("\t")
        : line.split(/\s{2,}|[,，;；|]/);
      tokens = tokens.map((token) => token.trim()).filter(Boolean);
      if (tokens.length === 1) {
        const qtyMatch = tokens[0].match(/^(.*?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*([^\d\s]*)$/i);
        if (qtyMatch) tokens = [qtyMatch[1], qtyMatch[2], qtyMatch[3]].filter(Boolean);
      }
      const item = newOrderItem();
      item.sku = tokens[0] || "";
      const numbers: string[] = [];
      const texts: string[] = [];
      for (const token of tokens.slice(1)) {
        const unitMatch = token.match(/^(\d+(?:\.\d+)?)\s*([^\d\s.]+)$/);
        if (unitMatch && KNOWN_UNITS.includes(unitMatch[2])) {
          numbers.push(unitMatch[1]);
          item.unit = unitMatch[2];
        } else if (isNumberToken(token)) {
          numbers.push(toNumberText(token));
        } else if (KNOWN_UNITS.includes(token)) {
          item.unit = token;
        } else {
          texts.push(token);
        }
      }
      if (numbers[0]) item.quantity = numbers[0];
      if (numbers[1]) item.target_price = numbers[1];
      item.specification = texts[0] || "";
      item.description = texts.slice(1).join(" ");
      return item;
    })
    .filter((item) => item.sku);
}

interface OrderItemsEditorProps {
  items: OrderItemDraft[];
  onChange: (items: OrderItemDraft[]) => void;
  onError?: (message: string) => void;
  maxHeightClass?: string;
}

export function OrderItemsEditor({
  items,
  onChange,
  onError,
  maxHeightClass = "max-h-[48vh]",
}: OrderItemsEditorProps) {
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<number>(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const update = (index: number, patch: Partial<OrderItemDraft>) =>
    onChange(items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));

  const addRow = () => {
    onChange([...items, newOrderItem()]);
    window.setTimeout(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      const inputs = scrollRef.current?.querySelectorAll<HTMLInputElement>("input[data-sku-input]");
      inputs?.[inputs.length - 1]?.focus();
    }, 30);
  };

  const removeRow = (index: number) =>
    onChange(items.length === 1 ? [newOrderItem()] : items.filter((_, itemIndex) => itemIndex !== index));

  const mergeParsed = (parsed: OrderItemDraft[], atIndex?: number) => {
    if (parsed.length === 0) return;
    const kept = items.filter((item, index) => index !== atIndex && (item.sku.trim() || item.images.length > 0));
    onChange([...kept, ...parsed]);
  };

  const applyPaste = () => {
    const parsed = parsePastedOrderItems(pasteText);
    if (parsed.length === 0) {
      onError?.("没有识别到产品，请每行一个 SKU，列之间用 Tab、逗号或两个空格分隔。");
      return;
    }
    mergeParsed(parsed);
    setPasteText("");
    setPasteOpen(false);
  };

  const handleSkuPaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/\r?\n/.test(text.trim()) && !text.includes("\t")) return;
    event.preventDefault();
    mergeParsed(parsePastedOrderItems(text), items[index].sku.trim() ? undefined : index);
  };

  const uploadImages = async (files: FileList | null) => {
    const index = uploadTargetRef.current;
    if (!files || files.length === 0) return;
    setUploadingIndex(index);
    try {
      const uploaded: OrderItemImageDraft[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.toLowerCase().startsWith("image/")) {
          throw new Error(`${file.name} 不是图片文件`);
        }
        const body = new FormData();
        body.append("file", await preparePhoto(file));
        const response = await api.form<{ id: number }>("/upload", body);
        if (response.code !== 0 || !response.data?.id) {
          throw new Error(response.message || `上传 ${file.name} 失败`);
        }
        uploaded.push({ id: response.data.id, preview: URL.createObjectURL(file) });
      }
      onChange(
        items.map((item, itemIndex) =>
          itemIndex === index ? { ...item, images: [...item.images, ...uploaded] } : item,
        ),
      );
    } catch (uploadError) {
      onError?.(uploadError instanceof Error ? uploadError.message : "上传询价图片失败");
    } finally {
      setUploadingIndex(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const filledCount = items.filter(isFilledOrderItem).length;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">
            询价产品
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              {filledCount} 个
            </span>
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">
            SKU 即产品；可直接从 Excel / 微信粘贴多行到 SKU 格，或使用批量粘贴。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPasteOpen((open) => !open)}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${pasteOpen ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            批量粘贴
          </button>
          <button
            type="button"
            onClick={addRow}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" />
            添加一行
          </button>
        </div>
      </div>

      {pasteOpen && (
        <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50/60 p-3">
          <textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            autoFocus
            className="min-h-28 w-full rounded-lg border border-sky-200 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-sky-400"
            placeholder={"每行一个产品，列顺序：SKU  数量  单位  目标价  规格  备注\nAB-1001\t500\tpcs\t1.2\t黑色 304不锈钢\nAB-1002, 300, 套\nAB-1003 x 1000"}
          />
          <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-500">
            <span>已识别 {parsePastedOrderItems(pasteText).length} 个产品，会追加到下方列表。</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPasteOpen(false)}
                className="h-8 rounded-lg border border-slate-200 bg-white px-3 font-medium"
              >
                取消
              </button>
              <button
                type="button"
                onClick={applyPaste}
                className="h-8 rounded-lg bg-sky-700 px-3 font-semibold text-white hover:bg-sky-800"
              >
                导入
              </button>
            </div>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => void uploadImages(event.target.files)}
      />

      <div
        ref={scrollRef}
        className={`mt-2 overflow-auto rounded-lg border border-slate-200 ${maxHeightClass}`}
      >
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs text-slate-500 shadow-[0_1px_0_#e2e8f0]">
            <tr>
              <th className="w-10 px-2 py-2 text-center">#</th>
              <th className="w-28 px-2 py-2" title="客户发来的询价参考图；到货实拍在质检环节上传">询价图</th>
              <th className="min-w-[180px] px-2 py-2">
                SKU<span className="text-rose-500"> *</span>
              </th>
              <th className="min-w-[160px] px-2 py-2">规格 / 材质 / 颜色</th>
              <th className="w-24 px-2 py-2">数量</th>
              <th className="w-20 px-2 py-2">单位</th>
              <th className="w-24 px-2 py-2">目标价</th>
              <th className="min-w-[160px] px-2 py-2">客户要求 / 备注</th>
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={index} className="border-t border-slate-100 align-middle hover:bg-slate-50/60">
                <td className="px-2 py-1.5 text-center text-xs font-semibold text-slate-400">{index + 1}</td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    {item.images.slice(0, 2).map((image) => (
                      <span key={image.id} className="group relative h-8 w-8 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-50">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={image.preview} alt="" className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => update(index, { images: item.images.filter((candidate) => candidate.id !== image.id) })}
                          className="absolute inset-0 hidden items-center justify-center bg-slate-900/60 text-white group-hover:flex"
                          title="移除图片"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))}
                    {item.images.length > 2 && (
                      <span className="text-[10px] text-slate-400">+{item.images.length - 2}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        uploadTargetRef.current = index;
                        fileInputRef.current?.click();
                      }}
                      disabled={uploadingIndex !== null}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-dashed border-slate-300 text-slate-400 hover:border-sky-400 hover:text-sky-600 disabled:opacity-40"
                      title="上传客户发来的询价图片"
                    >
                      {uploadingIndex === index ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ImagePlus className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </td>
                <td className="px-2 py-1.5">
                  <input
                    data-sku-input
                    value={item.sku}
                    onChange={(event) => update(index, { sku: event.target.value })}
                    onPaste={(event) => handleSkuPaste(index, event)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if (index === items.length - 1) addRow();
                      }
                    }}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 font-medium outline-none focus:border-sky-400"
                    placeholder="产品 SKU"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={item.specification}
                    onChange={(event) => update(index, { specification: event.target.value })}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 outline-none focus:border-sky-400"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={item.quantity}
                    onChange={(event) => update(index, { quantity: event.target.value })}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 text-right tabular-nums outline-none focus:border-sky-400"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={item.unit}
                    onChange={(event) => update(index, { unit: event.target.value })}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 outline-none focus:border-sky-400"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={item.target_price}
                    onChange={(event) => update(index, { target_price: event.target.value })}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 text-right tabular-nums outline-none focus:border-sky-400"
                    placeholder="可选"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    value={item.description}
                    onChange={(event) => update(index, { description: event.target.value })}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 outline-none focus:border-sky-400"
                    placeholder="包装、认证等"
                  />
                </td>
                <td className="px-2 py-1.5 text-center">
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-rose-500 hover:bg-rose-50"
                    title="删除产品"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={addRow}
        className="mt-2 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 text-xs font-semibold text-slate-500 hover:border-sky-400 hover:text-sky-700"
      >
        <Plus className="h-3.5 w-3.5" />
        添加产品（在最后一行 SKU 按回车也可新增）
      </button>
    </div>
  );
}
