import type { PosOrder } from "../types";

/**
 * **客人端**嘅訂單狀態文案（掃碼「本枱訂單」頁顯示「下單狀態」用）。
 *
 * 用客人聽得明嘅講法，唔好直接露 DB 枚舉值（`sent_to_kitchen` / `partially_refunded` …）。
 *
 * 刻意同收銀端嘅 `pos-order-filters.ts` 狀態標籤分開：嗰邊係**職員**睇嘅營運看板文案
 * （「待處理 / 製作中 / 待取餐」），呢邊係**客人**睇嘅（「已送出 · 待店員確認」）。
 * 兩者受眾同語境唔同，唔應該互相 import。
 *
 * 純函式、零依賴（只讀 `PosOrder` 兩個欄位）→ 可單元測試（`npm run test`）。
 */
export function customerOrderStatusLabel(
  order: Pick<PosOrder, "status" | "fulfillmentStatus">,
): string {
  // 未經店員確認（pos_kiosk_settings 嘅「自動接自助單」熄咗）：
  // 客人需要知「我已經送出，但店員未撳確認」，唔係「已落單」。
  if (order.status === "draft") return "已送出 · 待店員確認";

  // 出餐狀態優先於單據狀態：已標記可取餐 / 製作中，對客人嚟講比「已送廚房」有用。
  if (order.fulfillmentStatus === "ready") return "可取餐";
  if (order.status === "sent_to_kitchen") {
    return order.fulfillmentStatus === "preparing" ? "製作中" : "已送廚房";
  }

  if (order.status === "paid") return "已付款";
  if (order.status === "settled") return "已完成";
  if (order.status === "cancelled") return "已取消";
  if (order.status === "refunded") return "已退款";
  if (order.status === "partially_refunded") return "部分退款";
  // `reopened`（返結後重新開單）同任何未知值：當「進行中」處理，唔好露出內部枚舉。
  return "進行中";
}
