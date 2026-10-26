// Images placed in the body of a mail being written. The editor shows them
// through blob: URLs so typing never copies megabytes of base64 around; the
// data: URI is only put in when the mail is sent, and the server turns it into
// an embedded (cid:) image part.

interface ComposeImage {
  url: string;
  dataURI: string;
  bytes: number;
  width: number;
}

const images = new Map<string, ComposeImage>();
let nextImageID = 1;

/** Types the server embeds; anything else is converted to JPEG first. */
const embeddableTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const keepOriginalMaxBytes = 1536 << 10;
const maxSide = 2560;
/** Displayed width in the sent mail; wider photos are scaled down to it. */
const sentMaxWidth = 720;
/** Total size of the images of one mail; beyond it they become attachments. */
export const composeImagesMaxBytes = 15 << 20;

function readDataURI(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片无法读取"));
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片转换失败"))), "image/jpeg", 0.88),
  );
}

/**
 * Registers a picked or pasted image and returns the <img> markup for the
 * editor, or null when the browser cannot read it (e.g. HEIC on desktop).
 * Large photos are scaled to 2560px and re-encoded, as mail clients do.
 */
export async function addComposeImage(file: File): Promise<{ html: string; bytes: number } | null> {
  const sourceURL = URL.createObjectURL(file);
  let image: HTMLImageElement;
  try {
    image = await loadImage(sourceURL);
  } catch {
    URL.revokeObjectURL(sourceURL);
    return null;
  }
  let blob: Blob = file;
  let width = image.naturalWidth;
  const keep =
    embeddableTypes.has(file.type) &&
    (file.type === "image/gif" || (file.size <= keepOriginalMaxBytes && Math.max(image.naturalWidth, image.naturalHeight) <= maxSide));
  if (!keep) {
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      URL.revokeObjectURL(sourceURL);
      return null;
    }
    // JPEG has no transparency; paint it on white instead of black.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    try {
      blob = await canvasBlob(canvas);
    } catch {
      URL.revokeObjectURL(sourceURL);
      return null;
    }
    width = canvas.width;
  }
  const url = blob === file ? sourceURL : URL.createObjectURL(blob);
  if (url !== sourceURL) URL.revokeObjectURL(sourceURL);
  const dataURI = await readDataURI(blob);
  const id = `i${nextImageID++}`;
  images.set(id, { url, dataURI, bytes: blob.size, width });
  const alt = file.name && file.name !== "image.png" ? file.name.replace(/"/g, "") : "图片";
  return {
    html: `<img data-mail-img="${id}" src="${url}" alt="${alt}" style="max-width:100%;height:auto">`,
    bytes: blob.size,
  };
}

/** Bytes of the registered images still present in the editor HTML. */
export function composeImagesBytes(editorHTML: string) {
  let total = 0;
  for (const match of editorHTML.matchAll(/data-mail-img="([^"]+)"/g)) {
    total += images.get(match[1])?.bytes || 0;
  }
  return total;
}

export function hasComposeImages(editorHTML: string) {
  return /data-mail-img="/.test(editorHTML);
}

/** Drops every registered image, e.g. when the compose window closes. */
export function clearComposeImages() {
  images.forEach((image) => URL.revokeObjectURL(image.url));
  images.clear();
}

/** Plain text as editor content. */
export function textToComposeHTML(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The HTML that is sent for the editor content: images carry their data, line
 * breaks become <br> and repeated spaces survive, so the mail looks like it
 * did while typing in any client.
 */
export function composeEditorMailHTML(editorHTML: string) {
  const doc = new DOMParser().parseFromString(`<div id="yaerp-compose-root">${editorHTML}</div>`, "text/html");
  const root = doc.getElementById("yaerp-compose-root");
  if (!root) return "";
  root.querySelectorAll("img").forEach((element) => {
    const image = images.get(element.getAttribute("data-mail-img") || "");
    if (!image) {
      element.remove();
      return;
    }
    element.removeAttribute("data-mail-img");
    element.setAttribute("src", image.dataURI);
    if (image.width > sentMaxWidth) element.setAttribute("width", String(sentMaxWidth));
  });
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) textNodes.push(node as Text);
  for (const node of textNodes) {
    const value = (node.nodeValue || "").replace(/ {2}/g, "  ");
    if (!value.includes("\n")) {
      node.nodeValue = value;
      continue;
    }
    const fragment = doc.createDocumentFragment();
    value.split("\n").forEach((line, index) => {
      if (index > 0) fragment.append(doc.createElement("br"));
      if (line) fragment.append(doc.createTextNode(line));
    });
    node.replaceWith(fragment);
  }
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111827">` +
    `${root.innerHTML}</div>`
  );
}
