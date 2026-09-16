import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { readAdminSessionFromRequest } from "@/lib/admin-session-token";
import { isPosDeviceAuthRequired, readPosDeviceTokenFromRequest } from "@/lib/pos/pos-device-token";

// 診斷用：確認 POS 能否直連 expenseRecorder 專案（fjvfvpedklhdenavbcjg）。
// 僅回傳狀態布林與計數，不含任何 PII。
//
// 🔴 2026-09-16 資安加固：以前**完全冇鑑權**（任何人打一次就知你嘅 expenseRecorder
// 連通狀態同 shop_users 數量）。原本註釋寫「正式上線前可移除或加 POS session 保護」
// —— 已經上線，所以而家補閘：**admin session 或 POS 終端憑證**（本端點冇 storeId
// 參數，所以唔做綁店檢查；佢只回布林／計數，唔含業務資料）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // ⚠️ 閘語義同 `posRouteAuthGuard` 一致：全域 kill switch（`POS_REQUIRE_DEVICE_AUTH=0`）
  //    仍然可以一鍵回滾。
  const allowed =
    !isPosDeviceAuthRequired() ||
    Boolean(readAdminSessionFromRequest(request)) ||
    Boolean(readPosDeviceTokenFromRequest(request));
  if (!allowed) {
    console.warn("[inventory/health] 拒絕未授權存取");
    return NextResponse.json(
      { ok: false, error: "未經授權：需要 POS 終端憑證或 admin session。" },
      { status: 401 },
    );
  }

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
