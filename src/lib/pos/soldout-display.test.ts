import assert from "node:assert/strict";
import test from "node:test";

import { dropSoldOutKeys, resolveSoldOutDisplay, type SoldOutMap } from "./soldout-display.ts";

/**
 * 守衛：沽清菜品卡**唔可以倒原始 UUID 出街**（2026-10-01，J 截圖實案）。
 *
 * 病徵：報表「沽清菜品」卡同時出現菜名同 `ledger-074cf1d4-2390-4921-…` 原始 ID。
 * 根因：`names.get(k) ?? k`（搵唔到名就倒 key）＋ 沽清狀態只增不減（孤兒殘留）。
 *
 * ⚠️ 下面 5 個 ID 係 J 截圖嘅**真實生產值**，直接當回歸樣本用。
 */

const ORPHAN_IDS = [
  "ledger-074cf1d4-2390-4921-b22e-68e5e335d739",
  "ledger-e4295eb9-26a9-4be8-ac31-19ef11d31292",
  "ledger-79b5c76e-23f6-4116-8d6d-44ce5fb449bc",
  "ledger-e5681414-b4cf-42d3-b1c2-4bfbd19bb280",
  "ledger-e32c28a8-07c8-4d86-8e4a-94de78aae070",
];

/** 截圖入面同卡正常顯示嘅菜名（對應真實仲在賣嘅菜品）。 */
const LIVE_NAMES = ["南乳鸡中亦", "快閃菜（水煮鴨血）", "表嫂肉餅飯"];

function entry(remainingQty: number) {
  return { initialQty: 10, remainingQty, updatedAt: "2026-10-01T00:00:00.000Z" };
}

/** 還原 J 截圖嗰一刻嘅狀態：5 個孤兒 + 3 個仍在賣嘅沽清菜。 */
function screenshotState() {
  const map: SoldOutMap = {};
  for (const id of ORPHAN_IDS) map[id] = entry(0);
  for (const name of LIVE_NAMES) map[`ledger-live-${name}`] = entry(0);
  const menuItems = LIVE_NAMES.map((name) => ({ id: `ledger-live-${name}`, name }));
  return { map, menuItems };
}

test("孤兒 ID 唔會出現喺顯示清單（唔倒 UUID 出街）", () => {
  const { map, menuItems } = screenshotState();
  const { items } = resolveSoldOutDisplay(map, menuItems);

  assert.deepEqual(items, LIVE_NAMES, "只應該顯示真實仍在賣嘅沽清菜名");
  for (const id of ORPHAN_IDS) {
    assert.ok(!items.includes(id), `清單唔應該包含原始 ID：${id}`);
  }
});

test("孤兒 ID 會被歸入 orphans（可以清走）", () => {
  const { map, menuItems } = screenshotState();
  const { orphans } = resolveSoldOutDisplay(map, menuItems);

  assert.equal(orphans.length, ORPHAN_IDS.length);
  for (const id of ORPHAN_IDS) assert.ok(orphans.includes(id), `應該判定為孤兒：${id}`);
});

test("清單長度＝真實沽清菜品數（唔含孤兒）", () => {
  const { map, menuItems } = screenshotState();
  const { items } = resolveSoldOutDisplay(map, menuItems);

  assert.equal(items.length, LIVE_NAMES.length, "8 款（含孤兒）應該收斂為 3 款真實沽清");
});

test("有剩餘數量（未沽清）嘅菜品唔會列入", () => {
  const map: SoldOutMap = { "ledger-a": entry(5), "ledger-b": entry(0) };
  const menuItems = [
    { id: "ledger-a", name: "有貨" },
    { id: "ledger-b", name: "沽清" },
  ];
  const { items } = resolveSoldOutDisplay(map, menuItems);

  assert.deepEqual(items, ["沽清"]);
});

test("規格沽清（specopt:）唔會當成菜品，亦唔會當孤兒", () => {
  const map: SoldOutMap = { "specopt:opt-1": entry(0), "ledger-a": entry(0) };
  const { items, orphans } = resolveSoldOutDisplay(map, [{ id: "ledger-a", name: "菜A" }]);

  assert.deepEqual(items, ["菜A"]);
  assert.deepEqual(orphans, [], "規格 key 唔應該被當孤兒清走");
});

test("同名菜品只出現一次（卡面用名做 key，重名會撞）", () => {
  const map: SoldOutMap = { "ledger-a": entry(0), "ledger-b": entry(0) };
  const menuItems = [
    { id: "ledger-a", name: "凍檸茶" },
    { id: "ledger-b", name: "凍檸茶" },
  ];
  const { items } = resolveSoldOutDisplay(map, menuItems);

  assert.deepEqual(items, ["凍檸茶"]);
});

test("菜單係空（未同步）時全部當孤兒 —— 但唔會倒 ID 出街", () => {
  const { map } = screenshotState();
  const { items, orphans } = resolveSoldOutDisplay(map, []);

  assert.deepEqual(items, []);
  assert.equal(orphans.length, ORPHAN_IDS.length + LIVE_NAMES.length);
});

test("空狀態／null 唔會拋錯", () => {
  assert.deepEqual(resolveSoldOutDisplay(null, null), { items: [], orphans: [], soldOutIds: [] });
  assert.deepEqual(resolveSoldOutDisplay({}, []), { items: [], orphans: [], soldOutIds: [] });
});

test("dropSoldOutKeys 只刪指定 key，唔改原物件", () => {
  const map: SoldOutMap = { a: entry(0), b: entry(0), c: entry(0) };
  const next = dropSoldOutKeys(map, ["b"]);

  assert.deepEqual(Object.keys(next).sort(), ["a", "c"]);
  assert.deepEqual(Object.keys(map).sort(), ["a", "b", "c"], "原物件唔應該被改動");
});

test("dropSoldOutKeys 冇命中時回原參照（避免無謂寫入 localStorage）", () => {
  const map: SoldOutMap = { a: entry(0) };
  assert.equal(dropSoldOutKeys(map, ["nope"]), map);
  assert.equal(dropSoldOutKeys(map, []), map);
});

test("清走孤兒後再解析 ⇒ 零孤兒、菜名不變", () => {
  const { map, menuItems } = screenshotState();
  const first = resolveSoldOutDisplay(map, menuItems);
  const cleaned = dropSoldOutKeys(map, first.orphans);
  const second = resolveSoldOutDisplay(cleaned, menuItems);

  assert.deepEqual(second.items, LIVE_NAMES);
  assert.deepEqual(second.orphans, [], "清理後應該冇任何孤兒");
});
