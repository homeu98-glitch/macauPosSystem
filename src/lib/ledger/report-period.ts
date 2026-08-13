/** Macau (+08:00) date boundaries for Ledger `get_merchant_report_summary`. */

const MACAU_TZ = "Asia/Macau";

export function macauDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MACAU_TZ }).format(date);
}

function macauParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Macau",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return { year, month, day };
}

export function macauDateToStartISO(year: string, month: string, day: string): string {
  return `${year}-${month}-${day}T00:00:00+08:00`;
}

export function macauDateToEndISO(year: string, month: string, day: string): string {
  return `${year}-${month}-${day}T23:59:59.999+08:00`;
}

export function macauTodayRange(now = new Date()): { start: string; end: string } {
  const { year, month, day } = macauParts(now);
  return {
    start: macauDateToStartISO(year, month, day),
    end: macauDateToEndISO(year, month, day),
  };
}

export function macauYesterdayRange(now = new Date()): { start: string; end: string } {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const { year, month, day } = macauParts(yesterday);
  return {
    start: macauDateToStartISO(year, month, day),
    end: macauDateToEndISO(year, month, day),
  };
}

export function macauRollingRange(days: number, now = new Date()): { start: string; end: string } {
  const endParts = macauParts(now);
  const startDate = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const startParts = macauParts(startDate);
  return {
    start: macauDateToStartISO(startParts.year, startParts.month, startParts.day),
    end: macauDateToEndISO(endParts.year, endParts.month, endParts.day),
  };
}

export type ReportRangeKey = "today" | "yesterday" | "7d" | "30d" | "all";

export const REPORT_RANGE_OPTIONS: Array<{ key: ReportRangeKey; label: string }> = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "7d", label: "最近 7 天" },
  { key: "30d", label: "最近 30 天" },
  { key: "all", label: "全部" },
];

export function ledgerReportRangeForKey(key: ReportRangeKey, now = new Date()): { start: string; end: string } | null {
  if (key === "today") return macauTodayRange(now);
  if (key === "yesterday") return macauYesterdayRange(now);
  if (key === "7d") return macauRollingRange(7, now);
  if (key === "30d") return macauRollingRange(30, now);
  // "all" — use 365-day window as practical upper bound for RPC
  return macauRollingRange(365, now);
}

/** 以澳門日曆篩選本機訂單（優先 `updatedAt`，結帳／報表用）。 */
export function orderMatchesReportRange(
  order: { updatedAt?: string; createdAt?: string },
  range: ReportRangeKey,
  now = new Date(),
): boolean {
  if (range === "all") return true;

  const ts = order.updatedAt || order.createdAt;
  if (!ts) return false;

  const instant = new Date(ts);
  if (Number.isNaN(instant.getTime())) return false;

  if (range === "today") {
    return macauDateKey(instant) === macauDateKey(now);
  }

  if (range === "yesterday") {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return macauDateKey(instant) === macauDateKey(yesterday);
  }

  const period = ledgerReportRangeForKey(range, now);
  if (!period) return false;

  const time = instant.getTime();
  return time >= Date.parse(period.start) && time <= Date.parse(period.end);
}

export function reportRangeLabel(range: ReportRangeKey): string {
  return REPORT_RANGE_OPTIONS.find((row) => row.key === range)?.label ?? range;
}
