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

  const body = (await request.json().catch(() => null)) as { store?: string; account?: string } | null;
  const store = body?.store;
  const account = body?.account;
  if (!store) return NextResponse.json({ ok: false, error: "缺少 store" }, { status: 400 });
  if (!account) return NextResponse.json({ ok: false, error: "缺少 account" }, { status: 400 });

  const resolved = await resolveExpenseUserId(expense, account);
  if ("error" in resolved) return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });

  const result = await syncFromReceipts(macau, store, expense, resolved.userId);
  if ("error" in result) return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, summary: result.summary });
}