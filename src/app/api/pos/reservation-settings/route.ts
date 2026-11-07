import { NextResponse } from "next/server";

import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import {
  mapSettingsRow,
  toSettingsRow,
  type SettingsRow,
} from "@/lib/pos/reservation/row";
import { defaultReservationSettings, type ReservationSettings } from "@/lib/pos/reservation/types";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * `/api/pos/reservation-settings` —— 訂位設置讀寫（POS 與會員通後台共用）。
 *
 * | Method | 用途 |
 * |---|---|
 * | GET | 讀現況；未設定過回預設值（`exists:false`） |
 * | PUT | 整包覆寫（只保留白名單欄位） |
 *
 * ## 為什麼 GET 要回預設值而唔係 404
 *
 * 新店第一次入設置頁，UI 要即刻有嘢填。回 404 就要前端自己造一份預設，
 * 兩邊的預設值一定會慢慢漂移。
 *
 * ## 未跑 migration
 *
 * 表未建立 → PostgREST 回 `42P01` / `PGRST205` / `PGRST204`。
 * 呢種情況回 `tableReady:false`，UI 顯示「請先跑 migration」，唔會爆 500。
 */

export const dynamic = "force-dynamic";

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42P01" || code === "PGRST204" || code === "PGRST205") return true;
  const message = String(error.message ?? "");
  return (
    /relation .*pos_reservation/.test(message) ||
    /Could not find the table 'public\.pos_reservation/.test(message) ||
    /Could not find the '[^']*' column/.test(message)
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({
      ok: true,
      tableReady: false,
      exists: false,
      settings: defaultReservationSettings(storeId),
    });
  }

  // 🔒 放喺 early-return 之後：缺 storeId／未配置嘅回應完全不變
  const denied = posRouteAuthGuard(request, storeId, "pos/reservation-settings");
  if (denied) return denied;

  const { data, error } = await supabase
    .from("pos_reservation_settings")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({
        ok: true,
        tableReady: false,
        exists: false,
        settings: defaultReservationSettings(storeId),
      });
    }
    console.error("[pos/reservation-settings] 讀取失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({
      ok: true,
      tableReady: true,
      exists: false,
      settings: defaultReservationSettings(storeId),
    });
  }

  return NextResponse.json({
    ok: true,
    tableReady: true,
    exists: true,
    settings: mapSettingsRow(data as unknown as SettingsRow),
  });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const storeId = String(payload.storeId ?? "").trim();
  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "伺服器未配置 Supabase，無法儲存。" },
      { status: 503 },
    );
  }

  const denied = posRouteAuthGuard(request, storeId, "pos/reservation-settings");
  if (denied) return denied;

  const input = (payload.settings ?? {}) as Partial<ReservationSettings>;
  const row = toSettingsRow(storeId, input);

  // 最小一致性：最少人數不可大於最多人數
  if (Number(row.min_party_size) > Number(row.max_party_size)) {
    row.max_party_size = row.min_party_size;
  }

  const { data, error } = await supabase
    .from("pos_reservation_settings")
    .upsert(row, { onConflict: "store_id" })
    .select("*")
    .single();

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json(
        { ok: false, tableReady: false, error: "訂位資料表未建立，請先執行 migration 0077。" },
        { status: 503 },
      );
    }
    console.error("[pos/reservation-settings] 儲存失敗", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    tableReady: true,
    exists: true,
    settings: mapSettingsRow(data as unknown as SettingsRow),
  });
}
