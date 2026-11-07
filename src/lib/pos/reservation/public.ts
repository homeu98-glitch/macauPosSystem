/**
 * 客人端（匿名）專用嘅投影與讀取 helper。
 *
 * ## 🔴 呢度係唯一可以對外輸出訂位資料嘅地方
 *
 * `pos_reservations` 有客人姓名、電話、備註（個人資料），RLS 對 anon 全關，
 * 但 public API 用 service_role 讀 —— 即係**一定要自己遮罩**。
 * 唔可以貪方便直接 `mapReservationRow()` 成張掉出去：
 * 咁會連 `guestPhone`、`memberId`、`paymentRef`、`createdBy` 一齊送畀陌生人。
 *
 * 規則：
 *   · 電話一律遮罩（`2833 ****`）
 *   · 唔輸出 `memberId` / `paymentRef` / `refundRef` / 任何內部 id 以外嘅審計欄
 *   · 查單要 `訂位碼 + 電話尾 4 位` 雙因子，唔可以只憑可枚舉嘅訂位碼
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { mapSettingsRow, type SettingsRow } from "./row.ts";
import { defaultReservationSettings, type PosReservation, type ReservationSettings } from "./types.ts";

/** `+853 6612 3456` → `3456`。空白／太短 → 空字串（查單會被拒）。 */
export function phoneTail(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

/** `+853 6612 3456` → `**** 3456`（出紙／客人頁顯示用）。 */
export function maskPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  return `**** ${digits.slice(-4)}`;
}

/** 只輸出客人需要見到嘅欄位。 */
export function publicReservationView(row: PosReservation): Record<string, unknown> {
  return {
    code: row.code,
    status: row.status,
    bizDate: row.bizDate,
    slotAt: row.slotAt,
    partySize: row.partySize,
    guestName: row.guestName,
    guestPhoneMasked: maskPhone(row.guestPhone),
    guestNote: row.guestNote,
    tableName: row.tableName,
    items: row.items.map((item) => ({
      name: item.name,
      specText: item.specText,
      qty: item.qty,
      unitPrice: item.unitPrice,
      memberPrice: item.memberPrice,
    })),
    itemsSubtotal: row.itemsSubtotal,
    discountAmount: row.discountAmount,
    payableAmount: row.payableAmount,
    paidAmount: row.paidAmount,
    createdAt: row.createdAt,
    seatedAt: row.seatedAt,
  };
}

/** 對外公開嘅設定（唔好加內部管理欄位）。 */
export type PublicSettings = {
  enabled: boolean;
  notice: string;
  leadDaysMax: number;
  leadMinutesMin: number;
  minPartySize: number;
  maxPartySize: number;
  largePartyThreshold: number;
  slotIntervalMinutes: number;
  slotQuota: number;
  turnMinutes: number;
  autoConfirm: boolean;
  cancelCutoffMinutes: number;
  serviceHours: ReservationSettings["serviceHours"];
};

export function toPublicSettings(settings: ReservationSettings): PublicSettings {
  return {
    enabled: settings.enabled,
    notice: settings.notice,
    leadDaysMax: settings.leadDaysMax,
    leadMinutesMin: settings.leadMinutesMin,
    minPartySize: settings.minPartySize,
    maxPartySize: settings.maxPartySize,
    largePartyThreshold: settings.largePartyThreshold,
    slotIntervalMinutes: settings.slotIntervalMinutes,
    slotQuota: settings.slotQuota,
    turnMinutes: settings.turnMinutes,
    autoConfirm: settings.autoConfirm,
    cancelCutoffMinutes: settings.cancelCutoffMinutes,
    serviceHours: settings.serviceHours,
  };
}

export type PublicStoreInfo = {
  storeName: string;
  currency: string;
  /** 商家電話（客人查單頁「致電商家」用）；冇就空字串。 */
  storePhone: string;
  settings: ReservationSettings;
  exists: boolean;
  tableReady: boolean;
};

function missingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42P01" || code === "PGRST204" || code === "PGRST205") return true;
  const message = String(error.message ?? "");
  return /pos_reservation/.test(message) || /Could not find the '[^']*' column/.test(message);
}

/**
 * 一次過讀「公開設定 + 店名 + 商家電話」。
 * 未跑 migration → `tableReady:false`，前端顯示「本店尚未開放訂位」而唔係 500。
 */
export async function readPublicStoreInfo(
  supabase: SupabaseClient,
  storeId: string,
): Promise<PublicStoreInfo> {
  const [settingsRes, bootstrapRes] = await Promise.all([
    supabase.from("pos_reservation_settings").select("*").eq("store_id", storeId).maybeSingle(),
    supabase
      .from("pos_bootstrap_config")
      .select("store_name,currency,rules")
      .eq("store_id", storeId)
      .maybeSingle(),
  ]);

  const tableReady = !missingTable(settingsRes.error) && !missingTable(bootstrapRes.error);
  const settings = settingsRes.data
    ? mapSettingsRow(settingsRes.data as unknown as SettingsRow)
    : defaultReservationSettings(storeId);

  const bootstrap = (bootstrapRes.data ?? {}) as Record<string, unknown>;
  const rules = (bootstrap.rules ?? {}) as Record<string, unknown>;

  return {
    storeName: typeof bootstrap.store_name === "string" ? bootstrap.store_name : "",
    currency: typeof bootstrap.currency === "string" ? bootstrap.currency : "MOP",
    storePhone: typeof rules.storeTel === "string" ? String(rules.storeTel) : "",
    settings,
    exists: Boolean(settingsRes.data),
    tableReady,
  };
}
