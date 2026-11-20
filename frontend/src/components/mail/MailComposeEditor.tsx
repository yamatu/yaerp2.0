"use client";

import {
  ClipboardEvent,
  DragEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2 } from "lucide-react";
import {
  addComposeImage,
  composeImagesBytes,
  composeImagesMaxBytes,
} from "@/lib/mailComposeImages";
import MailFormatToolbar, { type MailFormatActions } from "@/components/mail/MailFormatToolbar";

export interface MailComposeEditorHandle {
  focusStart: () => void;
  insertImages: (files: File[]) => Promise<void>;
}

interface MailComposeEditorProps {
  /** Editor HTML: text, line breaks and images registered by addComposeImage. */
  html: string;
  onChange: (html: string, text: string) => void;
  /** Files that cannot go into the body; the caller attaches them. */
  onAttach: (files: File[]) => void;
  onNotice: (message: string) => void;
  placeholder: string;
  className?: string;
}

/**
 * The body of a mail being written: text formatted from the toolbar (fonts,
 * sizes, bold, colours, lists, links) plus images placed anywhere in it
 * (pasted screenshots, dropped or picked photos). Pasted rich text is kept as
 * plain text, so foreign styles never leak into a mail.
 */
const MailComposeEditor = forwardRef<MailComposeEditorHandle, MailComposeEditorProps>(
  function MailComposeEditor({ html, onChange, onAttach, onNotice, placeholder, className = "" }, ref) {
    const editorRef = useRef<HTMLDivElement | null>(null);
    const emittedRef = useRef<string | null>(null);
    const rangeRef = useRef<Range | null>(null);
    const [inserting, setInserting] = useState(0);
    const [empty, setEmpty] = useState(!html);

    // Uncontrolled while typing; only a value that did not come from this
    // editor (a new compose, a re-edited mail) replaces its content.
    useEffect(() => {
      const editor = editorRef.current;
      if (!editor || html === emittedRef.current) return;
      editor.innerHTML = html;
      emittedRef.current = html;
      setEmpty(!html);
    }, [html]);

    useEffect(() => {
      const remember = () => {
        const editor = editorRef.current;
        const selection = window.getSelection();
        if (!editor || !selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (editor.contains(range.commonAncestorContainer)) rangeRef.current = range.cloneRange();
      };
      document.addEventListener("selectionchange", remember);
      return () => document.removeEventListener("selectionchange", remember);
    }, []);

    const emit = () => {
      const editor = editorRef.current;
      if (!editor) return;
      const value = editor.innerHTML;
      const text = editor.innerText.replace(/\n$/, "");
      emittedRef.current = value;
      setEmpty(!text.trim() && !editor.querySelector("img"));
      onChange(value, text);
    };

    /** Puts the caret back where it was before a toolbar button took focus. */
    const restoreCaret = () => {
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection) return;
      editor.focus();
      const saved = rangeRef.current;
      if (saved && editor.contains(saved.commonAncestorContainer)) {
        selection.removeAllRanges();
        selection.addRange(saved);
        return;
      }
      const end = document.createRange();
      end.selectNodeContents(editor);
      end.collapse(false);
      selection.removeAllRanges();
      selection.addRange(end);
    };

    const insertImages = async (files: File[]) => {
      const editor = editorRef.current;
      if (!editor || !files.length) return;
      const pictures = files.filter((file) => file.type.startsWith("image/"));
      const others = files.filter((file) => !file.type.startsWith("image/"));
      const attach = [...others];
      let budget = composeImagesMaxBytes - composeImagesBytes(editor.innerHTML);
      let markup = "";
      setInserting((count) => count + pictures.length);
      try {
        for (const file of pictures) {
          const image = await addComposeImage(file).catch(() => null);
          if (!image) {
            attach.push(file);
            onNotice(`${file.name || "图片"} 无法插入正文，已作为附件添加。`);
          } else if (image.bytes > budget) {
            attach.push(file);
            onNotice(`正文图片总大小超过 ${composeImagesMaxBytes >> 20}MB，${file.name || "图片"} 已作为附件添加。`);
          } else {
            budget -= image.bytes;
            markup += image.html;
          }
        }
      } finally {
        setInserting((count) => count - pictures.length);
      }
      if (markup) {
        restoreCaret();
        document.execCommand("insertHTML", false, markup);
        emit();
      }
      if (attach.length) onAttach(attach);
    };

    // Stable, so the toolbar subscribes to selection changes once.
    const emitRef = useRef(emit);
    emitRef.current = emit;
    const restoreRef = useRef(restoreCaret);
    restoreRef.current = restoreCaret;
    const formatActions = useMemo<MailFormatActions>(
      () => ({
        exec: (command, value) => {
          restoreRef.current();
          document.execCommand("styleWithCSS", false, "true");
          document.execCommand(command, false, value);
          emitRef.current();
        },
        fontSize: (px) => {
          const editor = editorRef.current;
          if (!editor) return;
          restoreRef.current();
          // execCommand only knows sizes 1-7; mark with 7 and swap in pixels.
          document.execCommand("styleWithCSS", false, "false");
          document.execCommand("fontSize", false, "7");
          document.execCommand("styleWithCSS", false, "true");
          editor.querySelectorAll('font[size="7"]').forEach((font) => {
            const span = document.createElement("span");
            span.style.fontSize = `${px}px`;
            span.append(...Array.from(font.childNodes));
            font.replaceWith(span);
          });
          emitRef.current();
        },
        hasFocus: () => {
          const editor = editorRef.current;
          const selection = window.getSelection();
          return Boolean(editor && selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer));
        },
      }),
      [],
    );

    useImperativeHandle(ref, () => ({
      focusStart: () => {
        const editor = editorRef.current;
        const selection = window.getSelection();
        if (!editor || !selection) return;
        editor.focus();
        const start = document.createRange();
        start.setStart(editor, 0);
        start.collapse(true);
        selection.removeAllRanges();
        selection.addRange(start);
        editor.scrollTop = 0;
      },
      insertImages,
    }));

    const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
      const files = Array.from(event.clipboardData.files || []);
      event.preventDefault();
      if (files.length) {
        void insertImages(files);
        return;
      }
      const text = event.clipboardData.getData("text/plain");
      if (text) document.execCommand("insertText", false, text);
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files || []);
      const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (caret && editorRef.current?.contains(caret.commonAncestorContainer)) {
        rangeRef.current = caret;
      }
      if (files.length) {
        void insertImages(files);
        return;
      }
      const text = event.dataTransfer.getData("text/plain");
      if (text) {
        restoreCaret();
        document.execCommand("insertText", false, text);
      }
    };

    return (
      <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 focus-within:border-sky-400">
        <MailFormatToolbar actions={formatActions} />
        <div className="relative">
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="邮件正文"
          onInput={emit}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
          className={`block overflow-y-auto whitespace-pre-wrap break-words p-3 text-sm leading-7 outline-none [&_a]:text-sky-700 [&_a]:underline [&_hr]:my-2 [&_hr]:border-slate-300 [&_img]:my-1 [&_img]:inline-block [&_img]:h-auto [&_img]:max-h-[360px] [&_img]:max-w-full [&_img]:rounded [&_ol]:list-decimal [&_ol]:pl-7 [&_ul]:list-disc [&_ul]:pl-7 ${className}`}
        />
        {empty && (
          <div className="pointer-events-none absolute left-3 top-3 text-sm leading-7 text-slate-400">
            {placeholder}
          </div>
        )}
        {inserting > 0 && (
          <div className="pointer-events-none absolute bottom-2 right-3 inline-flex items-center gap-1.5 rounded-md bg-white/90 px-2 py-1 text-xs text-slate-500 shadow-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在插入图片…
          </div>
        )}
        </div>
      </div>
    );
  },
);

export default MailComposeEditor;
