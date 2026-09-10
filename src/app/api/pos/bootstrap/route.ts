import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeBootstrapPayload } from "@/lib/bootstrap-normalizer";
import { mockBootstrap } from "@/lib/mock-data";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * 「本店未開放線上點餐」 payload（2026-09-10 掃碼點餐審查 P1-5）。
 *
 * 舊版未知店 / Supabase 未配置一律回 `mockBootstrap`（示範店 macau-store-a 嘅菜式與店名）→
 * 客人掃碼見到 demo 餐牌，而且**可以真金白銀落單入真店**（錯菜、錯價、品牌事故）。
 * 家陣改為空餐牌 + `menuUnavailable: true`，前端顯示「餐牌準備中，請聯絡職員」並停用落單。
 */
function menuUnavailablePayload(storeId: string | null) {
  return normalizeBootstrapPayload({
    sourceVersion: 1,
    storeId: storeId ?? "",
    storeName: "",
    currency: "MOP",
    categories: [],
    menuItems: [],
    tables: [],
    rules: {},
    printerGroups: [],
    lastUpdatedAt: new Date().toISOString(),
    menuUnavailable: true,
  });
}

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  const ip = clientIp(request);
  if (!rateLimit(`pos-bootstrap:${ip}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  // 冇 storeId：保持舊行為（唯一用途係「未登入又未綁店」嘅內部呼叫，客人端一定會帶 storeId）。
  if (!storeId) {
    return NextResponse.json(normalizeBootstrapPayload(mockBootstrap));
  }

  if (!supabase) {
    // 未配置 DB：開發環境保留 mock（方便本機開發）；生產環境一律當「餐牌未開放」，
    // 唔可以將示範餐牌當真（P1-5）。
    return NextResponse.json(
      process.env.NODE_ENV === "production" ? menuUnavailablePayload(storeId) : { ...normalizeBootstrapPayload(mockBootstrap), storeId },
    );
  }

  const { data, error } = await supabase.from("pos_bootstrap_config").select("*").eq("store_id", storeId).maybeSingle();

  if (error || !data) {
    // 未知店 / 未同步餐牌 → 唔好露 demo 餐牌，回「餐牌未開放」
    return NextResponse.json(menuUnavailablePayload(storeId));
  }

  return NextResponse.json(
    normalizeBootstrapPayload({
      sourceVersion: data.source_version ?? 1,
      storeId: data.store_id,
      storeName: data.store_name,
      currency: data.currency,
      categories: data.categories,
      menuItems: data.menu_items,
      tables: data.tables,
      rules: data.rules,
      printerGroups: data.printer_groups,
      lastUpdatedAt: data.updated_at,
    }),
  );
}

/**
 * 上傳本店餐牌（收銀台「同步餐牌到雲端」call）。
 *
 * 2026-09-10 審查 P3-5：舊版**完全無鑑權**，任何人都可以 upsert 任意店嘅餐牌
 * （改價、落假菜）。家陣要求 POS 終端憑證（或 admin token），而且 storeId 必須同憑證一致。
 */
export async function POST(request: Request) {
  const ip = clientIp(request);
  if (!rateLimit(`pos-bootstrap-post:${ip}`, 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const payload = (await request.json().catch(() => null)) as
    | (Partial<{
        storeId: string;
        storeName: string;
        currency: string;
        categories: unknown;
        menuItems: unknown;
        tables: unknown;
        rules: unknown;
        printerGroups: unknown;
      }>)
    | null;

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }

  const storeId = String(payload.storeId ?? "").trim();
  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId。" }, { status: 400 });
  }

  // 授權：必須帶 POS 終端憑證（store 一致）或 admin session。
  const authEnforced = isPosDeviceAuthRequired();
  const deviceClaims = readPosDeviceTokenFromRequest(request);
  const adminClaims = readAdminSessionFromRequest(request);
  const authorized = !authEnforced || Boolean(adminClaims) || Boolean(deviceClaims && deviceClaims.storeId === storeId);
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "未經授權：需要 POS 終端憑證。" }, { status: 401 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 500 });
  }

  const updatedAt = new Date().toISOString();

  const { error } = await supabase.from("pos_bootstrap_config").upsert(
    {
      store_id: storeId,
      source_version: 1,
      store_name: payload.storeName ?? "澳門店",
      currency: payload.currency ?? "MOP",
      categories: payload.categories ?? [],
      menu_items: payload.menuItems ?? [],
      tables: payload.tables ?? [],
      rules: payload.rules ?? {},
      printer_groups: payload.printerGroups ?? [],
      updated_at: updatedAt,
    },
    { onConflict: "store_id" },
  );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, updatedAt });
}
