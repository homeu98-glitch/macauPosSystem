import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { PosOrderDbRow } from "@/lib/pos-order-row";

/** 由 client 推導 FilterBuilder 型別（untyped client → any 泛型，唔使手寫 4-8 個泛型參數）。 */
type OrderFilterBuilder = ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;

/**
 * 報表區間訂單查詢（兩腿合併，OR 語義）——2026-09-06 問題 6 根治。
 *
 * 【口徑】報表計數用 `orderMatchesReportRange`（src/lib/ledger/report-period.ts），
 *   而佢 2026-09-19 起改用 `orderEventInstant()`：
 *   `reopenedAt → originalSettledAt → updatedAt → createdAt` 取第一個有效值，
 *   落喺 Macau 區間 [start, end] 內就算。
 *   所以 SQL layer 必須回傳**超集**：任何一條腿命中就要回。
 *
 *   🔴 2026-09-19 加第三條腿 `reopened_at`：原本只有 created / updated 兩腿。
 *   返結（反結賬）會寫 `reopened_at`，但**唔一定**同時刷新 `updated_at`
 *   （見 docs/113「加 pos_orders 欄位要改四條讀取路徑」嗰條鐵律 —— 中過兩次）。
 *   ⇒ 一張「昨日開、今日返結重結」嘅單，created_at 同 updated_at 可能**都唔喺**今日區間，
 *   於是 SQL 唔回、client 永遠睇唔到 ⇒ 報表**靜默少錢**。
 *   加呢條腿之後，SQL 仍然只係超集（多回無害，client 端 `orderMatchesReportRange` 會再篩一次）。
 *
 * 【點解唔用 .or()】
 *   - 舊版 `.or('and(created_at.gte.X,...),and(updated_at.gte.X,...)')`（nested and 群組）
 *     係 2026-09-04 commit 4f14c8e 先引入，無長期生產驗證；supabase-js 2.112 將整個
 *     filter 字串 URL-encode 後，PostgREST 對 nested 群組 + `+08:00` offset 值嘅解析
 *     存喺回 0 筆嘅風險（admin 報表「全部→今天」空資料嘅候選根因）。
 *   - 中間版本改過 `.filter()` chain（AND 語義）——**錯**：會漏「昨日開單、今日結帳」
 *     （created_at < start 但 updated_at ∈ 區間）嘅單，同 client 口徑矛盾。
 *
 * 【而家嘅做法】三條**完全無 logic 語法**嘅 plain indexed 查詢並行：
 *   - created 腿：`created_at ∈ [start,end]`（涵蓋 NULL updated_at 嘅 legacy row）
 *   - updated 腿：`updated_at ∈ [start,end]`（涵蓋昨日開單今日結帳）
 *   - reopened 腿：`reopened_at ∈ [start,end]`（涵蓋昨日開單今日返結重結）
 *   Server 端按 `id` 去重合併 + `created_at` DESC 排序。三腿各自 `.range(offset, offset+limit-1)`
 *   分頁；合併結果係超集，client 用「回傳筆數 < PAGE 就停」嘅迴圈仍可收齊全部
 *   （每頁最多 3×limit，多拉一頁即可收完，終止條件不受影響）。
 *
 * 【時區】start / end 喺呼叫端先轉成 UTC ISO（`...Z`），徹底避開 `+08:00` offset
 *   喺 filter 值入面嘅解析歧義（UTC 轉換係 lossless：同一 instant）。
 */

export type OrdersInRangeParams = {
  supabase: SupabaseClient;
  /** 唔帶 = 全部店（admin 跨店彙總用；POS / 單店模式一定帶） */
  storeId?: string | null;
  /** UTC ISO（`...Z`）；null = 無下限 */
  start?: string | null;
  /** UTC ISO（`...Z`）；null = 無上限 */
  end?: string | null;
  limit: number;
  offset: number;
};

export type OrdersInRangeResult = {
  orders: PosOrderDbRow[];
  error: string | null;
};

function applyRange(
  query: OrderFilterBuilder,
  column: "created_at" | "updated_at" | "reopened_at",
  start?: string | null,
  end?: string | null,
) {
  let q = query;
  if (start) q = q.gte(column, start);
  if (end) q = q.lte(column, end);
  return q;
}

export async function fetchOrdersInRange(params: OrdersInRangeParams): Promise<OrdersInRangeResult> {
  const { supabase, storeId, start, end, limit, offset } = params;

  // 三腿基礎查詢（同 table、同 store 過濾）——先 .select("*") 轉 FilterBuilder，
  // 之後嘅 conditional .gte() / .lte() chain 先會全部喺同一型別上（PostgrestQueryBuilder
  // 嘅 .eq() 會跳去 FilterBuilder，直接 chain 會撞型別鴻溝）。
  const base = () =>
    storeId ? supabase.from("pos_orders").select("*").eq("store_id", storeId) : supabase.from("pos_orders").select("*");

  // 各腿只 filter 自己嘅時間欄位 + 同 window 分頁，plain chain、零 .or() 語法。
  const createdQuery = applyRange(base(), "created_at", start, end)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  const updatedQuery = applyRange(base(), "updated_at", start, end)
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1);
  // 🔴 第三腿：返結會寫 `reopened_at`，但唔一定刷新 `updated_at`（見檔頭註釋）。
  const reopenedQuery = applyRange(base(), "reopened_at", start, end)
    .order("reopened_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const [createdRes, updatedRes, reopenedRes] = await Promise.all([createdQuery, updatedQuery, reopenedQuery]);

  if (createdRes.error) return { orders: [], error: createdRes.error.message };
  if (updatedRes.error) return { orders: [], error: updatedRes.error.message };
  // ⚠️ reopened 腿係「加碼」而非「必需」：若該欄位／索引喺某個環境未就緒，
  // 唔應該令成個報表失敗（會由「少一張返結單」變成「全頁 error」）。
  // 所以呢條腿出錯只當「冇命中」，其他兩腿照用。
  if (reopenedRes.error) {
    console.warn("[pos-orders-range] reopened_at 腿查詢失敗，已略過：", reopenedRes.error.message);
  }

  // 按 id 去重合併（三腿之間必然有交集：多個時間欄位都喺區間內嘅單）
  const merged = new Map<string, PosOrderDbRow>();
  for (const row of (createdRes.data ?? []) as PosOrderDbRow[]) merged.set(row.id, row);
  for (const row of (updatedRes.data ?? []) as PosOrderDbRow[]) {
    if (!merged.has(row.id)) merged.set(row.id, row);
  }
  for (const row of (reopenedRes.data ?? []) as PosOrderDbRow[]) {
    if (!merged.has(row.id)) merged.set(row.id, row);
  }

  // 統一按 created_at DESC（client 聚合唔依賴順序，但穩定輸出方便診斷）
  const orders = [...merged.values()].sort((a, b) => {
    const ta = Date.parse(a.created_at ?? "") || 0;
    const tb = Date.parse(b.created_at ?? "") || 0;
    return tb - ta;
  });

  return { orders, error: null };
}
