import { NextResponse } from "next/server";

import { PrintTemplates } from "@/lib/types";
import { getSupabaseServerClient, getSupabaseWriteClient } from "@/lib/supabase-server";
import { normalizePrintTemplateSet } from "@/lib/storage";

/**
 * 打印模板（按店）。`pos_print_templates` 表，0027 migration。
 *
 * 背景（docs/71 擱置嘅 "push seam" 落地）：print-center 以前淨係寫 localStorage
 * （`macau-pos/stores/{storeId}/local-settings` → printTemplates），從未 POST 後台，
 * 令模板跨終端各自為政、新終端入打印頁永遠只見到 local default。而家模板喺呢度做
 * per-store 真源：GET 進入打印頁即拉，POST 儲存即上傳。
 *
 * 點解唔用 `pos_device_configs`：嗰張表嘅讀取係 `.order("updated_at", { ascending: false })
 * .limit(1)` **冇 store filter** = 「全店最新一條（任何 terminal）」，用嚟存 per-store
 * 設定一定會錯亂（同 docs/52 autoAccept 同一個坑）。所以模板獨立一張 `pos_print_templates`，
 * store_id 係 primary key → 一店一行，天然唔會互蓋。
 *
 * 授權：同 kiosk-settings / shift 一致 —— 寫入行 server service_role（0016/0023 已將
 * 業務表收做 service_role-only + revoke anon），讀取行 server client。storeId 由 client
 * resolveStoreId()（登入 merchantId / kiosk 綁定）帶嚟，route 唔自行斷言「屬於邊間店」，
 * 同 /api/pos/state 嘅信任模型一致（店舖 scope 由上游 auth 層決定）。
 */

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!storeId) {
    return NextResponse.json({
      ok: true,
      found: false,
      templates: null,
      updatedAt: null,
      reason: "no-store-id",
    });
  }

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配 Supabase：唔好當錯誤 —— 返「無 server 記錄」，等 client 保留本地模板（離線優先）
    return NextResponse.json({
      ok: true,
      fallback: true,
      found: false,
      templates: null,
      updatedAt: null,
    });
  }

  const { data, error } = await supabase
    .from("pos_print_templates")
    .select("receipt, label, kitchen, kiosk, updated_at")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  if (!data) {
    // 未設定過 → found:false，client 保留本機（向後兼容舊店已設計但未上傳嘅模板）
    return NextResponse.json({
      ok: true,
      found: false,
      templates: null,
      updatedAt: null,
    });
  }

  // 用同 client 一致嘅 normalize：舊 DB 記錄缺新 section（例如 divider / qrSize）都唔會
  // 被當成權威蓋走預設 —— normalize 會補返預設 + 保留已存嘅用戶設定。
  const templates = normalizePrintTemplateSet({
    receipt: data.receipt,
    label: data.label,
    kitchen: data.kitchen,
    kiosk: data.kiosk,
  });

  return NextResponse.json({
    ok: true,
    found: true,
    templates,
    updatedAt: data.updated_at ?? null,
  });
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as {
    storeId?: string;
    templates?: Partial<PrintTemplates>;
  } | null;
  const storeId = String(payload?.storeId ?? "").trim();

  if (!storeId) {
    return NextResponse.json({ ok: false, error: "缺少 storeId。" }, { status: 400 });
  }

  const templates = normalizePrintTemplateSet(payload?.templates ?? null);

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置（缺 service role key），打印模板無法同步到後台。" },
      { status: 503 },
    );
  }

  // 一店一行 upsert：任何一部終端儲存都會覆寫該店模板（last-write-wins）。
  // 為咗唔好整份 replace 前剷走「呢次請求冇帶但 DB 已有」嘅槽位（理論上舊 client 只帶
  // 部分槽位），先讀返現有 row，missing 槽位用 DB 舊值補返再寫。
  const existingRes = await supabase
    .from("pos_print_templates")
    .select("receipt, label, kitchen, kiosk")
    .eq("store_id", storeId)
    .maybeSingle();

  if (existingRes.error) {
    return NextResponse.json({ ok: false, error: existingRes.error.message }, { status: 500 });
  }

  const old = existingRes.data;
  const merged = normalizePrintTemplateSet({
    receipt: payload?.templates?.receipt ?? old?.receipt,
    label: payload?.templates?.label ?? old?.label,
    kitchen: payload?.templates?.kitchen ?? old?.kitchen,
    kiosk: payload?.templates?.kiosk ?? old?.kiosk,
  });

  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("pos_print_templates").upsert(
    {
      store_id: storeId,
      receipt: merged.receipt as unknown as object,
      label: merged.label as unknown as object,
      kitchen: merged.kitchen as unknown as object,
      kiosk: merged.kiosk as unknown as object,
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
