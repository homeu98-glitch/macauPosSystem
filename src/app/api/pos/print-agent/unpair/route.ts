// POST /api/pos/print-agent/unpair — 解除配對（revoke 雲端 agent）。
// web 同 APK 兩邊解除配對都要 call 呢度，否則 pos_print_agents 行仲喺度，
// 中繼機會繼續 claim 呢間店嘅單。合約見 docs/96 §8。
import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function POST(request: Request) {
  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    agentId?: string;
    storeId?: string;
  };
  const agentId = (body.agentId ?? "").trim();
  const storeId = (body.storeId ?? "").trim();
  if (!agentId || !storeId || !STORE_ID_PATTERN.test(storeId) || storeId.length > 64) {
    return NextResponse.json({ ok: false, error: "缺少 agentId / storeId" }, { status: 400 });
  }

  const { error } = await supabase
    .from("pos_print_agents")
    .update({ revoked_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .eq("store_id", storeId);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
