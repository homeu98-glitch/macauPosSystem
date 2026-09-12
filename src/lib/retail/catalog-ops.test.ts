// 零售商品主檔操作測試（docs/124 §9.6 Phase 1）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyImportPlan,
  categoriesOf,
  emptyProductDraft,
  filterProducts,
  findRetailProduct,
  findRetailVariant,
  nextProductId,
  normalizeNewProduct,
  productStats,
  removeRetailProduct,
  removeRetailProducts,
  setProductActive,
  setProductStock,
  sortProducts,
  totalStockOf,
  upsertRetailProduct,
  variantCountOf,
} from "./catalog-ops.ts";
import { buildImportPlan } from "./csv-import.ts";
import type { RetailProduct } from "./types.ts";

function base(): RetailProduct[] {
  return [
    {
      id: "rp-1",
      name: "維他檸檬茶 250ml",
      categoryId: "飲品",
      barcode: "4891028001232",
      extraBarcodes: ["2000000001187"],
      sku: "DRK-LT-250",
      price: 9.5,
      unit: "件",
      trackStock: true,
      stockQty: 48,
      reorderLevel: 10,
    },
    {
      id: "rp-2",
      name: "香蕉（散裝）",
      categoryId: "生鮮",
      plu: "01234",
      price: 28,
      unit: "kg",
      trackStock: true,
      stockQty: 12.5,
      isWeighed: true,
    },
    {
      id: "rp-3",
      name: "純棉圓領 T 恤",
      categoryId: "服裝",
      price: 199,
      unit: "件",
      trackStock: true,
      stockQty: 0,
      variants: [
        { id: "v1", label: "黑 / L", attributes: {}, barcode: "4891028700311", stockQty: 3 },
        { id: "v2", label: "白 / M", attributes: {}, stockQty: 11 },
        { id: "v3", label: "灰 / S", attributes: {}, stockQty: 0 },
      ],
    },
  ];
}

// ─────────────────────────────────────────────────────────────

test("findRetailProduct / findRetailVariant", () => {
  const list = base();
  assert.equal(findRetailProduct(list, "rp-2")?.name, "香蕉（散裝）");
  assert.equal(findRetailProduct(list, "nope"), undefined);
  assert.equal(findRetailVariant(list[2], "v2")?.label, "白 / M");
  assert.equal(findRetailVariant(list[2], "zz"), undefined);
  assert.equal(findRetailVariant(undefined, "v1"), undefined);
});

test("totalStockOf：有變體 = 各變體相加（停售變體唔計）；冇變體 = 自己", () => {
  const list = base();
  assert.equal(totalStockOf(list[0]), 48);
  assert.equal(totalStockOf(list[2]), 14); // 3 + 11 + 0
  assert.equal(totalStockOf(list[2], "v1"), 3);
  assert.equal(variantCountOf(list[2]), 3);
  assert.equal(variantCountOf(list[0]), 0);
});

test("nextProductId：接最大編號，並避開已用 id", () => {
  const list = base();
  assert.equal(nextProductId(list), "rp-4");
  const withGap: RetailProduct[] = [
    ...list,
    { id: "rp-9", name: "X", categoryId: "c", price: 1, unit: "件", trackStock: false },
    // 自訂 id（例如 CSV 帶入）唔應該影響編號
    { id: "custom-abc", name: "Y", categoryId: "c", price: 1, unit: "件", trackStock: false },
  ];
  assert.equal(nextProductId(withGap), "rp-10");
  assert.equal(nextProductId([]), "rp-1");
});

test("emptyProductDraft：有安全預設（唔會留 undefined 令下游要 null check）", () => {
  const d = emptyProductDraft("store-1");
  assert.equal(d.storeId, "store-1");
  assert.equal(d.unit, "件");
  assert.equal(d.trackStock, true);
  assert.equal(d.stockQty, 0);
  assert.equal(d.isActive, true);
  assert.equal(d.price, 0);
});

test("normalizeNewProduct：補 id / 預設值、trim 名、夾負數", () => {
  const p = normalizeNewProduct({ name: "  新商品  ", price: -5 }, []);
  assert.equal(p.name, "新商品");
  assert.equal(p.price, 0);
  assert.equal(p.id, "rp-1");
  assert.equal(p.unit, "件");
  assert.equal(p.stockQty, 0);

  const withId = normalizeNewProduct({ name: "A", price: 5, id: "my-id" }, []);
  assert.equal(withId.id, "my-id");
});

test("normalizeNewProduct：變體庫存補 0（唔會留 undefined）", () => {
  const p = normalizeNewProduct(
    { name: "T", price: 1, variants: [{ id: "v1", label: "黑", attributes: {} }] },
    [],
  );
  assert.equal(p.variants?.[0].stockQty, 0);
});

