/**
 * 外賣平台單（澳覓 / MFOOD，由 Chrome 插件推入）嘅**作廢（覆寫）**規則。
 *
 * ── 為什麼要有「作廢」而唔係用「取消結帳」────────────────────────────
 * 使用者 2026-09-24 明確要求（原文要點）：
 *   1. 商家接單後，訂單喺真實世界仍可能被取消，**可能發生喺任何階段，甚至已完結之後**；
 *   2. 我哋**無法將平台嘅真實狀態流程完整同步過來**（只同步「單子本身」）
 *      → 需要保留足夠嘅操作自由度；
 *   3. 呢個動作係 **override**：用嚟覆寫系統狀態，令商家唔會因為線上單而**報表數字出錯**。
 *
 * 所以佢**唔可以**由狀態流程推導（「paid/settled 就唔准取消」係本地單嘅規則，
 * 因為本地單嘅錢係我哋自己收、作廢要走退款／返結）。
 * 平台單嘅錢係**平台收**，我哋只係記錄營業額 —— 平台取消咗，我哋就要跟住唔計。
 *
 * ── 為什麼仍要擋兩種狀態（唔係「一律可以」）──────────────────────────
 * `refunded` / `partially_refunded`：**刻意唔准**。
 *   報表淨額 = `Σ(isSaleCountable.total) − refundTotalOf(orders)`
 *   （見 `@/lib/refund-net`），而 `refundTotalOf()` **只認**退款狀態嘅單。
 *   一條退款單一旦被改成 `cancelled`：毛額唔變（本來就唔計）、但退款額**消失**
 *   → 淨額反而**多咗一筆退款**，報表錯得更厲害。
 *   ⇒ 呢兩種狀態要用「退款流程」，唔可以用作廢。
 *   （實務上平台單唔會落到呢兩個狀態：入站 route 直接拒收已取消／已退款嘅平台單。）
 *
 * `cancelled`：已經作廢，冇需要再寫一次事件。
 *
 * ── 零 import ────────────────────────────────────────────────────
 * 保持零 import 先可以被 `node --test` 直接載入驗證（同 `pos-order-row.ts` 同一理由）。
 * 所以參數型別寫 inline、用 `unknown` 收（順便避免 `PosOrder["source"]` 目前**未包含**
 * `"aomi"` / `"mfood"` 而要在呼叫端做 type cast）。
 */

/** 外賣平台單嘅 `source` 值（migration 0054 起放寬咗 `source` CHECK）。 */
export const PLATFORM_ORDER_SOURCES = ["aomi", "mfood"] as const;

/** 係咪外賣平台單。`source` 收 `unknown` → 呼叫端唔需要 type cast。 */
export function isPlatformOrderSource(source: unknown): boolean {
  return source === "aomi" || source === "mfood";
}

/**
 * 唔准「作廢（覆寫）」嘅狀態。
 * ⚠️ 唔可以擴大到 `paid` / `settled` —— 嗰兩個正正係使用者要覆寫嘅對象。
 */
export const PLATFORM_VOID_BLOCKED_STATUSES = [
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;

/** 可以作廢（覆寫）嘅狀態（供 UI／測試直接引用）。 */
export const PLATFORM_VOID_ALLOWED_STATUSES = [
  "draft",
  "sent_to_kitchen",
  "paid",
  "settled",
  "reopened",
] as const;

/** 作廢（覆寫）要寫入嘅狀態（`cancelled` 係終態 → 兩邊 LWW 守門都會放行）。 */
export const PLATFORM_VOID_TARGET_STATUS = "cancelled";

/** 冇填原因時嘅預設審計文字（同本地單「收銀取消結帳」一樣要一眼睇得出係邊種操作）。 */
export const PLATFORM_VOID_DEFAULT_REASON = "平台單作廢（覆寫）";

/** 只有呢啲欄位會被讀 —— 唔綁死 `PosOrder`，方便單測同避免 import。 */
export interface PlatformVoidCandidate {
  source?: unknown;
  status?: unknown;
}

/** 係唔係平台單（同時檢查 source 同 status 欄位存在）。 */
export function isPlatformOrder(order: PlatformVoidCandidate | null | undefined): boolean {
  return Boolean(order) && isPlatformOrderSource(order?.source);
}

/**
 * 可唔可以作廢（覆寫）。
 *
 * @returns `true` = 無論而家係 `paid` 定 `settled`（甚至已完結）都可以覆寫成 `cancelled`。
 */
export function canVoidPlatformOrder(
  order: PlatformVoidCandidate | null | undefined,
): boolean {
  if (!order) return false;
  if (!isPlatformOrder(order)) return false;
  const status = String(order.status ?? "").trim();
  if (!status) return false;
  return !(PLATFORM_VOID_BLOCKED_STATUSES as readonly string[]).includes(status);
}

/**
 * 唔可以作廢時嘅**一句話原因**（UI 用；可以作廢／唔關呢支事 → `null`）。
 *
 * `null` 有兩種意思，呼叫端要分清：
 *   · 唔係平台單 → 用返既有「取消結帳」口徑；
 *   · 係平台單而且可以作廢 → 出「取消（覆寫）」掣。
 * 所以另設 `isPlatformOrder()` 分辨。
 */
export function platformVoidDenyReason(
  order: PlatformVoidCandidate | null | undefined,
): string | null {
  if (!order || !isPlatformOrder(order)) return null;
  const status = String(order.status ?? "").trim();
  if (status === "cancelled") return "訂單已經作廢";
  if (status === "refunded" || status === "partially_refunded") {
    return "已退款單唔可以用作廢處理（會令報表淨額多計一筆退款），請用退款流程";
  }
  if (!(PLATFORM_VOID_ALLOWED_STATUSES as readonly string[]).includes(status)) {
    // 未知狀態（平台改版／未來新值）→ 保守放行，因為平台單本身就係 override 語意。
    return null;
  }
  return null;
}
