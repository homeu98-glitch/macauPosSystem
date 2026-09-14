/**
 * 預約單（Ledger `scheduled_pickup_at`）顯示口徑嘅**唯一入口**。
 *
 * ## 資料來源
 *
 * Ledger `orders.scheduled_pickup_at`（timestamptz | null，契約 §5.1「預約取餐」），
 * 經 `mapLedgerOrderRow()` 映射成 `LedgerOnlineOrder.scheduledPickupAt`。
 * 有值 ＝ 預約單；null ＝ 即時單（唔顯示任何預約標籤，佈局零改動）。
 *
 * ## 為何抽成純模組
 *
 * 「快到 / 已逾時」係**時間相關**判斷：同一張單過幾分鐘就會由 `soon` 變 `overdue`。
 * 呢個判斷會被 ① 線上訂單列表 ② 訂單詳情 ③ 快餐面板卡片 三處用到，
 * 寫死喺 component 就會三份分叉（同 `orderCodeLabel` 一樣嘅教訓）。
 *
 * ⚠️ 本檔**刻意零 runtime import** → `node --test` 可以直接載入（見 repo 慣例）。
 *    時間格式化一律留喺 caller（`@/lib/format`），呢度只出 kind／分鐘數。
 */

/**
 * 「快到了」門檻（分鐘）：距離預約時間 30 分鐘內就轉琥珀色提醒收銀優先處理。
 *
 * 揀 30 分鐘嘅理由：澳門餐飲嘅取餐預約一般係「30 分鐘後／1 小時後」級數，
 * 30 分鐘剛好抓到「而家要開始做」嘅窗口，又唔會令成版單都變色。
 */
export const SCHEDULED_PICKUP_SOON_MINUTES = 30;

/** 預約單時間狀態。`null`（由 kindOf 回傳）＝ 冇有效預約時間。 */
export type ScheduledPickupKind = "scheduled" | "soon" | "overdue";

/** 任何帶 `scheduledPickupAt` 嘅物件（`LedgerOnlineOrder` / `PosOrder` 都符合）。 */
type ScheduledLike = { scheduledPickupAt?: string | null } | null | undefined;

/** 解析 `scheduled_pickup_at` → epoch ms；空 / 無效一律 `null`（唔可以當 0／NaN 用）。 */
export function scheduledPickupTimeMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}

/** 呢張單係唔係預約單（唯一判斷：`scheduledPickupAt` 有有效值）。 */
export function isScheduledOrder(order: ScheduledLike): boolean {
  return scheduledPickupTimeMs(order?.scheduledPickupAt) != null;
}

/**
 * 距離預約時間仲有幾多分鐘。
 *
 * - 正數 ＝ 未到（幾多分鐘後）
 * - 負數 ＝ 已過（逾時幾多分鐘）
 * - `null` ＝ 冇有效預約時間
 *
 * 用 `Math.ceil` 計「剩餘」：剩 0.4 分鐘顯示「1 分鐘後」比顯示「0 分鐘後」合理。
 */
export function scheduledPickupMinutesUntil(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  const target = scheduledPickupTimeMs(value);
  if (target == null) return null;
  const diffMinutes = (target - nowMs) / 60_000;
  return diffMinutes >= 0 ? Math.ceil(diffMinutes) : -Math.ceil(-diffMinutes);
}

/**
 * 預約時間狀態：`soon`（快到，含剛好到點）／`overdue`（已過）／`scheduled`（仲有排）。
 * 冇有效預約時間 → `null`（caller 直接唔 render）。
 */
export function scheduledPickupKind(
  value: string | null | undefined,
  nowMs: number = Date.now(),
  soonMinutes: number = SCHEDULED_PICKUP_SOON_MINUTES,
): ScheduledPickupKind | null {
  const minutes = scheduledPickupMinutesUntil(value, nowMs);
  if (minutes == null) return null;
  if (minutes <= 0) return "overdue";
  return minutes <= soonMinutes ? "soon" : "scheduled";
}

/** 藥丸標籤文字（三處共用同一套文案，唔可以各自作）。 */
export function scheduledPickupChipText(kind: ScheduledPickupKind): string {
  if (kind === "overdue") return "預約單 · 已逾時";
  if (kind === "soon") return "預約單 · 快到了";
  return "預約單";
}

/**
 * 藥丸配色 token（同 `getLedgerStatusBadge()` 一致嘅 label + bg + dot 結構）。
 * 用得最多嘅正常態用琥珀（同預約時間文字同色系），逾時升紅，令收銀一眼掃到。
 */
export function scheduledPickupChipBadge(kind: ScheduledPickupKind): {
  bgClass: string;
  textClass: string;
  dotClass: string;
} {
  if (kind === "overdue") {
    return { bgClass: "bg-red-50", textClass: "text-red-700", dotClass: "bg-red-500" };
  }
  if (kind === "soon") {
    return { bgClass: "bg-amber-100", textClass: "text-amber-800", dotClass: "bg-amber-500" };
  }
  return { bgClass: "bg-amber-50", textClass: "text-amber-700", dotClass: "bg-amber-400" };
}

/** 預約時間文字用嘅 Tailwind 顏色 class（列表／卡片共用）。 */
export function scheduledPickupTimeClass(kind: ScheduledPickupKind): string {
  if (kind === "overdue") return "text-red-600";
  if (kind === "soon") return "text-amber-800";
  return "text-amber-700";
}

/**
 * 逾時／剩餘嘅中文尾綴，例如「18 分鐘後」「已逾時 42 分鐘」。
 * 逾時 1 分鐘內唔扮精確（顯示「已逾時」）—— 差一分鐘唔影響收銀決定。
 */
export function scheduledPickupRelativeText(minutes: number | null): string {
  if (minutes == null) return "";
  if (minutes > 0) return `${minutes} 分鐘後`;
  if (minutes === 0) return "已到時間";
  const overdue = -minutes;
  return overdue <= 1 ? "已逾時" : `已逾時 ${overdue} 分鐘`;
}
