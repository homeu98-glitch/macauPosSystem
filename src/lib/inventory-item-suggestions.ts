/**
 * 歷史品項建議（新增／編輯收據嘅「品項」快速選取）—— 聚合純函式。
 *
 * ## 為何要獨立成一個檔
 *
 * 🔴 呢個檔**零 import**（連 `type` 都唔可以 import）。
 *    本專案嘅測試係 `node --test`（見 `package.json`），佢**唔認** `@/` alias、
 *    亦唔識 `.tsx` ⇒ 只有「零 import 嘅純函式模組」先可以被測試直接 import。
 *    把聚合邏輯擺喺 `route.ts`（有 NextResponse／supabase import）會完全測唔到。
 *
 * ## 用途
 *
 * `GET /api/inventory/receipt-items` 由 `receipt_items` 拉一批原始行
 * （**已由 server 按 `created_at` 由新到舊排好**，呢個前提係下面「保留第一眼」嘅依據），
 * 交落嚟聚合成「品名 → 最近一次」嘅建議清單。
 *
 * ⚠️ 呼叫者可以帶 `merchantId` 令 server 只回某個供應商嘅品項
 * （＝「大大超市買過嘅嘢」）。本函式**唔理**來源係全店定單一供應商，
 * 只負責聚合 —— 咁樣兩種情境可以共用同一套口徑。
 */

/** 一個歷史品項建議（UI 直接渲染成 chip）。 */
export type ItemSuggestion = {
  /** 顯示用嘅品名（保留原本大小寫／空白已 trim）。 */
  name: string;
  /** 最近一次嘅單價（**參考用**，UI 只會喺單價欄空白時才填入）。 */
  unit_price: number;
  /**
   * 最近一次嘅單位（expenseRecorder `receipt_items.quantity_unit`）。
   *
   * 🔴 舊資料／舊 schema 冇呢一欄 ⇒ **空字串**。
   *    唔可以亂填「個」之類嘅假單位（同 `/api/inventory/receipts` 同一口徑）。
   */
  unit: string;
  /** 最近一次出現嘅日期（`YYYY-MM-DD`，可能係空字串）。 */
  last_date: string;
  /** 該名字喺今次窗口內出現過幾多次。 */
  count: number;
};

/**
 * 把 `receipt_items` 原始行聚合成建議清單。
 *
 * 口徑：
 * - 以「`trim()` 後轉細寫」做 key。中文唔受大小寫影響，但英文品名（POS 手打）會
 *   ⇒ 避免 `Coke` / `coke` 喺建議清單出現兩次。
 * - 同一 key **只保留第一眼見到嘅一行**（＝最新嗰次）嘅 `name` / `unit_price` / `unit` / `last_date`。
 *   `count` 累加全部出現次數。
 * - 品名係空／唔係字串 ⇒ 直接跳過（唔可以出一個冇名嘅 chip）。
 *
 * @param rows  server 回嘅原始行（**必須** already ordered by `created_at` desc）
 * @param limit 最多回幾個（前端會再本機過濾，唔會為打字再打 server）
 */
export function aggregateItemSuggestions(
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined,
  limit: number,
): ItemSuggestion[] {
  const byKey = new Map<string, ItemSuggestion>();

  for (const row of rows ?? []) {
    const raw = typeof row.name === "string" ? row.name.trim() : "";
    if (!raw) continue;
    const key = raw.toLowerCase();

    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      continue; // 已經由新到舊排序 ⇒ 第一眼見到嘅就係最新，唔覆蓋
    }

    byKey.set(key, {
      name: raw,
      unit_price: Number(row.unit_price) || 0,
      // 欄位缺席（舊 schema）⇒ 空字串。注意 `Number(null)` 係 0 但 `String(null)` 係 "null"，
      // 所以一定要做 `typeof === "string"` 判斷而唔可以靠 falsy。
      unit: typeof row.quantity_unit === "string" ? row.quantity_unit.trim() : "",
      last_date: typeof row.created_at === "string" ? row.created_at.slice(0, 10) : "",
      count: 1,
    });
  }

  // Map 嘅插入次序＝由新到舊 ⇒ 直接 slice 就係「按最近使用排序」。
  return Array.from(byKey.values()).slice(0, Math.max(0, limit));
}
