/**
 * 全站時間篩選嘅**唯一收口點**（2026-09-13 新增）。
 *
 * ## 背景
 *
 * 加「自訂」之前，專案同時並存兩套 key-only 嘅時間範圍型別：
 *
 * - `LedgerOrderDateFilter`（`order-date-filter.ts`）——訂單頁用，標籤「今天／昨天／7 天內／30 天／全部」，
 *   邊界用 `now - days*24h` 毫秒截止。
 * - `ReportRangeKey`（`report-period.ts`）——報表／打印／庫存用，標籤「今天／昨天／最近 7 天／最近 30 天／全部」，
 *   邊界用 Macau 日曆起訖 ISO（`macauTodayRange` / `macauRollingRange`）。
 *
 * 兩者 key 一樣但**語義邊界唔同**，而且 predicate 各自散落喺 6 個檔（`report-period`、
 * `print-center`、`inventory-stats`、`restaurant-footfall`、`restaurant-bom`、`restaurant-daily-report`），
 * 每個都係「key 比對」式，冇能力表達「任意起訖日子」。
 *
 * 「自訂」需求（2026-09-13）逼使呢層要統一：本模組將**日期區間**升為第一類公民，
 * key 只係派生值。所有 predicate 一律經 `resolveDateRange()` 取得 `{start, end} | null`，
 * 再自行比時間 —— 新增範圍時只需要改一個地方。
 *
 * ## 邊界口徑
 *
 * - 所有邊界一律係 **Macau（+08:00）日曆邊界**：`start = T00:00:00+08:00`、
 *   `end = T23:59:59.999+08:00`，同 `report-period.ts` 既有口徑一致。
 * - `null` 代表**無上限**（即「全部」），predicate 應該直接 `return true`。
 * - 唔喺呢度做「今天」嘅毫秒計算 —— 嗰個係 `order-date-filter.ts` 嘅既有行為，
 *   由該檔自己嘅 `resolve` 提供，避免改動訂單頁既有邊界語義（跨午夜 off-by-one 已修過）。
 *
 * @see docs/113-agent-gotchas.md
 */

/** 自訂日期區間（`YYYY-MM-DD`，Macau 日曆）。 */
export type CustomDateRange = {
  /** 起始日（含），格式 `YYYY-MM-DD`。 */
  start: string;
  /** 結束日（含），格式 `YYYY-MM-DD`。 */
  end: string;
};

/**
 * 一個「時間範圍選擇」＝ key ＋（key 為 `custom` 時）自訂區間。
 *
 * ⚠️ 刻意唔將 `custom` 塞入 key 字串（例如 `"custom:2026-08-01:2026-08-31"`）：
 * key 係俾 UI chip 比對 active 狀態用，加料會令 `filter.key === value` 永遠唔相等。
 */
export type DateRangeSelection<K extends string> = {
  key: K;
  /** 只在 `key === "custom"` 時有意義；其他 key 一律忽略。 */
  custom?: CustomDateRange | null;
};

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` 是否格式合法**且**係真實存在嘅日子（擋 2026-02-30）。 */
export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  // `new Date("2026-02-30T00:00:00+08:00")` 會自動滾到 3 月 2 日 —— 所以要用
  // Macau 本地 parts 反查，確認來回一致。
  const parsed = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  return macauDateKeyFromInstant(parsed) === value;
}

/** 由某個 instant 取 Macau 日曆日 key。 */
function macauDateKeyFromInstant(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(instant);
}

/**
 * 驗證並規範化自訂區間。
 *
 * - 兩端都必須係合法 `YYYY-MM-DD`。
 * - `start > end` 視為**無效**（唔自動對調 —— 靜默對調會令用戶以為自己揀啱）。
 *
 * @returns 合法 → `{start, end}`；無效 → `null`。
 */
export function normalizeCustomRange(range: CustomDateRange | null | undefined): CustomDateRange | null {
  if (!range) return null;
  const { start, end } = range;
  if (!isValidDateKey(start) || !isValidDateKey(end)) return null;
  if (start > end) return null;
  return { start, end };
}

/** `YYYY-MM-DD` → Macau 當日 00:00:00.000（ISO 帶 offset）。 */
export function dateKeyToStartISO(dateKey: string): string {
  return `${dateKey}T00:00:00+08:00`;
}

/** `YYYY-MM-DD` → Macau 當日 23:59:59.999（ISO 帶 offset）。 */
export function dateKeyToEndISO(dateKey: string): string {
  return `${dateKey}T23:59:59.999+08:00`;
}

/** 自訂區間 → 可直接餵 predicate 嘅 `{start, end}` ISO。 */
export function customRangeToISO(range: CustomDateRange): { start: string; end: string } {
  return { start: dateKeyToStartISO(range.start), end: dateKeyToEndISO(range.end) };
}

/** 自訂區間嘅顯示標籤，例如 `2026-08-01 ~ 2026-08-31`。 */
export function customRangeLabel(range: CustomDateRange): string {
  return `${range.start} ~ ${range.end}`;
}

/**
 * 由一個 ISO instant 判斷係唔係落喺 `{start, end}` 內（兩端皆含）。
 *
 * 收斂所有 predicate 嘅比較邏輯：以往每個 predicate 各自 `Date.parse` 兩次，
 * 喺 `print-center` / `inventory-stats` 更係各寫一次（且 `inventory-stats` 用字串比較、
 * `print-center` 用毫秒比較，兩者對邊界處理唔完全一致）。統一之後只有一個口徑。
 */
export function instantInRange(instant: Date | string | number, range: { start: string; end: string }): boolean {
  const ts = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ts)) return false;
  const startMs = Date.parse(range.start);
  const endMs = Date.parse(range.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return ts >= startMs && ts <= endMs;
}

/** 由某個 instant 取 Macau 日曆日 key（對外版本，庫存收據用）。 */
export function macauDateKeyOf(instant: Date | string | number): string | null {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  return macauDateKeyFromInstant(d);
}