test("upsertRetailProduct：新增 / 取代；唔會改到其他 reference", () => {
  const list = base();
  const added = upsertRetailProduct(list, normalizeNewProduct({ name: "新", price: 1 }, list));
  assert.equal(added.length, 4);
  assert.equal(added[0], list[0]); // 未改動保留原 reference

  const changed = upsertRetailProduct(list, { ...list[0], price: 12 });
  assert.equal(changed.length, 3);
  assert.equal(changed[0].price, 12);
  assert.equal(list[0].price, 9.5); // 原陣列唔變
});

test("removeRetailProduct / removeRetailProducts", () => {
  const list = base();
  assert.equal(removeRetailProduct(list, "rp-1").length, 2);
  assert.equal(removeRetailProducts(list, ["rp-1", "rp-3"]).length, 1);
  assert.equal(removeRetailProducts(list, []).length, 3);
});

test("setProductActive：停售唔刪（保留歷史訂單引用）", () => {
  const list = base();
  const off = setProductActive(list, "rp-1", false);
  assert.equal(off[0].isActive, false);
  assert.equal(off.length, 3);
});

test("setProductStock：母體 / 變體；負數夾 0", () => {
  const list = base();
  assert.equal(setProductStock(list, "rp-1", 100)[0].stockQty, 100);
  assert.equal(setProductStock(list, "rp-1", -5)[0].stockQty, 0);
  const v = setProductStock(list, "rp-3", 7, "v1");
  assert.equal(v[2].variants?.find((x) => x.id === "v1")?.stockQty, 7);
  assert.equal(v[2].stockQty, 0); // 母體唔動
});

// ─────────────────────────────────────────────────────────────
// 搜尋 / 篩選 / 排序
// ─────────────────────────────────────────────────────────────

test("🔴 filterProducts：完整條碼要排第一（收銀員打嘅多數係完整條碼）", () => {
  const list: RetailProduct[] = [
    ...base(),
    {
      id: "rp-4",
      name: "另一件含 4891 嘅貨",
      categoryId: "雜貨",
      barcode: "4891999999999",
      price: 1,
      unit: "件",
      trackStock: false,
    },
  ];
  // 完整條碼 → 精確匹配（score 0）一定行先
  const exact = filterProducts(list, { keyword: "4891028001232" });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].id, "rp-1");

  // 前綴匹配兩件並列 → 兩件都要出（次序唔重要，因為兩個都係「合理命中」）
  const prefix = filterProducts(list, { keyword: "4891" });
  assert.deepEqual(prefix.map((p) => p.id).sort(), ["rp-1", "rp-4"]);

  // 精確匹配要排喺前綴匹配之前
  const mixed = filterProducts([...list, { ...list[0], id: "rp-5", barcode: "4891", name: "短碼" }], {
    keyword: "4891",
  });
  assert.equal(mixed[0].id, "rp-5");
});

test("filterProducts：撈得到額外條碼 / PLU / SKU / 商品名", () => {
  const list = base();
  assert.equal(filterProducts(list, { keyword: "2000000001187" })[0].id, "rp-1");
  assert.equal(filterProducts(list, { keyword: "01234" })[0].id, "rp-2");
  assert.equal(filterProducts(list, { keyword: "DRK-LT-250" })[0].id, "rp-1");
  assert.equal(filterProducts(list, { keyword: "香蕉" })[0].id, "rp-2");
});

test("filterProducts：預設只出有效商品；分類篩選", () => {
  const list = [...base(), { ...base()[0], id: "rp-9", isActive: false }];
  assert.equal(filterProducts(list).length, 3);
  assert.equal(filterProducts(list, { onlyActive: false }).length, 4);
  assert.equal(filterProducts(list, { categoryId: "生鮮" }).length, 1);
});

test("filterProducts：只出低庫存（含變體逐個判斷）", () => {
  const list = base();
  const low = filterProducts(list, { onlyLowStock: true });
  // rp-3 有 v3 = 0 → 中；rp-1 48 > 10 → 唔中；rp-2 12.5 > 0（冇警戒線）→ 唔中
  assert.deepEqual(low.map((p) => p.id), ["rp-3"]);
});

test("filterProducts：大小寫無關", () => {
  const list = base();
  assert.equal(filterProducts(list, { keyword: "drk-lt-250" })[0].id, "rp-1");
});

test("sortProducts：唔會改到原陣列", () => {
  const list = base();
  const byPrice = sortProducts(list, "price");
  assert.equal(list[0].id, "rp-1"); // 原陣列次序不變
  assert.equal(byPrice[0].id, "rp-1"); // 9.5 最便宜
  assert.equal(byPrice[2].id, "rp-3"); // 199 最貴
  // 庫存升序：rp-2 (12.5) → rp-3 (14) → rp-1 (48)
  assert.deepEqual(sortProducts(list, "stock").map((p) => p.id), ["rp-2", "rp-3", "rp-1"]);
});

