// GET /api/pos/print-jobs/status?storeId=xxx
// 輕量輪詢端點：只回傳呢間店「已經有打印結果」嘅單（printed = 真實出紙成功 / failed = 印唔到），
// 用嚟俾網頁端把雲端結果回填本地 print job 狀態（見 docs/98 §10）。
// 故意唔回 pending / claimed —— 嗰啲係「仲未印完」，唔可以向下覆寫本地嘅 sent。
//
// 兩級狀態（2026-09-07）：
//   sent    = POS 已把任務交付打印通道（native / companion / relay），只代表「交咗出去」，未確認出紙
//   printed = 打印通道（APK / agent）真實出紙成功後回報嘅終態（唔再降格為 sent）
//   failed  = 打印通道回報失敗（或本地派發失敗）
import { NextResponse } from "next/server";

import { jsonWithEgressLog } from "@/lib/egress-log-server";
import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { rateLimit } from "@/lib/pos/rate-limit";
import {
  classifyPrintJobFailure,
  PRINT_JOB_FAILURE_HINTS,
  PRINT_JOB_FAILURE_LABELS,
} from "@/lib/pos/print-job-failure";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  // 維持原有「未配置 Supabase（mock / 本機）→ 回空 jobs」行為，唔會因為新閘而改變。
  if (!supabase) {
    return NextResponse.json({ ok: true, jobs: [] });
  }

  // 🔒 2026-09-15 資安加固：本端點以前**完全冇鑑權** —— 知道 storeId（枱 QR 內容已公開）
  // 就可以讀走該店所有打印任務嘅 id / 狀態 / `last_error`。
  // ⚠️ 閘一定放喺 `!supabase` 之後：避免改動 mock / 未配置環境嘅既有行為。
  const denied = posRouteAuthGuard(request, storeId, "pos/print-jobs/status");
  if (denied) return denied;

  /**
   * 🧹 P2/P4（2026-09-22）：sweep 節流 **60 秒 → 5 分鐘**（每個 store）。
   *
   * ## 為何
   *
   * 呢個 sweep 係一個**衞生工作**（把逾 ttl / 跨營業日仲未印完嘅 job 標 failed），
   * 唔需要每分鐘做一次；但打印中心每 30 秒就會打一次呢條 route
   *（實測 Supabase log：`rpc/pos_void_stale_print_jobs` 間隔中位 **60.0 秒**、
   * 12.3 分鐘 15 次）—— 即係「開住打印中心就每分鐘一個 RPC」。
   *
   * 5 分鐘嘅代價：一張卡死嘅 job 最多遲 4 分鐘才被標成 failed（顯示層面嘅延遲），
   * 而 `pos_claim_print_jobs` 本身有 60 秒的 claimed_at 重排窗（0035）——
   * 「重試」唔會因此變慢，只係「幾時喺 UI 見到紅標」遲幾分鐘。
   *
   * ⚠️ 同 `pos-state-legacy` 一樣用 in-memory `rateLimit`（每個 Vercel 實例一份）
   * ⇒ 多實例之下實際間隔會短過 5 分鐘，屬可接受（fail-open，唔會影響正確性）。
   */
  const sweepAllowed = storeId ? rateLimit(`pos-print-sweep:${storeId}`, 1, 5 * 60_000) : false;
  try {
    if (!sweepAllowed) {
      // 節流期間唔查、唔寫 —— 直接跳過（下面兩條主查詢照跑）。
    } else {
      const { error: sweepErr } = await supabase.rpc("pos_void_stale_print_jobs", {
        p_store_id: storeId,
      });
      if (sweepErr) {
        // 0042 未跑就會 42883 function does not exist —— 屬預期，唔好當錯。
        if (!/does not exist|42883/i.test(sweepErr.message)) {
          console.warn("[pos/print-jobs/status] stale sweep failed:", sweepErr.message);
        }
      }
    }
  } catch (err) {
    console.warn("[pos/print-jobs/status] stale sweep threw:", err);
  }

  /**
   * 兩條主查詢回傳上限：**200 → 120**（2026-09-22 P2）。
   *
   * 為何 120 夠：呢支 route 只係更新**已經喺本機清單**嘅 job 狀態（badge / 紅標），
   * 而本機清單本身由 `/api/pos/state` 餵（P1 之後係增量）。打印中心開住時每 30 秒
   * 拉一次，終態（printed/failed）一般喺幾分鐘內就出現 ⇒ 120 條已覆蓋數以小時計嘅出紙。
   * 舊行為要還原：改返 200。
   */
  const STATUS_LIMIT = 120;
  const { data, error } = await supabase
    .from("pos_print_jobs")
    .select("id, status, last_error")
    .eq("store_id", storeId)
    .in("status", ["printed", "failed"])
    .order("updated_at", { ascending: false })
    .limit(STATUS_LIMIT);

  if (error) {
    console.error("[pos/print-jobs/status] query failed:", error.message);
    return NextResponse.json({ ok: false, jobs: [] }, { status: 500 });
  }

  // P4（2026-09-15）：`failed` 行帶埋**穩定嘅原因碼**，令前端／告警唔使靠 error 原文。
  const nowMs = Date.now();
  const jobs = (data ?? []).map((row) => {
    const reason = classifyPrintJobFailure({
      status: row.status as string,
      attempts: 5, // 呢個查詢只揀 printed / failed；failed 代表重試已用完
      lastError: (row.last_error as string | null) ?? null,
      nowMs,
    });
    return {
      id: row.id as string,
      // 2026-09-07 兩級狀態：雲端 printed 唔再降格為 sent，原值透傳俾前端。
      //   sent    = POS 已把任務交付打印通道（native / companion / relay），未確認出紙
      //   printed = 打印通道（APK / agent）真實出紙成功後回報嘅終態
      // 前端會按呢兩個值分別顯示「已發送」/「打印成功」。
      // （本端點只揀 printed / failed，所以下面只會出呢兩個值；型別保留 sent 兼容舊紀錄。）
      status: (row.status === "printed"
        ? "printed"
        : "failed") as "sent" | "printed" | "failed",
      lastError: (row.last_error as string | null) ?? undefined,
      // P4：原因碼 + 中文標籤 + 建議處理。
      reason: reason ?? undefined,
      reasonLabel: reason ? PRINT_JOB_FAILURE_LABELS[reason] : undefined,
      reasonHint: reason ? PRINT_JOB_FAILURE_HINTS[reason] : undefined,
    };
  });

  /**
   * 🔴 2026-09-12 新增：**未完成**嘅任務（`pending` / `printing`）。
   *
   * 為咩一定要回：舊寫法只回 `printed` / `failed`，所以「冇人認領」（`pending`）同
   * 「認領咗但冇回報」（`printing`）**喺 POS 端零訊息** → 本地永遠顯示「已發送」、
   * 冇紅標、唔會自我修正（商家 2026-09-12 實案：4 張 job 全部卡住，一張紙都冇出）。
   *
   * 前端見到：
   *   `pending`  → 「雲端排隊（未認領）」＝中繼打印機代理離線／未配對
   *   `printing` → 「已認領未回報」＝APK claim 咗之後死咗 / render 拋錯
   *               （配合 migration 0035：超過 60 秒會自動重排）
   */
  const { data: unfinished, error: unfinishedError } = await supabase
    .from("pos_print_jobs")
    .select("id, status, claimed_at, attempts, created_at, last_error")
    .eq("store_id", storeId)
    .in("status", ["pending", "printing"])
    .order("created_at", { ascending: false })
    .limit(STATUS_LIMIT);
  if (unfinishedError) {
    // ⚠️ 唔可以因為呢個查詢失敗連 printed/failed 都返唔到（向下兼容舊 DB）。
    console.error("[pos/print-jobs/status] unfinished query failed:", unfinishedError.message);
    return NextResponse.json({ ok: true, jobs });
  }

  const payload = {
    ok: true,
    jobs,
    unfinished: (unfinished ?? []).map((row) => {
      // P4：未完成嘅行亦要分類 —— 「pending 太耐」同「printing 太耐」以前喺前端
      // 係零訊息（用戶只見到「已發送」），呢個就係當日 58 張靜默卡死嘅原因。
      const reason = classifyPrintJobFailure({
        status: row.status as string,
        attempts: Number(row.attempts ?? 0),
        lastError: (row.last_error as string | null) ?? null,
        claimedAt: (row.claimed_at as string | null) ?? null,
        createdAt: (row.created_at as string | null) ?? null,
        nowMs,
      });
      return {
        id: row.id as string,
        status: row.status as "pending" | "printing",
        claimedAt: (row.claimed_at as string | null) ?? null,
        attempts: Number(row.attempts ?? 0),
        createdAt: (row.created_at as string | null) ?? null,
        reason: reason ?? undefined,
        reasonLabel: reason ? PRINT_JOB_FAILURE_LABELS[reason] : undefined,
        reasonHint: reason ? PRINT_JOB_FAILURE_HINTS[reason] : undefined,
      };
    }),
  };
  // 🆕 2026-09-22：改用 `jsonWithEgressLog` ⇒ ① 多一行 `[egress]` 審計（同 pos/state 一致）
  // ② 順手記入 `pos_egress_daily`（admin「雲端用量」頁按店統計）。
  // 回應內容完全一樣（同一個 payload、同一個 content-type）。
  return jsonWithEgressLog(
    "pos/print-jobs/status",
    payload,
    { jobs: jobs.length, unfinished: payload.unfinished.length, store: storeId ?? "-" },
    { storeId },
  );
}
