/**
 * 建立訂位 —— **唯一真源**。
 *
 * 兩個入口共用呢份邏輯：
 *   · `/api/pos/reservations` POST（店員代訂，要 POS 終端憑證）
 *   · `/api/public/reservations` POST（客人自助，匿名 + 限流）
 *
 * 🔴 唔好喺任何一邊自己再寫一次核價／校驗／RPC。
 *    「同一個業務規則有幾個入口，就會漏其中一個」係本專案高頻事故：
 *    配額、會員折扣、沽清校驗只要有一邊少做，客人就可以用匿名入口 bypass。
 *
 * ## 安全不變量（改呢個檔時唔可以破）
 * 1. **服務端核價**：前端只傳 `menuItemId / qty / specs`；價錢、菜名、折扣
 *    一律由 `pos_bootstrap_config` 現價重算，唔信任何 client 傳入嘅金額。
 * 2. **DB 原子扣配額**：`create_reservation()` 用 `pg_advisory_xact_lock`，
 *    route 完全唔參與「剩幾多組」嘅判斷，兩個客人同時提交都唔會超賣。
 * 3. **唔存在嘅菜直接拒絕**，唔可以靜靜收少幾道。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { sanitizeReservationItems } from "./items.ts";
import { priceReservationItems, type MenuItemLite } from "./pricing.ts";
import { mapReservationRow, type ReservationRow } from "./row.ts";
import type { PosReservation, ReservationSource } from "./types.ts";
import { validateReservationInput } from "./validate.ts";

export type CreateReservationPayload = {
  storeId: string;
  slotAt: string;
  partySize: number;
  guestName: string;
  guestPhone: string;
  guestNote?: string;
  items?: unknown;
  source?: string;
  memberId?: string | null;
  createdBy?: string | null;
  forceStatus?: string | null;
};

export type CreateReservationOptions = {
  /** 允許嘅來源白名單（匿名端應該只畀 `ledger`）。 */
  allowedSources: readonly ReservationSource[];
  defaultSource: ReservationSource;
  /** 只有 POS 端可以指定「自動確認 / 人工確認」；客人端一律由商家設定決定。 */
  allowForceStatus: boolean;
};

export type CreateReservationResult =
  | { ok: true; reservation: PosReservation }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
      tableReady?: boolean;
      rejected?: unknown[];
    };

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42P01" || code === "PGRST204" || code === "PGRST205") return true;
  const message = String(error.message ?? "");
  return /pos_reservation/.test(message) || /Could not find the '[^']*' column/.test(message);
}

/** RPC 例外 → HTTP 語意。 */
export function mapRpcFailure(message: string): { status: number; code: string; error: string } {
  if (/slot_full/.test(message)) {
    return { status: 409, code: "slot_full", error: "該時段已滿，請選擇其他時間。" };
  }
  if (/reservation_disabled/.test(message)) {
    return { status: 403, code: "disabled", error: "本店未開放訂位。" };
  }
  if (/party_size_out_of_range/.test(message)) {
    return { status: 400, code: "party_size", error: "人數超出可接受範圍。" };
  }
  if (/pos_reservations_dup_guard_uidx|duplicate key/i.test(message)) {
    return { status: 409, code: "duplicate", error: "同一位客人在此時段已有訂位。" };
  }
  return { status: 500, code: "unknown", error: message };
}

