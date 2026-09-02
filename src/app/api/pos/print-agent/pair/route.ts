// POST /api/pos/print-agent/pair — Android Hub 用 POS 登入號碼（phone + PIN）拎到嘅 merchantId 自註冊配對。
// GET  /api/pos/print-agent/pair?agentId= — APK 每 3s 輪詢，未配對 → pending，已配對 → 返凭證。
// 合約見 docs/96 §8，APK 客戶端喺 print hub RelayApi.pollPair()。
//
// 【點解 storeId 要驗真】
// pos_print_agents.store_id 冇 FK 去 merchants（0020 migration），而 storeId 係由 client 傳入。
// 如果傳咗假嘢（例如 docs 舊範例嘅 "macau-store-a"），配對會「成功」、/pair-status 會話已配對，
// 但 Realtime filter `store_id=eq.<真 merchant UUID>` 永遠唔 match、claim 返 0 列 →
// 「配咗對但一張都印唔出」呢種最難 debug 嘅 silent failure。所以呢度要擋。
import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { loadPairedAgent, sha256Hex } from "@/lib/print-agent-server";

export const dynamic = "force-dynamic";

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 假店黑名單：呢啲係 mock / 範例值，一見即擋（唔使靠 DB 查詢，零基建風險）。 */
const PLACEHOLDER_STORE_IDS = new Set([
  "macau-store-a",
  "macau-store-b",
  "store-a",
  "store-b",
  "default",
  "demo",
  "test",
]);

/** PostgREST / Postgres「表唔存在或無權限」類錯誤碼 —— 呢啲係基建問題，應該 warn 而唔係擋配對。 */
const INFRA_ERROR_CODES = new Set(["42P01", "42501", "42703", "PGRST205", "PGRST301", "PGRST202"]);

/**
 * `22P02` = invalid text representation，即 storeId 嘅型別根本唔係 `merchants.id`（UUID）。
 * 呢個係「肯定唔係商戶」嘅鐵證，唔係基建問題，所以要當 missing 擋低。
 */
const INVALID_TYPE_CODES = new Set(["22P02"]);

type MerchantLookup =
  | { kind: "found"; name: string | null }
  | { kind: "missing" } // 表讀到，但呢個 id 唔存在 → 要擋
  | { kind: "unknown" }; // 表讀唔到（基建問題）→ 放行，只 log

/**
 * 查 `merchants` 表確認 storeId 係真商戶。
 * fail-open 只限基建錯誤（表唔存在 / 無權限），確保唔會因為環境問題誤殺所有配對。
 */
async function lookupMerchant(
  supabase: NonNullable<ReturnType<typeof getSupabaseWriteClient>>,
  storeId: string,
): Promise<MerchantLookup> {
  const { data, error } = await supabase
    .from("merchants")
    .select("id, name")
    .eq("id", storeId)
    .limit(1)
    .maybeSingle();

  if (error) {
    const code = String((error as { code?: string }).code ?? "");
    if (INVALID_TYPE_CODES.has(code)) {
      // storeId 型別唔夾 merchants.id（UUID）→ 鐵定唔係商戶 ID
      return { kind: "missing" };
    }
    if (INFRA_ERROR_CODES.has(code)) {
      console.warn(
        `[print-agent/pair] 無法驗真 storeId（merchants 表唔可讀，code=${code}），放行。msg=${error.message}`,
      );
      return { kind: "unknown" };
    }
    console.error(`[print-agent/pair] merchants 查詢失敗 code=${code}:`, error.message);
    return { kind: "unknown" };
  }
  if (!data) return { kind: "missing" };
  return { kind: "found", name: (data as { name?: string | null }).name ?? null };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = (searchParams.get("agentId") ?? "").trim();
  if (!agentId) {
    return NextResponse.json({ status: "pending" });
  }
  const agent = await loadPairedAgent(agentId);
  if (!agent || agent.revokedAt) {
    return NextResponse.json({ status: "pending" });
  }
  // supabaseUrl / anonKey 由 server 落（唔 hardcode 喺 APK），APK 用嚟訂閱 Realtime 拎單。
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
  return NextResponse.json({
    status: "paired",
    storeId: agent.storeId,
    storeName: agent.storeName,
    supabaseUrl: url,
    anonKey,
  });
}

export async function POST(request: Request) {
  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    agentId?: string;
    token?: string;
    storeId?: string;
    name?: string;
  };
  const agentId = (body.agentId ?? "").trim();
  const token = (body.token ?? "").trim();
  const storeId = (body.storeId ?? "").trim();
  const name = (body.name ?? "").trim();

  if (!agentId || !token || !storeId) {
    return NextResponse.json({ ok: false, error: "缺少 agentId / token / storeId" }, { status: 400 });
  }
  // storeId 容許字元（對齊 sync route 既有限制，防 path 注入）
  if (!STORE_ID_PATTERN.test(storeId) || storeId.length > 64) {
    return NextResponse.json({ ok: false, error: "storeId 格式不合法" }, { status: 400 });
  }

  // ── 1) 假店黑名單：mock / 範例值一見即擋（零 DB 依賴）──
  if (PLACEHOLDER_STORE_IDS.has(storeId.toLowerCase())) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "storeId 係範例用的假店名，不能用於配對。請改用 Android 中繼機以 POS 登入號碼（電話 + PIN）登入後自動取得的店舖識別。",
      },
      { status: 400 },
    );
  }

  // ── 2) 驗真：storeId 必須對應真實商戶（防「配咗對但印唔出」）──
  const merchant = await lookupMerchant(supabase, storeId);
  if (merchant.kind === "missing") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "storeId 唔對應任何商戶，配對會變成「顯示已連線但印唔出單」。請確認 Android 中繼機已用正確的 POS 登入號碼（電話 + PIN）登入。",
      },
      { status: 400 },
    );
  }

  // ── 3) 載入店名：優先 merchants.name，無則 fallback pos_bootstrap_config ──
  let storeName: string | null = merchant.kind === "found" ? merchant.name : null;
  if (!storeName) {
    const { data: boot } = await supabase
      .from("pos_bootstrap_config")
      .select("store_name")
      .eq("store_id", storeId)
      .maybeSingle();
    if (boot?.store_name) storeName = boot.store_name;
  }

  // upsert（重複配對同一 agentId 會更新 token_hash + 解除 revoke）
  const { error } = await supabase.from("pos_print_agents").upsert(
    {
      agent_id: agentId,
      store_id: storeId,
      name: name || null,
      token_hash: sha256Hex(token),
      revoked_at: null,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "agent_id" },
  );
  if (error) {
    console.error("[print-agent/pair] upsert failed:", error.message);
    return NextResponse.json({ ok: false, error: "配對寫入失敗" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
