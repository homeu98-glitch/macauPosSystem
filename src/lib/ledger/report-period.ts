/**
 * Macau (+08:00) date boundaries for Ledger `get_merchant_report_summary`.
 *
 * ⚠️ 2026-09-13 加「自訂」：`ReportRangeKey` 多咗 `"custom"`，而所有 predicate
 * （`orderMatchesReportRange` 等）嘅第二參數改為接受 **Either**：舊嘅 key 字串，
 * 或 `{ key, custom }` selection object。自訂區間一律用 Macau 日曆起訖，
 * 經 `date-range.ts` 統一處理。
 */

import { customRangeToISO, instantInRange, type CustomDateRange, type DateRangeSelection } from "./date-range.ts";
import { orderEventInstant } from "../pos/order-event-time.ts";

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

/** 將澳門本地日期 parts 轉成 Date（澳門 00:00 所對應嘅 UTC instant）。 */
function macauDateFromParts(year: string, month: string, day: string): Date {
  return new Date(`${year}-${month}-${day}T00:00:00+08:00`);
}

export function macauYesterdayRange(now = new Date()): { start: string; end: string } {
  const { year, month, day } = macauParts(now);
  const d = macauDateFromParts(year, month, day);
  d.setDate(d.getDate() - 1);
  const y = macauParts(d);
  return {
    start: macauDateToStartISO(y.year, y.month, y.day),
    end: macauDateToEndISO(y.year, y.month, y.day),
  };
}

export function macauRollingRange(days: number, now = new Date()): { start: string; end: string } {
  const endParts = macauParts(now);
  const startDate = macauDateFromParts(endParts.year, endParts.month, endParts.day);
  startDate.setDate(startDate.getDate() - (days - 1));
  const startParts = macauParts(startDate);
  return {
    start: macauDateToStartISO(startParts.year, startParts.month, startParts.day),
    end: macauDateToEndISO(endParts.year, endParts.month, endParts.day),
  };
}

export type ReportRangeKey = "today" | "yesterday" | "7d" | "30d" | "all" | "custom";

/**
 * 精確時間窗（ISO 8601，兩端皆含）。
 *
 * 🔴 2026-11-03 加（交班「本班」）：`custom` 只支援 `YYYY-MM-DD`（日級），
 * 但夜宵店嘅班次係「11/3 20:00 → 11/4 02:00」——用日級區間會連 11/3 日間
 * （上一班）都包埋。所以要有能力表達「任意起訖 instant」。
 *
 * 有 `window` 時**優先於** key / custom；`resolveReportRange()` 會先驗格式，
 * 無效 → `null`（fail-closed，唔會靜靜退回「今日」）。
 */
export type ExactWindow = { start: string; end: string };

/** 呼叫 predicate 時可以傳嘅第二參數（字串＝只用 key；object＝可帶 custom / 精確窗）。 */
export type ReportRangeArg =
  | ReportRangeKey
  | (DateRangeSelection<ReportRangeKey> & {
      /** 精確時間窗（交班「本班」用）；有值時優先於 key / custom。 */
      window?: ExactWindow | null;
    });

export const REPORT_RANGE_OPTIONS: Array<{ key: ReportRangeKey; label: string }> = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "7d", label: "最近 7 天" },
  { key: "30d", label: "最近 30 天" },
  { key: "all", label: "全部" },
  { key: "custom", label: "自訂" },
];

/** 拆解第二參數：回傳 key 同（如適用）自訂區間／精確窗。 */
export function splitReportRangeArg(arg: ReportRangeArg): {
  key: ReportRangeKey;
  custom: CustomDateRange | null;
  window: ExactWindow | null;
} {
  if (typeof arg === "string") return { key: arg, custom: null, window: null };
  return { key: arg.key, custom: arg.custom ?? null, window: arg.window ?? null };
}

