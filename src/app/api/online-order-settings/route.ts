import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * 線上訂單設定（自動接單）= per-store 設定。
 *
 * 舊 bug：
 * - GET 冇 filter `store_id` → `.order(updated_at desc).limit(1)` 讀咗「全店最新一條（任何店）」，
 *   A 店會讀到 B 店嘅自動接單設定。
 * - POST 用 `payload?.storeId ?? "macau-store-a"`，但 POS client 從來冇傳 storeId
 *   → 所有店都寫落同一行 `macau-store-a`，互相覆蓋。
 *
 * 現行：client 必須帶 storeId（`loadAuthSession()?.merchantId`）。
 * 為兼容未更新嘅 caller，冇 storeId 時維持舊行為（唔 filter / 寫默認店），但所有
 * 已知 call site（online-orders.tsx / pos-app.tsx / device-settings.tsx）已帶 storeId。
 */
function readStoreIdFromSearch(request: Request): string | null {
  const { searchParams } = new URL(request.url);
  return searchParams.get("storeId")?.trim() || null;
}

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({
      ok: true,
      autoAccept: false,
    });
  }

  const storeId = readStoreIdFromSearch(request);

  let query = supabase.from("online_order_settings").select("*");
  if (storeId) {
    query = query.eq("store_id", storeId);
  }
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({
      ok: true,
      autoAccept: false,
    });
  }

  return NextResponse.json({
    ok: true,
    autoAccept: Boolean(data.auto_accept),
  });
}

export async function POST(request: Request) {
  const payload = await request.json();
  const supabase = getSupabaseServerClient();
  const storeId = typeof payload?.storeId === "string" && payload.storeId.trim()
    ? payload.storeId.trim()
    : null;

  if (supabase) {
    const { error } = await supabase.from("online_order_settings").upsert(
      {
        store_id: storeId ?? "macau-store-a",
        auto_accept: Boolean(payload?.autoAccept),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "store_id" },
    );

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    autoAccept: Boolean(payload?.autoAccept),
    updatedAt: new Date().toISOString(),
  });
}
