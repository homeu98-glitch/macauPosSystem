import type { PosOrder } from "@/lib/types";

/**
 * 備註鎖定（docs/84）：備註內容喺「送出」嗰刻即固定，之後唔可以再改。
 *
 * 點解要鎖：
 *  1. 廚房單係送出當下嘅 snapshot（`buildKitchenPrintJobs` 行 `note: it.note`）。
 *     送出後改備註 → 廚房手上張單同螢幕唔一致，但唔會自動補印 → 廚房做錯菜。
 *  2. `pos_orders.items` 係 JSONB 整條存，改備註會連住寫入後台同收據，
 *     造成「後台改咗、廚房單冇改」嘅雙軌不一致。
 *  3. `itemIdentity()` = `menuItemId|specs|price|note`，**note 係 identity 一部分**。
 *     改已下單菜嘅 note → identity 變 → `orderedItemQtyMap` 搵唔返 →
 *     「已下單」標記消失、+/- 復活、退菜彈「尚未正式下單」。
 *
 * 鎖定時機（兩層，兩邊都係用同一個 predicate）：
 *  - 單品備註：菜品已喺一張 sent_to_kitchen 嘅單入面（baseOrderItems 有份）→ 鎖。
 *  - 全單備註：訂單 status 進入 sent_to_kitchen 或更後 → 鎖。
 *
 * 唔鎖（設計上要改得）：
 *  - `draft`：未送出。
 *  - `reopened`：返結帳，就係要改返。
 */

/** 全單備註被鎖定嘅訂單狀態。缺咗 draft / reopened（見上）。 */
export const NOTE_LOCKED_ORDER_STATUSES: ReadonlySet<PosOrder["status"]> = new Set<PosOrder["status"]>([
  "sent_to_kitchen",
  "paid",
  "settled",
  "cancelled",
  "partially_refunded",
  "refunded",
]);

export const ORDER_NOTE_LOCKED_MESSAGE = "訂單已送出，備註無法修改";
export const ITEM_SPEC_LOCKED_MESSAGE = "訂單已送出，規格無法修改";

/**
 * 全單備註係咪鎖定。冇單（workspaceOrder 為 null，即純 draft 車）→ 唔鎖。
 */
export function isOrderNoteLocked(order: Pick<PosOrder, "status"> | null | undefined): boolean {
  if (!order) return false;
  return NOTE_LOCKED_ORDER_STATUSES.has(order.status);
}
