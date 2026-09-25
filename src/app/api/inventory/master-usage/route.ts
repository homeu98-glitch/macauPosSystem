import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { isMissingColumnOrTable, resolveExpenseUserId } from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 最多掃幾多張收據去數「用過 N 次」。
 *
 * 取捨：PostgREST 冇 GROUP BY，唯一做法係拉返 `merchant_id` 再喺 server 端數。
 * 只拉**一個窄欄位（uuid）**，1500 行大約幾十 KB；而呢支 route 係
 * **lazy**（淨係商家撳入「設置 → 供應商」先會呼叫一次），唔會跟住主頁輪詢。
 * 超過上限就只當「近期」統計，並喺回應講明 `capped: true`，唔會扮成總數。
 */
const SCAN_LIMIT = 1500;

/**
 * 唯讀：回傳本店「近期各供應商用過幾多次」。
 *
 * 為何要獨立一支 route 而唔係喺 `GET /api/inventory/merchants` 一次過回：
 * ① `merchants` 係**主頁每次載入**都要讀（下拉選單），加咗聚合會令每次載入都多一個查詢；
 * ② 用量係「設置頁嘅裝飾資訊」，唔值得為佢拖慢主路徑。
 *
 * ⚠️ 唔回 `raw_ocr_data`：嗰個 jsonb 每行可以幾 KB，1500 行就係 MB 級 egress。
 * 品類喺設置頁顯示嘅係說明文案（「收據／庫存品共用」）而唔係次數，所以唔需要。
 *
 * ⚠️ `receipts.user_id` 由 POS 自己寫（`POST /api/inventory/receipts`）所以存在，
 * 但舊資料有機會靠 `merchant_id` 掛（見 `receipts/route.ts` 嘅 or 條件）。
 * 呢度刻意只用 `user_id`：用量係「本店開單次數」嘅參考值，寧願少算都唔可以
 * 把「另一間分店掛落同一個 merchant」嘅單計入自己。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get("account");

  const client = getExpenseSupabaseClient();
  if (!client) {
    return NextResponse.json({
      ok: true,
      supplierUsage: {},
      scanned: 0,
      capped: false,
      warning: "expense client 未設定",
    });
  }

  const resolved = await resolveExpenseUserId(client, account);
  if ("error" in resolved) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }

  const { data, error, count } = await client
    .from("receipts")
    .select("merchant_id", { count: "exact" })
    .eq("user_id", resolved.userId)
    .order("created_at", { ascending: false })
    .limit(SCAN_LIMIT);

  if (error) {
    if (isMissingColumnOrTable(error)) {
      return NextResponse.json({
        ok: true,
        supplierUsage: {},
        scanned: 0,
        capped: false,
        warning: "expenseRecorder 嘅 receipts 尚未就緒，暫無用量統計。",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const supplierUsage: Record<string, number> = {};
  for (const row of data ?? []) {
    const id = (row as { merchant_id?: unknown }).merchant_id;
    if (id === null || id === undefined) continue;
    const key = String(id);
    if (!key) continue;
    supplierUsage[key] = (supplierUsage[key] ?? 0) + 1;
  }

  const scanned = (data ?? []).length;
  const totalReceipts = typeof count === "number" ? count : scanned;

  return NextResponse.json({
    ok: true,
    supplierUsage,
    scanned,
    totalReceipts,
    capped: totalReceipts > scanned,
  });
}