test("🔴 sortProducts：用 code point 排序，唔用 localeCompare（唔可以有環境依賴）", () => {
  // localeCompare 嘅中文次序跟 ICU / locale 變 → 純函式同測試都會唔穩
  const list: RetailProduct[] = [
    { id: "z", name: "飲品", categoryId: "c", price: 1, unit: "件", trackStock: false },
    { id: "a", name: "服裝", categoryId: "c", price: 1, unit: "件", trackStock: false },
    { id: "m", name: "生鮮", categoryId: "c", price: 1, unit: "件", trackStock: false },
  ];
  // U+670D(服) < U+751F(生) < U+98F2(飲)
  assert.deepEqual(sortProducts(list, "name").map((p) => p.name), ["服裝", "生鮮", "飲品"]);
});

test("categoriesOf：由商品推導、去重、code point 排序", () => {
  assert.deepEqual(categoriesOf(base()), ["服裝", "生鮮", "飲品"]);
  assert.deepEqual(categoriesOf([]), []);
  assert.deepEqual(categoriesOf([...base(), { ...base()[0], id: "rp-9" }]), ["服裝", "生鮮", "飲品"]);
});

// ─────────────────────────────────────────────────────────────
// 匯入套用
// ─────────────────────────────────────────────────────────────

test("🔴 applyImportPlan：新增 + 更新，唔會清走 CSV 冇填嘅欄位", () => {
  const list = base();
  const csv = `商品名,條碼,售價\n維他檸檬茶 250ml,4891028001232,10.5\n全新商品,4999999999999,20`;
  const plan = buildImportPlan(csv, list);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.creates.length, 1);

  const r = applyImportPlan(list, plan);
  assert.equal(r.createdCount, 1);
  assert.equal(r.updatedCount, 1);
  assert.deepEqual(r.missing, []);

  const updated = r.products.find((p) => p.id === "rp-1")!;
  assert.equal(updated.price, 10.5);
  // CSV 冇填嘅欄位要保留
  assert.equal(updated.unit, "件");
  assert.equal(updated.stockQty, 48);
  assert.equal(updated.reorderLevel, 10);
  assert.deepEqual(updated.extraBarcodes, ["2000000001187"]);
  assert.equal(updated.sku, "DRK-LT-250");

  const created = r.products.find((p) => p.barcode === "4999999999999")!;
  assert.equal(created.name, "全新商品");
  assert.equal(created.unit, "件"); // 預設補齊
  assert.ok(created.id.startsWith("rp-"));
});

test("applyImportPlan：唔會改到原陣列", () => {
  const list = base();
  const plan = buildImportPlan(`商品名,條碼,售價\n維他檸檬茶 250ml,4891028001232,99`, list);
  const r = applyImportPlan(list, plan);
  assert.equal(list[0].price, 9.5);
  assert.equal(r.products[0].price, 99);
});

test("applyImportPlan：plan 係空 → 原樣回，唔會拋錯", () => {
  const list = base();
  const r = applyImportPlan(list, buildImportPlan("", list));
  assert.equal(r.createdCount, 0);
  assert.equal(r.updatedCount, 0);
  assert.equal(r.products.length, 3);
});

test("applyImportPlan：對唔中 existing 要報 missing（唔可以靜默漏）", () => {
  const list = base();
  const plan = buildImportPlan(`商品名,條碼,售價\nA,4891028001232,5`, list);
  // 模擬：更新目標已經被另一部機刪走
  const r = applyImportPlan([], plan);
  assert.equal(r.updatedCount, 0);
  assert.deepEqual(r.missing, ["rp-1"]);
});

// ─────────────────────────────────────────────────────────────
// 統計
// ─────────────────────────────────────────────────────────────

test("productStats：缺貨 / 低庫存分開數，停售唔計入 active", () => {
  const list = [...base(), { ...base()[0], id: "rp-off", isActive: false }];
  const s = productStats(list);
  assert.equal(s.total, 4);
  assert.equal(s.active, 3);
  assert.equal(s.variantCount, 3);
  // rp-3 嘅 v3 = 0 → 1 個缺貨
  assert.equal(s.outOfStock, 1);
  // rp-3 冇母體警戒線（undefined → 0）→ v1=3, v2=11 都 > 0，唔算 low
  assert.equal(s.lowStock, 0);
});

test("productStats：母體商品低於警戒線要數 lowStock", () => {
  const list: RetailProduct[] = [
    { id: "a", name: "A", categoryId: "c", price: 1, unit: "件", trackStock: true, stockQty: 3, reorderLevel: 5 },
    { id: "b", name: "B", categoryId: "c", price: 1, unit: "件", trackStock: true, stockQty: 0, reorderLevel: 5 },
  ];
  const s = productStats(list);
  assert.equal(s.lowStock, 1);
  assert.equal(s.outOfStock, 1);
});
