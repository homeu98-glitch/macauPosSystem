import { NextResponse } from "next/server";

import { KioskSettings } from "@/lib/pos/kiosk-settings";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { clientIp, rateLimit } from "@/lib/pos/rate-limit";

/**
 * 自助點餐設定（按店）。`pos_kiosk_settings` 表，0015 migration。
 *
 * 點解唔用 `pos_device_configs`：
 *   嗰張表嘅讀取係 `.order("updated_at", { ascending: false }).limit(1)` **冇 store filter**
 *   = 「全店最新一條（任何 terminal）」。用嚟存 per-store 設定一定會錯亂 ——
 *   同 `onlineOrderSettings.autoAccept` 嗰個 bug 同一個坑（見 docs/52）。
 * 所以呢條 route 嘅 GET **一定要帶 storeId filter**。
 *
 * 見 docs/87 §4.3。
 */

const DEFAULT_STORE_ID = "macau-store-a";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || DEFAULT_STORE_ID;

  // GET 保持開放（kiosk / 掃碼落單時讀一次，只暴露一個 boolean），但加基本限流。
  if (!rateLimit(`pos-kiosk-settings-get:${clientIp(request)}`, 120, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配 Supabase：唔好當錯誤，返預設（免確認），等 Kiosk 照樣落得到單（離線優先）
    return NextResponse.json({
      ok: true,
      fallback: true,
      settings: { storeId, selfOrderAutoAccept: true, updatedAt: null },
    });
  }

  const { data, error } = await supabase
    .from("pos_kiosk_settings")
    .select("store_id, self_order_auto_accept, updated_at")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    settings: {
      storeId,
      // 未設定過 → 用表嘅 default（true = 免確認直接出單，規格 5）
      selfOrderAutoAccept: data?.self_order_auto_accept ?? true,
      updatedAt: data?.updated_at ?? null,
    },
  });
}

export async function POST(request: Request) {
  // 2026-09-10 審查 P3-5：舊版 POST **完全無鑑權** —— 任何人都可以改全店接單行為
  // （例如偷偷關掉「自動接自助單」，令客人落單全部變待確認）。家陣要求 POS 終端憑證。
  const ip = clientIp(request);
  if (!rateLimit(`pos-kiosk-settings-post:${ip}`, 30, 60_000)) {
    return NextResponse.json({ ok: false, error: "請求過於頻繁，請稍後再試。" }, { status: 429 });
  }

  const payload = (await request.json().catch(() => null)) as Partial<KioskSettings> | null;
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "請求格式錯誤。" }, { status: 400 });
  }
  const storeId = String(payload?.storeId ?? "").trim() || DEFAULT_STORE_ID;
  const selfOrderAutoAccept = Boolean(payload?.selfOrderAutoAccept ?? true);

  const authEnforced = isPosDeviceAuthRequired();
  const deviceClaims = readPosDeviceTokenFromRequest(request);
  const adminClaims = readAdminSessionFromRequest(request);
  const authorized = !authEnforced || Boolean(adminClaims) || Boolean(deviceClaims && deviceClaims.storeId === storeId);
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "未經授權：需要 POS 終端憑證。" }, { status: 401 });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置，自助點餐設定無法保存到後台。" },
      { status: 503 },
    );
  }

  const { error } = await supabase.from("pos_kiosk_settings").upsert(
    {
      store_id: storeId,
      self_order_auto_accept: selfOrderAutoAccept,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id" },
  );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    settings: { storeId, selfOrderAutoAccept, updatedAt: new Date().toISOString() },
  });
}
