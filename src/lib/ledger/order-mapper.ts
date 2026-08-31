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
  change_request_type?: string | null;
  change_request_status?: string | null;
  /**
   * 折扣欄位（defensive）：Ledger 後端未必有呢啲 key，但我哋先喺 type 預埋，
   * 等 Ledger 加咗對應 SQL view / column 時即刻可顯示。RPC 可能嘅常見命名：
   * `discount_avos` / `coupon_avos` / `promotion_avos` —— 任何一個有值都攞嚟做訂單折扣。
   * 詳見 docs/折扣 v2 §Ledger integration（TODO: 確認 Ledger schema 後可收窄）。
   */
  discount_avos?: number | null;
  coupon_avos?: number | null;
  promotion_avos?: number | null;
  /** 折扣前原價（list 顯示用，可選） */
  subtotal_avos?: number | null;
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
  /** 全單折扣金額（money，MOP）。null/0 = 冇折扣。從 Ledger `discount_avos` 等欄位攞。 */
  discountAmount?: number;
  /** 折扣前原價小計（money，MOP）。null = 未知。 */
  subtotalBeforeDiscount?: number;
  createdAt?: string;
  updatedAt?: string;
  fulfillmentType: string;
  tabType: Exclude<LedgerOrderTab, "all">;
  pickupCode?: string;
  deliveryAddress?: string;
  note?: string;
  itemSummary?: string;
  itemCount?: number;
  changeRequestType?: string;
  changeRequestStatus?: string;
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
  const total = avosToMop(row.total_avos);
  // 折扣讀取（defensive）：三個可能欄位都試，加總（如果 Ledger 同時設多個唔合理但安全）。
  const discountAvos = [row.discount_avos, row.coupon_avos, row.promotion_avos]
    .reduce<number>((sum, v) => sum + (Number.isFinite(Number(v)) && Number(v) != null ? Number(v) : 0), 0);
  const discountAmount = discountAvos > 0 ? Math.round(discountAvos) / 100 : undefined;
  // subtotal（折扣前）= total + discount；如果 Ledger 提供 subtotal_avos 就用佢。
  const subtotalBeforeDiscount = row.subtotal_avos != null
    ? Math.round(Number(row.subtotal_avos)) / 100
    : discountAmount != null
      ? Math.round((total + discountAmount) * 100) / 100
      : undefined;

  return {
    id: row.id,
    status: row.status,
    paymentStatus: row.payment_status === "paid" ? "paid" : "unpaid",
    paymentMode: row.payment_mode ?? undefined,
    paidAmount: total,
    customerName: row.customer_display_name ?? undefined,
    phone: row.customer_phone ?? undefined,
    total,
    discountAmount,
    subtotalBeforeDiscount,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    fulfillmentType,
    tabType,
    pickupCode: row.pickup_code ?? undefined,
    deliveryAddress: row.delivery_address_text ?? undefined,
    note: row.note ?? undefined,
    itemSummary: row.first_item_name ?? undefined,
    itemCount: itemCount > 0 ? itemCount : undefined,
    changeRequestType: row.change_request_type ?? undefined,
    changeRequestStatus: row.change_request_status ?? undefined,
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
  // 拆分 accepted vs preparing：舊寫法兩者都摺成「製作中」，
  // 令收銀分唔清「已接單但未開始做」同「製作中」。
  const raw = String(status).toLowerCase();
  if (raw === "accepted") return "已接單";
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

export function rawLedgerStatus(status: string): string {
  return String(status).toLowerCase();
}

export function paymentModeLabel(mode?: string): string {
  const value = String(mode ?? "").toLowerCase();
  if (value === "balance") return "餘額扣點";
  if (value === "in_store") return "到店付款";
  return mode ?? "--";
}

export function hasPendingCancelRequest(order: Pick<LedgerOnlineOrder, "changeRequestType" | "changeRequestStatus">): boolean {
  const type = String(order.changeRequestType ?? "").toLowerCase();
  const status = String(order.changeRequestStatus ?? "").toLowerCase();
  if (!type || !status) return false;
  if (status !== "pending" && status !== "requested") return false;
  return type === "cancel" || type.includes("cancel");
}

export function changeRequestLabel(order: Pick<LedgerOnlineOrder, "changeRequestType" | "changeRequestStatus">): string | null {
  if (!hasPendingCancelRequest(order)) return null;
  return "客人申請取消";
}
