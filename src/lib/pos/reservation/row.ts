/**
 * DB row ↔ 前端型別 mapping —— 純函數，零依賴（可單測）。
 *
 * ⚠️ 加欄位時**兩邊都要改**：呢個檔 + migration。
 *    漏改 mapper 嘅症狀係「寫得入但讀唔出」（見 docs/113）。
 */

import type {
  PosReservation,
  ReservationItem,
  ReservationSettings,
  ReservationSource,
  ReservationStatus,
  ServiceHours,
} from "./types.ts";

/** `pos_reservations` 的 snake_case row。 */
export type ReservationRow = {
  id: string;
  store_id: string;
  code: string;
  biz_date: string;
  slot_at: string;
  party_size: number;
  guest_name: string | null;
  guest_phone: string | null;
  guest_note: string | null;
  status: string;
  source: string;
  table_id: string | null;
  table_name: string | null;
  order_id: string | null;
  order_no: string | null;
  items: unknown;
  items_subtotal: number | string | null;
  discount_amount: number | string | null;
  payable_amount: number | string | null;
  paid_amount: number | string | null;
  paid_at: string | null;
  payment_ref: string | null;
  payment_method: string | null;
  refund_amount: number | string | null;
  refunded_at: string | null;
  member_id: string | null;
  member_discount_rate: number | null;
  created_at: string;
  confirmed_at: string | null;
  arrived_at: string | null;
  seated_at: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  updated_at: string;
};

/** `pos_reservation_settings` 的 snake_case row。 */
export type SettingsRow = {
  store_id: string;
  enabled: boolean;
  notice: string | null;
  lead_days_max: number;
  lead_minutes_min: number;
  slot_interval_minutes: number;
  slot_quota: number;
  turn_minutes: number;
  min_party_size: number;
  max_party_size: number;
  large_party_threshold: number;
  auto_confirm: boolean;
  grace_minutes: number;
  cancel_cutoff_minutes: number;
  deposit_required: boolean;
  prepay_enabled: boolean;
  prepay_mode: string;
  deposit_amount: number | string | null;
  refund_cutoff_minutes: number;
  service_hours: unknown;
  updated_at: string;
};

function num(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function str(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

const STATUSES: readonly ReservationStatus[] = [
  "pending",
  "confirmed",
  "arrived",
  "seated",
  "completed",
  "canceled",
  "no_show",
  "waitlist",
];

/** 未知狀態一律當 `pending`（寧可顯示要人跟進，也不要靜靜消失）。 */
export function toReservationStatus(value: unknown): ReservationStatus {
  const s = String(value ?? "");
  return (STATUSES as readonly string[]).includes(s) ? (s as ReservationStatus) : "pending";
}

export function toReservationSource(value: unknown): ReservationSource {
  const s = String(value ?? "");
  return s === "ledger" || s === "phone" || s === "walkin" ? s : "pos";
}

/** items jsonb → 型別安全的陣列（逐項白名單，壞資料靜靜丟棄）。 */
export function parseReservationItems(raw: unknown): ReservationItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ReservationItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const menuItemId = typeof row.menuItemId === "string" ? row.menuItemId : "";
    if (!menuItemId) continue;
    const qty = Math.trunc(Number(row.qty) || 0);
    if (qty <= 0) continue;

    const specs: Record<string, string[]> = {};
    if (row.specs && typeof row.specs === "object" && !Array.isArray(row.specs)) {
      for (const [group, value] of Object.entries(row.specs as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          const ids = value.filter((v): v is string => typeof v === "string");
          if (ids.length > 0) specs[group] = ids;
        }
      }
    }

    out.push({
      menuItemId,
      name: typeof row.name === "string" ? row.name : "",
      specText: typeof row.specText === "string" ? row.specText : "",
      specs,
      qty,
      unitPrice: num(row.unitPrice as number | string | null),
      memberPrice:
        row.memberPrice === null || row.memberPrice === undefined
          ? null
          : num(row.memberPrice as number | string | null),
      discountRate:
        row.discountRate === null || row.discountRate === undefined
          ? null
          : num(row.discountRate as number | string | null),
      snapshotAt: typeof row.snapshotAt === "string" ? row.snapshotAt : new Date(0).toISOString(),
    });
  }
  return out;
}

export function mapReservationRow(row: ReservationRow): PosReservation {
  return {
    id: row.id,
    storeId: row.store_id,
    code: row.code,
    bizDate: row.biz_date,
    slotAt: row.slot_at,
    partySize: row.party_size,
    guestName: str(row.guest_name),
    guestPhone: str(row.guest_phone),
    guestNote: str(row.guest_note),
    status: toReservationStatus(row.status),
    source: toReservationSource(row.source),
    tableId: row.table_id,
    tableName: row.table_name,
    orderId: row.order_id,
    orderNo: row.order_no,
    items: parseReservationItems(row.items),
    itemsSubtotal: num(row.items_subtotal),
    discountAmount: num(row.discount_amount),
    payableAmount: num(row.payable_amount),
    paidAmount: num(row.paid_amount),
    paidAt: row.paid_at,
    paymentRef: row.payment_ref,
    paymentMethod: row.payment_method,
    refundAmount: num(row.refund_amount),
    refundedAt: row.refunded_at,
    memberId: row.member_id,
    memberDiscountRate: row.member_discount_rate,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    arrivedAt: row.arrived_at,
    seatedAt: row.seated_at,
    canceledAt: row.canceled_at,
    cancelReason: row.cancel_reason,
    updatedAt: row.updated_at,
  };
}

