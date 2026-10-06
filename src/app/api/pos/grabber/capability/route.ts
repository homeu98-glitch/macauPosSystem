// GET /api/pos/grabber/capability?storeId=…
// 「平台（抓單）入口喺呢部 APK 上可唔可見」—— 第 1 層開關，fail-closed。
//
// 對應 APK 端 `grabber/GrabberVisibility.kt`：
//   · 未配對 ⇒ APK 唔會發请求（直接 false）
//   · 401     ⇒ false（重新配對）
//   · 404     ⇒ null → APK 用離線快取 / false
//   · 200     ⇒ 讀 body 嘅 `grabberEnabled`（缺欄 = false）
//
// 🔴 為什麼淨係 GET、而且**唔可以**加 recordActivity：
//   print-agent-server.ts 嘅 `recordActivity` 只可以喺 POST 路由用 ——
//   GET 會被瀏覽器 prefetch／爬蟲／重試意外觸發，改寫 `last_seen_at` 令
//   「中繼機在線」顯示失真。呢度**淨係讀**，唔蓋任何活躍時間。
//
// 🔴 fail-closed 係重點：
//   row 唔存在、讀唔到、Supabase 未配置 —— 一律當 **false**。
//   小店永遠唔會因為「旗標表未初始化」而見到入口。
import { NextResponse } from "next/server";

import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = (searchParams.get("storeId") ?? "").trim();

  const { agentId, token } = readAgentHeaders(request);
  const agent = await verifyAgent(agentId, token); // 🔴 純讀，唔傳 recordActivity
  if (!agent) {
    return NextResponse.json(
      { grabberEnabled: false, error: "agent 驗證失敗" },
      { status: 401 },
    );
  }

  // 🔴 綁店防護：只服務**自己嗰間店**。
  //    APK 會傳 storeId（可能係 persistedMerchantId），但 token 對應嘅
  //    store 先係真相 ⇒ 唔一致就當 false，唔好畀任何人查其他店嘅旗標。
  const storeId = requested || agent.storeId || "";
  if (!storeId || !STORE_ID_PATTERN.test(storeId) || storeId.length > 64) {
    return NextResponse.json(
      { grabberEnabled: false, error: "storeId 格式錯誤" },
      { status: 400 },
    );
  }
  if (storeId !== agent.storeId) {
    console.warn(
      `[grabber/capability] storeId 不符（header 對應 ${agent.storeId}，請求 ${storeId}）⇒ 當 false`,
    );
    return NextResponse.json({ grabberEnabled: false }, { status: 200 });
  }

  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    // 🔴 唔可以回 500：APK 收到 !isSuccessful 一律當 false，等同誤導。
    //    回 200 + false 語義更乾淨（真係「未開放」）。
    console.error("[grabber/capability] Supabase 未配置 ⇒ 當未開放");
    return NextResponse.json({ grabberEnabled: false, reason: "supabase_unconfigured" });
  }

  const { data, error } = await supabase
    .from("pos_grabber_capability")
    .select("grabber_enabled, note, updated_at")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) {
    // 42P01 = 未跑 0064 ⇒ 預期之內（唔可以當 500，會令 APK 以為服務壞咗）
    console.error("[grabber/capability] 讀旗標失敗 ⇒ 當未開放", error.code, error.message);
    return NextResponse.json({
      grabberEnabled: false,
      reason: error.code === "42P01" ? "not_initialized" : "read_failed",
    });
  }

  // 🔴 row 唔存在 = 未開放（唔係「預設開」）。呢個係小店唔見入口嘅保證。
  return NextResponse.json({
    grabberEnabled: data?.grabber_enabled === true,
    note: data?.note ?? null,
    updatedAt: (data?.updated_at as string | null) ?? null,
  });
}
