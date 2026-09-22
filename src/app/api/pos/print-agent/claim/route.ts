// POST /api/pos/print-agent/claim — 中繼 APK 認領待印工作。
// 合約見 docs/96 §8 / RelayApi.claim()。
// 實作：驗 agent → call RPC pos_claim_print_jobs(p_store_id, p_agent_id, p_limit)
//       （RPC 內含 for update skip locked + 寫 claimed_by/claimed_at/status='printing'/attempts+1）
//       → 返 full pos_print_jobs row（snake_case），APK 用 PrintJobDto.fromRow() 食。
import { NextResponse } from "next/server";

import {
  claimCadenceLabel,
  nextClaimPollMs,
  nextEmptyStreak,
} from "@/lib/pos/print-agent-cadence";
import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";

export const dynamic = "force-dynamic";

/**
 * 🆕 2026-09-22（第三次覆核）**空閒退避** —— 節奏決策搬去純模組
 * `@/lib/pos/print-agent-cadence`（9 條單測鎖住 5 秒~180 秒嘅硬性合約）。
 *
 * ## 演變（三日內三次，記住脈絡）
 *
 * | 版本 | 值 | 觸發 |
 * |---|---|---|
 * | 原始 | 60 秒 | — |
 * | 2026-09-21 23:54 | **180 秒** | egress 事故（省請求） |
 * | 2026-09-22 中午 | **30 秒** | 商家投訴「打印非常慢」 |
 * | **2026-09-22 17:45（今次）** | **30 → 60 → 120 → 180 秒（按「連續冇 job」退避）** | 用戶：「關店唔應該 call 任何嘢」 |
 *
 * ⇒ 之前兩個做法各有代價：固定 180 秒令高峰慢；固定 30 秒令**關店之後照樣每 30 秒打一次**
 * （實測 152 次 / 192 分鐘）。退避同時滿足兩邊：**有單就快、冇單就自動慢落去**。
 *
 * ## 🔴 為何係「退避」而唔係「關店就 block」
 *
 * 出紙通道只有「雲端 `pos_print_jobs` → 中繼 APK claim」一條，
 * block 咗 ⇒ **關店後嘅結尾結帳收據、補打帳單永遠印唔出**。
 * 而且 claim 成本實測只 ≈ 0.17 MB/日（相對舊分頁迴圈 1.4 GB/日 ＝ 0.01%）
 * ⇒ **唔會**靠呢個解決超額；呢個係衞生／原則修正。
 *
 * 上限 180 秒係硬線：POS 網頁 `print-center.tsx` 寫死「`last_seen_at` ≥5 分鐘 → 疑似離線」。
 *
 * ## 為何用 in-memory 記「連續冇 job」
 *
 * 零額外查詢（唔想為判斷「店有冇開」每次多打 1–2 條 DB 查詢，反而更貴）。
 * 多實例之下退避會唔準（最壞情況維持 30 秒）—— 屬安全側失效，唔會壞。
 */
const emptyStreakByAgent = new Map<string, number>();

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
  // 🆕 2026-09-22：**三檔 ＋ 空閒退避**（見檔頭）。
  //
  // 為何放喺 claim 而唔係 heartbeat：`claim` 本來就要每輪打一次（拎任務），
  // 而 `heartbeat` 唯一作用只係蓋 `last_seen_at`，**完全多餘**（`claim` 已經順手蓋）。
  // 所以建議 APK **刪走獨立心跳迴圈**，改為由呢個欄位控制節奏 ⇒
  // 服務端可以隨時調整（有單加快／冇單退避），唔使再出 APK。
  //
  // ⚠️ 加欄位對現役 APK **零影響**（`org.json` 嘅 `opt*` 會忽略未知欄位）。
  const jobs = data ?? [];
  const streak = nextEmptyStreak(emptyStreakByAgent.get(agentId) ?? 0, jobs.length);
  emptyStreakByAgent.set(agentId, streak);
  // 記憶體保護：一個實例最多記 500 個 agent（正常一間店一兩個）
  if (emptyStreakByAgent.size > 500) {
    const firstKey = emptyStreakByAgent.keys().next().value;
    if (firstKey) emptyStreakByAgent.delete(firstKey);
  }
  const nextPollMs = nextClaimPollMs({ claimed: jobs.length, limit, emptyStreak: streak });
  return NextResponse.json({
    ok: true,
    jobs,
    printers: [],
    nextPollMs,
    // 🆕 診斷：一眼睇得出「點解係呢個間隔」（舊 APK 忽略未知欄位，零影響）。
    cadence: claimCadenceLabel(jobs.length, limit),
    idleStreak: streak,
  });
}
