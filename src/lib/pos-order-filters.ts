import { PosOrder } from "@/lib/types";
import { quickCompletionLabel } from "@/lib/quick-order-fulfillment";

export function isLocalPosOrder(order: PosOrder): boolean {
  return !order.onlineOrderId;
}

/**
 * 本地面板可見範圍：本地單 + 「已轉到堂食枱」嘅線上堂食單。
 * 純線上快餐 / 自取 / 外賣（counter / 無枱）屬上游 Ledger 對賬，唔喺本地面板管理，亦唔可以返結。
 * 美容同其他本地單無 onlineOrderId，一律當本地單。
 */
export function isLocalOrTransferredDineIn(order: PosOrder): boolean {
  if (!order.onlineOrderId) return true; // 本地單
  // 線上堂食單，已轉到枱（tableId 唔係 counter）→ 當本地單管理
  return !!order.tableId && order.tableId !== "counter";
}

/** 快餐 counter 單（先收款、後出餐流程） */
export function isQuickCounterOrder(order: PosOrder): boolean {
  return isLocalPosOrder(order) && order.tableId === "counter";
}

export function orderTimestamp(order: PosOrder): number {
  return Date.parse(order.updatedAt || order.createdAt || "") || 0;
}

/** 合併多份訂單列表，同 id 保留 updatedAt 較新者（防止雲端拉取覆蓋本機剛寫入的單） */
export function mergeOrderLists(...sources: PosOrder[][]): PosOrder[] {
  const byId = new Map<string, PosOrder>();
  for (const list of sources) {
    for (const order of list) {
      const existing = byId.get(order.id);
      if (!existing || orderTimestamp(order) >= orderTimestamp(existing)) {
        byId.set(order.id, order);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => orderTimestamp(b) - orderTimestamp(a));
}

export function isWithinLastMinutes(order: PosOrder, minutes: number, nowMs = Date.now()): boolean {
  const ts = orderTimestamp(order);
  if (!ts) return false;
  return ts >= nowMs - minutes * 60 * 1000;
}

function isTerminalLocalOrder(order: PosOrder): boolean {
  return (
    order.status === "cancelled" ||
    order.status === "refunded" ||
    order.status === "partially_refunded" ||
    order.status === "settled"
  );
}

/** 匯出：終態訂單狀態（已取消 / 已退款 / 部分退款 / 已完成）。backfill / realtime 合併時，
 * 伺服器單邊嘅終態單唔可以復活入活躍工作列表（見 docs/52）。 */
export function isTerminalOrderStatus(status: string | undefined): boolean {
  return (
    status === "cancelled" ||
    status === "refunded" ||
    status === "partially_refunded" ||
    status === "settled"
  );
}

/**
 * backfill / realtime 合併後嘅「防復活」過濾（見 docs/52）：
 *  - 本機已真刪除嘅訂單（deletedOrderIds tombstone）一律唔顯示；
 *  - 伺服器單邊嘅終態單（cancelled / refunded / partially_refunded / settled）唔可以復活入活躍列表，
 *    除非本機 localStorage 已經有佢（留返本地對賬 tab 睇）。
 * localOrders = 本地持久化 store（loadOrders()），用嚟判斷「本機已有」。
 */
export function filterResurrectedOrders(
  orders: PosOrder[],
  deletedOrderIds: string[],
  localOrders: PosOrder[],
): PosOrder[] {
  const deleted = new Set(deletedOrderIds);
  const localIds = new Set(localOrders.map((o) => o.id));
  return orders.filter(
    (o) => !deleted.has(o.id) && !(isTerminalOrderStatus(o.status) && !localIds.has(o.id)),
  );
}

/** 快餐點餐頁底部：所有未完成的 counter 單（不限時間） */
export function isActionableQuickOrder(order: PosOrder): boolean {
  if (!isQuickCounterOrder(order)) return false;
  if (isTerminalLocalOrder(order)) return false;
  if (order.status === "paid" && order.fulfillmentStatus === "ready") return true;
  return order.status === "draft" || order.status === "sent_to_kitchen" || order.status === "paid";
}

export function filterQuickActionBarOrders(orders: PosOrder[]): PosOrder[] {
  return orders.filter(isActionableQuickOrder).sort((a, b) => orderTimestamp(b) - orderTimestamp(a));
}

export function localOrderStatusLabel(order: PosOrder): string {
  if (isQuickCounterOrder(order)) {
    if (order.status === "paid" && order.fulfillmentStatus === "ready") {
      return quickCompletionLabel(order);
    }
    if (order.status === "paid" || order.status === "sent_to_kitchen") return "製作中";
  }
  if (order.status === "draft") return "點單中";
  if (order.status === "sent_to_kitchen") return "製作中";
  if (order.status === "paid" && order.fulfillmentStatus === "ready") return "待取餐";
  if (order.status === "paid") return "已付款";
  if (order.status === "settled") return "已完成";
  if (order.status === "reopened") return "已返結";
  if (order.status === "cancelled") return "已取消";
  if (order.status === "refunded" || order.status === "partially_refunded") return "已退款";
  return order.status;
}

export type LocalOrderPanelTab = "all" | "preparing" | "ready" | "settled" | "reopened" | "cancelled";

export function matchesLocalOrderPanelTab(order: PosOrder, tab: LocalOrderPanelTab): boolean {
  if (tab === "all") return true;
  if (tab === "settled") return order.status === "settled";
  if (tab === "reopened") return order.status === "reopened";
  if (tab === "cancelled") {
    return order.status === "cancelled" || order.status === "refunded" || order.status === "partially_refunded";
  }
  if (tab === "ready") {
    return isQuickCounterOrder(order) && order.status === "paid" && order.fulfillmentStatus === "ready";
  }
  if (tab === "preparing") {
    if (isQuickCounterOrder(order)) {
      return (
        order.status === "draft" ||
        order.status === "sent_to_kitchen" ||
        (order.status === "paid" && order.fulfillmentStatus !== "ready")
      );
    }
    return order.status === "draft" || order.status === "sent_to_kitchen";
  }
  return true;
}
