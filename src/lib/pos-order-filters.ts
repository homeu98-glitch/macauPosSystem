import { PosOrder } from "@/lib/types";

/** 點餐頁底部操作列：線下單只顯示近 N 分鐘 */
export const POS_ACTION_BAR_LOCAL_MINUTES = 60;

export function isLocalPosOrder(order: PosOrder): boolean {
  return !order.onlineOrderId;
}

export function orderTimestamp(order: PosOrder): number {
  return Date.parse(order.updatedAt || order.createdAt || "") || 0;
}

export function isWithinLastMinutes(order: PosOrder, minutes: number, nowMs = Date.now()): boolean {
  const ts = orderTimestamp(order);
  if (!ts) return false;
  return ts >= nowMs - minutes * 60 * 1000;
}

export function isActionableLocalOrder(order: PosOrder): boolean {
  if (!isLocalPosOrder(order)) return false;
  if (order.status === "cancelled" || order.status === "refunded" || order.status === "partially_refunded") {
    return false;
  }
  if (order.status === "settled") return false;
  if (order.status === "paid" && order.fulfillmentStatus === "ready") {
    return true;
  }
  return order.status === "draft" || order.status === "sent_to_kitchen" || order.status === "paid";
}

export function filterActionBarLocalOrders(orders: PosOrder[], nowMs = Date.now()): PosOrder[] {
  return orders
    .filter(isActionableLocalOrder)
    .filter((order) => isWithinLastMinutes(order, POS_ACTION_BAR_LOCAL_MINUTES, nowMs))
    .sort((a, b) => orderTimestamp(b) - orderTimestamp(a));
}

export function localOrderStatusLabel(order: PosOrder): string {
  if (order.status === "draft") return "點單中";
  if (order.status === "sent_to_kitchen") return "製作中";
  if (order.status === "paid" && order.fulfillmentStatus === "ready") return "待取餐";
  if (order.status === "paid") return "已付款";
  if (order.status === "settled") return "已完成";
  if (order.status === "cancelled") return "已取消";
  if (order.status === "refunded" || order.status === "partially_refunded") return "已退款";
  return order.status;
}

export type LocalOrderStatusTab = "all" | "active" | "settled" | "cancelled";

export function matchesLocalStatusTab(order: PosOrder, tab: LocalOrderStatusTab): boolean {
  if (tab === "all") return true;
  if (tab === "active") {
    return (
      order.status !== "settled" &&
      order.status !== "cancelled" &&
      order.status !== "refunded" &&
      order.status !== "partially_refunded"
    );
  }
  if (tab === "settled") return order.status === "settled";
  if (tab === "cancelled") {
    return order.status === "cancelled" || order.status === "refunded" || order.status === "partially_refunded";
  }
  return true;
}
