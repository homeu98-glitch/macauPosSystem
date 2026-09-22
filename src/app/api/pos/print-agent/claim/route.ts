// POST /api/pos/print-agent/claim — 中繼 APK 認領待印工作。
// 合約見 docs/96 §8 / RelayApi.claim()。
// 實作：驗 agent → call RPC pos_claim_print_jobs(p_store_id, p_agent_id, p_limit)
//       （RPC 內含 for update skip locked + 寫 claimed_by/claimed_at/status='printing'/attempts+1）
//       → 返 full pos_print_jobs row（snake_case），APK 用 PrintJobDto.fromRow() 食。
import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";

export const dynamic = "force-dynamic";

/**
 * 建議 APK 下次幾時再 claim（ms）—— **刪咗心跳之後嘅唯一節奏旋鈕**（2026-09-21）。
 *
 * ## 2026-09-22 調快：180_000 → **30_000**（商家投訴「打印非常慢、非常不即時」）
 *
 * 舊值 180 秒係為省請求數而設，但實測（2026-09-22）出紙延遲完全由呢個值支配：
 * 叫醒路徑（Realtime `pos_print_jobs` INSERT → `onWake()`）一旦唔通，一張單最壞要等
 * **整整 3 分鐘**才被認領，而 APK 每次最多只 claim 5 張 ⇒ 高峰吞吐只有 ~1.7 張/分鐘。
 *
 * ## 為何 30 秒係**安全**嘅（成本已核算）
 *
 * · 請求數：30 秒 = 2 次/分鐘。**仍然低於優化之前嘅 3.0 次/分鐘**（當時係
 *   心跳 30 秒 ＋ claim 60 秒），唔會重回 egress 事故前嘅水平。
 * · 位元組：空 claim 嘅 Supabase 回應只有幾百 byte（RPC 0 行 ＋ PATCH 1 行），
 *   ≈ 1 MB/日。2026-09-22 已收口到 10~20 MB/日 ⇒ 呢項佔比可忽略。
 *   （當年 904 MB/日 嘅元兇係「舊 bundle 全量拉取」，唔係 claim 本身。）
 * · UI 閾值：值只可以**細**，唔可以大過 180 秒 —— POS 網頁 `print-center.tsx` 寫死
 *   「`last_seen_at` ≥5 分鐘 → 疑似離線」。
 *
 * ⚠️ 任何值都一定要落喺 **5_000 ~ 180_000**：APK 側係
 * `resp.optInt("nextPollMs", 0).takeIf { it in 5_000..180_000 }`，
 * 超出範圍（例如圖快設 3_000）會**靜默 fallback 30 秒**，以為調快咗其實冇。
 */
const SUGGESTED_CLAIM_MS = 30_000;

/**
 * **仲有積壓**時嘅追趕節奏（ms）：今次 claim 已經取滿 `limit`（＝後面仲有單未認領）
 * ⇒ 叫 APK 幾乎即刻再嚟，令一批單可以連續消化，而唔係再等一輪基礎間隔
 * （舊行為：10 張單 = 2 輪 × 180 秒 = 6 分鐘）。
 *
 * ⚠️ 唔可以細過 5_000（APK 有效範圍下限）。
 */
const CLAIM_BACKLOG_MS = 5_000;

export async function POST(request: Request) {
  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 503 });
  }

  const { agentId, token } = readAgentHeaders(request);
  // 🔴 2026-09-21：`recordActivity: true` —— claim 每次都會驗 agent，所以順手蓋 `last_seen_at`
  //    ⇒ **成功嘅 claim 本身已經構成一次心跳**（實測 claim 間隔由下面 `nextPollMs` 決定）。
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
  //
  // 🆕 2026-09-21：加 `nextPollMs` —— **建議 APK 下次幾時再 claim**。
  //
  // 為何放喺 claim 而唔係 heartbeat：`claim` 本來就要每輪打一次（拎任務），
  // 而 `heartbeat` 唯一作用只係蓋 `last_seen_at`，**完全多餘**（`claim` 已經順手蓋）。
  // 所以建議 APK **刪走獨立心跳迴圈**，改為由呢個欄位控制節奏 ⇒
  // 服務端可以隨時調整（關店放慢／夜間放慢），唔使再出 APK。
  //
  // 🆕 2026-09-22：改為**雙檔自適應**（見上面兩個常數嘅說明）——
  //   ① 今次取滿 `limit` ⇒ 仲有單未認領 ⇒ `CLAIM_BACKLOG_MS`（連續消化，唔再等一輪）；
  //   ② 否則 ⇒ `SUGGESTED_CLAIM_MS`（基礎兜底節奏）。
  // ⚠️ 加欄位對現役 APK **零影響**（`org.json` 嘅 `opt*` 會忽略未知欄位）。
  const jobs = data ?? [];
  const nextPollMs = jobs.length >= limit ? CLAIM_BACKLOG_MS : SUGGESTED_CLAIM_MS;
  return NextResponse.json({
    ok: true,
    jobs,
    printers: [],
    nextPollMs,
  });
}
