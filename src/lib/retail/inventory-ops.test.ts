// 零售庫存 / 盤點操作測試（docs/124 §Phase 2 · 庫存頁）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";

import assert from "node:assert/strict";

import {
  applyInventoryCounts,
  inventoryRows,
  inventorySummary,
  inventoryToCsv,
  replenishSuggestions,
  stockHealthOf,
} from "./inventory-ops.ts";
import type { RetailProduct } from "./types.ts";

function catalog(): RetailProduct[] {
  return [
    {
      id: "p1",
      name: "維他檸檬茶",
      categoryId: "drink",
      barcode: "4891028001232",
      price: 9.5,
      cost: 5,
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
      cost: 12,
      unit: "kg",
      trackStock: true,
      stockQty: 1.5,
      isWeighed: true,
      reorderLevel: 2,
    },
    {
      id: "p3",
      name: "純棉圓領 T 恤",
      categoryId: "apparel",
      price: 199,
      cost: 80,
      unit: "件",
      trackStock: true,
      stockQty: 8,
      reorderLevel: 3,
      variants: [
        { id: "v1", label: "黑 / M", attributes: {}, stockQty: 5, reorderLevel: 2 },
        { id: "v2", label: "黑 / L", attributes: {}, stockQty: 0, reorderLevel: 2 },
        { id: "v3", label: "白 / M", attributes: {}, stockQty: 3 },
      ],
    },
    {
      id: "p4",
      name: "雪糕（唔追蹤庫存）",
      categoryId: "frozen",
      price: 12,
      unit: "件",
      trackStock: false,
    },
    {
      id: "p5",
      name: "已停售商品",
      categoryId: "misc",
      price: 5,
      cost: 2,
      unit: "件",
      trackStock: true,
      stockQty: 0,
      reorderLevel: 5,
      isActive: false,
    },
  ];
}

// ─────────────────────────────────────────────────────────────
// stockHealthOf
// ─────────────────────────────────────────────────────────────

test("stockHealthOf：缺貨 / 低庫存 / 正常 / 唔追蹤", () => {
  const [tea, , , iceCream] = catalog();
  assert.equal(stockHealthOf(tea), "ok");
  assert.equal(stockHealthOf(iceCream), "untracked");
});

test("stockHealthOf：唔追蹤庫存 ≠ 缺貨（唔可以製造假警報）", () => {
  const iceCream = catalog()[3];
  // 冇 stockQty、冇追蹤 → 唔可以當 out
  assert.notEqual(stockHealthOf(iceCream), "out");
  assert.equal(stockHealthOf(iceCream), "untracked");
});

test("stockHealthOf：警戒線為 0 時，只有 <= 0 才係 out（唔會誤報 low）", () => {
  const p: RetailProduct = {
    id: "x",
    name: "無警戒線",
    categoryId: "c",
    price: 1,
    unit: "件",
    trackStock: true,
    stockQty: 1,
  };
  assert.equal(stockHealthOf(p), "ok");
  assert.equal(stockHealthOf({ ...p, stockQty: 0 }), "out");
});

test("stockHealthOf：指定 variantId 時用變體警戒線", () => {
  const tshirt = catalog()[2];
  assert.equal(stockHealthOf(tshirt, "v1", 2), "ok");
  assert.equal(stockHealthOf(tshirt, "v2", 2), "out");
});

// ─────────────────────────────────────────────────────────────
// inventoryRows
// ─────────────────────────────────────────────────────────────

test("inventoryRows：有變體商品逐個變體出列 + 一行母體（標記 isParent）", () => {
  const rows = inventoryRows(catalog());
  const tshirtRows = rows.filter((r) => r.productId === "p3");
  // v1 / v2 / v3 + 母體 = 4
  assert.equal(tshirtRows.length, 4);
  assert.equal(tshirtRows.filter((r) => r.isParent).length, 1);
  assert.equal(tshirtRows.filter((r) => !r.isParent).length, 3);
});

test("inventoryRows：變體列嘅 label 接上變體名", () => {
  const rows = inventoryRows(catalog());
  const v2 = rows.find((r) => r.productId === "p3" && r.variantId === "v2");
  assert.ok(v2);
  assert.match(v2.label, /純棉圓領 T 恤 · 黑 \/ L/);
  assert.equal(v2.health, "out");
});

test("inventoryRows：唔追蹤庫存商品預設唔出列（避免一堆永遠低庫存）", () => {
  const rows = inventoryRows(catalog());
  assert.equal(rows.some((r) => r.productId === "p4"), false);
  // 但可以明確要求出列
  const withUntracked = inventoryRows(catalog(), { includeUntracked: true });
  assert.equal(withUntracked.some((r) => r.productId === "p4"), true);
});