/** service_hours jsonb → 型別安全（只保留合法 HH:MM）。 */
export function parseServiceHours(raw: unknown): ServiceHours {
  const out: ServiceHours = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[1-7]$/.test(key)) continue;
    if (!value || typeof value !== "object") continue;
    const slot = value as Record<string, unknown>;
    const open = typeof slot.open === "string" ? slot.open : "";
    const close = typeof slot.close === "string" ? slot.close : "";
    if (!hm.test(open) || !hm.test(close)) continue;
    out[key] = { open, close };
  }
  return out;
}

export function mapSettingsRow(row: SettingsRow): ReservationSettings {
  const mode = row.prepay_mode === "deposit" ? "deposit" : "full";
  return {
    storeId: row.store_id,
    enabled: row.enabled === true,
    notice: str(row.notice),
    leadDaysMax: row.lead_days_max,
    leadMinutesMin: row.lead_minutes_min,
    slotIntervalMinutes: row.slot_interval_minutes,
    slotQuota: row.slot_quota,
    turnMinutes: row.turn_minutes,
    minPartySize: row.min_party_size,
    maxPartySize: row.max_party_size,
    largePartyThreshold: row.large_party_threshold,
    autoConfirm: row.auto_confirm === true,
    graceMinutes: row.grace_minutes,
    cancelCutoffMinutes: row.cancel_cutoff_minutes,
    depositRequired: row.deposit_required === true,
    prepayEnabled: row.prepay_enabled === true,
    prepayMode: mode,
    depositAmount: num(row.deposit_amount),
    refundCutoffMinutes: row.refund_cutoff_minutes,
    serviceHours: parseServiceHours(row.service_hours),
    updatedAt: row.updated_at,
  };
}

/** 前端傳嚟的設置 → DB row（只保留可控欄位，未知一律忽略）。 */
export function toSettingsRow(storeId: string, input: Partial<ReservationSettings>): SettingsRow {
  const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const intervalRaw = clampInt(input.slotIntervalMinutes, 30, 15, 60);
  const interval = [15, 30, 60].includes(intervalRaw) ? intervalRaw : 30;

  return {
    store_id: storeId,
    enabled: input.enabled === true,
    notice: typeof input.notice === "string" ? input.notice.slice(0, 2000) : "",
    lead_days_max: clampInt(input.leadDaysMax, 14, 1, 60),
    lead_minutes_min: clampInt(input.leadMinutesMin, 30, 0, 1440),
    slot_interval_minutes: interval,
    slot_quota: clampInt(input.slotQuota, 5, 1, 50),
    turn_minutes: clampInt(input.turnMinutes, 90, 30, 300),
    min_party_size: clampInt(input.minPartySize, 1, 1, 99),
    max_party_size: clampInt(input.maxPartySize, 20, 1, 99),
    large_party_threshold: clampInt(input.largePartyThreshold, 8, 1, 99),
    auto_confirm: input.autoConfirm !== false,
    grace_minutes: clampInt(input.graceMinutes, 15, 0, 120),
    cancel_cutoff_minutes: clampInt(input.cancelCutoffMinutes, 120, 0, 2880),
    deposit_required: input.depositRequired === true,
    prepay_enabled: input.prepayEnabled === true,
    prepay_mode: input.prepayMode === "deposit" ? "deposit" : "full",
    deposit_amount: Math.max(0, num(input.depositAmount)),
    refund_cutoff_minutes: clampInt(input.refundCutoffMinutes, 120, 0, 2880),
    service_hours: parseServiceHours(input.serviceHours ?? {}),
    updated_at: new Date().toISOString(),
  };
}

/** 狀態 → 是否仍算「進行中」（會佔用配額、要顯示在訂位台）。 */
export function isOpenReservation(status: ReservationStatus): boolean {
  return status === "pending" || status === "confirmed" || status === "arrived";
}

/** 狀態 → 可否取消。`seated` 之後走訂單流程，不可從訂位側取消。 */
export function canCancelReservation(status: ReservationStatus): boolean {
  return status === "pending" || status === "confirmed" || status === "arrived";
}

/** 狀態 → 可否標記到店（掃碼 / 手動）。 */
export function canMarkArrived(status: ReservationStatus): boolean {
  return status === "confirmed";
}

/** 狀態 → 可否入座開枱。 */
export function canSeat(status: ReservationStatus): boolean {
  return status === "arrived" || status === "confirmed";
}
