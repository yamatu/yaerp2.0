"use client";

import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  ExternalLink,
  FileText,
  ImagePlus,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import type { TradePaymentProof } from "@/types";

interface PaymentProofPanelProps {
  proofs: TradePaymentProof[];
  canUpload: boolean;
  uploading: boolean;
  onUpload: (files: File[]) => Promise<void> | void;
}

function isImageProof(proof: TradePaymentProof) {
  return (
    proof.mime_type?.toLowerCase().startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(proof.filename || "")
  );
}

function isSupportedFile(file: File) {
  return (
    file.type.toLowerCase().startsWith("image/") ||
    file.type.toLowerCase() === "application/pdf" ||
    /\.pdf$/i.test(file.name)
  );
}

function formatFileSize(size = 0) {
  if (size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function PaymentProofPanel({
  proofs,
  canUpload,
  uploading,
  onUpload,
}: PaymentProofPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<TradePaymentProof | null>(null);

  const submitFiles = (files: File[]) => {
    const supported = files.filter(isSupportedFile);
    if (supported.length === 0) {
      setError("仅支持图片或 PDF 文件");
      return;
    }
    setError(
      supported.length === files.length
        ? ""
        : `已忽略 ${files.length - supported.length} 个不支持的文件`,
    );
    void onUpload(supported);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!canUpload || uploading) return;
    submitFiles(Array.from(event.dataTransfer.files || []));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === "Enter" || event.key === " ") && canUpload && !uploading) {
      event.preventDefault();
      inputRef.current?.click();
    }
  };

  return (
    <div className="mt-3 space-y-3">
      {proofs.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {proofs.map((proof) => {
            const image = isImageProof(proof);
            return (
              <button
                key={proof.id}
                type="button"
                onClick={() => setPreview(proof)}
                className="group min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white text-left hover:border-emerald-300 hover:shadow-sm"
                title={`预览 ${proof.filename || "付款凭证"}`}
              >
                <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-slate-100">
                  {image ? (
                    <img
                      src={proof.thumbnail_url || proof.attachment_url}
                      alt={proof.filename || "付款凭证"}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-rose-600">
                      <FileText className="h-8 w-8" />
                      <span className="text-xs font-semibold">PDF</span>
                    </div>
                  )}
                </div>
                <div className="px-2.5 py-2">
                  <div className="truncate text-xs font-semibold text-slate-700">
                    {proof.filename || "付款凭证"}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-slate-400">
                    {[proof.uploaded_by_name, formatFileSize(proof.size)]
                      .filter(Boolean)
                      .join(" · ") || "点击预览"}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {canUpload && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => !uploading && inputRef.current?.click()}
          onKeyDown={handleKeyDown}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!uploading) setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragging(false);
            }
          }}
          onDrop={handleDrop}
          onPaste={(event) => {
            if (uploading) return;
            const files = Array.from(event.clipboardData.files || []);
            if (files.length > 0) {
              event.preventDefault();
              submitFiles(files);
            }
          }}
          className={`flex min-h-16 cursor-pointer items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-3 outline-none transition focus:ring-2 focus:ring-emerald-100 ${
            dragging
              ? "border-emerald-400 bg-emerald-50"
              : "border-slate-300 bg-slate-50 hover:border-emerald-300 hover:bg-emerald-50/40"
          } ${uploading ? "pointer-events-none opacity-60" : ""}`}
          title="点击选择文件，也支持拖拽或粘贴图片及 PDF"
        >
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
          ) : dragging ? (
            <Upload className="h-5 w-5 text-emerald-600" />
          ) : (
            <ImagePlus className="h-5 w-5 text-slate-500" />
          )}
          <div>
            <div className="text-sm font-semibold text-slate-700">
              {uploading ? "正在上传付款凭证" : "添加付款凭证"}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              图片 / PDF · 支持拖放与粘贴
            </div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf,.pdf"
            multiple
            className="hidden"
            disabled={uploading}
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              event.currentTarget.value = "";
              if (files.length > 0) submitFiles(files);
            }}
          />
        </div>
      )}
      {error && <div className="text-xs text-amber-700">{error}</div>}

      {preview && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/70 p-3 sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900">
                  {preview.filename || "付款凭证"}
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {[preview.uploaded_by_name, formatFileSize(preview.size)]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <a
                  href={preview.attachment_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                  title="在新窗口打开"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
                <button
                  type="button"
                  onClick={() => setPreview(null)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                  title="关闭预览"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-slate-100 p-2 sm:p-4">
              {isImageProof(preview) ? (
                <img
                  src={preview.attachment_url}
                  alt={preview.filename || "付款凭证"}
                  className="mx-auto max-h-[78vh] max-w-full object-contain"
                />
              ) : (
                <iframe
                  src={preview.attachment_url}
                  title={preview.filename || "付款凭证 PDF"}
                  className="h-[78vh] w-full rounded-md bg-white"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
