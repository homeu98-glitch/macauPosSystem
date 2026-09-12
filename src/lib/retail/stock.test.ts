// 零售庫存扣減 / 回補測試（docs/124 §D3：即時扣減）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";

import assert from "node:assert/strict";

import {
  applyStockDeltas,
  canFulfill,
  currentStock,
  deductStockForLines,
  lowStockItems,
  mergeStockDeltas,
  restoreStockForLines,
  stockDeltasForLines,
  stockKey,
} from "./stock.ts";
import type { RetailCartLine } from "./retail-cart.ts";
import type { RetailProduct } from "./types.ts";

function products(): RetailProduct[] {
  return [
    {
      id: "p1",
      name: "維他檸檬茶",
      categoryId: "drink",
      barcode: "4891028001232",
      price: 9.5,
      unit: "件",
      trackStock: true,
      stockQty: 48,
      reorderLevel: 10,
    },
    {
      id: "p2",
      name: "香蕉（散裝）",
      categoryId: "fresh",
      plu: "01234",
      price: 28,
      unit: "kg",
      trackStock: true,
      stockQty: 12.5,
      isWeighed: true,
      reorderLevel: 2,
    },
    {
      id: "p3",
      name: "純棉圓領 T 恤",
      categoryId: "apparel",
      price: 199,
      unit: "件",
      trackStock: true,
      stockQty: 0, // 母體係 0，真實庫存睇變體
      reorderLevel: 2,
      variants: [
        { id: "v1", label: "黑 / L", attributes: { 顏色: "黑" }, stockQty: 3 },
        { id: "v2", label: "白 / M", attributes: { 顏色: "白" }, stockQty: 11 },
        { id: "v3", label: "灰 / S", attributes: { 顏色: "灰" }, stockQty: 0 },
        // 呢個變體自己嘅警戒線高過母體（8 > 2）→ 5 件已經算低
        { id: "v4", label: "藏青 / XL", attributes: { 顏色: "藏青" }, stockQty: 5, reorderLevel: 8 },
      ],
    },
    {
      id: "p4",
      name: "唔追蹤庫存（服務 / 散賣）",
      categoryId: "misc",
      price: 5,
      unit: "件",
      trackStock: false,
    },
    {
      id: "p5",
      name: "已停售商品",
      categoryId: "drink",
      price: 1,
      unit: "件",
      trackStock: true,
      stockQty: 9,
      isActive: false,
    },
  ];
}

function line(over: Partial<RetailCartLine> & { productId: string }): RetailCartLine {
  return {
    lineId: "l",
    name: "n",
    unitPrice: 1,
    quantity: 1,
    unit: "件",
    ...over,
  } as RetailCartLine;
}

// ─────────────────────────────────────────────────────────────

test("stockKey / currentStock", () => {
  assert.equal(stockKey({ productId: "p1" }), "p1");
  assert.equal(stockKey({ productId: "p1", variantId: "v1" }), "p1::v1");

  const list = products();
  assert.equal(currentStock(list[0]), 48);
  assert.equal(currentStock(list[2], "v1"), 3);
  assert.equal(currentStock(list[2], "nope"), undefined);
  // 唔追蹤庫存 → undefined（唔可以當 0）
  assert.equal(currentStock(list[3]), undefined);
});

test("mergeStockDeltas：同一目標合併，0 值剔走", () => {
  const m = mergeStockDeltas([
    { productId: "p1", delta: -2 },
    { productId: "p1", delta: -3 },
    { productId: "p2", delta: 1 },
    { productId: "p2", delta: -1 }, // 抵消 → 剔走
  ]);
  assert.equal(m.length, 1);
  assert.equal(m[0].productId, "p1");
  assert.equal(m[0].delta, -5);
});

test("applyStockDeltas：基本扣減，其他商品保留原 reference", () => {
  const list = products();
  const r = applyStockDeltas(list, [{ productId: "p1", delta: -6 }]);
  const p1 = r.products.find((p) => p.id === "p1")!;
  assert.equal(p1.stockQty, 42);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].before, 48);
  assert.equal(r.changes[0].after, 42);
  assert.equal(r.changes[0].shortfall, 0);
  // 冇改動嘅保留同一個 reference
  assert.equal(r.products.find((p) => p.id === "p2"), list.find((p) => p.id === "p2"));
});

