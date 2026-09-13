import assert from "node:assert/strict";
import test from "node:test";

import {
  customRangeLabel,
  customRangeToISO,
  dateKeyToEndISO,
  dateKeyToStartISO,
  instantInRange,
  isValidDateKey,
  macauDateKeyOf,
  normalizeCustomRange,
} from "./date-range.ts";

test("isValidDateKey：合法日期", () => {
  assert.equal(isValidDateKey("2026-08-01"), true);
  assert.equal(isValidDateKey("2026-12-31"), true);
  assert.equal(isValidDateKey("2024-02-29"), true, "閏年 2 月 29 日應該合法");
});

test("isValidDateKey：格式錯", () => {
  assert.equal(isValidDateKey("2026-8-1"), false, "月份／日子必須補零");
  assert.equal(isValidDateKey("2026/08/01"), false);
  assert.equal(isValidDateKey(""), false);
  assert.equal(isValidDateKey(null), false);
  assert.equal(isValidDateKey(20260801), false);
});

test("isValidDateKey：唔存在嘅日子要擋（防 Date 自動滾月）", () => {
  assert.equal(isValidDateKey("2026-02-30"), false);
  assert.equal(isValidDateKey("2026-02-29"), false, "2026 唔係閏年");
  assert.equal(isValidDateKey("2026-04-31"), false);
  assert.equal(isValidDateKey("2026-13-01"), false);
  assert.equal(isValidDateKey("2026-00-10"), false);
});

test("normalizeCustomRange：正常", () => {
  assert.deepEqual(normalizeCustomRange({ start: "2026-08-01", end: "2026-08-31" }), {
    start: "2026-08-01",
    end: "2026-08-31",
  });
});

test("normalizeCustomRange：單日區間", () => {
  assert.deepEqual(normalizeCustomRange({ start: "2026-08-01", end: "2026-08-01" }), {
    start: "2026-08-01",
    end: "2026-08-01",
  });
});

test("normalizeCustomRange：start > end 視為無效（唔自動對調）", () => {
  assert.equal(normalizeCustomRange({ start: "2026-08-31", end: "2026-08-01" }), null);
});

test("normalizeCustomRange：任一端非法 → null", () => {
  assert.equal(normalizeCustomRange({ start: "2026-02-30", end: "2026-03-01" }), null);
  assert.equal(normalizeCustomRange({ start: "2026-08-01", end: "bad" }), null);
  assert.equal(normalizeCustomRange(null), null);
  assert.equal(normalizeCustomRange(undefined), null);
});

test("dateKeyToStartISO / dateKeyToEndISO：Macau 邊界", () => {
  assert.equal(dateKeyToStartISO("2026-08-01"), "2026-08-01T00:00:00+08:00");
  assert.equal(dateKeyToEndISO("2026-08-31"), "2026-08-31T23:59:59.999+08:00");
});

test("customRangeToISO：頭尾都係 Macau 當日邊界", () => {
  const iso = customRangeToISO({ start: "2026-08-01", end: "2026-08-31" });
  assert.equal(iso.start, "2026-08-01T00:00:00+08:00");
  assert.equal(iso.end, "2026-08-31T23:59:59.999+08:00");
});

test("instantInRange：兩端皆含", () => {
  const range = customRangeToISO({ start: "2026-08-01", end: "2026-08-31" });
  // 8 月 1 日 00:00:00.000 Macau（＝ 7 月 31 日 16:00 UTC）
  assert.equal(instantInRange("2026-07-31T16:00:00.000Z", range), true, "起始時刻應該計入");
  // 8 月 31 日 23:59:59.999 Macau（＝ 8 月 31 日 15:59:59.999 UTC）
  assert.equal(instantInRange("2026-08-31T15:59:59.999Z", range), true, "結束時刻應該計入");
  // 8 月 1 日 00:00 前 1 毫秒
  assert.equal(instantInRange("2026-07-31T15:59:59.999Z", range), false, "起始前 1ms 唔計");
  // 9 月 1 日 00:00:00.000 Macau
  assert.equal(instantInRange("2026-08-31T16:00:00.000Z", range), false, "結束後 1ms 唔計");
});

test("instantInRange：接受 Date / number / ISO string", () => {
  const range = customRangeToISO({ start: "2026-08-01", end: "2026-08-31" });
  const mid = new Date("2026-08-15T12:00:00+08:00");
  assert.equal(instantInRange(mid, range), true);
  assert.equal(instantInRange(mid.getTime(), range), true);
  assert.equal(instantInRange("2026-08-15T12:00:00+08:00", range), true);
});

test("instantInRange：非法輸入一律 false", () => {
  const range = customRangeToISO({ start: "2026-08-01", end: "2026-08-31" });
  assert.equal(instantInRange("", range), false);
  assert.equal(instantInRange("not-a-date", range), false);
  assert.equal(instantInRange(Number.NaN, range), false);
});

test("instantInRange：跨月區間（8 月尾 → 9 月頭）", () => {
  const range = customRangeToISO({ start: "2026-08-28", end: "2026-09-02" });
  assert.equal(instantInRange("2026-08-28T00:00:00+08:00", range), true);
  assert.equal(instantInRange("2026-09-02T23:59:59+08:00", range), true);
  assert.equal(instantInRange("2026-08-27T23:59:59+08:00", range), false);
  assert.equal(instantInRange("2026-09-03T00:00:00+08:00", range), false);
});

test("macauDateKeyOf：UTC 深夜要歸入澳門當日", () => {
  // 2026-08-01 00:30 Macau ＝ 2026-07-31 16:30 UTC → 應該係 2026-08-01
  assert.equal(macauDateKeyOf("2026-07-31T16:30:00.000Z"), "2026-08-01");
  // 2026-07-31 23:30 Macau ＝ 2026-07-31 15:30 UTC → 仍然係 2026-07-31
  assert.equal(macauDateKeyOf("2026-07-31T15:30:00.000Z"), "2026-07-31");
});

test("macauDateKeyOf：非法 → null", () => {
  assert.equal(macauDateKeyOf("nope"), null);
});

test("customRangeLabel", () => {
  assert.equal(customRangeLabel({ start: "2026-08-01", end: "2026-08-31" }), "2026-08-01 ~ 2026-08-31");
});
