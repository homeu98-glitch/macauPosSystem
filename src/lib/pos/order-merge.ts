/**
 * 訂單合併：終態優先（2026-11-03）。
 *
 * ## 為咩要有呢個檔案
 *
 * 交班頁為咗偵測「未完成訂單」，2026-11-03 起會 merge **雲端全部非取消單**
 * （以前只 merge 已結帳單）。呢個放寬引入一個金額風險：
 *
 * `pos_orders.updated_at` 係 **server 收件時間**。一條遲到嘅舊 `ORDER_UPDATED`
 * （例如 `sent_to_kitchen`）重推之後，雲端 row 會變成「未完成、但 updated_at 最新」。
 * 如果照「updatedAt 較新就贏」合併，本地嘅 `settled` 會被蓋走 ⇒ **交班少錢**。
 *
 * ⇒ 合併規則必須係：
 *   1. **終態永遠贏過未完成**（唔理 updatedAt）；
 *   2. 兩者同級（都終態／都未完成）→ `updatedAt` 較新嗰個贏。
 *
 * 同一條規則亦用喺「撳交班時本機快照 ∪ 已 merge 嘅 state」同
 * `pos-orders-changed` 嘅即時合併 —— 三個入口一定要同一套，否則數字會飄。
 *
 * ## 為何係純模組
 *
 * `npm test` ＝ `node --test`（唔認 `@/` alias）⇒ 零 import、泛型收 structural type。
 */

/** 合併需要嘅最小欄位（`PosOrder` 直接符合，唔需要 cast）。 */
export type MergeableOrder = {
  id: string;
  status?: string | null;
  updatedAt?: string | null;
};

/**
 * 「終態」＝金錢／流程已完結，唔可以被「未完成」版本覆蓋。
 *
 * ⚠️ `reopened` **唔算**：返結之後張單仲喺度改，屬進行中。
 */
export const TERMINAL_ORDER_STATUSES: readonly string[] = [
  "settled",
  "refunded",
  "partially_refunded",
  "cancelled",
];

/** 呢個狀態係唔係終態。 */
export function isTerminalOrderStatus(status: unknown): boolean {
  return TERMINAL_ORDER_STATUSES.includes(String(status ?? "").trim());
}

/**
 * 合併兩批訂單（同一 id 只留一個）。
 *
 * @param base     現有（例如已 merge 嘅 state）
 * @param incoming 新到（例如本機 localStorage／雲端回應）
 */
export function mergeOrdersPreferTerminal<T extends MergeableOrder>(
  base: readonly T[],
  incoming: readonly T[],
): T[] {
  const map = new Map<string, T>();
  for (const order of base) map.set(order.id, order);
  for (const order of incoming) {
    const existing = map.get(order.id);
    if (!existing) {
      map.set(order.id, order);
      continue;
    }
    const baseTerminal = isTerminalOrderStatus(existing.status);
    const nextTerminal = isTerminalOrderStatus(order.status);
    if (baseTerminal && !nextTerminal) continue;
    if (nextTerminal && !baseTerminal) {
      map.set(order.id, order);
      continue;
    }
    const baseTs = Date.parse(existing.updatedAt ?? "") || 0;
    const nextTs = Date.parse(order.updatedAt ?? "") || 0;
    if (nextTs >= baseTs) map.set(order.id, order);
  }
  return [...map.values()];
}
