/**
 * storeId 嘅共用防護（假店黑名單）。
 *
 * 【背景】`macau-store-a` 係 `docs/sql/admin-account-schema.sql` 嘅**示範店代碼**，
 * 同 `merchants.id`（UUID）係兩套嘢。但佢歷史上散落喺好多處當 fallback 用，
 * 而 `STORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/` 係**過到**佢嘅 —— 即係單靠格式檢查擋唔到。
 *
 * 寫咗落 `pos_print_jobs.store_id` / `pos_print_agents.store_id` 會出現最難 debug 嘅
 * silent failure：配對 UI 話「已配對」，但 Realtime filter `store_id=eq.<真 UUID>` 永遠
 * 唔 match、claim 返 0 列 → **一張單都印唔出**。
 *
 * 所以：**所有會寫 store_id 落 DB 嘅入口都要過呢道黑名單。**
 *
 * 用法：
 *   if (isPlaceholderStoreId(storeId)) return 400;
 */

/** 假店黑名單：呢啲係 mock / 範例值，一見即擋（唔使靠 DB 查詢，零基建風險）。 */
export const PLACEHOLDER_STORE_IDS: ReadonlySet<string> = new Set([
  "macau-store-a",
  "macau-store-b",
  "store-a",
  "store-b",
  "default",
  "demo",
  "test",
]);

/**
 * 係咪假店代碼？（大小寫唔敏感、前後空白會 trim）
 *
 * 只做字面比對，**唔查 DB** —— 呢度要喺每一個寫入入口低風險咁擋，
 * 查 DB 嘅「真商戶驗真」係 `POST /api/pos/print-agent/pair` 先做（因為佢可以 fail-open）。
 */
export function isPlaceholderStoreId(storeId: string | null | undefined): boolean {
  if (typeof storeId !== "string") return false;
  const trimmed = storeId.trim();
  if (!trimmed) return false;
  return PLACEHOLDER_STORE_IDS.has(trimmed.toLowerCase());
}

/** 畀錯誤訊息用：列出黑名單，方便用家／工程師一眼認出自己填錯乜。 */
export function describePlaceholderStoreIds(): string {
  return [...PLACEHOLDER_STORE_IDS].join("、");
}
