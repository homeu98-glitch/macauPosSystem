// 回歸測試：新增收據嘅歷史品項建議聚合 —— 純函式，node --test 直接跑。
// node --test src/lib/inventory-item-suggestions.test.ts
//
// ⚠️ 呢個檔唔可以 import 任何 `@/` 或 `.tsx`：`node --test` 兩者都唔認。
//    被測模組（`inventory-item-suggestions.ts`）刻意零 import 就係為咗呢件事。
import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregateItemSuggestions } from "./inventory-item-suggestions.ts";

const row = (over: Record<string, unknown> = {}) => ({
  name: "魚",
  unit_price: 17,
  quantity_unit: "kg",
  created_at: "2026-10-08T03:20:00.000Z",
  ...over,
});

test("同名只保留最近一次（第一眼）嘅單價／單位／日期，count 累加", () => {
  const out = aggregateItemSuggestions(
    [
      row({ name: "魚", unit_price: 17, quantity_unit: "kg", created_at: "2026-10-08T00:00:00Z" }),
      row({ name: "魚", unit_price: 20, quantity_unit: "斤", created_at: "2026-10-01T00:00:00Z" }),
      row({ name: "魚", unit_price: 15, quantity_unit: "包", created_at: "2026-09-20T00:00:00Z" }),
    ],
    80,
  );
  assert.equal(out.length, 1, "同名唔可以出兩個 chip");
  assert.equal(out[0].unit_price, 17, "要保留最新嗰次嘅價");
  assert.equal(out[0].unit, "kg", "要保留最新嗰次嘅單位");
  assert.equal(out[0].last_date, "2026-10-08");
  assert.equal(out[0].count, 3);
});

test("🔴 舊 schema 冇 quantity_unit ⇒ 單位係空字串，唔可以變 \"undefined\" 或造假單位", () => {
  const out = aggregateItemSuggestions([{ name: "蝦", unit_price: 30, created_at: "2026-10-08T00:00:00Z" }], 80);
  assert.equal(out[0].unit, "");
  // `quantity_unit: null` 同樣要當「未填」（唔可以靠 falsy —— `String(null)` 係 "null"）。
  const out2 = aggregateItemSuggestions([row({ name: "蝦", quantity_unit: null })], 80);
  assert.equal(out2[0].unit, "");
  const out3 = aggregateItemSuggestions([row({ name: "蝦", quantity_unit: "   " })], 80);
  assert.equal(out3[0].unit, "", "淨係空白都要當未填");
});

test("unit_price 缺席／null ⇒ 0（唔可以 NaN）", () => {
  const out = aggregateItemSuggestions([row({ unit_price: null })], 80);
  assert.equal(out[0].unit_price, 0);
  const out2 = aggregateItemSuggestions([{ name: "菜", created_at: "" }], 80);
  assert.equal(out2[0].unit_price, 0);
  assert.equal(out2[0].last_date, "");
});

test("空名／非字串名要跳過（唔可以出冇名嘅 chip）", () => {
  const out = aggregateItemSuggestions(
    [row({ name: "   " }), row({ name: "" }), row({ name: 123 }), row({ name: null }), row({ name: "湯骨" })],
    80,
  );
  assert.deepEqual(
    out.map((x) => x.name),
    ["湯骨"],
  );
});

test("大小寫／前後空白視為同一個品項（避免 Coke / coke 出兩個）", () => {
  const out = aggregateItemSuggestions([row({ name: "Coke" }), row({ name: " coke " })], 80);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Coke", "要保留最先見到（最新）嗰個寫法");
  assert.equal(out[0].count, 2);
});

test("排序＝輸入次序（server 已 order by created_at desc）", () => {
  const out = aggregateItemSuggestions(
    [row({ name: "最近" }), row({ name: "中間" }), row({ name: "最舊" })],
    80,
  );
  assert.deepEqual(
    out.map((x) => x.name),
    ["最近", "中間", "最舊"],
  );
});

test("limit 生效；limit 0 ⇒ 空（唔可以當「無限」）", () => {
  const rows = [row({ name: "A" }), row({ name: "B" }), row({ name: "C" })];
  assert.equal(aggregateItemSuggestions(rows, 2).length, 2);
  assert.equal(aggregateItemSuggestions(rows, 0).length, 0);
});

test("輸入係 null / undefined / 空陣列都唔會爆", () => {
  assert.deepEqual(aggregateItemSuggestions(null, 80), []);
  assert.deepEqual(aggregateItemSuggestions(undefined, 80), []);
  assert.deepEqual(aggregateItemSuggestions([], 80), []);
});
