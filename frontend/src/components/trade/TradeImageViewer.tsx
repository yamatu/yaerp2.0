"use client";

import { useState } from "react";
import { FlipHorizontal2, ImagePlus, Loader2, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import api from "@/lib/api";
import { FilePreviewModal, type FilePreviewItem } from "@/components/ui/FilePreviewModal";
import { imageTransformLabel, transformRemoteImage, type ImageTransform } from "@/lib/imageTransform";
import type { TradeOrder } from "@/types";

/** Which pictures the viewer shows: one product's, or all inspection photos. */
export type TradeImageTarget =
  | { kind: "item"; itemID: number; key?: string }
  | { kind: "inspection"; key?: string };

interface ViewerImage extends FilePreviewItem {
  attachmentID: number;
  deletePath: string;
  editable: boolean;
}

function viewerImages(order: TradeOrder, target: TradeImageTarget, userID?: number): ViewerImage[] {
  const access = order.access;
  if (target.kind === "inspection") {
    return (order.inspection_photos || []).map((photo) => ({
      key: `inspection-${photo.id}`,
      name: photo.filename,
      url: photo.attachment_url,
      mimeType: "image/jpeg",
      meta: [photo.sku || "整单质检", photo.uploaded_by_name, photo.note].filter(Boolean).join(" · "),
      attachmentID: photo.attachment_id,
      deletePath: `/trade/orders/${order.id}/inspection-photos/${photo.id}`,
      editable: Boolean(access?.can_manage_inspection_photos || photo.uploaded_by === userID),
    }));
  }
  const item = (order.items || []).find((candidate) => candidate.id === target.itemID);
  return (item?.images || []).map((image) => {
    const inspection = image.source === "inspection";
    return {
      key: `${image.source}-${image.id}`,
      name: image.filename,
      url: image.url,
      mimeType: "image/jpeg",
      meta: `${item?.sku || item?.product_name || ""} · ${inspection ? "到货 / 质检实拍" : "产品图片"}`,
      attachmentID: image.attachment_id,
      deletePath: inspection
        ? `/trade/orders/${order.id}/inspection-photos/${image.id}`
        : `/trade/orders/${order.id}/items/${target.itemID}/images/${image.id}`,
      editable: Boolean(inspection ? access?.can_manage_inspection_photos : access?.can_manage_item_images),
    };
  });
}

const actionClass =
  "inline-flex h-9 w-9 items-center justify-center rounded-lg text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-40";

/**
 * The system image viewer for an order's pictures: browse, zoom, download,
 * and for permitted users rotate / flip (saved back) or delete a wrong one.
 */
export function TradeImageViewer({
  order,
  target,
  userID,
  onTargetChange,
  onClose,
  onOrderChange,
  onAddImage,
}: {
  order: TradeOrder;
  target: TradeImageTarget;
  userID?: number;
  onTargetChange: (target: TradeImageTarget) => void;
  onClose: () => void;
  onOrderChange: (order: TradeOrder) => void;
  onAddImage?: (itemID: number) => void;
}) {
  const [busy, setBusy] = useState<ImageTransform | "delete" | null>(null);
  const [error, setError] = useState("");
  const images = viewerImages(order, target, userID);
  const found = images.findIndex((image) => image.key === target.key);
  const index = found >= 0 ? found : Math.min(0, images.length - 1);
  const current = images[index];

  const transform = async (kind: ImageTransform) => {
    if (!current?.url || busy) return;
    setBusy(kind);
    setError("");
    try {
      const file = await transformRemoteImage(current.url, current.name, "image/jpeg", kind);
      const body = new FormData();
      body.append("file", file);
      const response = await api.form<TradeOrder>(
        `/trade/orders/${order.id}/images/${current.attachmentID}/content`,
        body,
        "PUT",
      );
      if (response.code !== 0 || !response.data) throw new Error(response.message || `${imageTransformLabel(kind)}失败`);
      onOrderChange(response.data);
    } catch (transformError) {
      setError(transformError instanceof Error ? transformError.message : `${imageTransformLabel(kind)}失败`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!current || busy) return;
    if (!window.confirm(`删除图片「${current.name}」？`)) return;
    setBusy("delete");
    setError("");
    try {
      const response = await api.delete<TradeOrder>(current.deletePath);
      if (response.code !== 0 || !response.data) throw new Error(response.message || "删除图片失败");
      const next = images[index + 1] || images[index - 1];
      onOrderChange(response.data);
      if (next) onTargetChange({ ...target, key: next.key });
      else onClose();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除图片失败");
    } finally {
      setBusy(null);
    }
  };

  const transformButton = (kind: ImageTransform, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onClick={() => void transform(kind)}
      disabled={Boolean(busy)}
      className={actionClass}
      title={`${label}并保存`}
      aria-label={`${label}并保存`}
    >
      {busy === kind ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
    </button>
  );

  return (
    <FilePreviewModal
      items={images}
      index={Math.max(0, index)}
      onIndexChange={(next) => onTargetChange({ ...target, key: images[next]?.key })}
      onClose={onClose}
      dimmed={Boolean(busy)}
      errorMessage={error || undefined}
      emptyHint="这里还没有图片"
      zIndexClass="z-[130]"
      headerActions={
        current?.editable ? (
          <>
            {transformButton("rotate-left", "向左旋转", <RotateCcw className="h-4 w-4" />)}
            {transformButton("rotate-right", "向右旋转", <RotateCw className="h-4 w-4" />)}
            {transformButton("flip-horizontal", "水平翻转", <FlipHorizontal2 className="h-4 w-4" />)}
            <button
              type="button"
              onClick={() => void remove()}
              disabled={Boolean(busy)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-rose-300 transition hover:bg-rose-500/20 hover:text-rose-100 disabled:opacity-40"
              title="删除这张图片"
              aria-label="删除这张图片"
            >
              {busy === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </button>
          </>
        ) : null
      }
      footer={
        target.kind === "item" && onAddImage && order.access?.can_manage_item_images ? (
          <button
            type="button"
            onClick={() => onAddImage(target.itemID)}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-white/10 px-3 text-sm font-semibold text-white hover:bg-white/20"
          >
            <ImagePlus className="h-4 w-4" />
            添加图片
          </button>
        ) : undefined
      }
    />
  );
}
