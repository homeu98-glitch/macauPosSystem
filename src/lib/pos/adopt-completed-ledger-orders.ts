/**
 * 「自動補建已完成線上單」嘅**純判定邏輯**（2026-09-27）。
 *
 * ## 為咩要同 hook 分開
 *
 * `npm test` ＝ `node --test`：**唔認 `@/` 別名、唔行 bundler、唔支援 JSX**，
 * 而且 import 要有副檔名。React hook（`use-adopt-completed-ledger-orders.ts`）含
 * `"use client"` 同 `react` import ⇒ 唔可以被測試直接載入。
 * 所以判定邏輯搬嚟呢度，**零 import** ⇒ 測試可以 `import ... from "./adopt-completed-ledger-orders.ts"`。
 *
 * ## 業務口徑（同 `ledger-pos-bridge.adoptCompletedLedgerOrderToLocal` 一致）
 *
 * 可以自動補建 ＝ **已付款（`paid`）＋ 已完成（status 含 `complete`）＋ 非取消**。
 * 未付款／未完成嘅單補上去 ＝ 向報表謊報收入（造數），唔係還原真相。
 */

/** 判定只需要嘅欄位（structural typing）。 */
export type AdoptableLedgerOrderLike = {
  id: string;
  paymentStatus?: string;
  status?: string;
};

/**
 * Ledger 狀態係唔係「已完成」。
 *
 * ⚠️ 同 `ledger-pos-bridge` 嘅 `normalizeLedgerStatus()` **同一口徑**：
 *    用 substring 比對（`completed` / `complete` / 任何含 `complete` 嘅變體），
 *    而唔係嚴格 `===`。歷史上 Ledger 回過唔同大小寫／變體，收緊會令漏帳重現。
 * ⚠️ 含 `cancel` 一律當取消（同報表 / 交班 / `online-reconcile` 同一口徑）。
 */
export function isCompletedLedgerOrderLike(order: AdoptableLedgerOrderLike): boolean {
  const status = String(order?.status ?? "").toLowerCase();
  if (status.includes("cancel")) return false;
  return status.includes("complete");
}

/** 已付款且已完成、可以（亦應該）自動補建嘅單。 */
export function isAdoptableCompletedOrder(order: AdoptableLedgerOrderLike): boolean {
  if (!order?.id) return false;
  if (String(order.paymentStatus ?? "").toLowerCase() !== "paid") return false;
  return isCompletedLedgerOrderLike(order);
}

/**
 * 由一批 Ledger 單篩出「需要嘗試補建」嘅（已付款＋已完成＋未試過）。
 *
 * @param orders 當前 Ledger 單（通常係 `ledgerOrders`）。
 * @param attempted 本掛載內**已經試過**嘅 id（避免重複嘗試 → 迴圈）。
 */
export function pickAdoptableOrders<T extends AdoptableLedgerOrderLike>(
  orders: readonly T[],
  attempted: ReadonlySet<string>,
): T[] {
  const out: T[] = [];
  for (const order of orders) {
    if (!isAdoptableCompletedOrder(order)) continue;
    if (attempted.has(order.id)) continue;
    out.push(order);
  }
  return out;
}

/**
 * 由 `pos_orders` 回應抽出「已經入帳」嘅 Ledger 單 id。
 *
 * 🔴 任何唔符形狀嘅輸入 → **空集合**（fail-open）：
 *    呢個集合係「額外資訊」，唔可以因為佢壞而令補建停擺。
 */
export function parseAdoptedOnlineIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as { onlineOrderIds?: unknown }).onlineOrderIds;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === "string" && value) out.push(value);
  }
  return out;
}

/**
 * 把雲端 id 併入本機集合（**union**，唔取代）。
 *
 * 本機集合＝「本機 `loadOrders()` 已有嘅 `ledger-<id>`」；雲端集合＝
 * 「雲端 `pos_orders` 已有嘅 `online_order_id`」。任何一邊有 ⇒ 都係「已入過帳」。
 */
export function mergeAdoptedOnlineIds(
  localIds: Iterable<string>,
  remoteIds: Iterable<string>,
): Set<string> {
  const merged = new Set<string>(localIds);
  for (const id of remoteIds) if (id) merged.add(id);
  return merged;
}
