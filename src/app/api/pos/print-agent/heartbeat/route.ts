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

/**
 * 建議下次心跳間隔（ms）—— **預備接口**（2026-09-21）。
 *
 * ## 為何要放喺回應（而唔係改 APK 常數）
 *
 * APK 而家係寫死常數（`PosJobRunner.kt`：`const val HEARTBEAT_MS = 30_000L`），
 * 實測每 ~32 秒一次（Supabase log 24 分鐘 44 次 PATCH）—— **係現時請求數第一位**。
 * 放一個「服務端建議值」落回應，日後就可以**由服務端**按情境（關店／夜間）放慢，
 * 唔使為咗調參數再出一個 APK 版本。
 *
 * ## 🔴 加呢個欄位係 100% 安全（已查證 APK 源碼）
 *
 * `RelayApi.kt` 用 `org.json.JSONObject` 嘅 `optBoolean("ok")` / `optString("error")` 解析，
 * **`opt*` 會忽略未知欄位並對缺失欄位回預設值**（唔似 kotlinx.serialization 預設會 throw）
 * ⇒ 多一個欄位對現役 APK **零影響**。
 *
 * ## ⚠️ 兩個限制
 *
 * · **APK 未讀之前，呢個欄位係惰性嘅**（唔會省到任何請求）—— 要真正省，APK 要改成
 *   讀 `nextPollMs`（唔存在就 fallback 30 秒）。呢個屬 APK 改動。
 * · 建議值**唔可以超過 3 分鐘**：`print-center.tsx:1789` 寫死
 *   「`minutesAgo >= 5` → 疑似離線」，超過就會誤報。要再放慢就要一齊改嗰個 UI 閾值。
 */
const SUGGESTED_HEARTBEAT_MS = 60_000;

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

  // 🔴 驗證失敗嘅路徑**唔會**行到呢度 ⇒ 唔會喺「驗唔過」時蓋章（同舊版語義一致）。
  return NextResponse.json({
    ok: true,
    serverTime: Date.now(),
    nextPollMs: SUGGESTED_HEARTBEAT_MS,
  });
}
