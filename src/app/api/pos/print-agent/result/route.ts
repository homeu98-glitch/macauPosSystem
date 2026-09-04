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
    // 打印成功後設為終態 printed；RPC 只揀 pending/failed，printed 永遠唔會被 re-claim。
    patch.status = "printed";
    patch.finished_at = new Date().toISOString();
    patch.last_error = null;
    patch.claimed_by = null;
  } else {
    if (attempts < 5) {
      patch.status = "pending";
      patch.claimed_by = null;
    } else {
      patch.status = "failed";
    }
    patch.last_error = (body.error ?? "").slice(0, 300) || null;
  }

  const { error: uErr } = await supabase.from("pos_print_jobs").update(patch).eq("id", jobId);
  if (uErr) {
    console.error("[print-agent/result] update failed:", uErr.message);
    return NextResponse.json({ ok: false, error: "結果寫入失敗" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
