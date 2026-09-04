// GET /api/pos/print-jobs/status?storeId=xxx
// 輕量輪詢端點：只回傳呢間店「已經有打印結果」嘅單（printed = Hub 印到 / failed = Hub 印唔到），
// 用嚟俾網頁端把雲端結果回填本地 print job 狀態（見 docs/98 §10）。
// 故意唔回 pending / claimed —— 嗰啲係「仲未印完」，唔可以向下覆寫本地嘅 sent。
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
    // 雲端 printed 對網頁本地狀態等價於 sent（都已印完）；保留舊 sent 兼容舊紀錄。
    status: (row.status === "printed" ? "sent" : (row.status as "sent" | "failed")),
    lastError: (row.last_error as string | null) ?? undefined,
  }));

  return NextResponse.json({ ok: true, jobs });
}
