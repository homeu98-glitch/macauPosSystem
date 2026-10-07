/**
 * 庫存同步差異判斷測試（優化 A）。
 *
 * 🔴 呢個檔案**只可以** import 零依賴嘅純函式模組（`node --test` 唔認 `@/` alias）。
 * 🔴 重點保護：`updated` 統計嘅意義 —— 商家會攞佢判斷「有冇嘢真嘅同步到」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COST_EPSILON,
  hasMaterialChange,
  shouldWriteBaseline,
  syncSummaryText,
  type SyncCurrent,
  type SyncTarget,
} from "./inventory-sync-diff.ts";

/** 一個「完全一致」嘅基準配對，測試用嚟改單一欄位。 */
function pair(over: { target?: Partial<SyncTarget>; current?: Partial<SyncCurrent> } = {}) {
  const target: SyncTarget = {
    avgUnitCost: 12.5,
    lastPurchaseDate: "2026-10-07",
    lastSupplier: "興發凍肉",
    category: "食材",
    ...over.target,
  };
  const current: SyncCurrent = {
    avgUnitCost: 12.5,
    lastPurchaseDate: "2026-10-07",
    lastSupplier: "興發凍肉",
    category: "食材",
    ...over.current,
  };
  return { target, current };
}

// ─────────────────────────────────────────────────────────────
// hasMaterialChange —— 核心
// ─────────────────────────────────────────────────────────────

test("完全相同 → false（唔應該寫入）", () => {
  const { target, current } = pair();
  assert.equal(hasMaterialChange(target, current, false), false);
});

test("成本有實質差異 → true", () => {
  const { target, current } = pair({ current: { avgUnitCost: 13.0 } });
  assert.equal(hasMaterialChange(target, current, false), true);
});

test("🔴 成本浮點容差：差 0.004 以內當作冇變", () => {
  // 加權平均 round 到 2 位，理論上唔會有 0.004 嘅差，
  // 但浮點誤差可以令 12.5 同 12.4999999 唔相等 ⇒ 必須有容差
  const { target, current } = pair({ current: { avgUnitCost: 12.5 - COST_EPSILON / 2 } });
  assert.equal(hasMaterialChange(target, current, false), false);
});

test("🔴 成本差剛好超過容差 → true（邊界）", () => {
  const { target, current } = pair({ current: { avgUnitCost: 12.5 - COST_EPSILON * 2 } });
  assert.equal(hasMaterialChange(target, current, false), true);
});

test("成本由 null 變有值 → true", () => {
  const { target, current } = pair({ current: { avgUnitCost: null } });
  assert.equal(hasMaterialChange(target, current, false), true);
});

test("🔴 成本係壞值（NaN）→ true（要修）", () => {
  const { target, current } = pair({ current: { avgUnitCost: Number.NaN } });
  assert.equal(hasMaterialChange(target, current, false), true);
});

test("最後採購日變更 → true", () => {
  const { target, current } = pair({ current: { lastPurchaseDate: "2026-10-06" } });
  assert.equal(hasMaterialChange(target, current, false), true);
});

test("最後供應商變更 → true", () => {
  const { target, current } = pair({ current: { lastSupplier: "永利行" } });
  assert.equal(hasMaterialChange(target, current, false), true);
});

test("品類變更 → true", () => {
  const { target, current } = pair({ current: { category: "雜貨" } });
  assert.equal(hasMaterialChange(target, current, false), true);
});

test("🔴 空字串同 null 等價（唔應該當作變化）", () => {
  // DB 可能存 '' 或 null，語意都係「冇值」⇒ 唔應該互相觸發寫入
  const a = pair({ target: { lastSupplier: null }, current: { lastSupplier: "" } });
  assert.equal(hasMaterialChange(a.target, a.current, false), false);

  const b = pair({ target: { category: "" }, current: { category: null } });
  assert.equal(hasMaterialChange(b.target, b.current, false), false);

  const c = pair({ target: { lastPurchaseDate: "  " }, current: { lastPurchaseDate: null } });
  assert.equal(hasMaterialChange(c.target, c.current, false), false);
});

test("字串前後空白唔算變化", () => {
  const { target, current } = pair({ current: { lastSupplier: "  興發凍肉  " } });
  assert.equal(hasMaterialChange(target, current, false), false);
});

test("🔴 有基準價要寫 → 一定 true（即使其餘欄位一樣）", () => {
  // 呢個係關鍵：基準價一旦掃到就要鎖定，唔可以因為「其他欄位冇變」而跳過
  const { target, current } = pair();
  assert.equal(hasMaterialChange(target, current, true), true);
});

test("🔴 由有值變 null（清空）→ true", () => {
  const { target, current } = pair({ target: { lastSupplier: null } });
  assert.equal(hasMaterialChange(target, current, false), true);
});

// ─────────────────────────────────────────────────────────────
// shouldWriteBaseline
// ─────────────────────────────────────────────────────────────

test("基準價 null + 有候選 → 寫", () => {
  assert.equal(shouldWriteBaseline(null, 10), true);
  assert.equal(shouldWriteBaseline(undefined, 10), true);
});

test("🔴 基準價已有值（包括 0）→ 永不寫", () => {
  assert.equal(shouldWriteBaseline(10, 12), false);
  // 0 係合法基準價（免費贈品）⇒ 唔可以當「未有基準」
  assert.equal(shouldWriteBaseline(0, 12), false);
});

test("基準價 null 但冇候選 → 唔寫（冇嘢可以寫）", () => {
  assert.equal(shouldWriteBaseline(null, null), false);
  assert.equal(shouldWriteBaseline(undefined, null), false);
});

test("🔴 回歸：`Number(x) > 0` 嘅舊寫法會誤判 0", () => {
  // 舊 code: const hasBase = Number(dupRows?.baseline_unit_cost) > 0;
  // 0 > 0 === false ⇒ 會以為「未有基準」⇒ 反覆覆寫（基準價飄移）
  const legacy = (v: unknown) => Number(v) > 0;
  assert.equal(legacy(0), false, "舊寫法確實誤判 0");
  assert.equal(shouldWriteBaseline(0, 12), false, "新寫法正確");
});

// ─────────────────────────────────────────────────────────────
// syncSummaryText —— 靜默原則
// ─────────────────────────────────────────────────────────────

test("🔴 冇變化 → null（唔彈提示，靜默原則）", () => {
  assert.equal(syncSummaryText({ created: 0, updated: 0, skipped_unchanged: 31 }), null);
});

test("有新增 → 出「已同步：新增 N 個」", () => {
  assert.equal(syncSummaryText({ created: 3, updated: 0, skipped_unchanged: 28 }), "已同步：新增 3 個");
});

test("有更新 → 出「已同步：更新 N 個」", () => {
  assert.equal(syncSummaryText({ created: 0, updated: 2, skipped_unchanged: 29 }), "已同步：更新 2 個");
});

test("兩者都有 → 用「、」串連", () => {
  assert.equal(
    syncSummaryText({ created: 3, updated: 2, skipped_unchanged: 26 }),
    "已同步：新增 3 個、更新 2 個",
  );
});

test("🔴 只有 skipped_unchanged 唔會出提示（唔可以講「更新 31 個」）", () => {
  const txt = syncSummaryText({ created: 0, updated: 0, skipped_unchanged: 100 });
  assert.equal(txt, null, "掃到但冇改 ≠ 更新，唔應該提示");
});
