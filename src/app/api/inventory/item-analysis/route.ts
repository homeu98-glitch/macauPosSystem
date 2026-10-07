import { NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { getExpenseSupabaseClient } from "@/lib/expense-supabase";
import { listProducts, type InvProduct } from "@/lib/inventory-products";
import { isMissingColumnOrTable } from "@/lib/expense-inventory";
import {
  buildAmountRanking,
  buildCategoryBreakdown,
  buildItemAnalysisRows,
  summarizeItemAnalysis,
  type AmountRankPoint,
  type CategorySharePoint,
} from "@/lib/item-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 🔴 2026-10-07：`inv_products.baseline_unit_cost` / `baseline_at` 係 migration 0065 嘅新欄。
 *
 * 若生產環境**未跑 0065**，`select("*")` 唔會爆（star 只回實際存在嘅欄），
 * 但 `listProducts()` 出嚟嘅物件冇 baseline ⇒ 全部品項都會被當「首次記錄」，
 * 而 `summarizeItemAnalysis()` 會老實報 `newCount = 全部`。
 *
 * 呢個係**靜默錯誤**：畫面唔會爆，但 KPI 會長期顯示「漲價品項 0」而商家以為真係冇漲價。
 * 所以喺 route 層主動抽驗一行，偵測到欄位缺席就明確回一個警告字串（UI 出黃色提示條），
 * 而**唔係**靜默降級 —— 同 `inventory-view.tsx` 處理 `schemaReady:false` 同一思路。
 */
function detectMissingBaselineColumn(products: InvProduct[]): boolean {
  if (products.length === 0) return false;
  return products.every(
    (p) => !Object.prototype.hasOwnProperty.call(p, "baseline_unit_cost"),
  );
}

/**
 * 唯讀：組出「庫存 › 品項分析」畫面所需嘅一切。
 *
 * 資料來源（**跨兩個 Supabase 專案**）：
 *   · macau 專案   → `inv_products`（庫存數量／加權價／基準價／分類／供應商）
 *   · expense 專案 → `shop_users`（account → 店戶），只為**確認店戶存在**，
 *                    令「帳號打錯」同「真係冇貨」唔會都顯示成空白畫面。
 *
 * ⚠️ 為何唔喺呢度由 `receipt_items` 即時重算基準價：
 *    基準價係**一經鎖定永不覆寫**（J 2026-10-07 拍板），佢嘅鎖定時機係
 *    `syncFromReceipts()`（`inventory-products.ts:293-302`）。
 *    若呢度再即時重算一次，就會出現「報表顯示 A、DB 顯示 B」嘅雙真源，
 *    而且補登／刪除舊收據會令已報告過嘅金額靜默改變。
 *    ⇒ **唯一真源 ＝ `inv_products.baseline_unit_cost`**，呢條 route 只讀不算。
 *
 * 降級（跟 `receipts/route.ts` 同一套路，**唔可以因為可選依賴而整頁 500**）：
 *   · macau client 未設定        → 503（庫存係核心，冇得降級）
 *   · expense client 未設定      → 照回庫存資料，`matched: null`
 *   · expense 表未建立（42P01）  → 照回庫存資料，`schemaReady:false`
 *   · baseline 欄未存在（0065）  → 照回資料，附 `warning` 明確講明
 *
 * 🔴 2026-10-07 加 `receiptCount`：令前端分得清「真係冇貨」同「有收據但未同步」。
 *    實例 —— 商家錄咗兩日收據從未按過同步 ⇒ 分析頁永遠空白，而畫面只叫佢
 *    「去設置按同步」，佢唔知有一步未做。有 `receiptCount` 就可以直接喺
 *    空狀態嗰度出一鍵同步，唔使人自己去搵。
 *
 * Query：
 *   `store`（必填，＝ merchantId）· `account`（選填，只作店戶存在性檢查）
 *   `range`（`today|yesterday|7d|30d|90d|all|custom`，選填）＋ `start`/`end`。
 *
 *   ⚠️ `range` 目前**唔會過濾任何數字**：庫存分析係「現況快照」（當下庫存 × 當下成本），
 *      唔似買貨統計係期間累加。保留參數係為咗將來加「期間內曾進貨」篩選時唔使改契約，
 *      並喺回應明寫 `stockRangeIgnored: true`，避免前端誤以為已經 filter 咗。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const store = searchParams.get("store");
  if (!store) return NextResponse.json({ ok: false, error: "缺少 store" }, { status: 400 });
  const account = searchParams.get("account");

  const macau = getSupabaseAdminClient();
  if (!macau) return NextResponse.json({ ok: false, error: "macau-pos supabase 未設定" }, { status: 503 });

  // 1) 庫存品（核心；失敗即 500）
  const result = await listProducts(macau, store);
  if ("error" in result) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  const products = result.data;

  // 2) 組列 + 摘要（純函式，可被 node --test 覆蓋）
  const rows = buildItemAnalysisRows(products);
  const summary = summarizeItemAnalysis(rows);

  // 3) expense 側存在性檢查（可選依賴 ⇒ 全部降級，唔 500）
  let matched: boolean | null = null;
  let schemaReady = true;
  let message: string | undefined;
  /**
   * 🔴 2026-10-07：就算 `inv_products` 係空，都要答得出「係真係冇貨，定係未同步」。
   *
   * 呢個係實際發生過嘅事故：商家連續兩日錄咗 35 張收據，但從未按過
   * 「從收據同步」⇒ `inv_products` 一直係空 ⇒ 品項分析永遠顯示空狀態，
   * 而畫面只叫佢「請先到設置按同步」，佢根本唔知原來有一步未做。
   *
   * ⇒ 回一個 `receiptCount`，前端就可以分辨：
   *      receiptCount > 0 且 rows 為空 ＝ 「有待同步嘅收據」→ 出**一鍵同步**按鈕
   *      receiptCount ＝ 0              ＝ 真係冇收據 → 出普通空狀態
   *
   * ⚠️ 只喺 rows 為空時先查（有貨就冇必要多打一個 count 請求 —— egress 敏感）。
   * ⚠️ count 用 `head: true` 唔拉任何列，成本近乎零。
   */
  let receiptCount: number | null = null;
  const expense = getExpenseSupabaseClient();
  if (!expense) {
    matched = null;
    message = "expenseRecorder 未設定，供應商名稱等由 expenseRecorder 補充的資訊可能不完整。";
  } else if (!account) {
    matched = null;
  } else {
    const { data: shopUser, error: suErr } = await expense
      .from("shop_users")
      .select("id")
      .eq("login_id", account)
      .maybeSingle();
    if (suErr) {
      if (isMissingColumnOrTable(suErr)) {
        schemaReady = false;
        message = "expenseRecorder 資料表尚未建立，部分資訊無法顯示。";
      } else {
        // 非 schema 問題：唔好阻住庫存分析 —— 記低原因，照回資料
        message = `expenseRecorder 查詢失敗：${suErr.message}`;
      }
    } else if (!shopUser) {
      matched = false;
      message = "expenseRecorder 找不到相同帳號的店戶。";
    } else {
      matched = true;
      // 只喺「庫存空」時才探測收據數（見上方註釋）
      if (rows.length === 0) {
        const { count, error: cErr } = await expense
          .from("receipts")
          .select("id", { count: "exact", head: true })
          .eq("user_id", shopUser.id);
        if (!cErr) receiptCount = count ?? 0;
      }
    }
  }

  // 4) migration 0065 偵測（見 detectMissingBaselineColumn 註釋）
  const missingBaseline = detectMissingBaselineColumn(products);
  const warning = missingBaseline
    ? "資料庫尚未加入基準價欄位（migration 0065 baseline_unit_cost / baseline_at）。目前所有品項都會顯示「首次記錄」，漲價統計無法計算。請先執行 0065 migration，再於「設置」觸發一次同步。"
    : undefined;

  // 5) 圖表資料（用未篩選嘅全量，先算好，前端唔使再算一次）
  const amountRanking: AmountRankPoint[] = buildAmountRanking(rows, 6);
  const categoryBreakdown: CategorySharePoint[] = buildCategoryBreakdown(rows);

  return NextResponse.json({
    ok: true,
    matched,
    schemaReady,
    ...(message ? { message } : {}),
    ...(warning ? { warning } : {}),
    /** 該店戶在 expenseRecorder 嘅收據總數；`null` ＝ 未探測／探測失敗。 */
    receiptCount,
    /** 明示 `range` 未參與過濾，防止前端誤會（見 route 註釋）。 */
    stockRangeIgnored: true,
    rows,
    summary,
    amountRanking,
    categoryBreakdown,
  });
}
