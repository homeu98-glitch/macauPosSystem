import { NextResponse } from "next/server";

import {
  isMissingColumnError,
  readNotePresets,
  writeNotePresets,
  type NotePresets,
} from "@/lib/note-presets-server";
import { getSupabaseServerClient, getSupabaseWriteClient } from "@/lib/supabase-server";

/**
 * 備註預設（按店）。`pos_note_presets` 表，0028 migration（折扣備註 = 0034）。
 *
 * 背景：備註預設（常用 / 免單 / 取消 / 折扣）以前塞喺 `pos_device_configs.local_settings`
 * JSONB，同 per-terminal 設定混埋一齊。但 pos_device_configs 以 device_id 為 primary key
 * （每台終端一行），而備註語意係全店共用 → 多台機同時改備註會各自寫自己嗰行，
 * 讀取端只拎 store_id「最新一條」，另一台機改動被靜默丟失（同 docs/52 autoAccept 同坑）。
 * 而家備註抽離做 per-store 真源：一店一行，store_id 係 primary key，天然唔會互蓋。
 *
 * 授權：同 kiosk-settings / shift / print-templates 一致 —— 寫入行 server service_role，
 * 讀取行 server client。storeId 由 client resolveStoreId()（登入 merchantId / kiosk 綁定）
 * 帶嚟，route 唔自行斷言「屬於邊間店」，同 /api/pos/state 嘅信任模型一致。
 *
 * 讀寫細節（含 0034 未跑時嘅 42703 降級）集中喺 `@/lib/note-presets-server`，兩個 route 共用。
 */

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

  const result = await readNotePresets(supabase, storeId);
  if (!result.ok) {
    // 真錯誤（網絡 / 權限）才 500。缺欄位（42703）已經喺 readNotePresets 內部降級處理。
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }

  if (!result.found) {
    // 未設定過 → found:false，client 保留本機（向後兼容舊店已設但未上傳嘅備註）
    return NextResponse.json({
      ok: true,
      found: false,
      presets: null,
      updatedAt: null,
    });
  }

  return NextResponse.json({
    ok: true,
    found: true,
    presets: result.presets,
    updatedAt: result.updatedAt,
    // 0034 未跑時為 false：client 可以藉此知道「折扣備註未上雲」，只留本機。
    discountNoteSynced: result.hasDiscountColumn,
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

  const result = await writeNotePresets(supabase, storeId, payload?.presets ?? {});
  if (!result.ok) {
    // 降級寫入（0034 未跑）都失敗 → 只有真錯誤才 5xx；缺欄位由 writeNotePresets 內部處理。
    const status = isMissingColumnError({ message: result.error }) ? 503 : 500;
    return NextResponse.json({ ok: false, error: result.error, detail: result.detail }, { status });
  }

  return NextResponse.json({
    ok: true,
    storeId,
    updatedAt: result.updatedAt,
    // false = 0034 未跑，只同步到三個舊槽位（折扣備註暫留本機）
    discountNoteSynced: result.discountNoteSynced,
  });
}
