"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Wrapper id emitted by the mail page's iframe document template. */
export const MAIL_FRAME_ROOT_ID = "yaerp-mail-root";

/*
 * Scripts stay disabled. `allow-same-origin` (without `allow-scripts`) only lets
 * this page measure the rendered message so the frame can grow to its content
 * and scale wide newsletters down to the screen width instead of scrolling
 * sideways inside a fixed-height box.
 */
const MEASURABLE_SANDBOX =
  "allow-popups allow-popups-to-escape-sandbox allow-same-origin";

interface MailBodyFrameProps {
  srcDoc: string;
  title: string;
  className?: string;
  /** Height used before the content is measured (and as the minimum). */
  minHeight?: number;
  /** Called with every previewable image when one of them is clicked. */
  onImageClick?: (images: MailFrameImage[], index: number) => void;
}

export interface MailFrameImage {
  src: string;
  alt: string;
}

// Logos, avatars and signature icons are too small to be worth a preview.
const MIN_PREVIEW_SIZE = 48;

function previewableImages(doc: Document): HTMLImageElement[] {
  return Array.from(doc.images).filter(
    (image) =>
      Boolean(image.currentSrc || image.src) &&
      (image.naturalWidth >= MIN_PREVIEW_SIZE || image.naturalHeight >= MIN_PREVIEW_SIZE),
  );
}

export default function MailBodyFrame({
  srcDoc,
  title,
  className = "",
  minHeight = 160,
  onImageClick,
}: MailBodyFrameProps) {
  const imageClickRef = useRef(onImageClick);
  imageClickRef.current = onImageClick;
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [scaled, setScaled] = useState(false);

  const measureHeight = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    const root = doc?.getElementById(MAIL_FRAME_ROOT_ID) || doc?.body;
    if (!root) return;
    const next = Math.max(minHeight, Math.ceil(root.getBoundingClientRect().height) + 8);
    setHeight((current) => (current === next ? current : next));
  }, [minHeight]);

  const fit = useCallback(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    const root = doc?.getElementById(MAIL_FRAME_ROOT_ID);
    if (!frame || !doc || !root) {
      setHeight(null);
      return;
    }
    root.style.transform = "";
    root.style.width = "";
    const available = doc.documentElement.clientWidth || frame.clientWidth;
    const natural = Math.max(root.scrollWidth, doc.body.scrollWidth);
    let scale = 1;
    if (available > 0 && natural > available + 1) {
      scale = Math.max(0.25, available / natural);
      root.style.width = `${natural}px`;
      root.style.transformOrigin = "0 0";
      root.style.transform = `scale(${scale})`;
    }
    setScaled(scale < 1);
    measureHeight();
  }, [measureHeight]);

  // Re-fit when the message changes or when the frame itself changes width
  // (rotation, pane resize). Late images also change the layout.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let inner: ResizeObserver | null = null;
    let raf = 0;
    const schedule = (full: boolean) => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        if (full) fit();
        else measureHeight();
      });
    };
    const handleLoad = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      fit();
      inner?.disconnect();
      const root = doc.getElementById(MAIL_FRAME_ROOT_ID) || doc.body;
      if (root && typeof ResizeObserver !== "undefined") {
        inner = new ResizeObserver(() => schedule(false));
        inner.observe(root);
      }
      doc.addEventListener("load", () => schedule(true), true);
      doc.addEventListener("click", (event) => {
        const handler = imageClickRef.current;
        const target = event.target as Element | null;
        const image = target?.closest?.("img") as HTMLImageElement | null;
        if (!handler || !image) return;
        const images = previewableImages(doc);
        const index = images.indexOf(image);
        if (index < 0) return;
        event.preventDefault();
        handler(
          images.map((item) => ({ src: item.currentSrc || item.src, alt: item.alt || "" })),
          index,
        );
      });
    };
    frame.addEventListener("load", handleLoad);
    if (frame.contentDocument?.readyState === "complete") handleLoad();
    let lastWidth = frame.clientWidth;
    const outer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (frame.clientWidth === lastWidth) return;
            lastWidth = frame.clientWidth;
            schedule(true);
          })
        : null;
    outer?.observe(frame);
    return () => {
      frame.removeEventListener("load", handleLoad);
      inner?.disconnect();
      outer?.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [fit, measureHeight, srcDoc]);

  return (
    <div className="relative">
      <iframe
        ref={frameRef}
        title={title}
        sandbox={MEASURABLE_SANDBOX}
        srcDoc={srcDoc}
        scrolling={height ? "no" : undefined}
        className={`block w-full border-0 ${height ? "" : "min-h-[55dvh]"} ${className}`}
        style={height ? { height } : undefined}
      />
      {scaled && (
        <div className="mt-1 text-right text-[10px] text-slate-400">
          已按屏幕宽度缩放显示
        </div>
      )}
    </div>
  );
}
