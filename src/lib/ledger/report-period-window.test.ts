/**
 * `report-period.ts` 精確窗（2026-11-03）單元測試。
 *
 * 交班「本班」＝任意起訖 instant（夜宵店 11/3 20:00 → 11/4 02:00）。
 * `custom` 只到日級，唔可以代替；呢個窗一定要**優先於** key 短路（尤其 `all`）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  orderMatchesReportRange,
  resolveReportRange,
  splitReportRangeArg,
} from "./report-period.ts";

const WINDOW = {
  start: "2026-11-03T20:00:00+08:00",
  end: "2026-11-04T02:00:00+08:00",
};

test("resolveReportRange：window 原樣回傳（保留 offset，唔會被日界擴大）", () => {
  const period = resolveReportRange({ key: "custom", window: WINDOW });
  assert.deepEqual(period, WINDOW);
});

test("window 優先於 key：就算 key 係 all／today 都照用精確窗", () => {
  assert.deepEqual(resolveReportRange({ key: "all", window: WINDOW }), WINDOW);
  assert.deepEqual(resolveReportRange({ key: "today", window: WINDOW }), WINDOW);
});

test("無效 window → null（fail-closed，唔會退回今日）", () => {
  assert.equal(resolveReportRange({ key: "custom", window: { start: "垃圾", end: WINDOW.end } }), null);
  assert.equal(
    resolveReportRange({ key: "custom", window: { start: WINDOW.end, end: WINDOW.start } }),
    null,
    "end < start 要當無效",
  );
});

test("splitReportRangeArg：window 一齊回傳，舊 key / custom 唔受影響", () => {
  assert.deepEqual(splitReportRangeArg("today"), { key: "today", custom: null, window: null });
  assert.deepEqual(splitReportRangeArg({ key: "custom", window: WINDOW }), {
    key: "custom",
    custom: null,
    window: WINDOW,
  });
});

test("🔴 orderMatchesReportRange：11/3 晚市計、開班前唔計、跨午夜後計", () => {
  const range = { key: "custom" as const, window: WINDOW };
  assert.equal(
    orderMatchesReportRange({ settledAt: "2026-11-03T19:50:00+08:00" }, range),
    false,
    "開班前 10 分鐘唔可以計",
  );
  assert.equal(orderMatchesReportRange({ settledAt: "2026-11-03T23:50:00+08:00" }, range), true);
  assert.equal(orderMatchesReportRange({ settledAt: "2026-11-04T01:30:00+08:00" }, range), true);
  assert.equal(
    orderMatchesReportRange({ settledAt: "2026-11-04T02:00:01+08:00" }, range),
    false,
    "交班後嘅單唔可以計",
  );
});

test("window 存在時唔會被「custom 未有區間 → 全部」嘅短路放行", () => {
  const range = { key: "custom" as const, window: WINDOW };
  assert.equal(
    orderMatchesReportRange({ settledAt: "2026-10-01T12:00:00+08:00" }, range),
    false,
    "一個月前嘅單唔可以因為 key=custom 而被當成「全部」",
  );
});