test("🔴 applyStockDeltas：扣到唔夠 → 夾 0 但一定要報 shortfall（唔可以靜默變負數）", () => {
  const list = products();
  const r = applyStockDeltas(list, [{ productId: "p1", delta: -100 }]);
  const p1 = r.products.find((p) => p.id === "p1")!;
  assert.equal(p1.stockQty, 0);
  assert.equal(r.changes[0].shortfall, 52); // 100 − 48
  assert.equal(r.changes[0].after, 0);
});

test("applyStockDeltas：唔追蹤庫存嘅商品唔會改，但會報 skipped", () => {
  const r = applyStockDeltas(products(), [{ productId: "p4", delta: -1 }]);
  assert.equal(r.changes.length, 0);
  assert.equal(r.skipped[0].reason, "no-track");
  assert.equal(r.products.find((p) => p.id === "p4")!.stockQty, undefined);
});

test("applyStockDeltas：停售商品 / 對唔中商品", () => {
  const r1 = applyStockDeltas(products(), [{ productId: "p5", delta: -1 }]);
  assert.equal(r1.skipped[0].reason, "inactive");
  const r2 = applyStockDeltas(products(), [{ productId: "nope", delta: -1 }]);
  assert.equal(r2.skipped[0].reason, "not-found");
});

test("applyStockDeltas：變體扣減（母體唔動）", () => {
  const r = applyStockDeltas(products(), [{ productId: "p3", variantId: "v1", delta: -1 }]);
  const p3 = r.products.find((p) => p.id === "p3")!;
  assert.equal(p3.variants!.find((v) => v.id === "v1")!.stockQty, 2);
  assert.equal(p3.variants!.find((v) => v.id === "v2")!.stockQty, 11);
  assert.equal(p3.stockQty, 0); // 母體不變
  assert.equal(r.changes[0].label, "純棉圓領 T 恤 · 黑 / L");
});

test("🔴 applyStockDeltas：有變體商品唔可以用母體數字扣（靜默扣母體 = 帳實不符）", () => {
  const r = applyStockDeltas(products(), [{ productId: "p3", delta: -1 }]);
  assert.equal(r.changes.length, 0);
  assert.equal(r.skipped[0].reason, "no-variant");
});

test("applyStockDeltas：變體 id 對唔中 → skipped", () => {
  const r = applyStockDeltas(products(), [{ productId: "p3", variantId: "zzz", delta: -1 }]);
  assert.equal(r.skipped[0].reason, "no-variant");
});

// ─────────────────────────────────────────────────────────────
// 購物車 → 庫存
// ─────────────────────────────────────────────────────────────

test("stockDeltasForLines：普通商品扣件數", () => {
  const d = stockDeltasForLines([line({ productId: "p1", quantity: 3 })]);
  assert.deepEqual(d, [{ productId: "p1", variantId: undefined, delta: -3 }]);
});

test("🔴 stockDeltasForLines：稱重商品扣**重量**，唔係扣 1 件（扣錯單位庫存永遠錯）", () => {
  const d = stockDeltasForLines([
    line({ productId: "p2", quantity: 1, isWeighed: true, weightKg: 0.35, unit: "kg" }),
  ]);
  assert.equal(d.length, 1);
  assert.equal(d[0].delta, -0.35);
});

test("stockDeltasForLines：稱重但冇重量 → 唔會扣（唔可以當扣 1）", () => {
  const d = stockDeltasForLines([line({ productId: "p2", quantity: 1, isWeighed: true, unit: "kg" })]);
  assert.deepEqual(d, []);
});

test("stockDeltasForLines：變體行帶 variantId", () => {
  const d = stockDeltasForLines([line({ productId: "p3", variantId: "v1", quantity: 2 })]);
  assert.equal(d[0].variantId, "v1");
  assert.equal(d[0].delta, -2);
});

test("🔴 deductStockForLines：成張確認稿購物車扣減（稱重扣 0.35kg）", () => {
  const list = products();
  const cart: RetailCartLine[] = [
    line({ lineId: "l1", productId: "p1", quantity: 2 }),
    line({ lineId: "l2", productId: "p2", quantity: 1, isWeighed: true, weightKg: 0.35, unit: "kg" }),
    line({ lineId: "l3", productId: "p3", variantId: "v1", quantity: 1 }),
    line({ lineId: "l4", productId: "p4", quantity: 5 }), // 唔追蹤
  ];
  const r = deductStockForLines(list, cart);
  assert.equal(r.products.find((p) => p.id === "p1")!.stockQty, 46);
  assert.equal(r.products.find((p) => p.id === "p2")!.stockQty, 12.15);
  assert.equal(r.products.find((p) => p.id === "p3")!.variants!.find((v) => v.id === "v1")!.stockQty, 2);
  assert.equal(r.skipped.find((s) => s.productId === "p4")!.reason, "no-track");
});

