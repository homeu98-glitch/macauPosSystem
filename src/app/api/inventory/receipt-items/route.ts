import { NextResponse } from "next/server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { resolveExpenseUserId, isMissingColumnOrTable } from "@/lib/expense-inventory";
import { aggregateItemSuggestions, type ItemSuggestion } from "@/lib/inventory-item-suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 最多拉幾多行原始 `receipt_items` 嚟聚合（唔係回傳行數）。 */
const RAW_LIMIT = 400;
/** 回傳畀前端嘅品項上限（前端會再本機過濾，唔會再打 server）。 */
const MAX_SUGGESTIONS = 80;
/**
 * 指定供應商時，最多回溯幾多張收據（2026-10-08）。
 *
 * 唔可以直接把所有 receipt id 塞入 `.in(...)`：老店開咗幾年，單一供應商可能
 * 累積幾千張單 ⇒ URL 長度同 PostgREST 參數上限都會出事。
 * 200 張單已經遠超「建議清單」需要（最終只出最多 80 個品名）。
 */
const SUPPLIER_RECEIPT_LIMIT = 200;

/** 向後相容：舊名（`route.ts` 一度 export 咗呢個名）。 */
export type ReceiptItemSuggestion = ItemSuggestion;

/**
 * 唯讀：回傳本店「最近用過嘅品項」清單，供新增／編輯收據時快速選取。
 *
 * ## 為何要另開一支 route 而唔係由 `/api/inventory/receipts` 反推
 * 收據 route 只回**當前 range**（預設 today）嘅資料，用嗰批做「歷史品項」
 * 會出現「今日冇落過單 ⇒ 建議清單空空如也」，即係功能等於冇。
 * 呢支 route 獨立按 `created_at` 取最近 N 行，同 range 篩選完全無關。
 *
 * ## 2026-10-08：加 `merchantId`（按供應商過濾）
 * 需求：商家揀咗「大大超市」之後，品項彈窗只應該出**喺大大超市買過嘅嘢**，
 * 唔係全店所有品項。
 *
 * 🔴 為何一定要喺 server 過濾而唔係前端篩：
 *    呢支 route 只回全域最近 `RAW_LIMIT`(400) 行。某供應商較舊嘅品項可能
 *    根本唔喺呢 400 行入面 ⇒ 前端點篩都會漏（「明明買過但搵唔到」）。
 *
 * ## 成本
 * - 唔帶 `merchantId`：**一次** query（同以前一樣）。
 * - 帶 `merchantId`：最多 **三次** narrow query（驗歸屬 → 該供應商收據 id → 品項）。
 * 前端每個供應商只會呼叫一次並本機快取，之後打字係本機過濾。
 *
 * ⚠️ `receipt_items.user_id` 係 expenseRecorder 自己 `save-receipt` 都會寫嘅欄位，
 * 所以係存在嘅。但仍然做 42703/42P01 防禦：舊專案若未補呢一欄，
 * 應該回「冇建議」而唔係令庫存頁爆掉。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const account = searchParams.get("account");
  const merchantId = (searchParams.get("merchantId") ?? "").trim();
  const client = getExpenseSupabaseClient();
  if (!client) return NextResponse.json({ ok: true, items: [], warning: "expense client 未設定" });

  const resolved = await resolveExpenseUserId(client, account);
  if ("error" in resolved) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: resolved.status });
  }

  /**
   * 該供應商嘅收據 id；`null` ＝「唔用供應商過濾」（回全店清單）。
   *
   * 🔴 **有 `merchantId` 就一定先驗歸屬**。
   *    `merchants` 係跨店共用嘅（`name` 全表唯一），但每一行有自己嘅 `user_id`
   *    ⇒ 唔驗就等於俾任何人用任意 merchant id 讀其他店嘅進貨歷史。
   */
  let receiptIds: string[] | null = null;
  if (merchantId) {
    const { data: merchant, error: mErr } = await client
      .from("merchants")
      .select("id")
      .eq("id", merchantId)
      .eq("user_id", resolved.userId)
      .maybeSingle();
    if (mErr) {
      if (isMissingColumnOrTable(mErr)) return NextResponse.json({ ok: true, items: [], matched: false });
      return NextResponse.json({ ok: false, error: mErr.message }, { status: 500 });
    }
    /*
     * 🔴 唔屬於本店／已被刪 ⇒ 當「冇歷史」，**唔可以**退回全店清單。
     *    退回會令商家以為嗰批品項係喺呢個供應商買過（比空白更差）。
     */
    if (!merchant) return NextResponse.json({ ok: true, items: [], matched: false });

    const { data: receipts, error: rErr } = await client
      .from("receipts")
      .select("id")
      .eq("merchant_id", merchantId)
      .order("created_at", { ascending: false })
      .limit(SUPPLIER_RECEIPT_LIMIT);
    if (rErr) {
      if (isMissingColumnOrTable(rErr)) return NextResponse.json({ ok: true, items: [], matched: false });
      return NextResponse.json({ ok: false, error: rErr.message }, { status: 500 });
    }
    receiptIds = (receipts ?? []).map((r) => String(r.id));
    if (receiptIds.length === 0) return NextResponse.json({ ok: true, items: [], matched: false });
  }

  /*
   * 🔴 2026-10-08：由 `name, unit_price, created_at` 擴到包 `quantity_unit`
   *    （需求：撳建議時要帶入該品項喺歷史單據用過嘅單位）。
   *    同 `/api/inventory/receipts` 同一口徑：舊環境冇呢一欄（42703）就降級
   *    唔選該欄 —— 單位留空，建議清單照出，唔可以因為一個可選欄位搞到 500。
   */
  let rows: Array<Record<string, unknown>> = [];
  {
    const base = client
      .from("receipt_items")
      .select("name, unit_price, quantity_unit, created_at")
      .eq("user_id", resolved.userId);
    const scoped = receiptIds ? base.in("receipt_id", receiptIds) : base;
    const { data, error } = await scoped.order("created_at", { ascending: false }).limit(RAW_LIMIT);

    if (error && isMissingColumnOrTable(error)) {
      const legacyBase = client
        .from("receipt_items")
        .select("name, unit_price, created_at")
        .eq("user_id", resolved.userId);
      const legacyScoped = receiptIds ? legacyBase.in("receipt_id", receiptIds) : legacyBase;
      const legacy = await legacyScoped.order("created_at", { ascending: false }).limit(RAW_LIMIT);
      if (legacy.error) {
        return NextResponse.json({ ok: false, error: legacy.error.message }, { status: 500 });
      }
      rows = legacy.data ?? [];
    } else if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    } else {
      rows = data ?? [];
    }
  }

  return NextResponse.json({
    ok: true,
    /**
     * `matched` 語意（前端可以據此出「此供應商尚無歷史品項」而唔係「載入失敗」）：
     * - 冇帶 `merchantId` ⇒ `true`（清單本身就係全店）
     * - 有帶而供應商存在、有單 ⇒ `true`
     * - 有帶而供應商唔屬本店／冇單 ⇒ `false`
     */
    matched: !merchantId || (receiptIds !== null && receiptIds.length > 0),
    items: aggregateItemSuggestions(rows, MAX_SUGGESTIONS),
  });
}
