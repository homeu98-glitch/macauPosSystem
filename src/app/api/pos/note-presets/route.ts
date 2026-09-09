import { NextResponse } from "next/server";

import { getSupabaseServerClient, getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * 備註預設（按店）。`pos_note_presets` 表，0028 migration。
 *
 * 背景：備註預設（常用 / 免單 / 取消）以前塞喺 `pos_device_configs.local_settings`
 * JSONB，同 per-terminal 設定混埋一齊。但 pos_device_configs 以 device_id 為 primary key
 * （每台終端一行），而備註語意係全店共用 → 多台機同時改備註會各自寫自己嗰行，
 * 讀取端只拎 store_id「最新一條」，另一台機改動被靜默丟失（同 docs/52 autoAccept 同坑）。
 * 而家備註抽離做 per-store 真源：一店一行，store_id 係 primary key，天然唔會互蓋。
 *
 * 授權：同 kiosk-settings / shift / print-templates 一致 —— 寫入行 server service_role，
 * 讀取行 server client。storeId 由 client resolveStoreId()（登入 merchantId / kiosk 綁定）
 * 帶嚟，route 唔自行斷言「屬於邊間店」，同 /api/pos/state 嘅信任模型一致。
 */

export interface NotePresets {
  notePresets: string[];
  cancelNotePresets: string[];
  compNotePresets: string[];
}

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({
      ok: true,
      found: false,
      presets: null,
      updatedAt: null,
      reason: "no-store-id",
    });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配 Supabase：唔當錯誤 —— 返「無 server 記錄」，等 client 保留本地備註（離線優先）
    return NextResponse.json({
      ok: true,
      fallback: true,
      found: false,
      presets: null,
      updatedAt: null,
    });
  }

  const { data, error } = await supabase
    .from("pos_note_presets")
    .select("note_presets, cancel_note_presets, comp_note_presets, updated_at")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!data) {
    // 未設定過 → found:false，client 保留本機（向後兼容舊店已設但未上傳嘅備註）
    return NextResponse.json({
      ok: true,
      found: false,
      presets: null,
      updatedAt: null,
    });
  }

  const presets: NotePresets = {
    notePresets: normalizeArray(data.note_presets),
    cancelNotePresets: normalizeArray(data.cancel_note_presets),
    compNotePresets: normalizeArray(data.comp_note_presets),
  };

  return NextResponse.json({
    ok: true,
    found: true,
    presets,
    updatedAt: data.updated_at ?? null,
  });
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    storeId?: string;
    presets?: Partial<NotePresets>;
  } | null;
  const storeId = String(payload?.storeId ?? "").trim();

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId。" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置（缺 service role key），備註預設無法同步到後台。" },
      { status: 503 },
    );
  }

  // 一店一行 upsert：任何一部終端儲存都會覆寫該店備註（last-write-wins）。
  // 為咗唔好整份 replace 前剷走「呢次請求冇帶但 DB 已有」嘅槽位（理論上舊 client 只帶
  // 部分槽位），先讀返現有 row，missing 槽位用 DB 舊值補返再寫。
  const existingRes = await supabase
    .from("pos_note_presets")
    .select("note_presets, cancel_note_presets, comp_note_presets")
    .eq("store_id", storeId)
    .maybeSingle();

  if (existingRes.error) {
    return NextResponse.json({ ok: false, error: existingRes.error.message }, { status: 500 });
  }

  const old = existingRes.data;
  const notePresets = normalizeArray(payload?.presets?.notePresets ?? old?.note_presets);
  const cancelNotePresets = normalizeArray(payload?.presets?.cancelNotePresets ?? old?.cancel_note_presets);
  const compNotePresets = normalizeArray(payload?.presets?.compNotePresets ?? old?.comp_note_presets);

  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("pos_note_presets").upsert(
    {
      store_id: storeId,
      note_presets: notePresets,
      cancel_note_presets: cancelNotePresets,
      comp_note_presets: compNotePresets,
      updated_at: updatedAt,
    },
    { onConflict: "store_id" },
  );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    storeId,
    updatedAt,
  });
}
