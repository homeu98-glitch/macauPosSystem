import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { resolveExpenseUserId, isMissingColumnOrTable } from "@/lib/expense-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 最多拉幾多行原始 `receipt_items` 嚟聚合（唔係回傳行數）。 */
const RAW_LIMIT = 400;
/** 回傳畀前端嘅品項上限（前端會再本機過濾，唔會再打 server）。 */
const MAX_SUGGESTIONS = 80;

export type ReceiptItemSuggestion = {
  name: string;
  /** 最近一次嘅單價（參考用，唔會自動覆蓋用戶輸入）。 */
  unit_price: number;
  /** 最近一次出現嘅日期（`YYYY-MM-DD`，可能係空字串）。 */
  last_date: string;
  count: number;
};

/**
 * 唯讀：回傳本店「最近用過嘅品項」清單，供新增收據時快速選取。
 *
 * 為何要另開一支 route 而唔係由 `/api/inventory/receipts` 反推：
 * 收據 route 只回**當前 range**（預設 today）嘅資料，用嗰批做「歷史品項」
 * 會出現「今日冇落過單 ⇒ 建議清單空空如也」，即係功能等於冇。
 * 呢支 route 獨立按 `created_at` 取最近 N 行，同 range 篩選完全無關。
 *
 * 成本：**一次** query、最多 `RAW_LIMIT` 行 × 3 個窄欄位，喺 `user_id` 上收窄。
 * 前端只會呼叫一次，之後打字係本機過濾（唔會每按一個字就打 server）。
 *
 * ⚠️ `receipt_items.user_id` 係 expenseRecorder 自己 `save-receipt` 都會寫嘅欄位，
 * 所以係存在嘅。但仍然做 42703/42P01 防禦：舊專案若未補呢一欄，
 * 應該回「冇建議」而唔係令庫存頁爆掉。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get("account");
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: true, items: [], warning: "expense client 未設定" });

  const resolved = await resolveExpenseUserId(client, account);
  if ("error" in resolved) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }

  const { data, error } = await client
    .from("receipt_items")
    .select("name, unit_price, created_at")
    .eq("user_id", resolved.userId)
    .order("created_at", { ascending: false })
    .limit(RAW_LIMIT);

  if (error) {
    if (isMissingColumnOrTable(error)) {
      return NextResponse.json({
        ok: true,
        items: [],
        warning: "expenseRecorder 嘅 receipt_items 尚未就緒，暫時冇歷史品項建議。",
      });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // 按「品名（忽略大小寫同前後空白）」聚合：同名只保留**最近一次**嘅單價同日期。
  const byKey = new Map<string, ReceiptItemSuggestion>();
  for (const row of data ?? []) {
    const raw = typeof row.name === "string" ? row.name.trim() : "";
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (byKey.has(key)) {
      const existing = byKey.get(key)!;
      existing.count += 1;
      continue; // 已經係由新到舊排序 ⇒ 第一眼見到嘅就係最新，唔覆蓋
    }
    byKey.set(key, {
      name: raw,
      unit_price: Number(row.unit_price) || 0,
      last_date: typeof row.created_at === "string" ? row.created_at.slice(0, 10) : "",
      count: 1,
    });
  }

  // Map 插入次序＝由新到舊（因為 query 已經 order by created_at desc）⇒ 直接 slice。
  return NextResponse.json({
    ok: true,
    items: Array.from(byKey.values()).slice(0, MAX_SUGGESTIONS),
  });
}
