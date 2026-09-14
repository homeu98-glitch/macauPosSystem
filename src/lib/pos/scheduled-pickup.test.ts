import assert from "node:assert/strict";
import { test } from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
import {
  isScheduledOrder,
  scheduledPickupChipBadge,
  scheduledPickupChipText,
  scheduledPickupKind,
  scheduledPickupMinutesUntil,
  scheduledPickupRelativeText,
  scheduledPickupTimeClass,
  scheduledPickupTimeMs,
} from "./scheduled-pickup.ts";

/**
 * 預約單判定與「快到／已逾時」狀態（2026-09-14 商家需求）。
 *
 * 呢個模組係三處 UI（線上訂單列表 / 訂單詳情 / 快餐面板卡片）嘅**唯一**判定入口，
 * 所以最緊要守住四件事：
 *   ① 冇值 / 空字串 / 亂碼 → 一律唔當預約單（唔可以無中生有出「預約單」標籤）；
 *   ② 邊界：預約時間**剛好到點** ＝ 逾時（唔係「快到了」），否則標籤會永遠唔轉色；
 *   ③ 30 分鐘係「必須顯示快到」嘅窗口（含 30 本身）；
 *   ④ 逾時 1 分鐘內唔扮精確（唔出「已逾時 0 分鐘」呢種廢話）。
 */

const T = Date.parse("2026-09-14T04:15:00+00:00"); // 澳門 12:15
const iso = new Date(T).toISOString();

function at(minutesBefore: number): number {
  return T - minutesBefore * 60_000;
}

test("空 / 無效值一律唔當預約單", () => {
  for (const value of [null, undefined, "", "   ", "not-a-date"]) {
    assert.equal(scheduledPickupTimeMs(value), null);
    assert.equal(isScheduledOrder({ scheduledPickupAt: value }), false);
    assert.equal(scheduledPickupKind(value, T), null);
    assert.equal(scheduledPickupMinutesUntil(value, T), null);
    assert.equal(scheduledPickupRelativeText(null), "");
  }
  assert.equal(isScheduledOrder(null), false);
  assert.equal(isScheduledOrder({}), false);
});

test("有有效時間 → 係預約單，狀態係 scheduled", () => {
  assert.equal(scheduledPickupTimeMs(iso), T);
  assert.equal(isScheduledOrder({ scheduledPickupAt: iso }), true);
  assert.equal(scheduledPickupKind(iso, at(120)), "scheduled");
  assert.equal(scheduledPickupMinutesUntil(iso, at(120)), 120);
  assert.equal(scheduledPickupChipText("scheduled"), "預約單");
});

test("30 分鐘邊界：31 分鐘前 = scheduled，剛好 30 = soon，29 = soon", () => {
  assert.equal(scheduledPickupKind(iso, at(31)), "scheduled");
  assert.equal(scheduledPickupKind(iso, at(30)), "soon");
  assert.equal(scheduledPickupKind(iso, at(29)), "soon");
  assert.equal(scheduledPickupKind(iso, at(1)), "soon");
  assert.equal(scheduledPickupChipText("soon"), "預約單 · 快到了");
});

test("剛好到點 ＝ 逾時（唔可以算『快到了』，否則永遠唔轉紅）", () => {
  assert.equal(scheduledPickupKind(iso, at(0)), "overdue");
  assert.equal(scheduledPickupMinutesUntil(iso, at(0)), 0);
  assert.equal(scheduledPickupRelativeText(0), "已到時間");
  assert.equal(scheduledPickupChipText("overdue"), "預約單 · 已逾時");
});

test("逾時：分鐘數為負、文字唔會出『已逾時 1 分鐘』以下嘅精確值", () => {
  assert.equal(scheduledPickupKind(iso, at(-45)), "overdue");
  assert.equal(scheduledPickupMinutesUntil(iso, at(-45)), -45);
  assert.equal(scheduledPickupRelativeText(-45), "已逾時 45 分鐘");
  assert.equal(scheduledPickupRelativeText(-1), "已逾時");
  assert.equal(scheduledPickupRelativeText(-2), "已逾時 2 分鐘");
  assert.equal(scheduledPickupRelativeText(18), "18 分鐘後");
});

test("配色：正常琥珀、快到深琥珀、逾時紅色", () => {
  assert.match(scheduledPickupChipBadge("overdue").textClass, /red-700/);
  assert.match(scheduledPickupChipBadge("soon").textClass, /amber-800/);
  assert.match(scheduledPickupChipBadge("scheduled").textClass, /amber-700/);
  assert.match(scheduledPickupTimeClass("overdue"), /red-600/);
  assert.match(scheduledPickupTimeClass("soon"), /amber-800/);
  assert.match(scheduledPickupTimeClass("scheduled"), /amber-700/);
});

test("接受 PosOrder（同一個 scheduledPickupAt 欄位形狀）", () => {
  assert.equal(isScheduledOrder({ scheduledPickupAt: iso }), true);
  assert.equal(scheduledPickupKind(iso, at(10)), "soon");
});

test("已完結單 → closed：唔會再標逾時（2026-09-14 商家實案）", () => {
  // 實案：14:54 睇一張 12:15 預約、狀態「已完成」嘅單 → 唔應該出「已逾時 159 分鐘」。
  const nowMs = at(-159);
  assert.equal(scheduledPickupKind(iso, nowMs, undefined, false), "overdue");
  assert.equal(scheduledPickupKind(iso, nowMs, undefined, true), "closed");
  // 已完結但預約時間**未到** → 一樣係 closed（唔會出「18 分鐘後」）
  assert.equal(scheduledPickupKind(iso, at(18), undefined, true), "closed");
  assert.equal(scheduledPickupChipText("closed"), "預約單");
  assert.match(scheduledPickupChipBadge("closed").textClass, /slate-500/);
  assert.match(scheduledPickupTimeClass("closed"), /slate-400/);
});

test("closed 唔會無中生有：冇有效預約時間仍然係 null", () => {
  assert.equal(scheduledPickupKind(null, T, undefined, true), null);
  assert.equal(scheduledPickupKind("", T, undefined, true), null);
  assert.equal(scheduledPickupKind("not-a-date", T, undefined, true), null);
});
