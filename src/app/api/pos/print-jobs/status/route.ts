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

  return NextResponse.json({ ok: true, jobs });
}