test("inventoryRows：預設唔出停售商品；includeInactive 才出", () => {
  assert.equal(inventoryRows(catalog()).some((r) => r.productId === "p5"), false);
  assert.equal(
    inventoryRows(catalog(), { includeInactive: true }).some((r) => r.productId === "p5"),
    true,
  );
});

test("inventoryRows：稱重商品 qty 係 kg（唔係件）", () => {
  const rows = inventoryRows(catalog());
  const banana = rows.find((r) => r.productId === "p2");
  assert.ok(banana);
  assert.equal(banana.qty, 1.5);
  assert.equal(banana.unit, "kg");
});

test("inventoryRows：stockValue = qty × cost", () => {
  const rows = inventoryRows(catalog());
  const tea = rows.find((r) => r.productId === "p1");
  assert.ok(tea);
  assert.equal(tea.stockValue, 240); // 48 × 5
});

// ─────────────────────────────────────────────────────────────
// inventorySummary
// ─────────────────────────────────────────────────────────────

test("inventorySummary：統計 out / low / 庫存值", () => {
  const s = inventorySummary(catalog());
  // v2 缺貨 = 1；香蕉 1.5 <= 2 = low；v3 冇警戒線（繼承母體 3）→ 3 <= 3 = low
  assert.equal(s.outCount, 1);
  assert.equal(s.lowCount, 2);
  assert.ok(s.totalValue > 0);
});

test("inventorySummary：冇填成本嘅商品要報出嚟（庫存值會偏低）", () => {
  const s = inventorySummary(catalog());
  // p4 唔追蹤 → 唔計；所有追蹤商品都有成本 → 0
  assert.equal(s.missingCostCount, 0);

  const noCost = catalog().map((p) => (p.id === "p1" ? { ...p, cost: undefined } : p));
  assert.equal(inventorySummary(noCost).missingCostCount, 1);
});

test("inventorySummary：空目錄唔會 throw", () => {
  const s = inventorySummary([]);
  assert.deepEqual(s, {
    trackedRows: 0,
    skuCount: 0,
    outCount: 0,
    lowCount: 0,
    totalValue: 0,
    missingCostCount: 0,
  });
});

// ─────────────────────────────────────────────────────────────
// replenishSuggestions
// ─────────────────────────────────────────────────────────────

test("replenishSuggestions：缺貨商品建議補到警戒線 × 2", () => {
  const s = replenishSuggestions(catalog());
  const v2 = s.find((x) => x.variantId === "v2");
  assert.ok(v2);
  assert.equal(v2.targetQty, 4); // 警戒線 2 × 2
  assert.equal(v2.suggestQty, 4); // 0 → 4
});

test("replenishSuggestions：低庫存商品建議補差額", () => {
  const s = replenishSuggestions(catalog());
  const banana = s.find((x) => x.productId === "p2");
  assert.ok(banana);
  assert.equal(banana.targetQty, 4); // 2 × 2
  assert.equal(banana.suggestQty, 2.5); // 1.5 → 4
  assert.equal(banana.unit, "kg");
});

test("replenishSuggestions：警戒線 0 → 目標至少 1", () => {
  const p: RetailProduct = {
    id: "z",
    name: "無警戒線缺貨品",
    categoryId: "c",
    price: 1,
    cost: 0.5,
    unit: "件",
    trackStock: true,
    stockQty: 0,
  };
  const s = replenishSuggestions([p]);
  assert.equal(s.length, 1);
  assert.equal(s[0].targetQty, 1);
  assert.equal(s[0].suggestQty, 1);
});

test("replenishSuggestions：multiplier 非法時退回 2（唔可以變 NaN）", () => {
  const s = replenishSuggestions(catalog(), Number.NaN);
  const v2 = s.find((x) => x.variantId === "v2");
  assert.ok(v2);
  assert.equal(v2.targetQty, 4);
});

test("replenishSuggestions：冇低庫存商品時回空陣列", () => {
  const healthy = catalog().map((p) => ({ ...p, stockQty: 999, variants: undefined }));
  assert.deepEqual(replenishSuggestions(healthy), []);
});

// ─────────────────────────────────────────────────────────────
// applyInventoryCounts（盤點：絕對值語義）
// ─────────────────────────────────────────────────────────────

test("applyInventoryCounts：絕對值語義（唔係累加）", () => {
  const r = applyInventoryCounts(catalog(), [{ productId: "p1", qty: 20 }]);
  const tea = r.products.find((p) => p.id === "p1");
  assert.ok(tea);
  assert.equal(tea.stockQty, 20);
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].before, 48);
  assert.equal(r.edits[0].after, 20);
  assert.equal(r.edits[0].diff, -28);
});

