import { NextResponse } from "next/server";

import { bizDateWindow, reservationBizDate } from "@/lib/pos/reservation/biz-date";
import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { mapSettingsRow, type SettingsRow } from "@/lib/pos/reservation/row";
import { buildDaySlots } from "@/lib/pos/reservation/slots";
import { defaultReservationSettings, type SlotUsage } from "@/lib/pos/reservation/types";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `/api/pos/reservations/slots` —— 某營業日的時段與餘量。
 *
 * | Query | 說明 |
 * |---|---|
 * | `storeId` | 必填 |
 * | `date` | 營業日 `YYYY-MM-DD`；省略 = 今日（澳門） |
 *
 * 回傳的 `slots[]` 已經算好 `remaining` / `full` / `past`，
 * 前端**只負責顯示**，唔好自己再計一次（兩套算法一定有一日對唔上）。
 */

export const dynamic = "force-dynamic";

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42P01" || code === "PGRST204" || code === "PGRST205") return true;
  const message = String(error.message ?? "");
  return /pos_reservation/.test(message) || /Could not find the '[^']*' column/.test(message);
}

/** 今日（澳門）的 `YYYY-MM-DD`。 */
function macauToday(now = new Date()): string {
  return reservationBizDate(now, {});
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;
  const date = searchParams.get("date")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: true, tableReady: false, slots: [] });
  }

  const denied = posRouteAuthGuard(request, storeId, "pos/reservations/slots");
  if (denied) return denied;

  const { data: settingsRow, error: settingsError } = await supabase
    .from("pos_reservation_settings")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();

  if (settingsError) {
    if (isMissingTable(settingsError)) {
      return NextResponse.json({ ok: true, tableReady: false, slots: [] });
    }
    return NextResponse.json({ ok: false, error: settingsError.message }, { status: 500 });
  }

  const settings = settingsRow
    ? mapSettingsRow(settingsRow as unknown as SettingsRow)
    : defaultReservationSettings(storeId);

  const today = macauToday();
  const bizDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;

  const window = bizDateWindow(bizDate, settings.serviceHours);
  if (!window) {
    return NextResponse.json({
      ok: true,
      tableReady: true,
      bizDate,
      slots: [],
      emptyReason: "no_service_hours",
    });
  }

  const { data: usageRows, error: usageError } = await supabase.rpc("reservation_slot_usage", {
    p_store_id: storeId,
    p_from: window.start.toISOString(),
    p_to: window.end.toISOString(),
  });

  if (usageError) {
    if (isMissingTable(usageError)) {
      return NextResponse.json({ ok: true, tableReady: false, slots: [] });
    }
    console.error("[pos/reservations/slots] 讀取用量失敗", usageError.message);
    return NextResponse.json({ ok: false, error: usageError.message }, { status: 500 });
  }

  const usage = ((usageRows ?? []) as Array<{ slot_at: string; used: number; guests: number }>).map(
    (row): SlotUsage => ({ slotAt: row.slot_at, used: Number(row.used) || 0, guests: Number(row.guests) || 0 }),
  );

  const slots = buildDaySlots({ bizDate, settings, usage });

  return NextResponse.json({
    ok: true,
    tableReady: true,
    bizDate,
    today,
    quota: settings.slotQuota,
    turnMinutes: settings.turnMinutes,
    intervalMinutes: settings.slotIntervalMinutes,
    enabled: settings.enabled,
    slots,
  });
}
