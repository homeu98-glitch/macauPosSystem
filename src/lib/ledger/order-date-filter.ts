export type LedgerOrderDateFilter = "today" | "yesterday" | "7d" | "30d" | "all";

export const LEDGER_ORDER_DATE_FILTERS: Array<{ key: LedgerOrderDateFilter; label: string }> = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "7d", label: "7 天內" },
  { key: "30d", label: "30 天" },
  { key: "all", label: "全部" },
];

const MACAU_TZ = "Asia/Macau";

export function macauDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MACAU_TZ }).format(date);
}

export function orderMatchesDateFilter(
  order: { createdAt?: string },
  filter: LedgerOrderDateFilter,
  now = new Date(),
): boolean {
  if (filter === "all") return true;
  if (!order.createdAt) return false;

  const created = new Date(order.createdAt);
  if (Number.isNaN(created.getTime())) return false;

  if (filter === "today") {
    return macauDateKey(created) === macauDateKey(now);
  }

  if (filter === "yesterday") {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return macauDateKey(created) === macauDateKey(yesterday);
  }

  const days = filter === "7d" ? 7 : 30;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return created.getTime() >= cutoff;
}

/** Ledger RPC `p_limit` 上限為 100；較長區間多拉一些以減少漏單。 */
export function limitForDateFilter(filter: LedgerOrderDateFilter): number {
  if (filter === "today" || filter === "yesterday") return 50;
  return 100;
}

export function dateFilterLabel(filter: LedgerOrderDateFilter): string {
  return LEDGER_ORDER_DATE_FILTERS.find((row) => row.key === filter)?.label ?? "今天";
}
