import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * 線上訂單設定 = **per-store 鏡像**（docs/92 + 0036）。
 *
 * ── 2026-09-12 改（開關店）──────────────────────────────────────────────
 * 「開啟接單」(`merchant_enabled`) 同「自動接單」(`auto_accept`) 嘅**真源都已經係 Ledger**：
 * 店員 JWT 直連 RPC（`merchant_set_order_enabled` / `merchant_set_auto_accept`，
 * 見 `src/lib/ledger/order-config.ts`）。呢個 route 由「真源 + 出站推 Ledger」
 * 降級做**鏡像寫入**：
 *
 *   收銀撳掣 → RPC（Ledger，權威）→ 回傳整份 config
 *            → 前端將回傳值 POST 落呢度做鏡像
 *            → 0019 嘅 Realtime publication 廣播 → 其他收銀機即時跟住變
 *
 * ⚠️ 所以呢度**唔再**推去 Ledger（`pushAutoAcceptToLedger` 已退役）。以前兩條路
 *    （HTTP push 同 RPC）會寫同一個 Ledger 欄位，互相覆寫。
 *
 * ⚠️ 鏡像唔係權威：進頁面／回前景一律以 RPC 回傳覆蓋本表。
 *    Ledger 側（Ledger Web / 另一部 Android）改動唔會即時傳過嚟 —— Ledger 冇推播。
 *
 * ── 2026-08-31 原有設計（保留說明）──────────────────────────────────────
 * 舊版 client 攞 localStorage 做權威真源、server 值從來冇被採用（死 code）；
 * 而且讀寫一張呢個 repo 從來冇 migration 建立過嘅 `online_order_settings`，
 * GET 仲用 `.order("updated_at", desc).limit(1)` 而唔係按 PK 搵（同 docs/52 嘅
 * `pos_device_configs`「全店最新一條」係同一個坑）。現行讀寫 `pos_online_order_settings`（0019）。
 */

const DEFAULT_STORE_ID = "macau-store-a";

function readStoreIdFromSearch(request: Request): string | null {
  const { searchParams } = new URL(request.url);
  return searchParams.get("storeId")?.trim() || null;
}

/**
 * migration 0036 未上嘅窗口期：PostgREST 會報
 * `column pos_online_order_settings.merchant_enabled does not exist`。
 *
 * 呢個唔係「讀唔到設定」，而係「鏡像表未加欄」—— Ledger RPC（真源）照樣運作，
 * 唔應該令成個 GET 500。呢條 helper 令讀／寫都可以退返 0019 嘅舊欄位版本。
 */
function isMissingMerchantEnabledColumn(message: string | null | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes("merchant_enabled") && lower.includes("does not exist");
}

export async function GET(request: Request) {
  const storeId = readStoreIdFromSearch(request) ?? DEFAULT_STORE_ID;

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    // 未配 Supabase：唔好當錯誤，返「未同步」標記，等 client 繼續用 localStorage 快取（離線優先）
    return NextResponse.json({
      ok: true,
      fallback: true,
      autoAccept: null,
      merchantEnabled: null,
      updatedAt: null,
      updatedSource: null,
    });
  }

  const SUPABASE_COLUMNS = "store_id, auto_accept, merchant_enabled, updated_at, updated_source";

  let { data, error } = await supabase
    .from("pos_online_order_settings")
    .select(SUPABASE_COLUMNS)
    .eq("store_id", storeId)
    .maybeSingle();

  // 0036 未上：退返 0019 嘅欄位組合，唔好因為加咗鏡像欄而令自動接單都讀唔到
  if (error && isMissingMerchantEnabledColumn(error.message)) {
    ({ data, error } = await supabase
      .from("pos_online_order_settings")
      .select("store_id, auto_accept, updated_at, updated_source")
      .eq("store_id", storeId)
      .maybeSingle());
  }

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    // 未設定過 → null（**唔係** false），等 client 知道「server 冇值，繼續用快取」
    autoAccept: typeof data?.auto_accept === "boolean" ? data.auto_accept : null,
    merchantEnabled: typeof data?.merchant_enabled === "boolean" ? data.merchant_enabled : null,
    updatedAt: data?.updated_at ?? null,
    updatedSource: data?.updated_source ?? null,
  });
}

export async function POST(request: Request) {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body 格式錯誤。" }, { status: 400 });
  }

  const storeId =
    typeof payload.storeId === "string" && payload.storeId.trim()
      ? payload.storeId.trim()
      : DEFAULT_STORE_ID;

  // 兩個欄位都可以單獨鏡像：只傳一個就**唔可以**動另一個
  // （以前寫死要 autoAccept，會令「開關店」鏡像順手覆蓋自動接單設定）。
  const hasAutoAccept = typeof payload.autoAccept === "boolean";
  const hasMerchantEnabled = typeof payload.merchantEnabled === "boolean";
  if (!hasAutoAccept && !hasMerchantEnabled) {
    return NextResponse.json(
      { ok: false, error: "autoAccept 或 merchantEnabled 至少要有一個 boolean。" },
      { status: 400 },
    );
  }

  // client 可以話畀 server 知呢個改動由邊度嚟（一般唔使傳；入站 webhook 會自己寫 'ledger'）
  const source: "pos" | "ledger" = payload.source === "ledger" ? "ledger" : "pos";
  const updatedBy = typeof payload.updatedBy === "string" ? payload.updatedBy : null;

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置，接單設定無法鏡像到後台。" },
      { status: 503 },
    );
  }

  const updatedAt = new Date().toISOString();
  const row: Record<string, unknown> = {
    store_id: storeId,
    updated_at: updatedAt,
    updated_source: source,
    updated_by: updatedBy,
  };
  if (hasAutoAccept) row.auto_accept = payload.autoAccept;
  if (hasMerchantEnabled) row.merchant_enabled = payload.merchantEnabled;

  let { error } = await supabase
    .from("pos_online_order_settings")
    .upsert(row, { onConflict: "store_id" });

  // 0036 未上：剝走鏡像欄再試一次。自動接單（0019 已有）唔應該被連累寫唔到。
  let droppedMerchantEnabled = false;
  if (error && isMissingMerchantEnabledColumn(error.message) && "merchant_enabled" in row) {
    droppedMerchantEnabled = true;
    delete row.merchant_enabled;
    ({ error } = await supabase.from("pos_online_order_settings").upsert(row, { onConflict: "store_id" }));
  }

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    autoAccept: hasAutoAccept ? payload.autoAccept : null,
    // 欄位未加 → 明確講「今次寫唔到」，唔好靜靜當成功（否則跨機同步靜默失效）
    merchantEnabled: droppedMerchantEnabled
      ? null
      : hasMerchantEnabled
        ? payload.merchantEnabled
        : null,
    updatedAt,
    updatedSource: source,
    ...(droppedMerchantEnabled ? { warning: "merchant_enabled 欄未建立（需要跑 migration 0036）" } : {}),
  });
}
