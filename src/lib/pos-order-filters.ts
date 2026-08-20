import { PosOrder } from "@/lib/types";
import { quickCompletionLabel } from "@/lib/quick-order-fulfillment";

export function isLocalPosOrder(order: PosOrder): boolean {
  return !order.onlineOrderId;
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
  if (order.status === "cancelled") return "已取消";
  if (order.status === "refunded" || order.status === "partially_refunded") return "已退款";
  return order.status;
}

export type LocalOrderPanelTab = "all" | "preparing" | "ready" | "settled" | "cancelled";

export function matchesLocalOrderPanelTab(order: PosOrder, tab: LocalOrderPanelTab): boolean {
  if (tab === "all") return true;
  if (tab === "settled") return order.status === "settled";
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
