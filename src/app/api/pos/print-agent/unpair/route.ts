// POST /api/pos/print-agent/unpair — 解除配對（revoke 雲端 agent）。
// web 同 APK 兩邊解除配對都要 call 呢度，否則 pos_print_agents 行仲喺度，
// 中繼機會繼續 claim 呢間店嘅單。合約見 docs/96 §8。
import { NextResponse } from "next/server";

import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";
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
    token?: string;
  };
  const agentId = (body.agentId ?? "").trim();
  const storeId = (body.storeId ?? "").trim();
  if (!agentId || !storeId || !STORE_ID_PATTERN.test(storeId) || storeId.length > 64) {
    return NextResponse.json({ ok: false, error: "缺少 agentId / storeId" }, { status: 400 });
  }

  /**
   * 🔒 2026-09-15 資安加固：本端點以前**完全冇鑑權** —— 任何人只要知道 agentId + storeId
   * 就可以 revoke 他店嘅中繼機 → 該店雲端打印即刻中斷（DoS）。
   *
   * 兩條合法路徑都要保住：
   *   ① **Web 面板**（`relay-pairing-panel.tsx`，喺 `/settings` 之下，已登入）
   *      → 帶 POS 終端憑證 / admin session。
   *   ② **APK 自己**（同一個 agentId 主動解除）→ 帶 `x-agent-id` + `x-agent-token`。
   * 兩者都冇 → 401。**唔可以**只認 ①，否則會斷 APK 嘅自我解除路徑。
   */
  const posDenied = posRouteAuthGuard(request, storeId, "pos/print-agent/unpair");
  if (posDenied) {
    const headerToken = readAgentHeaders(request);
    const agentToken = headerToken.token || (body.token ?? "").trim();
    const claimId = headerToken.agentId || agentId;
    const agent = agentToken ? await verifyAgent(claimId, agentToken) : null;
    if (!agent || agent.storeId !== storeId) {
      return posDenied;
    }
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
