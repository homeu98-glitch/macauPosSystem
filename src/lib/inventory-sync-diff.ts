/**
 * 庫存品同步差異判斷（**零 import 純函式**，故 `node --test` 可以直接跑）。
 *
 * 🔴 背景（2026-10-07 J 拍板 · 優化 A）：
 *     J 要求「每次進入頁面都同步」。但 `syncFromReceipts` 原本係
 *     **per-item 迴圈 UPDATE，即使資料完全冇變都照寫**。
 *     成本隨品項數線性惡化：
 *
 *     | 品項數 | 每次進頁面 | 每月（開 10 次/日） |
 *     |---|---|---|
 *     | 31（現況） | 31 次寫入 | 9,300 |
 *     | 1,000 | 1,000 | **300,000** |
 *
 *     ⇒ 加一層「有冇真嘅變化？」判斷，日常（冇新收據）由 N 次寫入 → **0 次**。
 *
 * 🔴 **語意完全不變**：寫入結果同原本一模一樣，只係唔做無謂嘅 UPDATE。
 *     要注意 `updated` 統計數仍然照計（＝掃到嘅既有品項數），
 *     另外用 `skipped_unchanged` 分開報告「有掃到但冇改」嘅數量。
 */

/** 浮點容差：`avg_unit_cost` 係 round 到 2 位嘅加權平均，用 0.005 避免假變化。 */
export const COST_EPSILON = 0.005;

/**
 * 單一庫存品嘅「同步目標值」。
 * 全部用 `null` 代表「冇值」，唔可以同 `0`／空字串混淆。
 */
export type SyncTarget = {
  /** 加權平均單價（已 round 2 位） */
  avgUnitCost: number;
  lastPurchaseDate: string | null;
  lastSupplier: string | null;
  category: string | null;
};

/** DB 現有值（只需要比較用嘅欄位）。 */
export type SyncCurrent = {
  avgUnitCost: number | null;
  lastPurchaseDate: string | null;
  lastSupplier: string | null;
  category: string | null;
};

const norm = (v: string | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};

/**
 * 目標值同現有值**有實質差異**？
 *
 * 🔴 用嚴謹判斷，唔可以用寬鬆 fallback：
 *    同步邏輯本身係 `row.last_date ?? hit.last_purchase_date`
 *    （即「掃到嘅為準，掃唔到就保留舊值」），
 *    所以**傳入嚟嘅 target 必須已經係最終值**，呢度只做逐欄比對。
 *
 * @param hasBaselinePatch 有基準價要寫（`baseline_unit_cost` 由 NULL 變有值）——
 *   即使其餘欄位一樣，都必須寫，否則基準價永遠鎖唔到。
 */
export function hasMaterialChange(
  target: SyncTarget,
  current: SyncCurrent,
  hasBaselinePatch: boolean,
): boolean {
  if (hasBaselinePatch) return true;

  // 成本：數值比較要容差（避免 12.499999 vs 12.5 呢類假變化）
  const curCost = current.avgUnitCost === null || current.avgUnitCost === undefined
    ? null
    : Number(current.avgUnitCost);
  if (curCost === null) return true;                  // 原本冇值 → 要寫
  if (!Number.isFinite(curCost)) return true;         // 壞值 → 當作要修
  if (Math.abs(curCost - target.avgUnitCost) > COST_EPSILON) return true;

  // 字串欄位：trim 後比對，空字串視同 null
  if (norm(target.lastPurchaseDate) !== norm(current.lastPurchaseDate)) return true;
  if (norm(target.lastSupplier) !== norm(current.lastSupplier)) return true;
  if (norm(target.category) !== norm(current.category)) return true;

  return false;
}

/**
 * 基準價要唔要寫？
 *
 * 🔴 只有喺**現有基準價係 NULL／undefined** 而且**今次掃到有候選值**時才寫。
 *     一經寫入**永不覆寫** —— 因為舊收據可能被刪／補登，
 *     若跟住飄移，已報告嘅上漲金額會「自己郁」（J 2026-10-07 拍板）。
 *
 * ⚠️ 刻意**唔用 `Number(x) > 0`** 判斷「有冇基準」：
 *     `Number(null)` 係 0、`Number(undefined)` 係 NaN，兩者語意唔同，
 *     而且基準價理論上可以係 0（免費贈品）⇒ 只認 `null`／`undefined`。
 */
export function shouldWriteBaseline(
  currentBaseline: number | null | undefined,
  candidateFirstUnitCost: number | null,
): boolean {
  if (currentBaseline !== null && currentBaseline !== undefined) return false;
  return candidateFirstUnitCost !== null && candidateFirstUnitCost !== undefined;
}

/** 同步統計（對外回報用）。 */
export type SyncCounts = {
  created: number;
  updated: number;
  skipped_unchanged: number;
};

/**
 * 把統計砌成人類可讀嘅一句。
 *
 * 🔴 只有**真嘅有變化**時先值得提示（見 P2「靜默原則」）——
 *     否則商家每次入頁面都見到「同步完成：新增 0、更新 31」，
 *     會以為系統有問題（其實 31 只係「掃到 31 個品項」）。
 */
export function syncSummaryText(c: SyncCounts): string | null {
  if (c.created === 0 && c.updated === 0) return null;
  const parts: string[] = [];
  if (c.created > 0) parts.push(`新增 ${c.created} 個`);
  if (c.updated > 0) parts.push(`更新 ${c.updated} 個`);
  return `已同步：${parts.join("、")}`;
}
