import { loadOrders, loadQueue, saveOrders, saveQueue } from "@/lib/storage";
import { PosOrder, QueueEvent } from "@/lib/types";
import { readNetworkOnline } from "@/lib/use-network-online";

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function quickCompletionLabel(order: Pick<PosOrder, "tableName">) {
  if (order.tableName === "自取") return "待取餐";
  if (order.tableName === "外賣") return "待交付";
  return "待出餐";
}

export function quickCompleteLabel(order: Pick<PosOrder, "tableName">) {
  if (order.tableName === "外賣") return "已交付";
  if (order.tableName === "自取") return "已取餐";
  return "已完成";
}

function persistOrderUpdate(nextOrders: PosOrder[], event: QueueEvent) {
  saveOrders(nextOrders);
  const queue = loadQueue();
  saveQueue([event, ...queue]);
}

export function updateQuickFulfillmentInStore(
  orderId: string,
  nextStatus: "preparing" | "ready",
): PosOrder | null {
  const orders = loadOrders();
  const target = orders.find((order) => order.id === orderId) ?? null;
  if (!target || target.tableId !== "counter" || target.status !== "paid") return null;

  const updatedAt = new Date().toISOString();
  const updatedOrder: PosOrder = { ...target, fulfillmentStatus: nextStatus, updatedAt };
  const nextOrders = orders.map((order) => (order.id === orderId ? updatedOrder : order));
  persistOrderUpdate(nextOrders, {
    id: uid("evt"),
    type: "ORDER_UPDATED",
    entityId: updatedOrder.id,
    payload: { order: updatedOrder, action: nextStatus === "ready" ? "ready" : "preparing" },
    status: readNetworkOnline() ? "synced" : "pending",
    createdAt: updatedAt,
  });
  return updatedOrder;
}

export function markQuickOrderCompletedInStore(
  orderId: string,
  options?: { label?: string },
): PosOrder | null {
  const orders = loadOrders();
  const target = orders.find((order) => order.id === orderId) ?? null;
  if (!target || target.tableId !== "counter") return null;

  const updatedAt = new Date().toISOString();
  const updatedOrder: PosOrder = {
    ...target,
    status: "settled",
    fulfillmentStatus: "ready",
    updatedAt,
  };
  const nextOrders = orders.map((order) => (order.id === orderId ? updatedOrder : order));
  persistOrderUpdate(nextOrders, {
    id: uid("evt"),
    type: "ORDER_UPDATED",
    entityId: updatedOrder.id,
    payload: { order: updatedOrder, action: "completed", label: options?.label ?? "已完成" },
    status: readNetworkOnline() ? "synced" : "pending",
    createdAt: updatedAt,
  });
  return updatedOrder;
}
