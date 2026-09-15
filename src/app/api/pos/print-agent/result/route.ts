// POST /api/pos/print-agent/result — 中繼 APK 回報單張結果。
// 合約見 docs/96 §8 / RelayApi.report()。
//   sent    → status='printed', finished_at=now(), last_error=null, claimed_by=null（釋放）
//   printed → 同上（Hub 未來可直報 printed）
//   failed  → attempts<5 → status='pending', claimed_by=null（可重領）; 否則 status='failed'
import { NextResponse } from "next/server";

import { getSupabaseWriteClient } from "@/lib/supabase-server";
import { readAgentHeaders, verifyAgent } from "@/lib/print-agent-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = getSupabaseWriteClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase 未配置" }, { status: 503 });
  }

  const { agentId, token } = readAgentHeaders(request);
  const agent = await verifyAgent(agentId, token);
  if (!agent) {
    return NextResponse.json({ ok: false, error: "agent 驗證失敗" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    jobId?: string;
    status?: string;
    error?: string;
  };
  const jobId = (body.jobId ?? "").trim();
  const status = (body.status ?? "").trim();
  if (!jobId || (status !== "sent" && status !== "printed" && status !== "failed")) {
    return NextResponse.json({ ok: false, error: "缺少 jobId / status" }, { status: 400 });
  }

  // 讀 job 確認係呢個 agent 認領咗（防冒充），並攞 attempts
  const { data: job, error: jErr } = await supabase
    .from("pos_print_jobs")
    .select("id, attempts, claimed_by")
    .eq("id", jobId)
    .maybeSingle();
  if (jErr || !job) {
    return NextResponse.json({ ok: false, error: "job 不存在" }, { status: 404 });
  }
  if (job.claimed_by && job.claimed_by !== agentId) {
    return NextResponse.json({ ok: false, error: "非本機認領" }, { status: 403 });
  }

  const attempts = Number(job.attempts ?? 0);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (status === "sent" || status === "printed") {
    // 打印成功後設為終態 printed；RPC 只揀 pending/failed/printing，printed 永遠唔會被 re-claim。
    patch.status = "printed";
    patch.finished_at = new Date().toISOString();
    patch.last_error = null;
    patch.claimed_by = null;
    // 🔴 2026-09-15（P2）：成功時一定要清零 `attempts`。
    //
    // 以前只清 `last_error` 唔清 `attempts` → 「成功過一次」同「失敗過 4 次」喺 DB 上面
    // 完全分唔開。配合 0042 新增嘅 `finished_at is null` 守衛，`finished_at` 已經足以
    // 擋住重複 claim，但清零 `attempts` 可以令「人工重印」（P3 端點）有個乾淨起點，
    // 亦唔會令一張印咗 4 次先成功嘅單，喺 UI 顯示成「試過 4 次」而誤導。
    patch.attempts = 0;
  } else {
    if (attempts < 5) {
      patch.status = "pending";
      patch.claimed_by = null;
      patch.claimed_at = null;
    } else {
      patch.status = "failed";
      patch.claimed_by = null;
      patch.claimed_at = null;
    }
    // P4（2026-09-15）：失敗原因加穩定前綴，令前端／告警唔使靠 APK 原文。
    // `AGENT_FAILED:` 係固定標記，中繼機報咩文字都照樣歸一類。
    const rawError = (body.error ?? "").slice(0, 240).trim();
    patch.last_error = rawError ? `AGENT_FAILED: ${rawError}`.slice(0, 300) : "AGENT_FAILED";
  }

  const { error: uErr } = await supabase.from("pos_print_jobs").update(patch).eq("id", jobId);
  if (uErr) {
    console.error("[print-agent/result] update failed:", uErr.message);
    return NextResponse.json({ ok: false, error: "結果寫入失敗" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