export async function createReservationRecord(
  supabase: SupabaseClient,
  payload: CreateReservationPayload,
  options: CreateReservationOptions,
): Promise<CreateReservationResult> {
  const storeId = payload.storeId;

  // ── 設置 ──────────────────────────────────────────────────────────────
  const { data: settingsRow, error: settingsError } = await supabase
    .from("pos_reservation_settings")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();

  if (settingsError) {
    if (isMissingTable(settingsError)) {
      return {
        ok: false,
        status: 503,
        code: "table_missing",
        error: "訂位資料表未建立，請先執行 migration 0077。",
        tableReady: false,
      };
    }
    return { ok: false, status: 500, code: "db_error", error: settingsError.message };
  }
  if (!settingsRow) {
    return { ok: false, status: 403, code: "disabled", error: "本店未開放訂位。" };
  }

  const settings = settingsRow as Record<string, unknown>;
  const serviceHours = (settings.service_hours ?? {}) as Record<string, { open: string; close: string }>;

  // ── 校驗（lead days / 時段 / 人數 / 姓名電話）────────────────────────
  const validated = validateReservationInput({
    settings: {
      serviceHours,
      minPartySize: Number(settings.min_party_size) || 1,
      maxPartySize: Number(settings.max_party_size) || 20,
      leadDaysMax: Number(settings.lead_days_max) || 14,
      leadMinutesMin: Number(settings.lead_minutes_min) || 0,
    },
    slotAt: String(payload.slotAt ?? ""),
    partySize: Number(payload.partySize),
    guestName: String(payload.guestName ?? ""),
    guestPhone: String(payload.guestPhone ?? ""),
    guestNote: String(payload.guestNote ?? ""),
  });

  if (!validated.ok) {
    return { ok: false, status: 400, code: validated.code, error: validated.message };
  }

  // ── 核價（服務端唯一真源）─────────────────────────────────────────────
  const { data: bootstrap, error: bootstrapError } = await supabase
    .from("pos_bootstrap_config")
    .select("menu_items,rules")
    .eq("store_id", storeId)
    .maybeSingle();

  if (bootstrapError) {
    console.error("[reservation/create] 讀取菜單失敗", bootstrapError.message);
  }

  const menuItems = ((bootstrap?.menu_items ?? []) as unknown as MenuItemLite[]) ?? [];
  const rules = (bootstrap?.rules ?? {}) as { memberDiscountRate?: number };
  const discountRate =
    typeof rules.memberDiscountRate === "number" && rules.memberDiscountRate > 0 && rules.memberDiscountRate < 100
      ? rules.memberDiscountRate
      : null;

  const priced = priceReservationItems({
    raw: sanitizeReservationItems(payload.items),
    menuItems,
    discountRate,
  });

  if (priced.rejected.length > 0) {
    return {
      ok: false,
      status: 400,
      code: "items_unavailable",
      error: "部分菜品已下架或無法預訂，請重新選擇。",
      rejected: priced.rejected,
    };
  }

  // ── 來源收緊 ──────────────────────────────────────────────────────────
  const requested = String(payload.source ?? "") as ReservationSource;
  const source: ReservationSource = options.allowedSources.includes(requested)
    ? requested
    : options.defaultSource;
  const forceStatus =
    options.allowForceStatus && (payload.forceStatus === "pending" || payload.forceStatus === "confirmed")
      ? String(payload.forceStatus)
      : null;

  // ── 建立（DB 原子扣配額）──────────────────────────────────────────────
  const { data: created, error: createError } = await supabase.rpc("create_reservation", {
    p_store_id: storeId,
    p_biz_date: validated.bizDate,
    p_slot_at: validated.slotAt.toISOString(),
    p_party_size: Math.trunc(Number(payload.partySize)),
    p_guest_name: String(payload.guestName ?? "").trim(),
    p_guest_phone: String(payload.guestPhone ?? "").trim(),
    p_guest_note: String(payload.guestNote ?? "").trim() || null,
    p_source: source,
    p_items: priced.items,
    p_items_subtotal: priced.totals.subtotal,
    p_discount_amount: priced.totals.discount,
    p_payable_amount: priced.totals.payable,
    p_member_id: payload.memberId ? String(payload.memberId) : null,
    p_member_discount_rate: discountRate,
    p_created_by: payload.createdBy ? String(payload.createdBy).slice(0, 60) : null,
    p_force_status: forceStatus,
  });

  if (createError) {
    if (isMissingTable(createError)) {
      return {
        ok: false,
        status: 503,
        code: "table_missing",
        error: "訂位資料表未建立，請先執行 migration 0077。",
        tableReady: false,
      };
    }
    const mapped = mapRpcFailure(createError.message);
    return { ok: false, ...mapped };
  }

  const row = (Array.isArray(created) ? created[0] : created) as ReservationRow | null;
  if (!row) return { ok: false, status: 500, code: "unknown", error: "建立訂位失敗。" };

  return { ok: true, reservation: mapReservationRow(row) };
}
