/**
 * 訂單頁（`/orders`）時間篩選。
 *
 * ⚠️ 2026-09-13 加「自訂」後，`custom` 唔再係 key-only：呼叫 predicate 時可以傳
 * `{ key: "custom", custom: { start, end } }`。為咗唔爆既有呼叫點，所有函式嘅第二參數
 * 都接受 **Either**：舊嘅 `"today"` 字串，或新嘅 selection object。
 *
 * 邊界口徑（保持原樣，**唔可以**改成 Macau 日曆 —— 訂單頁歷史上用滾動窗口）：
 * - `today` / `yesterday` 用 `macauDateKey` 比日曆日。
 * - `7d` / `30d` 用 `now - days*24h` 毫秒截止。
 * - `custom` 用 Macau 日曆起訖（`date-range.ts`）。
 * - `all` ＝ 無上限。
 */

import { customRangeToISO, instantInRange, type CustomDateRange, type DateRangeSelection } from "./date-range";

export type LedgerOrderDateFilterKey = "today" | "yesterday" | "7d" | "30d" | "all" | "custom";

/** @deprecated 用 `LedgerOrderDateFilterKey`。保留別名以免大規模改 import。 */
export type LedgerOrderDateFilter = LedgerOrderDateFilterKey;

/** 呼叫 predicate 時可以傳嘅第二參數（字串＝只用 key；object＝可帶 custom）。 */
export type DateFilterArg = LedgerOrderDateFilterKey | DateRangeSelection<LedgerOrderDateFilterKey>;

export const LEDGER_ORDER_DATE_FILTERS: Array<{ key: LedgerOrderDateFilterKey; label: string }> = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "7d", label: "7 天內" },
  { key: "30d", label: "30 天" },
  { key: "all", label: "全部" },
  { key: "custom", label: "自訂" },
];

const MACAU_TZ = "Asia/Macau";

export function macauDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MACAU_TZ }).format(date);
}

/** 拆解第二參數：回傳 key 同（如適用）自訂區間。 */
function splitArg(arg: DateFilterArg): { key: LedgerOrderDateFilterKey; custom: CustomDateRange | null } {
  if (typeof arg === "string") return { key: arg, custom: null };
  return { key: arg.key, custom: arg.custom ?? null };
}

export function orderMatchesDateFilter(
  order: { createdAt?: string },
  filter: DateFilterArg,
  now = new Date(),
): boolean {
  const { key, custom } = splitArg(filter);
  if (key === "all") return true;
  if (!order.createdAt) return false;

  const created = new Date(order.createdAt);
  if (Number.isNaN(created.getTime())) return false;

  if (key === "custom") {
    if (!custom) return true; // 未揀區間 → 當「全部」（同 chip 未套用時一致）
    return instantInRange(created, customRangeToISO(custom));
  }

  if (key === "today") {
    return macauDateKey(created) === macauDateKey(now);
  }

  if (key === "yesterday") {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return macauDateKey(created) === macauDateKey(yesterday);
  }

  const days = key === "7d" ? 7 : 30;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return created.getTime() >= cutoff;
}

/** Ledger RPC `p_limit` 上限為 100；較長區間多拉一些以減少漏單。 */
export function limitForDateFilter(filter: DateFilterArg): number {
  const { key } = splitArg(filter);
  if (key === "today" || key === "yesterday") return 50;
  return 100;
}

export function dateFilterLabel(filter: DateFilterArg): string {
  const { key } = splitArg(filter);
  return LEDGER_ORDER_DATE_FILTERS.find((row) => row.key === key)?.label ?? "今天";
}

/** 自訂區間是否已套用（UI 用：未套用時 chip 顯示「自訂」但列表仍係全部）。 */
export function hasAppliedCustomRange(filter: DateFilterArg): boolean {
  const { key, custom } = splitArg(filter);
  return key === "custom" && custom != null;
}
