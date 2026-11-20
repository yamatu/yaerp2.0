// Money and quantity input for the trade ERP. Values typed with a Chinese IME
// or copied from Excel/PayPal come as "１２。５", "$1,200.00" or "1200 USD";
// they must become numbers, and anything else must be refused instead of
// silently turning into 0.

const FULL_WIDTH = /[０-９]/g;

function toHalfWidth(value: string) {
  return value
    .replace(FULL_WIDTH, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[。．]/g, ".")
    .replace(/[，]/g, ",")
    .replace(/[－—–]/g, "-")
    .replace(/　/g, " ");
}

/** Text allowed while typing: digits and at most one decimal point. */
export function sanitizeTypedNumber(raw: string): string | null {
  const value = toHalfWidth(raw).replace(/\s/g, "");
  return /^\d*\.?\d*$/.test(value) ? value : null;
}

/**
 * Parses a pasted or typed amount. Returns the plain number text, "" for an
 * empty value, or null when it is not a number.
 */
export function parseAmountText(raw: string): string | null {
  let value = toHalfWidth(raw).trim();
  if (!value) return "";
  value = value
    .replace(/^(USD|CNY|RMB|EUR|GBP|HKD|JPY|AUD|CAD|US\$|HK\$)/i, "")
    .replace(/(USD|CNY|RMB|EUR|GBP|HKD|JPY|AUD|CAD)$/i, "")
    .replace(/[$¥￥€£元块美]|人民币|美元/g, "")
    .replace(/\s/g, "");
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(value)) value = value.replace(/,/g, "");
  else if (/^\d+,\d+$/.test(value)) value = value.replace(",", ".");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(value)) return null;
  return String(Number(value));
}

export function amountValue(text: string) {
  const parsed = parseAmountText(text);
  return parsed ? Number(parsed) : 0;
}
