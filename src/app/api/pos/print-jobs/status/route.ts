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

import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const supabase = getSupabaseServerClient();
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId")?.trim() || null;

  if (!supabase || !storeId) {
    return NextResponse.json({ ok: true, jobs: [] });
  }

  const { data, error } = await supabase
    .from("pos_print_jobs")
    .select("id, status, last_error")
    .eq("store_id", storeId)
    .in("status", ["printed", "failed"])
    .order("updated_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[pos/print-jobs/status] query failed:", error.message);
    return NextResponse.json({ ok: false, jobs: [] }, { status: 500 });
  }

  const jobs = (data ?? []).map((row) => ({
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
  }));

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
    .select("id, status, claimed_at, attempts, created_at")
    .eq("store_id", storeId)
    .in("status", ["pending", "printing"])
    .order("created_at", { ascending: false })
    .limit(200);
  if (unfinishedError) {
    // ⚠️ 唔可以因為呢個查詢失敗連 printed/failed 都返唔到（向下兼容舊 DB）。
    console.error("[pos/print-jobs/status] unfinished query failed:", unfinishedError.message);
    return NextResponse.json({ ok: true, jobs });
  }

  return NextResponse.json({
    ok: true,
    jobs,
    unfinished: (unfinished ?? []).map((row) => ({
      id: row.id as string,
      status: row.status as "pending" | "printing",
      claimedAt: (row.claimed_at as string | null) ?? null,
      attempts: Number(row.attempts ?? 0),
      createdAt: (row.created_at as string | null) ?? null,
    })),
  });
}
