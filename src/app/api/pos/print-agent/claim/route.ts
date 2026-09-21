// POST /api/pos/print-agent/claim — 中繼 APK 認領待印工作。
// 合約見 docs/96 §8 / RelayApi.claim()。
// 實作：驗 agent → call RPC pos_claim_print_jobs(p_store_id, p_agent_id, p_limit)
//       （RPC 內含 for update skip locked + 寫 claimed_by/claimed_at/status='printing'/attempts+1）
//       → 返 full pos_print_jobs row（snake_case），APK 用 PrintJobDto.fromRow() 食。
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
  // 🔴 2026-09-21：`recordActivity: true` —— claim 每次都會驗 agent，所以順手蓋 `last_seen_at`
  //    ⇒ **成功嘅 claim 本身已經構成一次心跳**（實測 claim 每 65 秒一次）。
  //    呢個係「日後 APK 可以唔發獨立 heartbeat」嘅前置條件（見 print-agent-server.ts 說明）。
  //    ⚠️ 只可以喺 POST 路由用；GET 路由（device-config / pair）一律唔可以傳。
  const agent = await verifyAgent(agentId, token, { recordActivity: true });
  if (!agent) {
    return NextResponse.json({ ok: false, error: "agent 驗證失敗" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    storeId?: string;
    limit?: number;
  };
  const storeId = (body.storeId ?? agent.storeId ?? "").trim();
  const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 50);

  const { data, error } = await supabase.rpc("pos_claim_print_jobs", {
    p_store_id: storeId,
    p_agent_id: agentId,
    p_limit: limit,
  });
  if (error) {
    console.error("[print-agent/claim] rpc failed:", error.message);
    return NextResponse.json({ ok: false, error: "claim 失敗" }, { status: 500 });
  }
  // printers 可選（v1 返空陣；APK 用自己配置嘅 Sunmi / LAN 打印機）
  return NextResponse.json({ ok: true, jobs: data ?? [], printers: [] });
}
