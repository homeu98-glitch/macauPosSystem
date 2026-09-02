// POST /api/pos/print-agent/heartbeat — 中繼 APK 心跳 + 狀態上報。
// 合約見 docs/96 §8 / RelayApi.heartbeat()。
// 實作：驗 agent → update pos_print_agents.last_seen_at=now() → 返 {ok, serverTime}。
// token 驗唔過 → 401，APK 清配對返去配對畫面。
import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 503 });
  }

  const { agentId, token } = readAgentHeaders(request);
  const agent = await verifyAgent(agentId, token);
  if (!agent) {
    return NextResponse.json({ ok: false, error: "agent 驗證失敗" }, { status: 401 });
  }

  const { error } = await supabase
    .from("pos_print_agents")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("agent_id", agentId);
  if (error) {
    console.error("[print-agent/heartbeat] update failed:", error.message);
    return NextResponse.json({ ok: false, error: "心跳寫入失敗" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, serverTime: Date.now() });
}
