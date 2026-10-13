// Parses supplier quotes pasted from Excel / WPS (tab separated) or typed as
// comma separated text. A header row is recognised by its column names, so the
// columns may come in any order; without one the fixed order of
// SUPPLIER_QUOTE_IMPORT_COLUMNS is used.

export interface ImportItemRef {
  id: number;
  line_no: number;
  sku: string;
  product_name: string;
}

export interface ImportSupplierRef {
  id: number;
  name: string;
  company_name?: string;
  default_currency?: string;
}

export interface ParsedQuoteRow {
  /** 1-based line of the pasted text. */
  source: number;
  itemText: string;
  item?: ImportItemRef;
  supplierID: number;
  supplierName: string;
  supplierIsNew: boolean;
  unitPrice: string;
  currency: string;
  moq: string;
  leadTime: string;
  validUntil: string;
  notes: string;
  unavailable: boolean;
  reason: string;
  error?: string;
}

type Field = "item" | "line" | "supplier" | "price" | "currency" | "moq" | "lead" | "valid" | "notes" | "status";

export const SUPPLIER_QUOTE_IMPORT_COLUMNS = ["SKU", "供应商", "单价", "币种", "MOQ", "交期(天)", "有效期", "备注"];
const DEFAULT_ORDER: Field[] = ["item", "supplier", "price", "currency", "moq", "lead", "valid", "notes"];

const HEADER_ALIASES: Array<[Field, string[]]> = [
  ["supplier", ["供应商", "供应商名称", "供应商简称", "厂家", "工厂", "厂商", "supplier", "vendor", "factory"]],
  ["line", ["行号", "序号", "#", "line", "no", "no."]],
  ["item", ["sku", "型号", "编号", "产品编号", "货号", "料号", "产品", "产品名称", "品名", "product", "item", "partno", "part number"]],
  ["price", ["单价", "价格", "采购价", "采购单价", "报价", "进价", "price", "unitprice", "unit price", "cost"]],
  ["currency", ["币种", "货币", "币别", "currency"]],
  ["moq", ["moq", "起订量", "最小起订量", "起订"]],
  ["lead", ["交期", "货期", "交货期", "交期(天)", "交期（天）", "leadtime", "lead time"]],
  ["valid", ["有效期", "有效期至", "报价有效期", "valid", "validuntil", "valid until"]],
  ["notes", ["备注", "说明", "notes", "note", "remark", "remarks"]],
  ["status", ["状态", "是否有货", "能否报价", "无法报价", "status"]],
];

export const UNAVAILABLE_PATTERN = /无法报价|不能报价|报不了|无货|没货|没有货|缺货|断货|停产|无此|找不到|没有|^无$|^n\/?a$/i;

const CURRENCY_ALIASES: Record<string, string> = { RMB: "CNY", "¥": "CNY", "￥": "CNY", $: "USD", "€": "EUR", "£": "GBP" };

function normalizeHeader(cell: string) {
  return cell.trim().toLowerCase().replace(/[\s:：*]/g, "");
}

function headerField(cell: string): Field | null {
  const key = normalizeHeader(cell);
  if (!key) return null;
  for (const [field, aliases] of HEADER_ALIASES) {
    if (aliases.some((alias) => alias.replace(/\s/g, "") === key)) return field;
  }
  return null;
}

function splitLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
  // Typed text: commas (half or full width), or a vertical bar.
  return line.split(/[,，|]/).map((cell) => cell.trim());
}

