import { NextResponse } from "next/server";

import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { resolveExpenseUserId } from "@/lib/expense-inventory";
import { syncFromReceipts } from "@/lib/inventory-products";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/products/sync-from-receipts
 * body: { store: merchantId, account: 8位 }
 * 從 expenseRecorder 的 receipts/merchants 聚合每個品名的累計採購量與加權單價，
 * upsert 到 macau-pos 的 inv_products：
 * - 新品：current_qty = 累計採購量
 * - 既有：更新 avg_unit_cost / last_purchase_date / last_supplier / category（不動 current_qty）
 */
export async function POST(request: Request) {
  const macau = getSupabaseAdminClient();
  if (!macau) return NextResponse.json({ ok: false, error: "macau-pos supabase 未設定" }, { status: 503 });
  const expense = getExpenseSupabaseClient();
  if (!expense) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as
    | { store?: string; account?: string; mode?: string }
    | null;
  const store = body?.store;
  const account = body?.account;
  if (!store) return NextResponse.json({ ok: false, error: "缺少 store" }, { status: 400 });
  if (!account) return NextResponse.json({ ok: false, error: "缺少 account" }, { status: 400 });

  /*
   * 🔴 2026-10-07（P2 項目 2）：`mode` 只係標籤，**唔改變任何行為**。
   *
   * 為何仍然要傳：J 要求「進入頁面時自動同步」⇒ 同步呼叫會由
   * 「商家主動撳」變成「每次開頁面都打一次」。當出問題（例如同步變慢、
   * 次數暴增、某店特別多收據）時，server log 需要分得出
   * 「自動觸發」同「人手觸發」，否則排查會好難。
   *
   * ⚠️ 刻意**唔用 mode 做任何邏輯分支**（例如「auto 就跳過某些檢查」）——
   *    行為一致先可以保證「手動同步嘅結果永遠同自動一樣」。
   */
  const mode = body?.mode === "auto" ? "auto" : "manual";

  const resolved = await resolveExpenseUserId(expense, account);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });

  const result = await syncFromReceipts(macau, store, expense, resolved.userId);
  if ("error" in result) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });

  // 一行可 grep 嘅結構化 log（見上方 `mode` 註釋）。
  console.log(
    `[inventory-sync] mode=${mode} store=${store} created=${result.summary.created} ` +
      `updated=${result.summary.updated} skipped=${result.summary.skipped_unchanged} ` +
      `total=${result.summary.total_after}`,
  );

  return NextResponse.json({ ok: true, mode, summary: result.summary });
}