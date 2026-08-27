import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DbError = { code?: string; message?: string } | null;

function isMissingTable(err: DbError): boolean {
  if (!err) return false;
  if (err.code === "42P01") return true;
  return /relation .* does not exist/i.test(err.message ?? "");
}

type LowStockRow = {
  id: string;
  name: string;
  unit: string;
  unit_cost: number;
  current_qty: number;
  reorder_level: number | null;
};

/**
 * 庫存總覽（店別 scope = storeId = Ledger merchantId）。
 * 依據用戶選擇（2026-08-27）：只顯示「實際入貨成本」，不計算理論用料成本（食譜留待後續）。
 * - receipts.store_id + receipt_type='stock_in' → 今日用料成本 / 今日支出
 * - inv_products → 庫存總值 + 低庫存警示（該表可能尚未建立，missing-table 時降級）
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const storeId = searchParams.get("storeId");
  if (!storeId) return NextResponse.json({ ok: false, error: "缺少 storeId" }, { status: 400 });

  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: false, error: "expense client 未設定" }, { status: 503 });

  const today = new Date().toISOString().slice(0, 10);

  const { data: stockIn, error: siErr } = await client
    .from("receipts")
    .select("id, total_amount, receipt_date, category, created_at")
    .eq("store_id", storeId)
    .eq("receipt_type", "stock_in")
    .eq("receipt_date", today);
  if (siErr) {
    if (isMissingTable(siErr)) {
      return NextResponse.json({
        ok: false,
        schemaReady: false,
        error: "receipts 缺少 store_id/receipt_type 欄位，請執行 M2 遷移 SQL",
      });
    }
    return NextResponse.json({ ok: false, error: siErr.message }, { status: 500 });
  }

  const actualStockInCost = (stockIn ?? []).reduce((sum, r) => sum + Number(r.total_amount || 0), 0);

  const { data: expenses } = await client
    .from("receipts")
    .select("total_amount")
    .eq("store_id", storeId)
    .eq("receipt_type", "expense")
    .eq("receipt_date", today);
  const todayExpense = (expenses ?? []).reduce((sum, r) => sum + Number(r.total_amount || 0), 0);

  let inventoryValue = 0;
  let lowStock: LowStockRow[] = [];
  let productsSchemaReady = true;
  const { data: products, error: pErr } = await client
    .from("inv_products")
    .select("id, name, unit, unit_cost, current_qty, reorder_level")
    .eq("store_id", storeId);
  if (pErr) {
    if (isMissingTable(pErr)) {
      productsSchemaReady = false;
    } else {
      return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
    }
  } else {
    const rows = (products ?? []) as LowStockRow[];
    inventoryValue = rows.reduce((sum, p) => sum + Number(p.unit_cost || 0) * Number(p.current_qty || 0), 0);
    lowStock = rows.filter((p) => Number(p.current_qty || 0) <= Number(p.reorder_level || 0));
  }

  return NextResponse.json({
    ok: true,
    schemaReady: true,
    productsSchemaReady,
    storeId,
    date: today,
    actualStockInCost,
    todayExpense,
    inventoryValue,
    lowStockCount: lowStock.length,
    todayStockIn: stockIn ?? [],
    lowStock,
  });
}
