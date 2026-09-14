/**
 * 線上單「廚房單補印」窗口判定（2026-09-14 · J 實案：取餐碼 005）。
 *
 * ── 為咩要一個獨立純模組 ────────────────────────────────────────────────
 * 補印兜底原本寫死喺 `online-orders.tsx`：
 *
 * ```ts
 * if (raw !== "accepted" && raw !== "preparing") return;   // ← 窗口太窄
 * ```
 *
 * 缺口（商家實案）：**POS 當時冇開 / Realtime 斷線 / 單係由另一方（Ledger 側
 * `auto_accept`、Sunmi、另一部機）接嘅** → 本機由頭到尾冇見過 `pending` →
 * 亦冇跑過接單路徑 → 當本機見到張單時已經係 `ready`／`completed`
 * ⇒ **永遠唔會補印**（零 job、零提示、零紙）。005 正正落喺呢個格。
 *
 * 所以要分三件事：
 *   1. 窗口要覆蓋 `ready`／`completed`（唔止 `accepted`／`preparing`）；
 *   2. 但 `completed` 係**終態**，唔可以無限期補 —— 否則一開頁就會補印
 *      幾個鐘前（甚至昨日）嘅舊單，洗版又浪費紙；
 *   3. 已經出過紙（本機 job 帳本有記錄）／同一個 session 試過 → 一律唔再試。
 *
 * 呢個模組**零 runtime 依賴**（`node --test` 可以直接載入），判定邏輯全部
 * 收喺 `decideKitchenBackfill()`，令「幾時補、幾時唔補」有測試鎖死。
 */

/**
 * `completed` 單嘅補印容忍期：**1 小時**。
 *
 * 口徑：由「本機第一次見到張單」起計，只要張單係**最近一小時內完結**就補印
 * （治「POS 冇開 / 斷線期間完結」）；超過就當歷史單，**唔補**（收銀要用
 * 打印中心手動重打）。揀 1 小時嘅理由：一般外賣自取／外送由完成到收銀察覺
 * 都喺一個營業時段內，唔會超過一個鐘；再舊就已經冇意義（客人都走咗）。
 */
export const KITCHEN_BACKFILL_MAX_AGE_MS = 60 * 60 * 1000;

/** 需要補印兜底嘅狀態（＝「廚房應該已經收過紙」嘅狀態）。 */
export const KITCHEN_BACKFILL_STATUSES = ["accepted", "preparing", "ready", "completed"] as const;

export type KitchenBackfillDecision =
  /** 應該補印 */
  | "print"
  /** 本機已經有同一張單嘅 job（或已出過紙帳本有記錄）→ 唔補 */
  | "has-job"
  /** 同一個 session 已經試過 / 正在跑 → 唔補 */
  | "in-flight"
  /** 狀態唔喺窗口內（pending / cancelled / delivering …）→ 唔補 */
  | "inactive-status"
  /** 終態但已經過咗容忍期（歷史單）→ 唔補 */
  | "stale";

export type KitchenBackfillInput = {
  /** Ledger 原始狀態（大小寫不拘）。 */
  status: string;
  /** 訂單最後更新時間（Ledger ISO）。 */
  updatedAt?: string | null;
  /** 建立時間（`updatedAt` 缺失時嘅後備）。 */
  createdAt?: string | null;
  nowMs: number;
  /** 本機已知「呢張單出過紙」（包含已被清除嘅 job，見 storage 帳本）。 */
  hasJob: boolean;
  /** 同一 session 已嘗試過／正在補印。 */
  inFlight?: boolean;
  maxAgeMs?: number;
};

export function normalizeBackfillStatus(status: string): string {
  return String(status ?? "").trim().toLowerCase();
}

/** 由 ISO 字串攞時間戳；缺失／唔合法 → `null`（唔可以當 0，否則永遠 stale）。 */
export function backfillTimestampMs(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

export function decideKitchenBackfill(input: KitchenBackfillInput): KitchenBackfillDecision {
  if (input.inFlight) return "in-flight";
  if (input.hasJob) return "has-job";

  const status = normalizeBackfillStatus(input.status);
  if (!(KITCHEN_BACKFILL_STATUSES as readonly string[]).includes(status)) return "inactive-status";

  // ⚠️ 只有終態（completed）需要時間窗：其餘三個狀態都係「製作中／待交付」，
  // 客人仲等緊，補印永遠合理（舊寫法就係無條件認呢兩三個）。
  if (status !== "completed") return "print";

  const at = backfillTimestampMs(input.updatedAt, input.createdAt);
  if (at == null) return "stale"; // 冇時間戳 = 無法證明係「最近」＝當歷史單，寧少唔多
  const maxAge = input.maxAgeMs ?? KITCHEN_BACKFILL_MAX_AGE_MS;
  return input.nowMs - at > maxAge ? "stale" : "print";
}
