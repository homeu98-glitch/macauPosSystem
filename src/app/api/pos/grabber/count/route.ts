// GET /api/pos/grabber/count?storeId=…&platform=…
// 「呢部機已經送咗幾多上嚟」—— 俾 APK 顯示，避免以為漏傳。
//
// 🔴 點解 404 唔可以當 0（APK 側刻意咁寫）：
//   未初始化（0064 未跑）⇒ 回 **503** 而唔係 0。APK 收到非 2xx 就顯示
//   「未知」，唔會令店員以為「送咗 0 張 = 漏咗單」。
//   回 0 係**最壞**答案：會令人以為系統正常但漏單。
import { NextResponse } from "next/server";

import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PLATFORM_PATTERN = /^[a-z0-9_-]{1,24}$/i;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedStore = (searchParams.get("storeId") ?? "").trim();
  const platform = (searchParams.get("platform") ?? "").trim();

  const { agentId, token } = readAgentHeaders(request);
  const agent = await verifyAgent(agentId, token); // 🔴 純讀
  if (!agent) {
    return NextResponse.json({ error: "agent 驗證失敗" }, { status: 401 });
  }

  const storeId = requestedStore || agent.storeId || "";
  if (!storeId || !STORE_ID_PATTERN.test(storeId) || storeId.length > 64) {
    return NextResponse.json({ error: "storeId 格式錯誤" }, { status: 400 });
  }
  if (storeId !== agent.storeId) {
    return NextResponse.json({ error: "storeId 不符" }, { status: 403 });
  }
  if (platform && !PLATFORM_PATTERN.test(platform)) {
    return NextResponse.json({ error: "platform 格式錯誤" }, { status: 400 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ error: "Supabase 未配置" }, { status: 503 });
  }

  // 單一 count query：精確 head count（PostgREST 支援 count: "exact" + head）。
  // ⚠️ 唔好分開查「總數 + 已投影 + 失敗」三條 —— 一條就夠，其餘由同一條件過濾。
  let q = supabase
    .from("pos_grabber_inbox")
    .select("*", { count: "exact", head: true })
    .eq("store_id", storeId);
  if (platform) q = q.eq("platform", platform);

  const { count, error } = await q;
  if (error) {
    console.error("[grabber/count] 讀計數失敗", error.code, error.message);
    const status = error.code === "42P01" ? 503 : 500;
    return NextResponse.json(
      { error: status === 503 ? "grabber 未初始化" : "讀計數失敗" },
      { status },
    );
  }

  return NextResponse.json({ ok: true, count: count ?? 0, storeId, platform: platform || null });
}
