// Settlement cycles (账期): a cycle starting on day N of the month holds the
// deals from day N of the previous month up to day N-1 of this month. Day 1
// (or unset) is the calendar month. Mirrors TradeModules.SettlementMonthFor.

function validStartDay(startDay?: number) {
  return startDay && startDay > 1 && startDay <= 28 ? startDay : 1;
}

function monthKey(year: number, monthIndex: number) {
  const date = new Date(year, monthIndex, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function settlementMonthFor(date: Date, startDay?: number) {
  const day = validStartDay(startDay);
  const shift = day > 1 && date.getDate() >= day ? 1 : 0;
  return monthKey(date.getFullYear(), date.getMonth() + shift);
}

export function currentSettlementMonth(startDay?: number) {
  return settlementMonthFor(new Date(), startDay);
}

export function shiftSettlementMonth(month: string, delta: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthKey(year, monthNumber - 1 + delta);
}

export function formatSettlementMonth(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  return `${year}年${monthNumber}月`;
}

// "10/26 – 11/25" for shifted cycles, empty for calendar months.
export function settlementRangeLabel(month: string, startDay?: number) {
  const day = validStartDay(startDay);
  if (day === 1) return "";
  const [year, monthNumber] = month.split("-").map(Number);
  const start = new Date(year, monthNumber - 2, day);
  const end = new Date(year, monthNumber - 1, day - 1);
  return `${start.getMonth() + 1}/${start.getDate()} – ${end.getMonth() + 1}/${end.getDate()}`;
}

export function todayInputDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
