/**
 * 「本班」時間窗 —— 交班頁所有金額／訂單篩選嘅**唯一時間口徑**（2026-11-03）。
 *
 * ## 為咩要有呢個檔案
 *
 * 交班頁一直用 `macauTodayRange()`（澳門**日曆日**）做彙總。對夜宵店嚟講呢個係錯嘅：
 * 11 月 3 日 20:00 開班、11 月 4 日 02:00 交班，舊寫法只計 11 月 4 日 00:00–02:00，
 * 11 月 3 日晚市**全部唔見**（交班單紙本一樣錯）；而且交班後 `openedAt` 清空，
 * 摘要仍然用「今日」⇒ 數字停留喺畫面，唔會清零。
 *
 * 商家口徑（2026-11-03）：「交班日期」＝**班次**，唔係日曆日；交完班就應該清 0。
 *
 * ## 定義
 *
 * ```
 * 本班區間 = [ shift.openedAt , now ]   // 開班中（自然跨越午夜）
 *          = null                       // 未開工／已交班 → 所有數字 0
 * ```
 *
 * ⚠️ 唔可以改用「營業日 cutoff（例如凌晨 6 點截數）」：唔同店嘅夜宵時段差好遠，
 *    而且會同 `shift.openedAt` 呢個**已經存在嘅真源**分叉。班次窗係唯一事實。
 *
 * ## 為何係純模組
 *
 * `npm test` ＝ `node --test`（唔認 `@/` alias、唔支援 `.tsx`），呢個模組要可以直接單測，
 * 所以：零 `@/` import、`import` 一律相對 + 顯式 `.ts`。
 */

import { orderEventInstant, type TimeStampableOrder } from "./order-event-time.ts";

export type ShiftWindow = {
  /** 班次起點（ISO 8601）。 */
  start: string;
  /** 班次終點（ISO 8601）—— 開班中 ＝ 呼叫當刻。 */
  end: string;
};

/** 由「開班時間」推導班次窗；未開工 → `null`（呼叫端一律當「本班未有數」）。 */
export function shiftWindowOf(
  shift: { openedAt?: string | null } | null | undefined,
  nowMs: number,
): ShiftWindow | null {
  const startMs = parseInstant(shift?.openedAt);
  if (startMs <= 0) return null;
  // 裝置鐘被調慢（now < openedAt）時唔可以回一個負區間：夾成一個零長度窗口。
  const endMs = Number.isFinite(nowMs) && nowMs > startMs ? nowMs : startMs;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

/** 呢張單係唔係落喺班次窗內（用全站唯一時間口徑 `orderEventInstant()`）。 */
export function orderMatchesShiftWindow(
  order: TimeStampableOrder | null | undefined,
  window: ShiftWindow | null | undefined,
): boolean {
  if (!window) return false;
  const startMs = parseInstant(window.start);
  const endMs = parseInstant(window.end);
  if (startMs <= 0 || endMs <= 0 || endMs < startMs) return false;
  const eventMs = orderEventInstant(order);
  return eventMs >= startMs && eventMs <= endMs;
}

/**
 * 班次窗 → 澳門日曆日 key（`YYYY-MM-DD`，兩端皆含）。
 *
 * 用途：`/orders?unfinished=1&from=&to=` 嘅日期 chip（訂單頁只支援日級區間），
 * 以及「本班跨咗幾多日」嘅顯示。**唔係**用嚟計錢 —— 計錢一律用 `ShiftWindow` 本身。
 */
export function shiftDayKeys(window: ShiftWindow | null | undefined): { from: string; to: string } | null {
  if (!window) return null;
  const startMs = parseInstant(window.start);
  const endMs = parseInstant(window.end);
  if (startMs <= 0 || endMs <= 0) return null;
  return {
    from: macauDateKeyOfInstant(startMs),
    to: macauDateKeyOfInstant(endMs),
  };
}

/** 由 epoch ms 取澳門日曆日 key。 */
export function macauDateKeyOfInstant(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(new Date(ms));
}

/** 兩個澳門日 key 之間較早嗰個（`YYYY-MM-DD` 字串比較 ＝ 時間比較）。 */
export function earlierDayKey(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a <= b ? a : b;
}

function parseInstant(raw: unknown): number {
  if (typeof raw !== "string") return 0;
  const s = raw.trim();
  if (!s || s === "0") return 0;
  const ts = Date.parse(s);
  return Number.isFinite(ts) && ts > 0 ? ts : 0;
}
