/**
 * `shift-window.ts` 單元測試 —— 「本班」時間窗（2026-11-03）。
 *
 * 重點：跨午夜。夜宵店 11/3 20:00 開班、11/4 02:00 交班，
 * 本班一定要包住 11/3 晚市，而**唔可以**包住早過開班嘅單。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  earlierDayKey,
  macauDateKeyOfInstant,
  orderMatchesShiftWindow,
  shiftDayKeys,
  shiftWindowOf,
} from "./shift-window.ts";

test("未開工 → null（交班後所有數一律 0）", () => {
  assert.equal(shiftWindowOf({}, Date.parse("2026-11-04T02:00:00+08:00")), null);
  assert.equal(shiftWindowOf(null, Date.now()), null);
  assert.equal(shiftWindowOf({ openedAt: "" }, Date.now()), null);
});

test("🔴 跨午夜：11/3 20:00 開班 → 11/4 02:00 交班，仍然係同一個窗", () => {
  const window = shiftWindowOf(
    { openedAt: "2026-11-03T20:00:00+08:00" },
    Date.parse("2026-11-04T02:00:00+08:00"),
  );
  assert.ok(window);
  assert.equal(window.start, "2026-11-03T12:00:00.000Z");
  assert.equal(window.end, "2026-11-03T18:00:00.000Z");
});

test("🔴 跨午夜窗：晚市單計、開班前單唔計、凌晨單計", () => {
  const window = shiftWindowOf(
    { openedAt: "2026-11-03T20:00:00+08:00" },
    Date.parse("2026-11-04T02:00:00+08:00"),
  );

  const before = { settledAt: "2026-11-03T19:50:00+08:00" };
  const lateNight = { settledAt: "2026-11-03T23:50:00+08:00" };
  const afterMidnight = { settledAt: "2026-11-04T01:30:00+08:00" };

  assert.equal(orderMatchesShiftWindow(before, window), false, "開班前 10 分鐘唔可以計");
  assert.equal(orderMatchesShiftWindow(lateNight, window), true, "11/3 晚市一定要計");
  assert.equal(orderMatchesShiftWindow(afterMidnight, window), true, "跨午夜後仍然計同一班");
});

test("邊界：開班一刻同查詢一刻都含（兩端皆含）", () => {
  const window = shiftWindowOf(
    { openedAt: "2026-11-03T20:00:00+08:00" },
    Date.parse("2026-11-04T02:00:00+08:00"),
  );
  assert.equal(orderMatchesShiftWindow({ updatedAt: "2026-11-03T20:00:00+08:00" }, window), true);
  assert.equal(orderMatchesShiftWindow({ updatedAt: "2026-11-04T02:00:00+08:00" }, window), true);
  assert.equal(orderMatchesShiftWindow({ updatedAt: "2026-11-04T02:00:01+08:00" }, window), false);
});

test("冇時間嘅單唔會靜靜雞計入（orderEventInstant = 0 → false）", () => {
  const window = shiftWindowOf({ openedAt: "2026-11-03T20:00:00+08:00" }, Date.now());
  assert.equal(orderMatchesShiftWindow({}, window), false);
  assert.equal(orderMatchesShiftWindow({ createdAt: "0" }, window), false);
});

test("裝置鐘被調慢 → 夾成零長度窗，唔會反轉區間", () => {
  const window = shiftWindowOf(
    { openedAt: "2026-11-03T20:00:00+08:00" },
    Date.parse("2026-11-03T19:00:00+08:00"),
  );
  assert.ok(window);
  assert.equal(window.start, window.end);
});

test("班次窗 → 澳門日 key（訂單頁日期 chip 用）", () => {
  const window = shiftWindowOf(
    { openedAt: "2026-11-03T20:00:00+08:00" },
    Date.parse("2026-11-04T02:00:00+08:00"),
  );
  assert.deepEqual(shiftDayKeys(window), { from: "2026-11-03", to: "2026-11-04" });
  assert.equal(shiftDayKeys(null), null);
});

test("澳門日 key 唔可以用 UTC slice（00:00–08:00 會變前一日）", () => {
  // 澳門 11/4 02:00 = UTC 11/3 18:00
  assert.equal(macauDateKeyOfInstant(Date.parse("2026-11-04T02:00:00+08:00")), "2026-11-04");
  assert.equal(earlierDayKey("2026-11-03", "2026-11-04"), "2026-11-03");
  assert.equal(earlierDayKey(null, "2026-11-04"), "2026-11-04");
  assert.equal(earlierDayKey("2026-11-03", null), "2026-11-03");
  assert.equal(earlierDayKey(null, null), null);
});
