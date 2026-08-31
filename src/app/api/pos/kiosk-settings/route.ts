import { NextResponse } from "next/server";

import { KioskSettings } from "@/lib/pos/kiosk-settings";
import { getSupabaseServerClient } from "@/lib/supabase-server";

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
  const payload = (await request.json()) as Partial<KioskSettings>;
  const storeId = String(payload?.storeId ?? "").trim() || DEFAULT_STORE_ID;
  const selfOrderAutoAccept = Boolean(payload?.selfOrderAutoAccept ?? true);

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