/** 精確窗驗證：兩端都要 parse 得到、`end >= start`；否則 `null`（fail-closed）。 */
function normalizeExactWindow(window: ExactWindow | null | undefined): ExactWindow | null {
  if (!window) return null;
  const startMs = Date.parse(String(window.start ?? ""));
  const endMs = Date.parse(String(window.end ?? ""));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return { start: window.start, end: window.end };
}

/** `custom` 區間 → Macau 起訖 ISO；其他 key 走原本邏輯。`null` ＝ 無上限（全部）。 */
export function resolveReportRange(arg: ReportRangeArg, now = new Date()): { start: string; end: string } | null {
  const { key, custom, window } = splitReportRangeArg(arg);
  // 🔴 精確窗優先：交班「本班」用（見 `ExactWindow` 註解）。無效 → null，唔會退回日級區間。
  if (window) return normalizeExactWindow(window);
  if (key === "custom") {
    return custom ? customRangeToISO(custom) : null;
  }
  return ledgerReportRangeForKey(key, now);
}

export function ledgerReportRangeForKey(key: ReportRangeKey, now = new Date()): { start: string; end: string } | null {
  if (key === "today") return macauTodayRange(now);
  if (key === "yesterday") return macauYesterdayRange(now);
  if (key === "7d") return macauRollingRange(7, now);
  if (key === "30d") return macauRollingRange(30, now);
  if (key === "custom") return null; // 由 resolveReportRange 處理
  // "all" — use 365-day window as practical upper bound for RPC
  return macauRollingRange(365, now);
}

/**
 * 以澳門日曆篩選本機訂單。
 *
 * 🔴 2026-09-19：時間欄位已收口去 `orderEventInstant()`（`pos/order-event-time.ts`），
 * 唔再喺呢度自己讀 `updatedAt || createdAt`。原因見嗰個檔案 —— 訂單頁讀 `createdAt`、
 * 報表讀 `updatedAt`，同一張單兩邊都通過篩選 ⇒ 重複計錢。
 *
 * ⚠️ 呢個 predicate 本身就係舊 bug 嘅「正確嗰半」，即係原本已經用 `updatedAt`。
 * 保留成 wrapper 而唔刪，係為咗唔爆 6 個既有呼叫點。
 */
export function orderMatchesReportRange(
  // ⚠️ 一定要包 `settledAt`：`orderEventInstant()` 嘅第一優先就係佢（0057）。
  // 之前個 type 漏咗 → 傳 object literal 會 TS 報錯，令人以為呢個口徑唔支援 settledAt。
  order: {
    updatedAt?: string;
    createdAt?: string;
    reopenedAt?: string;
    originalSettledAt?: string;
    settledAt?: string;
  },
  range: ReportRangeArg,
  now = new Date(),
): boolean {
  const { key, custom, window } = splitReportRangeArg(range);
  // 精確窗（交班「本班」）優先：唔可以落下面嘅 key 短路（尤其 "all"／"custom 未有區間"）。
  if (!window) {
    if (key === "all") return true;
    // 自訂：未揀區間 → 當「全部」
    if (key === "custom" && !custom) return true;
  }

  const eventMs = orderEventInstant(order);
  if (eventMs <= 0) return false;

  // 「昨天／今天／7d／30d／自訂」統一先計出 Macau 起訖 ISO 字串，再用
  // instant >= start && instant <= end 判斷，避免用 now.getTime() - 86400000 喺
  // 跨午夜邊界時嘅 off-by-one。Macau 與 UTC 相差 +08:00，毫秒級計算嘅昨日邊界
  // 喺凌晨 0–8 點可能跨越 Macau 日界，導致昨日的單被誤判到前天（或反之）。
  const period = resolveReportRange(range, now);
  if (period) {
    return instantInRange(eventMs, period);
  }

  // 兜底：只有 "custom" 而未有區間會嚟到（上面已 return true）。
  return false;
}

export function reportRangeLabel(range: ReportRangeArg): string {
  const { key } = splitReportRangeArg(range);
  return REPORT_RANGE_OPTIONS.find((row) => row.key === key)?.label ?? key;
}
