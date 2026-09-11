/**
 * `pos_orders` 資料表 row（snake_case）→ 領域物件嘅共享映射。
 *
 * 之前呢個映射只存在於 `/api/pos/state`（收銀工作台嘅單一真源）。
 * admin panel（`/api/admin/orders`）需要同樣嘅映射嚟讀跨店訂單，
 * 所以抽出嚟共享——兩個 route 必須保持同一份映射，避免欄位漂移。
 */

export type PosOrderDbRow = {
  id: string;
  store_id?: string | null;
  local_order_no: string | null;
  table_id: string | null;
  table_name: string | null;
  status: string;
  fulfillment_status: string | null;
  sent_to_kitchen_at: string | null;
  served_at: string | null;
  items: unknown;
  order_note: string | null;
  subtotal: number;
  tax_amount: number;
  service_charge_amount: number;
  discount_amount: number;
  total: number;
  prepaid_amount: number;
  online_order_id: string | null;
  source?: string | null;
  party_size?: number | null;
  comp_note?: string | null;
  comped_at?: string | null;
  /** 全單折扣備註（0034 migration）。未跑 migration 嘅環境會係 undefined。 */
  discount_note?: string | null;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
};

/** `pos_orders` row → 領域物件。與 `/api/pos/state` 既有映射保持一致。 */
export function mapOrderRow(order: PosOrderDbRow) {
  return {
    id: order.id,
    storeId: order.store_id ?? undefined,
    localOrderNo: order.local_order_no,
    tableId: order.table_id,
    tableName: order.table_name,
    status: order.status,
    fulfillmentStatus: order.fulfillment_status ?? undefined,
    sentToKitchenAt: order.sent_to_kitchen_at ?? undefined,
    servedAt: order.served_at ?? undefined,
    items: Array.isArray(order.items) ? order.items : [],
    orderNote: order.order_note ?? undefined,
    subtotal: Number(order.subtotal ?? 0),
    taxAmount: Number(order.tax_amount ?? 0),
    serviceChargeAmount: Number(order.service_charge_amount ?? 0),
    discountAmount: Number(order.discount_amount ?? 0),
    total: Number(order.total ?? 0),
    prepaidAmount: Number(order.prepaid_amount ?? 0),
    onlineOrderId: order.online_order_id ?? undefined,
    // docs/87 §5.2：訂單來源（kiosk / scan / pos）。舊 migration 冇呢欄 → fallback "pos"。
    source: order.source ?? "pos",
    partySize: order.party_size == null ? undefined : Number(order.party_size),
    // 免單審計（docs/91 · 0018 migration）。未跑 migration 嘅環境會冇呢兩欄 → undefined。
    compNote: order.comp_note ?? undefined,
    compedAt: order.comped_at ?? undefined,
    // 全單折扣備註（0034 migration）。同 comp_note 一樣係結帳期審計欄位，
    // 唔落 items（單品折扣原因喺 items 內逐件存）。
    discountNote: order.discount_note ?? undefined,
    paymentMethod: order.payment_method ?? undefined,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}
