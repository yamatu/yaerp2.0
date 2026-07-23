"use client";

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code2,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Minus,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Table2,
  Trash2,
  Underline,
  Undo2,
  Unlink,
} from "lucide-react";
import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  MouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";

interface MailSignatureEditorProps {
  value: string;
  onChange: (value: string) => void;
  onUploadImage: (file: File) => Promise<string>;
  displayName?: string;
  emailAddress?: string;
}

type EditorMode = "visual" | "html";

const fontFamilies = [
  ["Arial", "Arial"],
  ["Helvetica", "Helvetica"],
  ["Georgia", "Georgia"],
  ["Times New Roman", "Times New Roman"],
  ["Microsoft YaHei", "微软雅黑"],
  ["SimSun", "宋体"],
];

const fontSizes = [
  ["1", "10px"],
  ["2", "12px"],
  ["3", "14px"],
  ["4", "16px"],
  ["5", "18px"],
  ["6", "24px"],
  ["7", "32px"],
];

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ToolbarButton({
  title,
  onClick,
  children,
  active = false,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-sky-100 text-sky-700"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      }`}
    >
      {children}
    </button>
  );
}

export default function MailSignatureEditor({
  value,
  onChange,
  onUploadImage,
  displayName = "姓名",
  emailAddress = "name@example.com",
}: MailSignatureEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const selectedImageRef = useRef<HTMLImageElement | null>(null);
  const selectionRangeRef = useRef<Range | null>(null);
  const lastSyncedHTMLRef = useRef("");
  const lastRenderedModeRef = useRef<EditorMode>("visual");
  const [mode, setMode] = useState<EditorMode>("visual");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [selectedImage, setSelectedImage] = useState(false);
  const [editorError, setEditorError] = useState("");

  useEffect(() => {
    const previousMode = lastRenderedModeRef.current;
    lastRenderedModeRef.current = mode;
    if (mode !== "visual" || !editorRef.current) return;
    if (
      previousMode !== "visual" ||
      value !== lastSyncedHTMLRef.current
    ) {
      editorRef.current.innerHTML = value;
      lastSyncedHTMLRef.current = value;
      selectedImageRef.current = null;
      setSelectedImage(false);
    }
  }, [mode, value]);

  const editorHTML = () => {
    const image = selectedImageRef.current;
    if (!image) return editorRef.current?.innerHTML || "";
    const outline = image.style.outline;
    const outlineOffset = image.style.outlineOffset;
    image.style.outline = "";
    image.style.outlineOffset = "";
    const html = editorRef.current?.innerHTML || "";
    image.style.outline = outline;
    image.style.outlineOffset = outlineOffset;
    return html;
  };

  const saveSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      selectionRangeRef.current = range.cloneRange();
    }
  };

  const restoreSelection = () => {
    const range = selectionRangeRef.current;
    if (!range || !range.startContainer.isConnected) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const syncHTML = () => {
    const html = editorHTML();
    lastSyncedHTMLRef.current = html;
    onChange(html);
    saveSelection();
  };

  const focusEditor = () => {
    editorRef.current?.focus();
  };

  const runCommand = (command: string, commandValue?: string) => {
    focusEditor();
    restoreSelection();
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(command, false, commandValue);
    syncHTML();
  };

  const insertHTML = (html: string) => {
    focusEditor();
    restoreSelection();
    document.execCommand("insertHTML", false, html);
    syncHTML();
  };

  const insertLink = () => {
    const rawURL = window.prompt("请输入链接地址或邮箱地址");
    if (!rawURL?.trim()) return;
    let url = rawURL.trim();
    if (url.includes("@") && !url.includes("://") && !url.startsWith("mailto:")) {
      url = `mailto:${url}`;
    } else if (!/^(?:https?:|mailto:|tel:|#)/i.test(url)) {
      url = `https://${url}`;
    }
    runCommand("createLink", url);
  };

  const insertTable = () => {
    insertHTML(
      '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:collapse"><tbody><tr><td style="padding:0 16px 0 0;vertical-align:top"><strong>姓名 / Name</strong><br><span style="color:#64748b">职位 / 公司</span></td><td style="padding:0;vertical-align:top;color:#475569">电话 / Phone<br>邮箱 / Email</td></tr></tbody></table>',
    );
  };

  const insertTemplate = (template: string) => {
    if (!template) return;
    const name = escapeAttribute(displayName || "姓名");
    const email = escapeAttribute(emailAddress || "name@example.com");
    const templates: Record<string, string> = {
      simple: `<div style="font-family:Arial,sans-serif;color:#334155;line-height:1.6"><strong style="font-size:16px;color:#0f172a">${name}</strong><br><span>职位 / Position</span><br><a href="mailto:${email}" style="color:#0284c7">${email}</a></div>`,
      trade: `<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:620px;border-collapse:collapse;font-family:Arial,sans-serif;color:#334155"><tbody><tr><td style="padding:0 16px 0 0;vertical-align:top;border-right:3px solid #0284c7"><strong style="font-size:18px;color:#0f172a">${name}</strong><br><span style="color:#64748b">Sales Manager</span></td><td style="padding:0 0 0 16px;vertical-align:top"><strong>Company Name</strong><br><span>Tel: +86 000 0000 0000</span><br><a href="mailto:${email}" style="color:#0284c7">${email}</a><br><a href="https://example.com" style="color:#0284c7">www.example.com</a></td></tr></tbody></table>`,
      compact: `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#334155"><strong>${name}</strong> · Position · Company<br><span style="color:#64748b">M +86 000 0000 0000 · </span><a href="mailto:${email}" style="color:#0284c7">${email}</a></div>`,
      disclaimer: '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #cbd5e1;font-size:11px;line-height:1.5;color:#94a3b8">This email and any attachments are confidential and intended only for the named recipient. If you received it in error, please notify the sender and delete it.</div>',
    };
    insertHTML(templates[template] || "");
  };

  const uploadImages = async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      setEditorError("请选择 JPG、PNG、WebP、GIF 等图片文件。");
      return;
    }
    const oversized = images.find((file) => file.size > 10 * 1024 * 1024);
    if (oversized) {
      setEditorError(`图片“${oversized.name}”超过 10MB，请压缩后重试。`);
      return;
    }
    setUploadingImage(true);
    setEditorError("");
    try {
      for (const file of images) {
        const url = await onUploadImage(file);
        insertHTML(
          `<img src="${escapeAttribute(url)}" alt="${escapeAttribute(file.name)}" width="180" style="display:inline-block;max-width:100%;height:auto;margin:6px 0">`,
        );
      }
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "上传落款图片失败。");
    } finally {
      setUploadingImage(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  const selectImage = (image: HTMLImageElement | null) => {
    if (selectedImageRef.current) {
      selectedImageRef.current.style.outline = "";
      selectedImageRef.current.style.outlineOffset = "";
    }
    selectedImageRef.current = image;
    if (image) {
      image.style.outline = "2px solid #0ea5e9";
      image.style.outlineOffset = "2px";
    }
    setSelectedImage(Boolean(image));
  };

  const resizeSelectedImage = (width: number | "100%") => {
    const image = selectedImageRef.current;
    if (!image) return;
    image.setAttribute("width", String(width));
    image.style.width = typeof width === "number" ? `${width}px` : width;
    image.style.maxWidth = "100%";
    image.style.height = "auto";
    syncHTML();
  };

  const removeSelectedImage = () => {
    const image = selectedImageRef.current;
    if (!image) return;
    image.remove();
    selectedImageRef.current = null;
    setSelectedImage(false);
    syncHTML();
  };

  const handleEditorClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    selectImage(target.closest("img"));
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (images.length === 0) return;
    event.preventDefault();
    void uploadImages(images);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const images = Array.from(event.dataTransfer.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (images.length === 0) return;
    event.preventDefault();
    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const range = documentWithCaret.caretRangeFromPoint?.(
      event.clientX,
      event.clientY,
    );
    if (range) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      selectionRangeRef.current = range.cloneRange();
    }
    void uploadImages(images);
  };

  const changeMode = (nextMode: EditorMode) => {
    if (mode === "visual") syncHTML();
    selectionRangeRef.current = null;
    setMode(nextMode);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-2 py-2">
        <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5">
          <button
            type="button"
            onClick={() => changeMode("visual")}
            className={`inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium ${mode === "visual" ? "bg-sky-600 text-white" : "text-slate-600"}`}
          >
            <Bold className="h-3.5 w-3.5" />
            可视化编辑
          </button>
          <button
            type="button"
            onClick={() => changeMode("html")}
            className={`inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium ${mode === "html" ? "bg-sky-600 text-white" : "text-slate-600"}`}
          >
            <Code2 className="h-3.5 w-3.5" />
            HTML 源码
          </button>
        </div>
        <select
          defaultValue=""
          onChange={(event) => {
            insertTemplate(event.target.value);
            event.target.value = "";
          }}
          onMouseDown={saveSelection}
          disabled={mode !== "visual"}
          title="插入常用落款模板"
          className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none disabled:opacity-50"
        >
          <option value="">插入模板</option>
          <option value="simple">简洁商务</option>
          <option value="trade">外贸名片</option>
          <option value="compact">单行紧凑</option>
          <option value="disclaimer">保密声明</option>
        </select>
      </div>

      {mode === "visual" && (
        <>
          <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 px-2 py-1.5">
            <ToolbarButton title="撤销" onClick={() => runCommand("undo")}>
              <Undo2 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="重做" onClick={() => runCommand("redo")}>
              <Redo2 className="h-4 w-4" />
            </ToolbarButton>
            <span className="mx-1 h-5 w-px bg-slate-200" />
            <select
              defaultValue="Arial"
              onMouseDown={saveSelection}
              onChange={(event) => runCommand("fontName", event.target.value)}
              title="字体"
              className="h-8 max-w-32 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none"
            >
              {fontFamilies.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              defaultValue="3"
              onMouseDown={saveSelection}
              onChange={(event) => runCommand("fontSize", event.target.value)}
              title="字号"
              className="h-8 w-20 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none"
            >
              {fontSizes.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <ToolbarButton title="加粗" onClick={() => runCommand("bold")}>
              <Bold className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="斜体" onClick={() => runCommand("italic")}>
              <Italic className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="下划线" onClick={() => runCommand("underline")}>
              <Underline className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="删除线" onClick={() => runCommand("strikeThrough")}>
              <Strikethrough className="h-4 w-4" />
            </ToolbarButton>
            <label
              title="文字颜色"
              className="relative inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
            >
              <span className="text-sm font-bold">A</span>
              <span className="absolute bottom-1 h-0.5 w-4 bg-slate-900" />
              <input
                type="color"
                defaultValue="#0f172a"
                onMouseDown={saveSelection}
                onChange={(event) => runCommand("foreColor", event.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
            <label
              title="背景颜色"
              className="relative inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-slate-600 hover:bg-slate-100"
            >
              <span className="h-4 w-4 rounded-sm border border-slate-400 bg-amber-100" />
              <input
                type="color"
                defaultValue="#fef3c7"
                onMouseDown={saveSelection}
                onChange={(event) => runCommand("hiliteColor", event.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
            <span className="mx-1 h-5 w-px bg-slate-200" />
            <ToolbarButton title="左对齐" onClick={() => runCommand("justifyLeft")}>
              <AlignLeft className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="居中" onClick={() => runCommand("justifyCenter")}>
              <AlignCenter className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="右对齐" onClick={() => runCommand("justifyRight")}>
              <AlignRight className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="项目符号" onClick={() => runCommand("insertUnorderedList")}>
              <List className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="编号列表" onClick={() => runCommand("insertOrderedList")}>
              <ListOrdered className="h-4 w-4" />
            </ToolbarButton>
            <span className="mx-1 h-5 w-px bg-slate-200" />
            <ToolbarButton title="插入链接" onClick={insertLink}>
              <LinkIcon className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="取消链接" onClick={() => runCommand("unlink")}>
              <Unlink className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="插入分隔线" onClick={() => runCommand("insertHorizontalRule")}>
              <Minus className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton title="插入双栏名片" onClick={insertTable}>
              <Table2 className="h-4 w-4" />
            </ToolbarButton>
            <ToolbarButton
              title="上传图片"
              onClick={() => imageInputRef.current?.click()}
              disabled={uploadingImage}
            >
              {uploadingImage ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ImagePlus className="h-4 w-4" />
              )}
            </ToolbarButton>
            <ToolbarButton title="清除格式" onClick={() => runCommand("removeFormat")}>
              <RemoveFormatting className="h-4 w-4" />
            </ToolbarButton>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                void uploadImages(Array.from(event.target.files || []))
              }
            />
          </div>

          {selectedImage && (
            <div className="flex flex-wrap items-center gap-1 border-b border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-800">
              <span className="mr-1 font-medium">图片宽度</span>
              {[80, 120, 180, 240, 320].map((width) => (
                <button
                  key={width}
                  type="button"
                  onClick={() => resizeSelectedImage(width)}
                  className="h-7 rounded border border-sky-200 bg-white px-2 hover:bg-sky-100"
                >
                  {width}px
                </button>
              ))}
              <button
                type="button"
                onClick={() => resizeSelectedImage("100%")}
                className="h-7 rounded border border-sky-200 bg-white px-2 hover:bg-sky-100"
              >
                自适应
              </button>
              <button
                type="button"
                onClick={removeSelectedImage}
                className="ml-auto inline-flex h-7 items-center gap-1 rounded border border-rose-200 bg-white px-2 text-rose-600 hover:bg-rose-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                删除图片
              </button>
            </div>
          )}

          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
          onInput={syncHTML}
          onBlur={syncHTML}
          onClick={handleEditorClick}
          onMouseUp={saveSelection}
          onKeyUp={saveSelection}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={(event) => event.preventDefault()}
            data-placeholder="输入落款内容，可直接粘贴或拖入图片..."
            className="mail-signature-editor min-h-80 max-h-[52dvh] overflow-y-auto p-4 text-sm leading-7 text-slate-700 outline-none empty:before:pointer-events-none empty:before:text-slate-400 empty:before:content-[attr(data-placeholder)] [&_a]:text-sky-700 [&_img]:max-w-full [&_table]:max-w-full"
          />
        </>
      )}

      {mode === "html" && (
        <textarea
          value={value}
          onChange={(event) => {
            lastSyncedHTMLRef.current = event.target.value;
            onChange(event.target.value);
          }}
          spellCheck={false}
          placeholder={'<strong>Janice Chen</strong><br><a href="mailto:sales@example.com">sales@example.com</a>'}
          className="min-h-[410px] w-full resize-y p-4 font-mono text-sm leading-6 text-slate-700 outline-none"
        />
      )}

      <div className="flex min-h-9 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
        <span>
          {mode === "visual"
            ? "支持粘贴、拖放图片；点击图片后可调整尺寸。"
            : "保存时会自动移除脚本和不安全样式。"}
        </span>
        {editorError && <span className="text-right text-rose-600">{editorError}</span>}
      </div>
    </div>
  );
}
