/** Macau (+08:00) date boundaries for Ledger `get_merchant_report_summary`. */

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

export type ReportRangeKey = "all" | "yesterday" | "7d" | "30d";

export function ledgerReportRangeForKey(key: ReportRangeKey, now = new Date()): { start: string; end: string } | null {
  if (key === "yesterday") return macauYesterdayRange(now);
  if (key === "7d") return macauRollingRange(7, now);
  if (key === "30d") return macauRollingRange(30, now);
  // "all" — use 365-day window as practical upper bound for RPC
  return macauRollingRange(365, now);
}
