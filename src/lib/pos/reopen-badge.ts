/**
 * 「已返結」標籤文案 —— 全 repo 唯一真源。
 *
 * 【為何獨立成檔】
 * 呢個係**純函式、零 import**（只讀三個欄位），所以 `node --test` 直接載得到
 * （`npm test` = `node --test`，唔認 `@/` 別名、唔行 bundler）。
 * 標籤要喺三個載體共用（訂單列表 / 報表訂單明細 / 訂單詳情），
 * 如果每個 component 自己砌一次，文案口徑一定飄。
 *
 * 【為何「原因」唔喺呢個函式出】
 * 原因（`reopenReason`）只喺**詳情頁**有足夠橫向空間顯示。
 * 列表欄位窄，塞落去會截斷成「已返結 ×1 價…」，反而睇唔到重點。
 * 所以原因由 call site 自己決定要唔要顯示。
 *
 * 【為何標籤係永久】
 * `reopenCount > 0` 就帶標籤，**即使張單之後重新結帳（`settled`）都唔會消失**。
 * 理由：返結過係**歷史事實**，唔係「當前狀態」。
 * 收銀／對帳要知「呢張單被人改過」，所以審計痕跡唔可以隨重結抹走
 * （同 `reopenPosOrder()` 寫 `reopenCount` 單調遞增嘅設計一致）。
 */

/** 判定「曾返結過」—— 只看 `reopenCount`，唔看 `status`。 */
export function isReopenedOrder(order: { reopenCount?: number } | null | undefined): boolean {
  if (!order) return false;
  const count = order.reopenCount ?? 0;
  return Number.isFinite(count) && count > 0;
}

/**
 * 標籤文字：`已返結 ×1` / `已返結 ×3`。
 * 冇返結過 → 回 `null`（call site 直接唔 render，唔使再判一次）。
 *
 * ⚠️ 唔用「已返結」單獨一個詞，因為 `pos-order-filters.ts` 嘅**狀態標籤**
 * 已經有「已返結」（`status === "reopened"`）。兩者語義唔同：
 *   - 狀態標籤：**當前**狀態係 reopened（等緊重結）
 *   - 本標籤：**曾經**返結過幾多次（重結完仍然在）
 * 帶上次數（`×N`）就唔會同狀態標籤撈亂，亦順便帶出「改過幾次」嘅資訊。
 */
export function reopenBadgeLabel(order: { reopenCount?: number } | null | undefined): string | null {
  if (!isReopenedOrder(order)) return null;
  return `已返結 ×${order!.reopenCount}`;
}
