import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { POS_ORDER_DB_SELECT, type PosOrderDbRow } from "@/lib/pos-order-row";
import {
  classifyOrdersRangeFailure,
  decideReopenedLegOutcome,
  mergeOrderLegs,
  type OrdersRangeFailure,
} from "@/lib/pos/orders-range-shared";

/** 由 client 推導 FilterBuilder 型別（untyped client → any 泛型，唔使手寫 4-8 個泛型參數）。 */
type OrderFilterBuilder = ReturnType<ReturnType<SupabaseClient["from"]>["select"]>;

/**
 * 報表區間訂單查詢（兩腿合併，OR 語義）——2026-09-06 問題 6 根治。
 *
 * 【口徑】報表計數用 `orderMatchesReportRange`（src/lib/ledger/report-period.ts），
 *   而佢經 `orderEventInstant()` 取第一個有效值（2026-09-24 起嘅鏈：
 *   `settledAt → reopenedAt → originalSettledAt → updatedAt → createdAt`），
 *   落喺 Macau 區間 [start, end] 內就算。
 *   所以 SQL layer 必須回傳**超集**：任何一條腿命中就要回。
 *
 *   🔴 2026-09-24 加第四條腿 `settled_at`（0057，跨日漂移根治）：
 *   `updated_at` 係 server 蓋章，重推舊單會把佢推成重推當刻 ⇒ 一張「昨日結帳、
 *   今日被重推」嘅單，頭三腿喺**昨日**區間全部唔命中；client 口徑改用 `settledAt`
 *   做首選之後，SQL 超集一定要包埋呢條腿，否則昨日報表靜默少單。
 *   呢條腿係純 best-effort（migration 未跑嘅過渡期 42703 係常態 ⇒ 任何錯誤當冇命中）。
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
 * 【而家嘅做法】四條**完全無 logic 語法**嘅 plain indexed 查詢並行：
 *   - created 腿：`created_at ∈ [start,end]`（涵蓋 NULL updated_at 嘅 legacy row）
 *   - updated 腿：`updated_at ∈ [start,end]`（涵蓋昨日開單今日結帳）
 *   - reopened 腿：`reopened_at ∈ [start,end]`（涵蓋昨日開單今日返結重結）
 *   - settled 腿：`settled_at ∈ [start,end]`（涵蓋昨日結帳、今日被重推；0057）
 *   Server 端按 `id` 去重合併 + `created_at` DESC 排序。四腿各自 `.range(offset, offset+limit-1)`
 *   分頁；合併結果係超集，client 用「回傳筆數 < PAGE 就停」嘅迴圈仍可收齊全部
 *   （每頁最多 4×limit，多拉一頁即可收完，終止條件不受影響）。
 *   ⚠️ 呢條係 **RPC 唔可用時嘅降級路**；首選係單一 RPC `pos_orders_page`（0046/0057），
 *   佢喺 SQL 內做四腿 OR ⇒ 每行只回一次（唔會有四倍流量）。
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
  /**
   * PostgREST 欄位投影（逗號分隔）。**預設 ＝ `POS_ORDER_DB_SELECT`**（`pos_orders` 全部 mapper 會讀嘅欄）。
   *
   * 2026-09-21 egress 優化：`select("*")` 會連 mapper 完全唔讀嘅欄（DB 陸續加過嘅
   * `member_*` 等）都傳出嚟，而 PostgREST egress 係按 bytes 計費。
   * 投影清單同 `PosOrderDbRow` 由 `pos-order-row.test.ts` 焊死（漏欄／多欄都會即刻紅）。
   *
   * · 傳 `"*"` → 明確要求舊行為（全欄位）。
   * · 傳自訂清單 → 只限白名單欄位（例如對賬守護只要 `id,status,updated_at`）。
   *
   * ⚠️ 若清單帶咗一個 DB 未有嘅欄（migration 未跑），PostgREST 會回 42703
   * → 下面會**自動降級**做 `select("*")` 重試一次（同 note-presets-server 同一套做法），
   * 保證「舊 DB + 新 client」唔會因為投影而整個報表 500。
   */
  columns?: string;
};

export type OrdersInRangeResult = {
  orders: PosOrderDbRow[];
  error: string | null;
};

function applyRange(
  query: OrderFilterBuilder,
  column: "created_at" | "updated_at" | "reopened_at" | "settled_at",
  start?: string | null,
  end?: string | null,
) {
  let q = query;
  if (start) q = q.gte(column, start);
  if (end) q = q.lte(column, end);
  return q;
}

