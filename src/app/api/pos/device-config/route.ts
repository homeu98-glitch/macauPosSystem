import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { normalizeDeviceConfig, normalizePosLocalSettings } from "@/lib/storage";

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!supabase) {
    return NextResponse.json({ ok: true, deviceConfig: null, localSettings: null });
  }

  // 舊版冇 store_id 過濾，攞嘅係「全平台 updated_at 最新一行」——多店環境會撈錯店（見 docs/98 問題二）。
  // 加咗選用 storeId 過濾：Hub 配對後帶自己嘅 storeId 嚟拎路由配置；web 端唔傳就維持舊行為。
  let query = supabase
    .from("pos_device_configs")
    .select("*")
    .order("updated_at", { ascending: false });
  if (storeId) query = query.eq("store_id", storeId);
  const { data, error } = await query.limit(1).maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    deviceConfig: data
      ? normalizeDeviceConfig({
          deviceId: data.device_id,
          terminalName: data.terminal_name,
          storeId: data.store_id,
          printers: Array.isArray(data.printers) ? data.printers : [],
          updatedAt: data.updated_at,
        })
      : null,
    localSettings: data?.local_settings ? normalizePosLocalSettings(data.local_settings) : null,
  });
}

export async function POST(request: Request) {
  const payload = await request.json();
  const supabase = getSupabaseServerClient();

  if (supabase && payload?.action !== "test-print") {
    const { error } = await supabase.from("pos_device_configs").upsert(
      {
        device_id: payload.deviceId,
        store_id: payload.storeId,
        terminal_name: payload.terminalName,
        printers: payload.printers,
        local_settings: payload.localSettings ?? null,
        updated_at: payload.updatedAt ?? new Date().toISOString(),
      },
      { onConflict: "device_id" },
    );

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    message: "已接收設備設定事件",
    receivedAt: new Date().toISOString(),
    payload,
  });
}
