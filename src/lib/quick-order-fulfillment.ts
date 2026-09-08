import { loadOrders, loadQueue, saveOrders, saveQueue } from "@/lib/storage";
import { PosOrder, QueueEvent } from "@/lib/types";
import { notifyQueueChanged, withStoreScope } from "@/lib/pos/sync-flush";
import { enqueueEvents } from "@/lib/pos/queue-outbox";

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
  // 🛡️ 跨店隔離 L1：只 stamp 新建事件，舊 queue 原封不動。
  // docs/111：入隊取代 flush 去重（順序改成 append，flush 會按 createdAt 升序推送）。
  saveQueue(enqueueEvents(queue, withStoreScope([event])));
  // 入隊即觸發 flush worker。以前完全冇 trigger，要等 30s interval 或者
  // 別處嘅操作偶然 trigger 先上到雲。
  notifyQueueChanged();
}

export function updateQuickFulfillmentInStore(orderId: string): PosOrder | null {
  const orders = loadOrders();
  const target = orders.find((order) => order.id === orderId) ?? null;
  // docs/87 §6.3：放寬閘門，容許「先出餐後付款」——自助點餐單可能係 sent_to_kitchen 就標記 ready
  const allowedStatuses = new Set<PosOrder["status"]>(["draft", "sent_to_kitchen", "paid"]);
  if (!target || target.tableId !== "counter" || !allowedStatuses.has(target.status)) return null;

  const updatedAt = new Date().toISOString();
  const updatedOrder: PosOrder = { ...target, fulfillmentStatus: "ready", updatedAt };
  const nextOrders = orders.map((order) => (order.id === orderId ? updatedOrder : order));
  persistOrderUpdate(nextOrders, {
    id: uid("evt"),
    type: "ORDER_UPDATED",
    entityId: updatedOrder.id,
    payload: { order: updatedOrder, action: "ready" },
    // docs/111：以前線上時寫 "synced" 但**從來冇 push**過（靠 legacyHealed 首次 flush
    // 撞彩先上到雲）。一律 pending，交畀 outbox 推送 —— 上到雲先算數。
    status: "pending",
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
    servedAt: target.servedAt ?? updatedAt,
    updatedAt,
  };
  const nextOrders = orders.map((order) => (order.id === orderId ? updatedOrder : order));
  persistOrderUpdate(nextOrders, {
    id: uid("evt"),
    type: "ORDER_UPDATED",
    entityId: updatedOrder.id,
    payload: { order: updatedOrder, action: "completed", label: options?.label ?? "已完成" },
    // 同上（docs/111）：一律 pending，由 outbox 負責推送。
    status: "pending",
    createdAt: updatedAt,
  });
  return updatedOrder;
}