/**
 * 四條腿嘅實際查詢（原三腿邏輯，一行不改；只係 `select()` 改用傳入嘅投影，
 * 外加 0057 嘅第四條 `settled_at` 腿）。
 * @returns 合併結果 ＋ 失敗分類（`null` = 成功；供外層決定要唔要降級重試）。
 */
async function runTimeLegs(
  params: OrdersInRangeParams,
  columns: string,
): Promise<{ result: OrdersInRangeResult; failure: OrdersRangeFailure | null }> {
  const { supabase, storeId, start, end, limit, offset } = params;

  // 三腿基礎查詢（同 table、同 store 過濾）——先 .select(columns) 轉 FilterBuilder，
  // 之後嘅 conditional .gte() / .lte() chain 先會全部喺同一型別上（PostgrestQueryBuilder
  // 嘅 .eq() 會跳去 FilterBuilder，直接 chain 會撞型別鴻溝）。
  //
  // ⚠️ 型別註釋（2026-09-21）：`columns` 係 runtime 字串，supabase-js 對
  //    `select(columns: string)` 會將結果元素型別推成 `GenericStringError[]`，
  //    同上面由 ReturnType 推導嘅 `OrderFilterBuilder`（`unknown[]`）對唔上
  //    （連帶觸發 TS2589「型別實例化過深」）。呢度做一次**純型別層面**嘅 assertion
  //    收窄（runtime 完全一樣，`.gte()`/`.order()`/`.range()` 行為不變）。
  //    原本寫死 `select("*")` 時唔會撞到，係改成可變字串投影後才出現。
  const buildBase = () =>
    supabase.from("pos_orders").select(columns) as unknown as OrderFilterBuilder;
  const base = () => (storeId ? buildBase().eq("store_id", storeId) : buildBase());

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
  // 🔴 第四腿（0057 `settled_at`，跨日漂移根治）：client 口徑 2026-09-24 起以
  //    `settledAt` 為日歸屬首選 —— 一張「昨日結帳、今日被重推（updated_at 漂到今日）」
  //    嘅單，頭三腿喺**昨日**區間全部唔命中，要靠呢條腿補返，否則昨日報表靜默少單。
  const settledQuery = applyRange(base(), "settled_at", start, end)
    .order("settled_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const [createdRes, updatedRes, reopenedRes, settledRes] = await Promise.all([
    createdQuery,
    updatedQuery,
    reopenedQuery,
    settledQuery,
  ]);

  // 頭兩條腿係必需：出錯就要向上報（由外層決定係降級定真失敗）。
  // ⚠️ 判別收歸 `classifyOrdersRangeFailure()`（純函式、有單測）—— 唔可以喺呢度
  //    自己寫 `code === "42703"`，因為「函數唔存在」同「欄位唔存在」要分開處理。
  if (createdRes.error) {
    return {
      result: { orders: [], error: createdRes.error.message },
      failure: classifyOrdersRangeFailure(createdRes.error),
    };
  }
  if (updatedRes.error) {
    return {
      result: { orders: [], error: updatedRes.error.message },
      failure: classifyOrdersRangeFailure(updatedRes.error),
    };
  }
  // ⚠️ reopened 腿係「加碼」而非「必需」：若該欄位／索引喺某個環境未就緒，
  // 唔應該令成個報表失敗（會由「少一張返結單」變成「全頁 error」）。
  // 所以呢條腿出錯**一般**只當「冇命中」，其他兩腿照用；
  // 但投影類錯誤（42703）例外 —— 見 `decideReopenedLegOutcome()`（純函式、有單測）。
  const reopenedOutcome = decideReopenedLegOutcome(reopenedRes.error);
  if (reopenedOutcome === "fail") {
    return {
      result: { orders: [], error: reopenedRes.error?.message ?? "reopened 腿失敗" },
      failure: "projection-missing",
    };
  }
  if (reopenedRes.error) {
    console.warn("[pos-orders-range] reopened_at 腿查詢失敗，已略過：", reopenedRes.error.message);
  }

  // 🔴 settled 腿係**純 best-effort**：`settled_at` 係 0057 先加嘅欄，migration 人手跑 ⇒
  //    「新 code 已上、DB 未跑」係預期嘅過渡狀態（可以維持幾日），呢段時間佢 42703 係常態。
  //    ⇒ **任何錯誤都當冇命中**（冇 reopened 腿嗰種 42703 例外 —— 投影類錯誤會先喺
  //    頭兩條必需腿爆，由外層降級 `select("*")`，唔使靠呢條腿探測）。
  if (settledRes.error) {
    console.warn("[pos-orders-range] settled_at 腿查詢失敗，已略過：", settledRes.error.message);
  }

  // 按 id 去重合併 + 統一按 created_at DESC（純函式、有單測）。
  const orders = mergeOrderLegs([
    (createdRes.data ?? []) as PosOrderDbRow[],
    (updatedRes.data ?? []) as PosOrderDbRow[],
    (reopenedRes.data ?? []) as PosOrderDbRow[],
    (settledRes.data ?? []) as PosOrderDbRow[],
  ]);

  return { result: { orders, error: null }, failure: null };
}

