// POST /api/pos/print-jobs/retry — 人工重試一張「印唔到」嘅雲端打印任務。
//
// ── 為咩需要呢個端點（2026-09-15 P3）─────────────────────────────
// 打印中心嘅「重試打印」掣（`print-center.tsx`）以前只係 call
// `retryFailedPrintJob()`（`print-bridge/dispatch.ts:101`）—— 佢**只改本機
// localStorage**，然後行本機 flush：
//   · relay 分支嘅 `RelayTransport.send()` 本身係 no-op（只 flush sync queue），
//     樂觀回 `{ ok: true }`；
//   · 本機狀態即刻變 `"sent"` → UI 彈「已重新送出打印。」
//   · **但雲端 `pos_print_jobs` 一行都冇改**（`status` 仲係 `failed`、
//     `attempts` 仲係 5、`claimed_by` 可能仲有值）。
// ⇒ 用戶見到「成功」，一張紙都唔出 = **靜默失敗**。
// 呢個係「重試打印」掣一直以嚟最大嘅騙局。
//
// 本端點係呢個掣嘅**雲端版本**：直接改 DB，令中繼機真係可以再 claim 到。
//
// ── 冪等（重複撳唔會出兩張紙）──────────────────────────────────
// 條件 update：`where id = ? and store_id = ?`，無論撳幾次，結果都係同一組值：
//   status = 'pending', attempts = 0, claimed_by = null, claimed_at = null,
//   finished_at = null, last_error = null
//
// ⚠️ 中繼機側亦按 `job.id` 去重（APK `fromRow`），所以即使連同一個 id
//    被 claim 兩次，APK 都唔會印兩次（見 docs/96）。
//
// 🔒 鑑權：`posRouteAuthGuard`（admin session 或 POS 終端憑證且綁店）。
import { NextResponse } from "next/server";

import { posRouteAuthGuard } from "@/lib/pos/pos-route-auth";
import { getSupabaseWriteClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 503 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    storeId?: string;
    jobId?: string;
  };
  const storeId = (body.storeId ?? "").trim() || null;
  const jobId = (body.jobId ?? "").trim();

  // 🔒 閘放喺 `!supabase` 之後：避免改動 mock / 未配置環境嘅既有行為。
  const denied = posRouteAuthGuard(request, storeId, "pos/print-jobs/retry");
  if (denied) return denied;

  if (!jobId) {
    return NextResponse.json({ ok: false, error: "缺少 jobId" }, { status: 400 });
  }

  // 只可以重試**本店**嘅 job（`.eq("store_id", storeId)` 已帶住，防跨店）。
  // 同時唔准重試「已經成功出紙」嘅（`finished_at` 有值）—— 嗰啲要印應該用
  // 「補打帳單」重新建 job，而唔係令同一條舊 job 再出紙。
  const { data, error } = await supabase
    .from("pos_print_jobs")
    .update({
      status: "pending",
      attempts: 0,
      claimed_by: null,
      claimed_at: null,
      finished_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("store_id", storeId)
    .is("finished_at", null)
    .select("id, status");

  if (error) {
    console.error("[pos/print-jobs/retry] update failed:", error.message);
    return NextResponse.json({ ok: false, error: "重試寫入失敗" }, { status: 500 });
  }

  // 命中 0 行有兩個可能：
  //   a) job 唔存在 / 唔屬本店 → 404
  //   b) 已經成功出過紙（finished_at 有值）→ 409
  // 分開回覆，令 UI 可以講清楚（「找唔到」vs「已印過」）。
  if (!data || data.length === 0) {
    const { data: probe } = await supabase
      .from("pos_print_jobs")
      .select("id, finished_at")
      .eq("id", jobId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (probe?.finished_at) {
      return NextResponse.json(
        { ok: false, error: "此任務已成功出紙，如需再印請用「補打帳單」。" },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, error: "找不到該打印任務。" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: data[0].id, status: "pending" });
}
