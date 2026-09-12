// 零售條碼索引 + 掃碼解析測試（docs/124 §R1）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCatalog,
  isScannedHit,
  isSellable,
  isVariantSellable,
  nextInternalBarcode,
  resolveScannedCode,
  resolveScannedCodeIn,
} from "./barcode-index.ts";
import { WEIGHED_RULE_PRESETS } from "./weighed-barcode.ts";
import type { RetailProduct } from "./types.ts";

const rule21 = WEIGHED_RULE_PRESETS.find((r) => r.id === "preset-21-weight")!;
/** `21 01234 00350 C` → PLU 01234、350g */
const WEIGHT_CODE = "2101234003503";

function catalogProducts(): RetailProduct[] {
  return [
    {
      id: "p1",
      name: "維他檸檬茶 250ml",
      categoryId: "drink",
      barcode: "4891028001232",
      price: 9.5,
      unit: "件",
      trackStock: true,
      stockQty: 48,
    },
    {
      id: "p2",
      name: "香蕉（散裝）",
      categoryId: "fresh",
      plu: "01234",
      price: 28,
      unit: "kg",
      trackStock: false,
      isWeighed: true,
    },
    {
      id: "p3",
      name: "純棉圓領 T 恤",
      categoryId: "apparel",
      price: 199,
      unit: "件",
      trackStock: true,
      variants: [
        {
          id: "v1",
          label: "黑 / L",
          attributes: { 顏色: "黑", 尺碼: "L" },
          barcode: "4891028700311",
          sku: "TSH-BLK-L",
          stockQty: 3,
        },
        {
          id: "v2",
          label: "白 / M",
          attributes: { 顏色: "白", 尺碼: "M" },
          barcode: "4891028700328",
          stockQty: 11,
        },
        {
          id: "v3",
          label: "停售色",
          attributes: { 顏色: "灰", 尺碼: "S" },
          barcode: "4891028700397",
          isActive: false,
        },
      ],
    },
    {
      id: "p5",
      name: "散裝腰果",
      categoryId: "nuts",
      barcode: "2000000001187",
      extraBarcodes: ["6934177709999", "4890000000000"],
      plu: "09999",
      price: 68,
      unit: "包",
      trackStock: true,
    },
    {
      id: "p4",
      name: "已停售商品",
      categoryId: "drink",
      barcode: "4999999999999",
      price: 1,
      unit: "件",
      trackStock: false,
      isActive: false,
    },
  ];
}

test("isSellable / isVariantSellable：只有明確 false 才停售（undefined = 賣得）", () => {
  assert.equal(isSellable({}), true);
  assert.equal(isSellable({ isActive: true }), true);
  assert.equal(isSellable({ isActive: false }), false);
  assert.equal(isVariantSellable({}), true);
  assert.equal(isVariantSellable({ isActive: false }), false);
});

test("createCatalog：只計有效商品，停售商品入唔到索引", () => {
  const c = createCatalog(catalogProducts());
  assert.equal(c.activeCount, 4); // p4 已停售
  assert.equal(c.byId.has("p4"), false);
  assert.equal(c.index.byBarcode.has("4999999999999"), false);
});

test("createCatalog：主條碼 / 額外條碼 / 變體條碼一律認得（一商品多條碼）", () => {
  const c = createCatalog(catalogProducts());
  for (const code of ["4891028001232"]) {
    assert.equal(c.index.byBarcode.get(code)?.productId, "p1");
  }
  // 額外條碼（舊包裝碼 / 廠碼）
  for (const code of ["6934177709999", "4890000000000", "2000000001187"]) {
    assert.equal(c.index.byBarcode.get(code)?.productId, "p5");
  }
  // 變體條碼
  assert.equal(c.index.byBarcode.get("4891028700311")?.productId, "p3");
  assert.equal(c.index.byBarcode.get("4891028700311")?.variantId, "v1");
  // 停售變體唔入索引
  assert.equal(c.index.byBarcode.has("4891028700397"), false);
});

test("createCatalog：PLU 索引（變重碼反查商品用）", () => {
  const c = createCatalog(catalogProducts());
  assert.equal(c.index.byPlu.get("01234"), "p2");
  assert.equal(c.index.byPlu.get("09999"), "p5");
});

test("🔴 createCatalog：撞條碼要報衝突，唔可以靜默取其一", () => {
  const products = [
    ...catalogProducts(),
    {
      id: "dup",
      name: "撞碼商品",
      categoryId: "drink",
      barcode: "4891028001232", // 同 p1 撞
      price: 5,
      unit: "件",
      trackStock: false,
    },
  ];
  const c = createCatalog(products);
  const conflict = c.conflicts.find((x) => x.kind === "barcode" && x.code === "4891028001232");
  assert.ok(conflict);
  assert.deepEqual(conflict.productIds.sort(), ["dup", "p1"]);
  // 先入者為準（p1 喺陣列前面）
  assert.equal(c.index.byBarcode.get("4891028001232")?.productId, "p1");
});

test("🔴 createCatalog：撞 PLU 一樣要報衝突（PLU 撞 = 秤重收錯錢）", () => {
  const products = [
    ...catalogProducts(),
    {
      id: "dup-plu",
      name: "撞 PLU 商品",
      categoryId: "fresh",
      plu: "01234",
      price: 10,
      unit: "kg",
      trackStock: false,
    },
  ];
  const c = createCatalog(products);
  const conflict = c.conflicts.find((x) => x.kind === "plu" && x.code === "01234");
  assert.ok(conflict);
  assert.deepEqual(conflict.productIds, ["p2", "dup-plu"]);
});

