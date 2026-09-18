import { test } from "node:test";
import assert from "node:assert/strict";

import { isReopenedOrder, reopenBadgeLabel } from "./reopen-badge.ts";

test("冇返結過 → 冇標籤", () => {
  assert.equal(isReopenedOrder({ reopenCount: 0 }), false);
  assert.equal(reopenBadgeLabel({ reopenCount: 0 }), null);
  assert.equal(isReopenedOrder({}), false);
  assert.equal(reopenBadgeLabel({}), null);
  assert.equal(isReopenedOrder(null), false);
  assert.equal(isReopenedOrder(undefined), false);
});

test("返結一次 → 「已返結 ×1」", () => {
  assert.equal(isReopenedOrder({ reopenCount: 1 }), true);
  assert.equal(reopenBadgeLabel({ reopenCount: 1 }), "已返結 ×1");
});

test("返結多次 → 次數照出", () => {
  assert.equal(reopenBadgeLabel({ reopenCount: 3 }), "已返結 ×3");
});

test("🔴 重結之後（settled）標籤仍然在 —— 審計痕跡唔可以隨重結抹走", () => {
  // 呢個係核心契約：`reopenCount` 唔清零，標籤就永遠在。
  // 判準只看 reopenCount，唔看 status —— 所以已重結（settled）嘅單一樣出標籤。
  // （物件刻意只帶 `reopenCount`：函式簽名只讀呢個欄位，唔應該依賴 status。）
  const settledAfterReopen = { reopenCount: 1 };
  assert.equal(isReopenedOrder(settledAfterReopen), true, "已重結嘅單仍然係「曾返結」");
  assert.equal(reopenBadgeLabel(settledAfterReopen), "已返結 ×1");
});

test("reopened 狀態但 reopenCount 缺失 → 唔出標籤（reopenCount 才係唯一真源）", () => {
  // 防禦：正常流程 reopenPosOrder() 一定會寫 reopenCount，
  // 但舊資料 / 手改過嘅 snapshot 可能冇。此時寧願唔出，都唔好出「×undefined」。
  // 注意：函式**唔會**讀 status，所以「狀態係 reopened」本身就唔構成顯示理由。
  assert.equal(reopenBadgeLabel({}), null);
  assert.equal(reopenBadgeLabel({ reopenCount: undefined }), null);
});

test("異常值（負數 / NaN）一律當冇返結", () => {
  assert.equal(isReopenedOrder({ reopenCount: -1 }), false);
  assert.equal(isReopenedOrder({ reopenCount: Number.NaN }), false);
  assert.equal(reopenBadgeLabel({ reopenCount: Number.NaN }), null);
});
