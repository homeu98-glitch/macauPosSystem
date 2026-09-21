// POST /api/pos/print-agent/heartbeat — 中繼 APK 心跳 + 狀態上報。
// 合約見 docs/96 §8 / RelayApi.heartbeat()。
// 實作：驗 agent（**順手蓋 `last_seen_at`**）→ 返 {ok, serverTime}。
// token 驗唔過 → 401，APK 清配對返去配對畫面。
//
// 🔴 2026-09-21 請求數優化：舊版係「1 個 SELECT 驗證 ＋ 1 個 UPDATE 蓋章」＝ **2 個 Supabase query**。
//    而 `claim` / `result` 每次都會做同一個驗證 ⇒ **成功嘅 claim 本身已經構成一次心跳**
//    （驗到 agent 存在、未 revoke、token 正確）。所以把「驗證 + 蓋章」合併成一個
//    `update … returning`（`verifyAgent(..., { recordActivity: true })`）⇒ **每次心跳由 2 個 query 變 1 個**。
//    ⚠️ 唔可以調返轉頭：**GET 路由一定唔可以** recordActivity（見 `print-agent-server.ts` 嘅說明）。
//    ⚠️ 驗證失敗（401）嗰陣**唔應該**蓋章 —— 舊版都係「驗唔過就唔 update」，呢度保持一樣語義。
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
  // recordActivity：驗證成功嘅同時蓋 last_seen_at（update … returning）
  const agent = await verifyAgent(agentId, token, { recordActivity: true });
  if (!agent) {
    return NextResponse.json({ ok: false, error: "agent 驗證失敗" }, { status: 401 });
  }

  return NextResponse.json({ ok: true, serverTime: Date.now() });
}