test("沒有任何衝突時 conflicts 係空", () => {
  assert.deepEqual(createCatalog(catalogProducts()).conflicts, []);
});

test("resolveScannedCode：掃到商品 → 回商品", () => {
  const c = createCatalog(catalogProducts());
  const hit = resolveScannedCode("4891028001232", c);
  assert.equal(hit.kind, "product");
  if (hit.kind === "product") {
    assert.equal(hit.product.id, "p1");
    assert.equal(hit.variant, undefined);
    assert.equal(hit.code, "4891028001232");
  }
});

test("resolveScannedCode：掃到變體條碼 → 帶埋變體（服裝必需）", () => {
  const c = createCatalog(catalogProducts());
  const hit = resolveScannedCode("4891028700311", c);
  assert.equal(hit.kind, "product");
  if (hit.kind === "product") {
    assert.equal(hit.product.id, "p3");
    assert.equal(hit.variant?.id, "v1");
    assert.equal(hit.variant?.label, "黑 / L");
  }
});

test("resolveScannedCode：變重碼 → PLU + 重量，並反查到商品", () => {
  const c = createCatalog(catalogProducts());
  const hit = resolveScannedCode(WEIGHT_CODE, c, [rule21]);
  assert.equal(hit.kind, "weighed");
  if (hit.kind === "weighed") {
    assert.equal(hit.weighed.plu, "01234");
    assert.equal(hit.weighed.weightKg, 0.35);
    assert.equal(hit.product?.id, "p2");
  }
});

test("resolveScannedCode：變重碼對唔中 PLU 都要照收（價錢已經喺條碼）", () => {
  const c = createCatalog(catalogProducts());
  const hit = resolveScannedCode("2199999003503", c, [rule21]);
  // 校驗位唔對 → 唔會當成變重碼；用一條冇校驗要求嘅規則再試
  assert.equal(hit.kind, "unknown");

  const noCheck = { ...rule21, id: "no-check", hasCheckDigit: false };
  const hit2 = resolveScannedCode("2199999003503", c, [noCheck]);
  assert.equal(hit2.kind, "weighed");
  if (hit2.kind === "weighed") {
    assert.equal(hit2.weighed.plu, "99999");
    assert.equal(hit2.product, undefined);
  }
});

test("🔴 resolveScannedCode：變重碼優先過商品條碼（2x 係店內保留區間，會撞）", () => {
  const products = [
    ...catalogProducts(),
    {
      id: "sneaky",
      name: "自編碼商品（撞秤重區間）",
      categoryId: "misc",
      barcode: WEIGHT_CODE, // 同一串字
      price: 99,
      unit: "件",
      trackStock: false,
    },
  ];
  const c = createCatalog(products);
  const hit = resolveScannedCode(WEIGHT_CODE, c, [rule21]);
  assert.equal(hit.kind, "weighed");
});

test("resolveScannedCode：唔認得 → unknown（呼叫端要響鈴提示）", () => {
  const c = createCatalog(catalogProducts());
  const hit = resolveScannedCode("0000000000000", c);
  assert.equal(hit.kind, "unknown");
  assert.equal(isScannedHit(hit), false);
});

test("resolveScannedCode：空 / null / 空白字元一律 unknown，唔會拋錯", () => {
  const c = createCatalog(catalogProducts());
  for (const input of ["", "   ", null, undefined]) {
    const hit = resolveScannedCode(input, c);
    assert.equal(hit.kind, "unknown");
  }
});

test("resolveScannedCode：掃碼槍嘅結尾字元同出廠前綴都要處理到", () => {
  const c = createCatalog(catalogProducts());
  const hit = resolveScannedCode("~4891028001232\r\n", c);
  assert.equal(hit.kind, "product");
});

test("resolveScannedCode：冇規則時唔會誤判變重碼", () => {
  const c = createCatalog(catalogProducts());
  // 完全冇配置規則 → 秤標籤應該「唔認得」，而唔係亂解
  assert.equal(resolveScannedCode(WEIGHT_CODE, c, []).kind, "unknown");
});

test("resolveScannedCodeIn：便利版每次都重建索引，結果要一致", () => {
  const products = catalogProducts();
  const a = resolveScannedCodeIn("4891028001232", products);
  const b = resolveScannedCodeIn("4891028001232", products);
  assert.deepEqual(a.kind, "product");
  assert.equal(a.kind === "product" ? a.product.id : "", b.kind === "product" ? b.product.id : "x");
});

test("nextInternalBarcode：避開已用嘅碼", () => {
  const c = createCatalog(catalogProducts());
  assert.equal(nextInternalBarcode(c, 2000000001187), "2000000001188");
  // 冇撞 → 原樣回
  assert.equal(nextInternalBarcode(c, 2000000009000), "2000000009000");
});

test("nextInternalBarcode：連續已用會一路跳", () => {
  const products: RetailProduct[] = [0, 1, 2].map((i) => ({
    id: `x${i}`,
    name: `商品${i}`,
    categoryId: "c",
    barcode: String(2000000000000 + i),
    price: 1,
    unit: "件",
    trackStock: false,
  }));
  const c = createCatalog(products);
  assert.equal(nextInternalBarcode(c), "2000000000003");
});

test("isScannedHit：商品同變重碼都算認得", () => {
  const c = createCatalog(catalogProducts());
  assert.equal(isScannedHit(resolveScannedCode("4891028001232", c)), true);
  assert.equal(isScannedHit(resolveScannedCode(WEIGHT_CODE, c, [rule21])), true);
});