function parseNumber(text: string): string {
  const match = text.replace(/[,，\s]/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? match[0] : "";
}

function parseCurrency(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  for (const [symbol, code] of Object.entries(CURRENCY_ALIASES)) {
    if (trimmed.toUpperCase().includes(symbol)) return code;
  }
  const code = trimmed.match(/[A-Za-z]{3}/)?.[0]?.toUpperCase() || "";
  return CURRENCY_ALIASES[code] || code;
}

function parseLeadTime(text: string): string {
  const numbers = text.match(/\d+/g);
  return numbers ? numbers[numbers.length - 1] : "";
}

function parseDate(text: string): string {
  const match = text.trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function parseSupplierQuoteText(
  text: string,
  items: ImportItemRef[],
  suppliers: ImportSupplierRef[],
): { rows: ParsedQuoteRow[]; headerDetected: boolean } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const itemByKey = new Map<string, ImportItemRef>();
  for (const item of items) {
    if (item.product_name.trim()) itemByKey.set(item.product_name.trim().toLowerCase(), item);
  }
  // SKUs win over product names when both match.
  for (const item of items) {
    if (item.sku.trim()) itemByKey.set(item.sku.trim().toLowerCase(), item);
  }
  const itemByLine = new Map(items.map((item) => [item.line_no, item]));
  const supplierByName = new Map<string, ImportSupplierRef>();
  for (const supplier of suppliers) {
    const company = supplier.company_name?.trim().toLowerCase();
    if (company && !supplierByName.has(company)) supplierByName.set(company, supplier);
  }
  for (const supplier of suppliers) {
    if (supplier.name.trim()) supplierByName.set(supplier.name.trim().toLowerCase(), supplier);
  }

  let columns: Field[] = DEFAULT_ORDER;
  let headerDetected = false;
  const rows: ParsedQuoteRow[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const cells = splitLine(line);
    if (!headerDetected && rows.length === 0) {
      const fields = cells.map(headerField);
      const recognised = fields.filter(Boolean).length;
      if (recognised >= 2 && (fields.includes("supplier") || fields.includes("price"))) {
        columns = fields.map((field) => field ?? ("ignored" as Field));
        headerDetected = true;
        return;
      }
    }
    const cell = (field: Field) => {
      const position = columns.indexOf(field);
      return position >= 0 ? (cells[position] ?? "").trim() : "";
    };
    const itemText = cell("item");
    const lineText = cell("line");
    let item = itemText ? itemByKey.get(itemText.toLowerCase()) : undefined;
    if (!item && /^#?\d+$/.test(lineText)) item = itemByLine.get(Number(lineText.replace("#", "")));
    if (!item && /^#\d+$/.test(itemText)) item = itemByLine.get(Number(itemText.slice(1)));
    if (!item && !itemText && !lineText && items.length === 1) item = items[0];

    const priceText = cell("price");
    const statusText = cell("status");
    const notes = cell("notes");
    const unavailable =
      UNAVAILABLE_PATTERN.test(statusText) || (!parseNumber(priceText) && UNAVAILABLE_PATTERN.test(priceText));
    const supplierName = cell("supplier");
    const supplier = supplierName ? supplierByName.get(supplierName.toLowerCase()) : undefined;
    const unitPrice = parseNumber(priceText);
    const row: ParsedQuoteRow = {
      source: index + 1,
      itemText: itemText || lineText,
      item,
      supplierID: supplier?.id ?? 0,
      supplierName: supplier?.name ?? supplierName,
      supplierIsNew: Boolean(supplierName && !supplier),
      unitPrice,
      currency: parseCurrency(cell("currency")) || parseCurrency(priceText.replace(/[\d.,，\s-]/g, "")) || supplier?.default_currency?.toUpperCase() || "",
      moq: parseNumber(cell("moq")),
      leadTime: parseLeadTime(cell("lead")),
      validUntil: parseDate(cell("valid")),
      notes,
      unavailable,
      reason: unavailable ? [statusText, priceText, notes].find((part) => part && part.trim()) || "无法报价" : "",
    };
    if (!item) row.error = row.itemText ? `订单中找不到产品「${row.itemText}」` : "缺少 SKU / 产品";
    else if (!unavailable && !supplierName) row.error = "缺少供应商";
    else if (!unavailable && !(Number(unitPrice) > 0)) row.error = priceText ? `单价「${priceText}」无效` : "缺少单价";
    rows.push(row);
  });
  return { rows, headerDetected };
}
