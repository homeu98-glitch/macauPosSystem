/**
 * Supabase / PostgREST 錯誤判別（共用）。
 *
 * 為咩要判「欄位唔存在」：新功能加欄（例如 `pos_orders.discount_note`）時，
 * 只要隻新 client 先上線、DB migration 未跑，寫入就會整個失敗 —— 而寫入失敗嘅
 * 後果唔止「新功能冇用」，係**整張單上唔到雲**（舊功能一齊死）。
 *
 * 所以凡係「帶新欄去寫」嘅位都要**降級重試**：拔走新欄再寫一次，
 * 保住主流程，新功能等 migration 跑完自然生效。讀取嗰邊同理（見 note-presets-server）。
 */

export interface SupabaseLikeError {
  code?: string | null;
  message?: string | null;
}

/**
 * 判斷係唔係「欄位唔存在」類錯誤。
 * - `42703` = undefined_column（Postgres）
 * - `PGRST204` = PostgREST schema cache 搵唔到欄位
 */
export function isMissingColumnError(error: SupabaseLikeError | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42703" || code === "PGRST204") return true;
  const message = String(error.message ?? "");
  return /column .* does not exist|Could not find the '.*' column/i.test(message);
}

/**
 * 判斷係唔係「唯一約束衝突」（`23505` unique_violation）。
 *
 * 用途（2026-09-21 內容唯一鍵）：`pos_print_jobs.once_key` 有 partial unique index，
 * 撞鍵代表**同一件事（同一張單 × 同一件事 × 同一部打印機）已經出過紙** ——
 * 呢個係**預期結果**，唔係基礎設施故障：
 *   · 唔可以當 `failInfra`（會令整批事件回 500、client 無限重試）；
 *   · 亦唔可以靜默當成功而唔 log（會查唔到「點解少咗一張紙」）。
 * ⇒ caller 應該：略過寫入 + `ack(true)` + `console.info` 留痕。
 */
export function isUniqueViolationError(error: SupabaseLikeError | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "23505") return true;
  return /duplicate key value violates unique constraint|already exists/i.test(
    String(error.message ?? ""),
  );
}

/**
 * 判斷係唔係「函數唔存在」類錯誤（2026-09-21，RPC 降級用）。
 * - `42883` = undefined_function（Postgres）
 * - `PGRST202` = PostgREST 喺 schema cache 搵唔到該 function
 *
 * 用途：`fetchOrdersInRange()` 改用 SQL RPC（`pos_orders_page`，見 migration 0046）
 * 之後，遇到**未跑 migration 嘅環境**要自動降級回「三條時間腿」路徑。
 * 唔可以只靠「有 error 就降級」：真係 DB 故障時降級會令同一個慢查詢變三次，
 * 所以一定要判準確係「函數唔存在」先降級。
 */
export function isMissingFunctionError(error: SupabaseLikeError | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42883" || code === "PGRST202") return true;
  const message = String(error.message ?? "");
  // ⚠️ 唔可以用泛泛嘅 /schema cache/：PostgREST 嘅**欄位**錯誤都含呢個字
  //    （"Could not find the 'x' column … in the schema cache"），會誤判。
  return /function .* does not exist|Could not find the function/i.test(message);
}