/**
 * 單一 SQL RPC 路徑（migration 0046 `pos_orders_page`）——**首選**。
 *
 * 好處（2026-09-21 egress）：一條 SQL 內做 OR + 去重 + 排序 + 分頁
 * ⇒ **每行只回一次**（舊三腿係回三份、client 再去重）＝ 直接省 2/3。
 * 實測（Supabase log）：`pos_orders` 嘅 `limit=5000` 三腿一組係當時最大單一來源。
 *
 * @returns `{ok:false, missingFunction:true}` = 未跑 migration 0046 → caller 降級三腿。
 */
async function runRpc(
  params: OrdersInRangeParams,
  columns: string,
): Promise<
  { ok: true; result: OrdersInRangeResult } | { ok: false; failure: OrdersRangeFailure; error: string }
> {
  const { supabase, storeId, start, end, limit, offset } = params;

  const { data, error } = await supabase
    .rpc("pos_orders_page", {
      // ⚠️ `pos_orders.store_id` 係 **text**（見 0012），唔係 uuid。
      p_store_id: storeId ?? null,
      p_start: start ?? null,
      p_end: end ?? null,
      p_limit: limit,
      p_offset: offset,
    })
    // PostgREST 對 `returns setof <table>` 嘅函數支援 `?select=` 投影
    //（舊版 PostgREST 會忽略而回全欄位 —— 只會少省流量，唔會出錯）。
    .select(columns);

  if (error) {
    return {
      ok: false,
      failure: classifyOrdersRangeFailure(error),
      error: error.message,
    };
  }

  return {
    ok: true,
    result: { orders: (data ?? []) as unknown as PosOrderDbRow[], error: null },
  };
}

export async function fetchOrdersInRange(params: OrdersInRangeParams): Promise<OrdersInRangeResult> {
  const columns = params.columns?.trim() || POS_ORDER_DB_SELECT;

  // ── ① 首選：單一 RPC（1 次 round trip、每行只回一次）──
  const viaRpc = await runRpc(params, columns);
  if (viaRpc.ok) return viaRpc.result;

  // ── ② RPC 唔可用 → 降級：三條時間腿（舊行為）──
  // 「未跑 migration 0046」係**預期**情況（正常 warn 一句就夠）；
  // 其他錯誤（DB 故障 / 權限）就要令人見得到。
  // ⚠️ `fatal`（超時之類）都一律行呢條路：寧願慢一次，都唔可以令報表變空。
  if (viaRpc.failure === "rpc-missing") {
    console.warn(
      "[pos-orders-range] 搵唔到 pos_orders_page()（migration 0046 未跑）→ 降級用四條時間腿。" +
        "跑咗 0046 之後會自動用返單一查詢（egress 省成截）。",
    );
  } else {
    console.warn(`[pos-orders-range] RPC 失敗（${viaRpc.error}）→ 降級用四條時間腿。`);
  }

  const first = await runTimeLegs(params, columns);
  if (first.failure !== "projection-missing") return first.result;

  // ── ③ 再降級：投影帶咗一個 DB 未有嘅欄（migration 未跑 → 42703 / PGRST204）──
  // 行為同「未改動之前」完全一致（select("*")），所以舊環境唔會退化。
  // 只有 `projection-missing` 先會行到呢度 —— 真 DB 錯誤（超時 / 權限）唔會重試，
  // 免得同一個慢查詢跑三次，而且真錯誤必須向上報（唔可以靜默變「今日冇單」）。
  console.warn(
    `[pos-orders-range] 欄位投影失敗（${first.result.error}），降級為 select("*") 重試。` +
      "（跑齊 migration 之後就會自動用返投影）",
  );
  const fallback = await runTimeLegs(params, "*");
  return fallback.result;
}
