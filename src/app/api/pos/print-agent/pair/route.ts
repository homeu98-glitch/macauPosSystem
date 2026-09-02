// POST /api/pos/print-agent/pair — iPad（已登入 web）發起配對。
// GET  /api/pos/print-agent/pair?agentId= — APK 每 3s 輪詢，未配對 → pending，已配對 → 返凭證。
// 合約見 docs/96 §8，APK 客戶端喺 print-agent-android RelayApi.pollPair()。
import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { loadPairedAgent, sha256Hex } from "@/lib/print-agent-server";

export const dynamic = "force-dynamic";

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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

  // 載入店名（無則 null；APK 之後會由 Realtime 數據自己攞）
  let storeName: string | null = null;
  const { data: boot } = await supabase
    .from("pos_bootstrap_config")
    .select("store_name")
    .eq("store_id", storeId)
    .maybeSingle();
  if (boot?.store_name) storeName = boot.store_name;

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
