// Helpers for replying to / forwarding mail and for making the earlier messages
// of a thread easy to tell apart when reading.

export interface MailThreadAddress {
  name?: string;
  address: string;
}

export interface MailThreadSource {
  from: MailThreadAddress[];
  to: MailThreadAddress[];
  cc?: MailThreadAddress[];
  date: string;
  subject: string;
  html_body?: string;
  text_body?: string;
}

/** The original message attached under a reply or forward. */
export interface MailQuote {
  /** Formal header + original body, exactly as it is sent. */
  html: string;
  text: string;
  include: boolean;
}

export function escapeMailHTML(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function addressLabel(address: MailThreadAddress) {
  return address.name && address.name !== address.address
    ? `${address.name} <${address.address}>`
    : address.address;
}

function addressList(values: MailThreadAddress[] | undefined) {
  return (values || []).map(addressLabel).join("; ");
}

// Mail goes to overseas customers, so the quote header follows the English
// Outlook layout every mail client recognises.
function formatQuoteDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Converts HTML to readable text, keeping line breaks of blocks and cells. */
export function htmlToPlainText(html: string) {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
  }
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  doc.querySelectorAll("style,script,head,title").forEach((node) => node.remove());
  doc.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  doc.querySelectorAll("td,th").forEach((node) => node.append("\t"));
  doc
    .querySelectorAll("p,div,tr,li,h1,h2,h3,h4,h5,h6,blockquote,pre,table,hr")
    .forEach((node) => node.append("\n"));
  return (doc.body.textContent || "")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function plainTextToMailHTML(text: string) {
  return escapeMailHTML(text).replace(/\r?\n/g, "<br>");
}

export function buildMailQuote(source: MailThreadSource): MailQuote {
  const rows: Array<[string, string]> = [
    ["From", addressList(source.from)],
    ["Sent", formatQuoteDate(source.date)],
    ["To", addressList(source.to)],
  ];
  if (source.cc?.length) rows.push(["Cc", addressList(source.cc)]);
  rows.push(["Subject", source.subject || ""]);

  const headerHTML = rows
    .map(([label, value]) => `<b>${label}:</b> ${escapeMailHTML(value)}`)
    .join("<br>");
  const bodyHTML = source.html_body || plainTextToMailHTML(source.text_body || "");
  const html =
    `<div style="margin-top:20px;border-top:1px solid #b5c4df;padding-top:8px;` +
    `font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:#1f2937">` +
    `${headerHTML}</div><br><div>${bodyHTML}</div>`;

  const headerText = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  const bodyText = (source.text_body || htmlToPlainText(source.html_body || "")).trim();
  const text = `________________________________\n${headerText}\n\n${bodyText}`;
  return { html, text, include: true };
}

export interface OutgoingMailBody {
  html: string;
  text: string;
  /**
   * Signature the server should append. Empty when the signature was already
   * placed above the quote, where it belongs.
   */
  signatureHTML: string;
}

/**
 * Assembles what is sent: the user's own text, then the signature, then the
 * quoted original. Without a quote the server keeps appending the signature.
 */
export function buildOutgoingMail(options: {
  format: "text" | "html";
  textBody: string;
  htmlBody: string;
  quote: MailQuote | null;
  signatureHTML: string;
  /** Text part when it is known better than derived from htmlBody. */
  plainText?: string;
}): OutgoingMailBody {
  const { format, textBody, htmlBody, quote, signatureHTML } = options;
  const ownText = options.plainText ?? (format === "html" ? htmlToPlainText(htmlBody) : textBody);
  if (!quote?.include) {
    return { html: format === "html" ? htmlBody : "", text: ownText, signatureHTML };
  }
  const ownHTML = format === "html" ? htmlBody : plainTextToMailHTML(textBody.replace(/\s+$/, ""));
  const signatureBlock = signatureHTML ? `<br><br>${signatureHTML}` : "";
  const signatureText = signatureHTML ? `\n\n${htmlToPlainText(signatureHTML)}` : "";
  return {
    html:
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111827">` +
      `${ownHTML}${signatureBlock}</div>${quote.html}`,
    text: `${ownText.replace(/\s+$/, "")}${signatureText}\n\n${quote.text}`,
    signatureHTML: "",
  };
}

// ---------------------------------------------------------------------------
// Thread separators for reading
// ---------------------------------------------------------------------------

const HEADER_START = /^(from|发件人|寄件人|寄件者|发信人)\s*[:：]/i;
const HEADER_FOLLOW = /(sent|date|发送时间|发送日期|日期|时间)\s*[:：]/i;
const THREAD_MARKERS = [
  /^-{2,}\s*(original message|forwarded message|原始邮件|转发邮件|转发的邮件|邮件原文)/i,
  /^-{2,}.{1,120}写道\s*-*$/,
  /^on\s.{4,240}\swrote\s*:?$/i,
  /^在\s?.{2,200}写道\s*[:：]?$/,
  /^.{1,160}于\s?.{4,60}写道\s*[:：]?$/,
];

function normalizedText(value: string) {
  return value.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function startsThread(text: string) {
  const head = text.slice(0, 400);
  if (HEADER_START.test(head) && HEADER_FOLLOW.test(head)) return true;
  return THREAD_MARKERS.some((pattern) => pattern.test(head.slice(0, 260)));
}

const SEPARATOR_HTML =
  `<div style="margin:26px 0 10px;border-top:2px solid #0ea5e9;line-height:0">` +
  `<span style="display:inline-block;padding:3px 10px;background:#0ea5e9;color:#fff;` +
  `font:600 11px/16px Arial,sans-serif;border-radius:0 0 6px 6px;line-height:16px">往来邮件</span></div>`;

const HEADER_STYLE =
  "margin:0 0 12px;padding:8px 12px;background:#f0f9ff;border-left:3px solid #0ea5e9;" +
  "border-radius:0 6px 6px 0;color:#0f172a;font-size:13px;line-height:1.6";

const BLOCK_TAGS = "div,p,blockquote,td,pre,li,section,article";

/**
 * The first `limit` characters of an element's text. Reading full textContent
 * for every nested block would be quadratic on large newsletters.
 */
function leadingText(element: Element, limit: number) {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node && text.length < limit; node = walker.nextNode()) {
    text += node.nodeValue || "";
  }
  return normalizedText(text.slice(0, limit * 2)).slice(0, limit);
}

/** Text inside the parent that precedes the element (e.g. a stray line). */
function textBefore(element: Element) {
  let text = "";
  for (let node = element.previousSibling; node; node = node.previousSibling) {
    text = (node.textContent || "") + text;
  }
  return text;
}

/**
 * Puts a clear divider above every earlier message of a thread (Outlook
 * "From:/Sent:" headers, Gmail "On … wrote:", Chinese clients' "原始邮件" /
 * "写道") and highlights its header. Display only; the HTML that is sent or
 * quoted is never changed.
 */
export function decorateMailThread(html: string) {
  if (!html || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div id="yaerp-thread-root">${html}</div>`, "text/html");
  const root = doc.getElementById("yaerp-thread-root");
  if (!root) return html;

  const matches = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_TAGS)).filter((element) =>
    startsThread(leadingText(element, 400)),
  );
  // Keep only the innermost match, so a container that merely starts with a
  // header does not swallow the whole quoted message.
  const innermost = matches.filter(
    (element) => !matches.some((other) => other !== element && element.contains(other)),
  );
  for (const element of innermost) {
    // Outlook wraps the header in containers carrying their own rule
    // (border-top or a preceding <hr>); the divider replaces them.
    let anchor: HTMLElement = element;
    while (
      anchor.parentElement &&
      anchor.parentElement !== root &&
      anchor.parentElement.firstElementChild === anchor &&
      !normalizedText(textBefore(anchor))
    ) {
      anchor = anchor.parentElement;
      anchor.style.removeProperty("border-top");
      anchor.style.removeProperty("border");
    }
    let previous = anchor.previousElementSibling;
    while (previous && previous.tagName === "HR") {
      const stale = previous;
      previous = previous.previousElementSibling;
      stale.remove();
    }
    anchor.insertAdjacentHTML("beforebegin", SEPARATOR_HTML);
    if (leadingText(element, 601).length <= 600) {
      element.setAttribute("style", HEADER_STYLE);
    }
  }
  root.querySelectorAll<HTMLElement>("blockquote").forEach((quote) => {
    if (!quote.getAttribute("style")) {
      quote.setAttribute("style", "margin:8px 0;padding-left:12px;border-left:3px solid #cbd5e1;color:#475569");
    }
  });
  return root.innerHTML;
}

/** Plain-text version of decorateMailThread. */
export function decoratePlainThread(text: string) {
  const lines = (text || "").replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^_{8,}$/.test(trimmed) || /^-{8,}$/.test(trimmed)) {
      const next = lines.slice(index + 1, index + 6).join(" ");
      if (HEADER_START.test(next.trim())) {
        output.push(SEPARATOR_HTML);
        continue;
      }
    }
    const window = [trimmed, ...lines.slice(index + 1, index + 4).map((value) => value.trim())].join(" ");
    if ((HEADER_START.test(trimmed) && HEADER_FOLLOW.test(window)) || THREAD_MARKERS.some((pattern) => pattern.test(trimmed))) {
      if (!output.length || output[output.length - 1] !== SEPARATOR_HTML) output.push(SEPARATOR_HTML);
    }
    const escaped = escapeMailHTML(line);
    output.push(trimmed.startsWith(">") ? `<span style="color:#64748b">${escaped}</span>` : escaped);
  }
  return `<div style="white-space:pre-wrap">${output
    .join("\n")
    .replace(new RegExp(`\\n?${SEPARATOR_HTML.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g"), SEPARATOR_HTML)}</div>`;
}
