// 回歸測試：買貨「貨品細項」聚合（2026-10-05 J 要求）—— 純函式，node --test 直接跑。
// node --test src/lib/purchase-items.test.ts
//
// 🔴 為何要獨立測：貨品細項嘅**排序口徑**由銷量改為金額（同菜品排行同步），
//    而且同名品項要跨收據合併。呢兩點都係「靜默計錯」高風險區（出錯唔會 throw，
//    只會排錯序／加錯數），所以用測試鎖死。
//
// ⚠️ 本體喺 `purchase-items.ts`（零 import）——`inventory-stats.ts` 有 `@/` alias
//    import，`node --test` 解析唔到，一 import 就爆。
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildItemStats, PURCHASE_ITEMS_PREVIEW } from "./purchase-items.ts";

type Receipt = Parameters<typeof buildItemStats>[0][number];

function receipt(
  id: string,
  total: number,
  items: Array<{ name: string; unit_price: number; quantity: number; quantity_unit?: string }>,
): Receipt {
  return {
    id,
    merchant_name: "某供應商",
    receipt_date: "2026-10-05",
    total_amount: total,
    payment_status: "paid",
    payment_method: "cash",
    items,
  };
}

test("buildItemStats：單一品項 ⇒ 數量 × 單價 = 金額", () => {
  const out = buildItemStats([receipt("r1", 80, [{ name: "墨魚滑", unit_price: 40, quantity: 2 }])]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "墨魚滑");
  assert.equal(out[0].qty, 2);
  assert.equal(out[0].amount, 80);
  assert.equal(out[0].avgPrice, 40);
  assert.equal(out[0].lines, 1);
});

test("buildItemStats：同名品項跨收據合併（唔理大小寫／前後空白）", () => {
  const out = buildItemStats([
    receipt("r1", 80, [{ name: "墨魚滑", unit_price: 40, quantity: 2 }]),
    receipt("r2", 120, [{ name: "  墨魚滑  ", unit_price: 40, quantity: 3 }]),
    receipt("r3", 40, [{ name: "墨魚滑", unit_price: 40, quantity: 1 }]),
  ]);
  assert.equal(out.length, 1, "同名應該合併成一行");
  assert.equal(out[0].qty, 6);
  assert.equal(out[0].amount, 240);
  assert.equal(out[0].lines, 3);
  assert.equal(out[0].avgPrice, 40);
});

test("🔴 buildItemStats：排序 = 金額倒序（唔係銷量倒序）", () => {
  const out = buildItemStats([
    // 三款刻意令「銷量序」同「金額序」不一致：
    //   豬扒包   86 × 24  = 2064
    //   凍檸茶  128 × 14  = 1792  ← 銷量最高但金額第 2
    //   和牛西冷  4 × 186 = 744   ← 銷量最低但單價最高
    receipt("r1", 0, [
      { name: "豬扒包", unit_price: 24, quantity: 86 },
      { name: "和牛西冷", unit_price: 186, quantity: 4 },
      { name: "凍檸茶", unit_price: 14, quantity: 128 },
    ]),
  ]);
  assert.deepEqual(
    out.map((x) => x.name),
    ["豬扒包", "凍檸茶", "和牛西冷"],
    "應該按金額倒序（2064 / 1792 / 744），唔係按銷量（128 / 86 / 4）",
  );
});

test("buildItemStats：金額並列時按名稱升序（穩定可重現）", () => {
  const out = buildItemStats([
    receipt("r1", 0, [
      { name: "B貨", unit_price: 10, quantity: 2 },
      { name: "A貨", unit_price: 10, quantity: 2 },
    ]),
  ]);
  assert.deepEqual(out.map((x) => x.name), ["A貨", "B貨"]);
});

test("buildItemStats：空名稱行一律跳過（唔可以出噪音行）", () => {
  const out = buildItemStats([
    receipt("r1", 0, [
      { name: "", unit_price: 10, quantity: 1 },
      { name: "   ", unit_price: 10, quantity: 1 },
      { name: "有名字", unit_price: 10, quantity: 1 },
    ]),
  ]);
  assert.deepEqual(out.map((x) => x.name), ["有名字"]);
});

test("buildItemStats：單位取第一個非空者（舊資料冇單位唔可以亂填）", () => {
  const out = buildItemStats([
    receipt("r1", 0, [{ name: "豬扒", unit_price: 27, quantity: 18 }]),
    receipt("r2", 0, [{ name: "豬扒", unit_price: 27, quantity: 20, quantity_unit: "kg" }]),
  ]);
  assert.equal(out[0].unit, "kg");
});

test("buildItemStats：冇 items 嘅收據唔會爆，回空陣列", () => {
  const out = buildItemStats([
    { id: "r1", merchant_name: "X", receipt_date: "2026-10-05", total_amount: 100, payment_status: "paid", payment_method: "cash", items: [] },
  ]);
  assert.equal(out.length, 0);
});

test("buildItemStats：qty 為 0 時 avgPrice 為 0，唔可以出現 NaN／Infinity", () => {
  const out = buildItemStats([receipt("r1", 0, [{ name: "免費品", unit_price: 0, quantity: 0 }])]);
  assert.equal(out[0].avgPrice, 0);
  assert.ok(Number.isFinite(out[0].avgPrice));
});

test("PURCHASE_ITEMS_PREVIEW：必須係正整數（截斷上限，唔可以係 0／負）", () => {
  assert.ok(Number.isInteger(PURCHASE_ITEMS_PREVIEW));
  assert.ok(PURCHASE_ITEMS_PREVIEW > 0);
});