test("applyInventoryCounts：重複提交同一目標唔會累加", () => {
  const counts = [{ productId: "p1", qty: 20 }];
  const once = applyInventoryCounts(catalog(), counts);
  const twice = applyInventoryCounts(once.products, counts);
  const tea = twice.products.find((p) => p.id === "p1");
  assert.ok(tea);
  assert.equal(tea.stockQty, 20);
  // 第二次冇改動 → 冇 edit
  assert.equal(twice.edits.length, 0);
});

test("applyInventoryCounts：母體（有變體商品）一律跳過 —— 唔可以改母體數字", () => {
  const r = applyInventoryCounts(catalog(), [{ productId: "p3", qty: 100 }]);
  assert.equal(r.edits.length, 0);
  assert.deepEqual(r.skipped, [{ productId: "p3", reason: "parent-of-variant" }]);
  const tshirt = r.products.find((p) => p.id === "p3");
  assert.equal(tshirt?.stockQty, 8); // 原封不動
});

test("applyInventoryCounts：指明 variantId 就可以改變體", () => {
  const r = applyInventoryCounts(catalog(), [{ productId: "p3", variantId: "v2", qty: 6 }]);
  const tshirt = r.products.find((p) => p.id === "p3");
  assert.ok(tshirt);
  assert.equal(tshirt.variants?.find((v) => v.id === "v2")?.stockQty, 6);
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].label, "純棉圓領 T 恤 · 黑 / L");
});

test("applyInventoryCounts：唔追蹤庫存商品跳過（no-track）", () => {
  const r = applyInventoryCounts(catalog(), [{ productId: "p4", qty: 50 }]);
  assert.equal(r.edits.length, 0);
  assert.deepEqual(r.skipped, [{ productId: "p4", variantId: undefined, reason: "no-track" }]);
});

test("applyInventoryCounts：對唔中商品跳過（not-found），唔會 throw", () => {
  const r = applyInventoryCounts(catalog(), [{ productId: "nope", qty: 5 }]);
  assert.equal(r.edits.length, 0);
  assert.deepEqual(r.skipped, [{ productId: "nope", variantId: undefined, reason: "not-found" }]);
});

test("applyInventoryCounts：負數 / NaN 夾成 0", () => {
  const r = applyInventoryCounts(catalog(), [
    { productId: "p1", qty: -5 },
    { productId: "p2", qty: Number.NaN },
  ]);
  assert.equal(r.products.find((p) => p.id === "p1")?.stockQty, 0);
  assert.equal(r.products.find((p) => p.id === "p2")?.stockQty, 0);
});

test("applyInventoryCounts：盤盈（數量增加）diff 為正", () => {
  const r = applyInventoryCounts(catalog(), [{ productId: "p1", qty: 60 }]);
  assert.equal(r.edits[0].diff, 12);
});

test("applyInventoryCounts：空輸入回原樣（同一個 reference）", () => {
  const list = catalog();
  const r = applyInventoryCounts(list, []);
  assert.equal(r.products, list);
  assert.equal(r.edits.length, 0);
});

// ─────────────────────────────────────────────────────────────
// inventoryToCsv
// ─────────────────────────────────────────────────────────────

test("inventoryToCsv：第一行係中文表頭", () => {
  const csv = inventoryToCsv(catalog());
  assert.equal(csv.split("\n")[0], "商品ID,變體ID,商品名,分類,單位,現有庫存,警戒線");
});

test("inventoryToCsv：包含變體列，變體 ID 有值", () => {
  const csv = inventoryToCsv(catalog());
  const lines = csv.split("\n");
  const v2 = lines.find((l) => l.includes("v2"));
  assert.ok(v2);
  assert.match(v2, /p3,v2,/);
});

test("inventoryToCsv：商品名有逗號 / 引號時正確轉義", () => {
  const weird: RetailProduct = {
    id: "w1",
    name: '可樂,"大"支裝',
    categoryId: "drink",
    price: 5,
    unit: "件",
    trackStock: true,
    stockQty: 3,
  };
  const csv = inventoryToCsv([weird]);
  assert.match(csv, /"可樂,""大""支裝"/);
});

test("inventoryToCsv：唔追蹤庫存商品唔出（否則匯入會多一堆 0）", () => {
  const csv = inventoryToCsv(catalog());
  assert.equal(csv.includes("雪糕"), false);
});

test("inventoryToCsv：空目錄只出表頭", () => {
  const csv = inventoryToCsv([]);
  assert.equal(csv.split("\n").length, 1);
});
