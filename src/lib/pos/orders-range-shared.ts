/**
 * `/api/pos/state` 訂單區間查詢嘅**純決策邏輯**（2026-09-21 egress 優化）。
 *
 * 🔴 為咩要抽一個零 import 嘅模組出嚟：
 *   `pos-orders-range.ts` 有 `import "server-only"`（Next 嘅 server 邊界保護），
 *   而 `node --test` 解唔到 `server-only` 呢個 package
 *   → 有 I/O 嘅執行層必須同純邏輯分檔，否則最新嘅降級邏輯完全冇回歸保護。
 *   （專案規則：可測模組必須零 import；見 MEMORY.md「UI／環境（硬性）」。）
 *
 * 呢個檔**只可以有 `import type` 同相對路徑嘅零 import 模組**。
 */

import { isMissingColumnError, isMissingFunctionError, type SupabaseLikeError } from "../supabase-errors.ts";

// ─────────────────────────────────────────────────────────────
// 三腿合併
// ─────────────────────────────────────────────────────────────

/** 任何有 `id` 嘅 row（`pos_orders` row 嘅最小契約）。 */
export interface IdentifiableRow {
  id: string;
  created_at?: string | null;
}

/**
 * 三條時間腿嘅結果 → 按 `id` 去重 + 統一按 `created_at` **desc** 排序。
 *
 * 舊版呢段係 inline 寫喺 `fetchOrdersInRange()` 內（I/O 檔），所以冇辦法測。
 * 抽出嚟之後可以由 fixture 直接鎖死「去重」同「排序」兩個唔可以錯嘅行為：
 *   · 同一張單可以同時命中多條腿（created 同 updated 都落喺區間）→ 只可以回一次；
 *   · 排序唔一致會令 client 分頁出現重複／漏行（報表少錢）。
 *
 * @param legs 各腿嘅 row 陣列（次序無關；通常係 created / updated / reopened）
 * @param override 可選嘅排序鍵覆寫（測試用；預設睇 `created_at`）
 */
export function mergeOrderLegs<T extends IdentifiableRow>(legs: T[][], override?: (row: T) => number): T[] {
  const merged = new Map<string, T>();
  for (const leg of legs) {
    for (const row of leg ?? []) {
      if (!row || typeof row.id !== "string") continue;
      if (!merged.has(row.id)) merged.set(row.id, row);
    }
  }
  const key = override ?? ((row: T) => Date.parse(row.created_at ?? "") || 0);
  return [...merged.values()].sort((a, b) => key(b) - key(a));
}

// ─────────────────────────────────────────────────────────────
// 降級方向判別
// ─────────────────────────────────────────────────────────────

/**
 * 查詢失敗之後應該點做。
 * - `rpc-missing`：SQL RPC 未部署（migration 0046 未跑）→ 用三條時間腿
 * - `projection-missing`：投影帶咗未跑 migration 嘅欄（42703）→ 用 `select("*")` 重試
 * - `fatal`：真 DB 錯誤（超時 / 權限 / 網絡）→ **唔可以**降級重試
 *   （否則同一個慢查詢會變三次，而且會令真錯誤被靜默吞掉）
 */
export type OrdersRangeFailure = "rpc-missing" | "projection-missing" | "fatal";

export function classifyOrdersRangeFailure(error: SupabaseLikeError | null | undefined): OrdersRangeFailure {
  // 一定要先判「函數唔存在」：PostgREST 對唔存在嘅函數回 PGRST202，
  // 而對唔存在嘅**欄位**回 PGRST204 —— 兩者唔可以撈埋。
  if (isMissingFunctionError(error)) return "rpc-missing";
  if (isMissingColumnError(error)) return "projection-missing";
  return "fatal";
}

/**
 * 三腿之中「reopened 腿」失敗時嘅處理（**歷史包袱，唔可以改語義**）。
 *
 * `reopened_at` 係 0043 之後先有嘅欄。舊行為係：該腿出錯只當「冇命中」，
 * 其他兩腿照用 —— 因為由「少一張返結單」變成「全頁 error」係更差嘅結果。
 *
 * 🔴 但**投影失敗（42703 / PGRST204）要例外**：嗰陣係「我哋叫 DB 回一個唔存在嘅欄」，
 * 唔降級就變成「reopened 腿永遠 0 命中」＝ 報表靜默少咗返結重結嘅單。
 * ⇒ 投影類錯誤一定要向上報，由外層改成 `select("*")` 重試。
 *
 * @returns `"skip"` = 當冇命中繼續；`"fail"` = 向上報（觸發降級）
 */
export function decideReopenedLegOutcome(error: SupabaseLikeError | null | undefined): "skip" | "fail" {
  if (!error) return "skip";
  return isMissingColumnError(error) ? "fail" : "skip";
}
