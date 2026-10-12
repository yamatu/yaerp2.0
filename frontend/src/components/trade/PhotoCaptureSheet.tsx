"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Images, Loader2, RotateCcw, RotateCw, Trash2, X } from "lucide-react";
import { preparePhoto } from "@/lib/photoPrepare";

interface PendingPhoto {
  id: string;
  file: File;
  preview: string;
  rotation: number;
}

export interface PhotoCaptureItemOption {
  id: number;
  label: string;
}

interface PhotoCaptureSheetProps {
  title: string;
  description?: string;
  items: PhotoCaptureItemOption[];
  initialItemID?: number | null;
  allowWholeOrder?: boolean;
  allowNote?: boolean;
  onUpload: (files: File[], itemID: number | null, note: string, onProgress: (done: number) => void) => Promise<void>;
  onPickFromGallery?: (itemID: number | null, note: string) => void;
  onClose: () => void;
}

// Bottom sheet on phones, dialog on desktop: take photos with the camera or pick
// from the album, fix orientation per photo, then upload them in one go.
export function PhotoCaptureSheet({
  title,
  description,
  items,
  initialItemID = null,
  allowWholeOrder = true,
  allowNote = true,
  onUpload,
  onPickFromGallery,
  onClose,
}: PhotoCaptureSheetProps) {
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [itemID, setItemID] = useState<number | null>(initialItemID ?? (allowWholeOrder ? null : items[0]?.id ?? null));
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const cameraRef = useRef<HTMLInputElement>(null);
  const albumRef = useRef<HTMLInputElement>(null);
  const photosRef = useRef<PendingPhoto[]>([]);
  photosRef.current = photos;

  useEffect(() => () => photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.preview)), []);

  const addFiles = (files: FileList | null) => {
    const images = Array.from(files || []).filter((file) => file.type.toLowerCase().startsWith("image/"));
    if (images.length === 0) return;
    setPhotos((current) => [
      ...current,
      ...images.map((file, index) => ({
        id: `${Date.now()}-${index}-${file.name}`,
        file,
        preview: URL.createObjectURL(file),
        rotation: 0,
      })),
    ]);
    setError("");
  };

  const rotate = (id: string, delta: number) =>
    setPhotos((current) =>
      current.map((photo) => (photo.id === id ? { ...photo, rotation: (photo.rotation + delta + 360) % 360 } : photo)),
    );

  const remove = (id: string) =>
    setPhotos((current) => {
      const target = current.find((photo) => photo.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return current.filter((photo) => photo.id !== id);
    });

  const submit = async () => {
    if (photos.length === 0 || uploading) return;
    if (!allowWholeOrder && !itemID) {
      setError("请选择对应的产品 SKU");
      return;
    }
    setUploading(true);
    setProgress(0);
    setError("");
    try {
      const prepared: File[] = [];
      for (const photo of photos) prepared.push(await preparePhoto(photo.file, photo.rotation));
      await onUpload(prepared, itemID, note.trim(), setProgress);
      photos.forEach((photo) => URL.revokeObjectURL(photo.preview));
      setPhotos([]);
      onClose();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "上传失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center bg-slate-950/50 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !uploading) onClose();
      }}
    >
      <div className="flex max-h-[94dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-lg">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-200 sm:hidden" />
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h2 className="font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={uploading}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 disabled:opacity-40"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {(items.length > 0 || allowNote) && (
            <div className="grid gap-2 sm:grid-cols-2">
              {items.length > 0 && (
                <label className="text-xs font-medium text-slate-600">
                  对应产品
                  <select
                    value={itemID ?? ""}
                    onChange={(event) => setItemID(event.target.value ? Number(event.target.value) : null)}
                    className="mt-1 h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm"
                  >
                    {allowWholeOrder && <option value="">整单（不指定 SKU）</option>}
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {allowNote && (
                <label className="text-xs font-medium text-slate-600">
                  说明
                  <input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    className="mt-1 h-11 w-full rounded-lg border border-slate-200 px-3 text-sm"
                    placeholder="问题、处理意见（可选）"
                  />
                </label>
              )}
            </div>
          )}

          <div className={`grid gap-2 ${onPickFromGallery ? "grid-cols-3" : "grid-cols-2"}`}>
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              disabled={uploading}
              className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl bg-teal-700 text-sm font-semibold text-white active:scale-[0.98] disabled:opacity-40"
            >
              <Camera className="h-6 w-6" />
              拍照
            </button>
            <button
              type="button"
              onClick={() => albumRef.current?.click()}
              disabled={uploading}
              className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-teal-200 bg-teal-50 text-sm font-semibold text-teal-800 active:scale-[0.98] disabled:opacity-40"
            >
              <ImagePlus className="h-6 w-6" />
              手机相册
            </button>
            {onPickFromGallery && (
              <button
                type="button"
                onClick={() => onPickFromGallery(itemID, note.trim())}
                disabled={uploading}
                className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-sky-200 bg-sky-50 text-sm font-semibold text-sky-800 active:scale-[0.98] disabled:opacity-40"
              >
                <Images className="h-6 w-6" />
                系统图库
              </button>
            )}
          </div>
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <input
            ref={albumRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />

          {photos.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-400">
              拍照或从相册选择，可连续添加多张；方向不对可在上传前旋转。
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {photos.map((photo) => (
                <div key={photo.id} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                  <div className="flex aspect-square items-center justify-center overflow-hidden bg-slate-900">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.preview}
                      alt=""
                      className="max-h-full max-w-full object-contain transition-transform"
                      style={{
                        transform: `rotate(${photo.rotation}deg)${photo.rotation % 180 ? " scale(0.75)" : ""}`,
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-3 border-t border-slate-200 bg-white">
                    <button
                      type="button"
                      onClick={() => rotate(photo.id, -90)}
                      className="flex h-10 items-center justify-center text-slate-600 active:bg-slate-100"
                      aria-label="向左旋转"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => rotate(photo.id, 90)}
                      className="flex h-10 items-center justify-center border-x border-slate-200 text-slate-600 active:bg-slate-100"
                      aria-label="向右旋转"
                    >
                      <RotateCw className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(photo.id)}
                      className="flex h-10 items-center justify-center text-rose-600 active:bg-rose-50"
                      aria-label="移除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        </div>

        <div className="border-t border-slate-200 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={photos.length === 0 || uploading}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-slate-900 text-sm font-semibold text-white disabled:opacity-40"
          >
            {uploading && <Loader2 className="h-4 w-4 animate-spin" />}
            {uploading ? `上传中 ${progress}/${photos.length}` : `上传 ${photos.length} 张照片`}
          </button>
        </div>
      </div>
    </div>
  );
}
