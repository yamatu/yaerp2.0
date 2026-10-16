// Parses customer prices pasted from Excel / WPS (tab separated) or typed as
// comma separated text. A header row may put the columns in any order; without
// one CUSTOMER_QUOTE_IMPORT_COLUMNS is assumed.

export interface CustomerQuoteImportItem {
  order_item_id: number;
  line_no: number;
  sku: string;
  product_name: string;
}

export interface ParsedCustomerQuoteRow {
  source: number;
  itemText: string;
  item?: CustomerQuoteImportItem;
  unitPrice: string;
  margin: string;
  weight: string;
  freight: string;
  error?: string;
}

type Field = "item" | "line" | "price" | "margin" | "weight" | "freight" | "ignored";

export const CUSTOMER_QUOTE_IMPORT_COLUMNS = ["SKU", "对客单价", "加价率%", "单重kg", "运费"];
const DEFAULT_ORDER: Field[] = ["item", "price", "margin", "weight", "freight"];

const HEADER_ALIASES: Array<[Field, string[]]> = [
  ["line", ["行号", "序号", "#", "line", "no", "no."]],
  ["item", ["sku", "型号", "编号", "产品编号", "货号", "料号", "产品", "产品名称", "品名", "product", "item", "partno", "partnumber"]],
  ["price", ["对客单价", "单价", "报价", "售价", "价格", "销售价", "price", "unitprice"]],
  ["margin", ["加价率", "加价率%", "加价", "利润率", "毛利率", "margin", "markup"]],
  ["weight", ["单重", "单重kg", "重量", "单件重量", "weight", "kg"]],
  ["freight", ["运费", "freight", "shipping"]],
];

function headerField(cell: string): Field | null {
  const key = cell.trim().toLowerCase().replace(/[\s:：*（）()%]/g, "");
  if (!key) return null;
  for (const [field, aliases] of HEADER_ALIASES) {
    if (aliases.some((alias) => alias.replace(/[\s%]/g, "") === key)) return field;
  }
  return null;
}

export function splitPastedLine(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
  return line.split(/[,，|]/).map((cell) => cell.trim());
}

export function parsePastedNumber(text: string): string {
  const match = text.replace(/[,，\s]/g, "").match(/-?\d+(?:\.\d+)?/);
  return match && Number(match[0]) >= 0 ? match[0] : "";
}

export function parseCustomerQuoteText(
  text: string,
  items: CustomerQuoteImportItem[],
): { rows: ParsedCustomerQuoteRow[]; headerDetected: boolean } {
  const byKey = new Map<string, CustomerQuoteImportItem>();
  for (const item of items) if (item.product_name.trim()) byKey.set(item.product_name.trim().toLowerCase(), item);
  for (const item of items) if (item.sku.trim()) byKey.set(item.sku.trim().toLowerCase(), item);
  const byLine = new Map(items.map((item) => [item.line_no, item]));

  let columns: Field[] = DEFAULT_ORDER;
  let headerDetected = false;
  const rows: ParsedCustomerQuoteRow[] = [];
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) return;
      const cells = splitPastedLine(line);
      if (!headerDetected && rows.length === 0) {
        const fields = cells.map(headerField);
        if (fields.filter(Boolean).length >= 2 && fields.some((field) => field === "price" || field === "margin" || field === "freight" || field === "weight")) {
          columns = fields.map((field) => field ?? "ignored");
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
      let item = itemText ? byKey.get(itemText.toLowerCase()) : undefined;
      if (!item && /^#?\d+$/.test(lineText)) item = byLine.get(Number(lineText.replace("#", "")));
      if (!item && /^#\d+$/.test(itemText)) item = byLine.get(Number(itemText.slice(1)));
      const row: ParsedCustomerQuoteRow = {
        source: index + 1,
        itemText: itemText || lineText,
        item,
        unitPrice: parsePastedNumber(cell("price")),
        margin: parsePastedNumber(cell("margin")),
        weight: parsePastedNumber(cell("weight")),
        freight: parsePastedNumber(cell("freight")),
      };
      if (!item) row.error = row.itemText ? `订单中找不到产品「${row.itemText}」` : "缺少 SKU / 产品";
      else if (!row.unitPrice && !row.margin && !row.weight && !row.freight) row.error = "没有可导入的数字";
      rows.push(row);
    });
  return { rows, headerDetected };
}
