import { NextResponse } from "next/server";

import { pushAutoAcceptToLedger } from "@/lib/ledger/auto-accept-sync";
import { getSupabaseServerClient } from "@/lib/supabase-server";

/**
 * 線上訂單設定（自動接單）= **per-store 設定，server 係真源**（docs/92）。
 *
 * ── 2026-08-31 重寫（docs/92）────────────────────────────────────────────
 * 舊版有三個問題：
 * 1. **真源放錯**：client 攞 localStorage 做權威真源，server 值從來冇被採用
 *    （`device-settings.tsx` 嗰段 GET 每個分支都 `return current`，係死 code）
 *    → Ledger 點改 POS 都唔會顯示。
 * 2. **讀寫錯表**：`online_order_settings` 呢個 repo 從來冇 migration 建立過，
 *    而且 GET 用 `.order("updated_at", desc).limit(1)` 而唔係按 PK 搵 ——
 *    對一張 per-store 設定表係錯寫法（同 `pos_device_configs` 嗰個
 *    「全店最新一條（任何 terminal）」bug 同一個坑，見 docs/52）。
 * 3. **冇 `updated_source`** → 做 POS ↔ Ledger 雙向同步嗰陣冇辦法防迴圈。
 *
 * 現行：
 * - 讀寫 **`pos_online_order_settings`**（0019 migration，PK `store_id`）。
 * - POST 成功後由 **server** 推去 Ledger（帶店員 Bearer，見 `auto-accept-sync.ts`）。
 * - Ledger 推過嚟嘅改動走 `/api/integration/ledger/auto-accept`，會寫 `updated_source='ledger'`，
 *   嗰條路**唔會**再推返去 Ledger（防迴圈）。
 * ────────────────────────────────────────────────────────────────────────
 */

const DEFAULT_STORE_ID = "macau-store-a";

function readStoreIdFromSearch(request: Request): string | null {
  const { searchParams } = new URL(request.url);
  return searchParams.get("storeId")?.trim() || null;
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
      updatedAt: null,
      updatedSource: null,
    });
  }

  const { data, error } = await supabase
    .from("pos_online_order_settings")
    .select("store_id, auto_accept, updated_at, updated_source")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    // 未設定過 → null（**唔係** false），等 client 知道「server 冇值，繼續用快取」
    autoAccept: typeof data?.auto_accept === "boolean" ? data.auto_accept : null,
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

  if (typeof payload.autoAccept !== "boolean") {
    return NextResponse.json({ ok: false, error: "autoAccept 必須係 boolean。" }, { status: 400 });
  }
  const autoAccept = payload.autoAccept;

  // client 可以話畀 server 知呢個改動由邊度嚟（一般唔使傳；入站 webhook 會自己寫 'ledger'）
  const source: "pos" | "ledger" = payload.source === "ledger" ? "ledger" : "pos";
  const token = typeof payload.ledgerAccessToken === "string" ? payload.ledgerAccessToken : null;
  const updatedBy = typeof payload.updatedBy === "string" ? payload.updatedBy : null;

  const supabase = getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, error: "Supabase 伺服器端未配置，自動接單設定無法保存到後台。" },
      { status: 503 },
    );
  }

  const updatedAt = new Date().toISOString();
  const { error } = await supabase.from("pos_online_order_settings").upsert(
    {
      store_id: storeId,
      auto_accept: autoAccept,
      updated_at: updatedAt,
      updated_source: source,
      updated_by: updatedBy,
    },
    { onConflict: "store_id" },
  );

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // 推去 Ledger（fire-and-forget：失敗唔 rollback POS 嘅改動，收銀掣要即刻有反應）
  const push = await pushAutoAcceptToLedger(storeId, autoAccept, token, source);
  if (!push.ok && process.env.NODE_ENV !== "production") {
    console.warn("[online-order-settings] push to Ledger failed:", push);
  }

  return NextResponse.json({
    ok: true,
    autoAccept,
    updatedAt,
    updatedSource: source,
    // 畀前端決定係唔係提示「已儲存，但 Ledger 未同步」
    ledgerSynced: push.ok,
  });
}
