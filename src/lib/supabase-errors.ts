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
