/** Raw row from `list_merchant_orders` or Realtime `orders` table. */
export type LedgerOrderRow = {
  id: string;
  status: string;
  total_avos?: number;
  pickup_code?: string | null;
  customer_phone?: string | null;
  customer_display_name?: string | null;
  note?: string | null;
  payment_mode?: string | null;
  payment_status?: string | null;
  paid_at?: string | null;
  fulfillment_type?: string | null;
  scheduled_pickup_at?: string | null;
  delivery_address_text?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  item_count?: number | null;
  first_item_name?: string | null;
  merchant_id?: string | null;
};

export type LedgerOrderTab = "all" | "dine_in" | "pickup" | "self_delivery";

export type LedgerOnlineOrder = {
  id: string;
  status: string;
  paymentStatus: "paid" | "unpaid";
  paymentMode?: string;
  paidAmount: number;
  customerName?: string;
  phone?: string;
  total: number;
  createdAt?: string;
  updatedAt?: string;
  fulfillmentType: string;
  tabType: Exclude<LedgerOrderTab, "all">;
  pickupCode?: string;
  deliveryAddress?: string;
  note?: string;
  itemSummary?: string;
  itemCount?: number;
};

export function mapFulfillmentToTab(fulfillmentType: string | null | undefined): Exclude<LedgerOrderTab, "all"> {
  const value = String(fulfillmentType ?? "").toLowerCase();
  if (value === "dine_in") return "dine_in";
  if (value === "takeaway") return "pickup";
  return "self_delivery";
}

export function tabLabel(tab: LedgerOrderTab): string {
  if (tab === "dine_in") return "堂食";
  if (tab === "pickup") return "外賣自取";
  if (tab === "self_delivery") return "外送";
  return "全部";
}

export function avosToMop(avos: number | null | undefined): number {
  return Math.round(Number(avos ?? 0)) / 100;
}

export function mapLedgerOrderRow(row: LedgerOrderRow): LedgerOnlineOrder {
  const fulfillmentType = String(row.fulfillment_type ?? "takeaway");
  const tabType = mapFulfillmentToTab(fulfillmentType);
  const itemCount = Number(row.item_count ?? 0);

  return {
    id: row.id,
    status: row.status,
    paymentStatus: row.payment_status === "paid" ? "paid" : "unpaid",
    paymentMode: row.payment_mode ?? undefined,
    paidAmount: avosToMop(row.total_avos),
    customerName: row.customer_display_name ?? undefined,
    phone: row.customer_phone ?? undefined,
    total: avosToMop(row.total_avos),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    fulfillmentType,
    tabType,
    pickupCode: row.pickup_code ?? undefined,
    deliveryAddress: row.delivery_address_text ?? undefined,
    note: row.note ?? undefined,
    itemSummary: row.first_item_name ?? undefined,
    itemCount: itemCount > 0 ? itemCount : undefined,
  };
}

export function mergeLedgerOrders(existing: LedgerOnlineOrder[], incoming: LedgerOnlineOrder[]): LedgerOnlineOrder[] {
  const map = new Map(existing.map((order) => [order.id, order]));
  for (const order of incoming) {
    map.set(order.id, order);
  }
  return Array.from(map.values()).sort((a, b) => {
    const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? "");
    const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? "");
    return bTime - aTime;
  });
}

export function computeSyncCursor(orders: LedgerOnlineOrder[]): { since: string | null; sinceId: string | null } {
  if (orders.length === 0) {
    return { since: null, sinceId: null };
  }

  let maxUpdatedAt = orders[0].updatedAt ?? orders[0].createdAt ?? null;
  let maxId = orders[0].id;

  for (const order of orders) {
    const updatedAt = order.updatedAt ?? order.createdAt;
    if (!updatedAt) continue;
    if (!maxUpdatedAt || Date.parse(updatedAt) > Date.parse(maxUpdatedAt)) {
      maxUpdatedAt = updatedAt;
      maxId = order.id;
      continue;
    }
    if (updatedAt === maxUpdatedAt && order.id > maxId) {
      maxId = order.id;
    }
  }

  return { since: maxUpdatedAt, sinceId: maxId };
}

export function normalizeLedgerStatus(status: string): "new" | "preparing" | "ready" | "delivering" | "completed" | "cancelled" {
  const value = String(status).toLowerCase();
  if (value.includes("cancel")) return "cancelled";
  if (value === "completed") return "completed";
  if (value === "ready") return "ready";
  if (value === "delivering") return "delivering";
  if (value === "accepted" || value === "preparing") return "preparing";
  return "new";
}

export function ledgerStatusLabel(status: string, fulfillmentType: string): string {
  const normalized = normalizeLedgerStatus(status);
  if (normalized === "cancelled") return "已取消";
  if (normalized === "completed") return "已完成";
  if (normalized === "delivering") return "配送中";
  if (normalized === "ready") {
    return fulfillmentType === "takeaway" ? "待取餐" : "待交付";
  }
  if (normalized === "preparing") return "製作中";
  return "新單";
}

export function orderCodeLabel(order: Pick<LedgerOnlineOrder, "id" | "pickupCode" | "tabType">): string {
  if (order.pickupCode) return `取餐碼 ${order.pickupCode}`;
  const suffix = order.id.slice(0, 8);
  if (order.tabType === "pickup") return `自取 ${suffix}`;
  if (order.tabType === "self_delivery") return `外送 ${suffix}`;
  if (order.tabType === "dine_in") return `堂食 ${suffix}`;
  return `線上單 ${suffix}`;
}
