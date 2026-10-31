/**
 * `pos_delivery_jobs` DB row → `PosDeliveryJob` 投影。
 *
 * 同 `pos-order-row.ts` 同一個教訓：**逐欄顯式複製**。
 * 漏抄一欄唔會 throw，只會令某個畫面靜靜冇咗資料（例如「已送達」時間）。
 *
 * 呢張表只經 server route 讀寫，所以 mapper 放喺 server 用到嘅 lib，
 * 但保持零 import（可以被 `node --test` 直接載入）。
 */

import type { DeliveryFeePaidBy, DeliveryJobStatus, PosDeliveryJob } from "./types.ts";

export type PosDeliveryJobRow = {
  id: string;
  store_id: string;
  order_source: string;
  order_ref: string;
  order_no_snapshot: string | null;
  platform: string | null;
  delivery_mode: string;
  provider: string;
  provider_order_id: string | null;
  ledger_dispatch_id: string | null;
  status: string;
  last_event: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  customer_lat: number | null;
  customer_lng: number | null;
  customer_note: string | null;
  fee_amount_avos: number | null;
  fee_paid_by: string | null;
  cod_amount_avos: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
};

const MODES = new Set(["platform", "merchant", "pickup", "unknown"]);
const STATUSES = new Set([
  "draft",
  "queued",
  "new",
  "accepted",
  "picked_up",
  "delivered",
  "canceled",
  "failed",
]);

/** 未知值一律收斂（唔好將 DB 嘅奇怪值直接漏去 UI）。 */
export function mapDeliveryJobRow(row: PosDeliveryJobRow): PosDeliveryJob {
  const mode = String(row.delivery_mode ?? "unknown");
  const status = String(row.status ?? "draft");
  const platform = String(row.platform ?? "");
  return {
    id: row.id,
    storeId: row.store_id,
    orderSource: row.order_source === "ledger" ? "ledger" : "pos",
    orderRef: row.order_ref,
    orderNoSnapshot: row.order_no_snapshot ?? "",
    platform: platform === "aomi" || platform === "mfood" ? platform : undefined,
    deliveryMode: (MODES.has(mode) ? mode : "unknown") as PosDeliveryJob["deliveryMode"],
    provider: "siteb",
    providerOrderId: row.provider_order_id ?? undefined,
    ledgerDispatchId: row.ledger_dispatch_id ?? undefined,
    status: (STATUSES.has(status) ? status : "draft") as DeliveryJobStatus,
    lastEvent: row.last_event ?? undefined,
    customerName: row.customer_name ?? undefined,
    customerPhone: row.customer_phone ?? undefined,
    customerAddress: row.customer_address ?? undefined,
    customerLat: row.customer_lat ?? undefined,
    customerLng: row.customer_lng ?? undefined,
    customerNote: row.customer_note ?? undefined,
    feeAmountAvos: Number(row.fee_amount_avos ?? 0),
    feePaidBy: (row.fee_paid_by === "customer" ? "customer" : "shop") as DeliveryFeePaidBy,
    codAmountAvos: Number(row.cod_amount_avos ?? 0),
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at ?? undefined,
  };
}
