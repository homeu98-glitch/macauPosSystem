import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";

// 診斷用：確認 POS 能否直連 expenseRecorder 專案（fjvfvpedklhdenavbcjg）。
// 僅回傳狀態布林與計數，不含任何 PII；正式上線前可移除或加 POS session 保護。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const client = getExpenseSupabaseClient();
  if (!client) {
    return NextResponse.json({
      configured: false,
      connected: false,
      reason: "EXPENSE_SUPABASE_URL / EXPENSE_SUPABASE_SERVICE_ROLE_KEY 未設定",
    });
  }

  try {
    const { count, error } = await client
      .from("shop_users")
      .select("*", { count: "exact", head: true });

    if (error) {
      return NextResponse.json({ configured: true, connected: false, error: error.message });
    }

    return NextResponse.json({ configured: true, connected: true, shop_users_count: count ?? 0 });
  } catch (e) {
    return NextResponse.json({
      configured: true,
      connected: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
