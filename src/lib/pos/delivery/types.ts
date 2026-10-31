/**
 * `pos_delivery_jobs` 嘅型別同狀態判斷。
 *
 * 表結構見 `supabase/migrations/0076_pos_delivery_jobs.sql`；
 * 判斷規則見 `./eligibility.ts`；平台配送方式見 `./delivery-mode.ts`。
 *
 * ⚠️ 呢張表**只經 server route 讀寫**，前端唔會直接 query，
 *    亦唔會訂閱 Realtime —— 避免多一條常駐 channel／polling。
 */

/** 對齊 SiteB 狀態；`draft` / `queued` 係 POS 本地階段。 */
export type DeliveryJobStatus =
  | "draft"
  | "queued"
  | "new"
  | "accepted"
  | "picked_up"
  | "delivered"
  | "canceled"
  | "failed";

export type DeliveryFeePaidBy = "shop" | "customer";

/** 進行中（未送達、未取消）—— 用嚟擋重複派單。 */
export const ACTIVE_JOB_STATUSES: readonly DeliveryJobStatus[] = [
  "draft",
  "queued",
  "new",
  "accepted",
  "picked_up",
];

export function isActiveJobStatus(status: unknown): boolean {
  return ACTIVE_JOB_STATUSES.includes(String(status ?? "") as DeliveryJobStatus);
}

/** 一筆派單紀錄（DB row 嘅 camelCase 投影）。 */
export type PosDeliveryJob = {
  id: string;
  storeId: string;
  orderSource: "ledger" | "pos";
  orderRef: string;
  orderNoSnapshot: string;
  platform?: "aomi" | "mfood";
  deliveryMode: "platform" | "merchant" | "pickup" | "unknown";
  provider: "siteb";
  providerOrderId?: string;
  ledgerDispatchId?: string;
  status: DeliveryJobStatus;
  lastEvent?: string;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  customerLat?: number;
  customerLng?: number;
  customerNote?: string;
  feeAmountAvos: number;
  feePaidBy: DeliveryFeePaidBy;
  codAmountAvos: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
};
