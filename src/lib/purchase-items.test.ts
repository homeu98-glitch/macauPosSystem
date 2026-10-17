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

import {
  buildItemStats,
  buildItemCurrencyTotals,
  normalizeItemCurrency,
  PURCHASE_ITEMS_PREVIEW,
} from "./purchase-items.ts";

type Receipt = Parameters<typeof buildItemStats>[0][number];

function receipt(
  id: string,
  total: number,
  items: Array<{ name: string; unit_price: number; quantity: number; quantity_unit?: string }>,
  currency?: string,
): Receipt {
  return {
    id,
    merchant_name: "某供應商",
    receipt_date: "2026-10-05",
    total_amount: total,
    payment_status: "paid",
    payment_method: "cash",
    ...(currency !== undefined ? { currency } : {}),
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

/* ─────────────── 2026-10-17 多幣值（J 拍板）─────────────── */

test("🔴 buildItemStats：同名品項跨幣值必須分成兩行（唔可以加埋做一個假 MOP 數）", () => {
  const out = buildItemStats([
    receipt("r1", 0, [{ name: "魷魚", unit_price: 51.5, quantity: 2 }], "MOP"),   // MOP 103.00
    receipt("r2", 0, [{ name: "魷魚", unit_price: 44, quantity: 1.5 }], "RMB"),   // RMB 66.00
  ]);
  assert.equal(out.length, 2, "同名唔同幣值應該出兩行");
  const mop = out.find((x) => x.currency === "MOP");
  const rmb = out.find((x) => x.currency === "RMB");
  assert.ok(mop && rmb);
  assert.equal(mop.amount, 103);
  assert.equal(rmb.amount, 66);
  assert.equal(mop.avgPrice, 51.5);
  assert.equal(rmb.avgPrice, 44);
  assert.notEqual(mop.key, rmb.key, "聚合 key 必須含幣值");
});

test("buildItemStats：同名同幣值跨收據仍然合併（多幣值改動唔可以破壞原行為）", () => {
  const out = buildItemStats([
    receipt("r1", 0, [{ name: "墨魚滑", unit_price: 40, quantity: 2 }], "MOP"),
    receipt("r2", 0, [{ name: "墨魚滑", unit_price: 40, quantity: 3 }], "MOP"),
    receipt("r3", 0, [{ name: "墨魚滑", unit_price: 40, quantity: 1 }], "MOP"),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].amount, 240);
  assert.equal(out[0].currency, "MOP");
});

test("buildItemStats：收據冇幣值 ⇒ fallback MOP（同 API 讀取端口徑一致）", () => {
  const out = buildItemStats([receipt("r1", 0, [{ name: "豬扒", unit_price: 27, quantity: 2 }])]);
  assert.equal(out.length, 1);
  assert.equal(out[0].currency, "MOP");
});

test("normalizeItemCurrency：trim ＋ 統一做大寫（mop／Mop 都變 MOP）", () => {
  assert.equal(normalizeItemCurrency("mop"), "MOP");
  assert.equal(normalizeItemCurrency("  Rmb  "), "RMB");
  assert.equal(normalizeItemCurrency("HKD"), "HKD");
  assert.equal(normalizeItemCurrency(""), "MOP");
  assert.equal(normalizeItemCurrency(undefined), "MOP");
  assert.equal(normalizeItemCurrency(null), "MOP");
});

test("🔴 buildItemCurrencyTotals：逐幣值加總，唔同幣值絕對唔可以加埋", () => {
  const stats = buildItemStats([
    receipt("r1", 0, [{ name: "魷魚", unit_price: 51.5, quantity: 2 }, { name: "蝦醬", unit_price: 44, quantity: 2 }], "MOP"), // MOP 103 + 88
    receipt("r2", 0, [{ name: "魷魚", unit_price: 44, quantity: 1.5 }, { name: "生菜", unit_price: 6.8, quantity: 1.62 }], "RMB"), // RMB 66 + 11.016
  ]);
  const totals = buildItemCurrencyTotals(stats);
  assert.deepEqual(totals, { MOP: 191, RMB: 77.02 });
});

test("buildItemCurrencyTotals：每幣值加總 = 該幣值逐行加總（UI 合計必然對得上）", () => {
  const stats = buildItemStats([
    receipt("r1", 0, [
      { name: "A", unit_price: 10.11, quantity: 3 },
      { name: "B", unit_price: 5.55, quantity: 2 },
    ], "MOP"),
    receipt("r2", 0, [{ name: "C", unit_price: 7.77, quantity: 1 }], "HKD"),
    receipt("r3", 0, [{ name: "A", unit_price: 9.99, quantity: 1 }], "MOP"),
  ]);
  const totals = buildItemCurrencyTotals(stats);
  for (const [cur, total] of Object.entries(totals)) {
    const sum = stats.filter((s) => s.currency === cur).reduce((a, s) => a + s.amount, 0);
    assert.equal(total, Math.round(sum * 100) / 100, `${cur} 加總要同逐行加總一致`);
  }
});

test("buildItemCurrencyTotals：空陣列 ⇒ 空物件（唔可以出 MOP 0 噪音鍵）", () => {
  assert.deepEqual(buildItemCurrencyTotals([]), {});
});