test("restoreStockForLines：退貨按重量回補", () => {
  const list = products();
  const cart = [
    line({ lineId: "l1", productId: "p1", quantity: 2 }),
    line({ lineId: "l2", productId: "p2", quantity: 1, isWeighed: true, weightKg: 0.35, unit: "kg" }),
  ];
  // 先扣再退 → 回到原值
  const afterDeduct = deductStockForLines(list, cart).products;
  const restored = restoreStockForLines(afterDeduct, cart).products;
  assert.equal(restored.find((p) => p.id === "p1")!.stockQty, 48);
  assert.equal(restored.find((p) => p.id === "p2")!.stockQty, 12.5);
});

// ─────────────────────────────────────────────────────────────
// 低庫存
// ─────────────────────────────────────────────────────────────

test("lowStockItems：未設定 reorderLevel = 0（即係冇貨才提示）", () => {
  const list: RetailProduct[] = [
    { id: "a", name: "A", categoryId: "c", price: 1, unit: "件", trackStock: true, stockQty: 0 },
    { id: "b", name: "B", categoryId: "c", price: 1, unit: "件", trackStock: true, stockQty: 1 },
  ];
  const out = lowStockItems(list);
  assert.equal(out.length, 1);
  assert.equal(out[0].productId, "a");
  assert.equal(out[0].severity, "out");
});

test("lowStockItems：有變體要逐個變體列，變體自己嘅警戒線優先", () => {
  const out = lowStockItems(products());
  const ids = out.map((o) => `${o.productId}:${o.variantId ?? "-"}`);

  // p1 48 > 10 唔列；p2 12.5 > 2 唔列
  assert.equal(ids.includes("p1:-"), false);
  assert.equal(ids.includes("p2:-"), false);

  // p3 母體 stockQty 0，但**唔可以**列母體（真實庫存睇變體）
  assert.equal(ids.includes("p3:-"), false);

  // v1 = 3，母體警戒線 2 → 3 > 2 → 唔列
  assert.equal(ids.includes("p3:v1"), false);
  // v2 = 11 → 唔列
  assert.equal(ids.includes("p3:v2"), false);
  // v3 = 0 → out
  assert.equal(out.find((o) => o.variantId === "v3")!.severity, "out");
  // v4 = 5，自己警戒線 8 → low（用母體嘅 2 就唔會報，所以呢個證明逐變體生效）
  const v4 = out.find((o) => o.variantId === "v4")!;
  assert.equal(v4.severity, "low");
  assert.equal(v4.reorderLevel, 8);
  assert.equal(v4.label, "純棉圓領 T 恤 · 藏青 / XL");
});

test("lowStockItems：唔追蹤庫存同停售商品唔列（否則永遠一堆假警報）", () => {
  const out = lowStockItems(products());
  assert.equal(out.some((o) => o.productId === "p4"), false);
  assert.equal(out.some((o) => o.productId === "p5"), false);
});

test("lowStockItems：out 排前面，同severity 則數量少嘅先", () => {
  const list: RetailProduct[] = [
    { id: "low2", name: "L2", categoryId: "c", price: 1, unit: "件", trackStock: true, stockQty: 2, reorderLevel: 5 },
    { id: "out2", name: "O2", categoryId: "c", price: 1, unit: "件", trackStock: true, stockQty: 0, reorderLevel: 5 },
    { id: "low1", name: "L1", categoryId: "c", price: 1, unit: "件", trackStock: true, stockQty: 1, reorderLevel: 5 },
  ];
  assert.deepEqual(lowStockItems(list).map((o) => o.productId), ["out2", "low1", "low2"]);
});

test("canFulfill：唔追蹤庫存一定可以；追蹤就要夠數；變體睇變體", () => {
  const list = products();
  assert.equal(canFulfill(list[3], 999), true);
  assert.equal(canFulfill(list[0], 48), true);
  assert.equal(canFulfill(list[0], 49), false);
  assert.equal(canFulfill(list[2], 3, "v1"), true);
  assert.equal(canFulfill(list[2], 4, "v1"), false);
});
