/**
 * 快餐（counter）單嘅出餐階段文案 —— **零依賴純函式**。
 *
 * ## 點解要獨立成一個檔
 *
 * 呢兩個函式原本住喺 `@/lib/quick-order-fulfillment`（一個會寫 localStorage、
 * import `@/lib/storage` 嘅 client 模組），令 `pos-order-filters.ts` 呢個純判斷模組
 * 被迫拖住一整條 client 依賴鏈，**完全冇得做單元測試**
 * （`node --test` 只可以載入零 runtime 依賴嘅 `.ts`）。
 *
 * 出餐文案 + 狀態判斷係「已收款 / 已出餐」呢類**沉默 bug** 嘅高風險區
 * （唔會 throw、唔會報錯，只會令收銀睇錯狀態），一定要有回歸測試鎖住 ——
 * 所以把純函式抽出嚟，同 `daily-order-seq.ts` / `order-status-label.ts` 同一做法。
 *
 * ⚠️ 呢個檔**唔可以** import 任何嘢（除咗 type）。要加功能前先諗清楚。
 */

/**
 * 出餐階段（`fulfillmentStatus === "ready"`）嘅狀態文案。
 *
 * 語義係「已經做好、等客人嚟攞」—— 唔同枱別叫法唔同：
 * 自取 → 待取餐；外賣 → 待交付；其餘（快餐堂食 / 未分類）→ 待出餐。
 */
export function quickCompletionLabel(order: Pick<{ tableName?: string }, "tableName">): string {
  if (order.tableName === "自取") return "待取餐";
  if (order.tableName === "外賣") return "待交付";
  return "待出餐";
}

/**
 * 快餐單「完成」掣 / 「已完成」狀態嘅文案（同 `quickCompletionLabel` 成對）。
 */
export function quickCompleteLabel(order: Pick<{ tableName?: string }, "tableName">): string {
  if (order.tableName === "外賣") return "已交付";
  if (order.tableName === "自取") return "已取餐";
  return "已完成";
}
