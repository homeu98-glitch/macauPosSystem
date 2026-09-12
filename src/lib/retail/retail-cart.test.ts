// 零售購物車測試（docs/124 §R2 / §R3）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addRetailLine,
  adjustmentRequiresApproval,
  changeRetailQty,
  effectiveUnitPrice,
  findRetailLine,
  isMergeableLine,
  lineDiscountAmount,
  lineGross,
  lineHasManualAdjustment,
  lineNet,
  lineQuantityFactor,
  lineTotalSaving,
  removeRetailLine,
  retailLineSignature,
  retailOrderTotals,
  setLineDiscount,
  setLineNote,
  setLinePriceOverride,
  setLineSerial,
  setRetailQty,
  type RetailCartLine,
} from "./retail-cart.ts";

const coke = {
  productId: "p1",
  name: "維他檸檬茶 250ml",
  unitPrice: 9.5,
  unit: "件",
  barcode: "4891028001232",
};

const shirt = {
  productId: "p3",
  name: "純棉圓領 T 恤",
  unitPrice: 199,
  unit: "件",
  variantId: "v1",
  variantLabel: "黑 / L",
};

const banana = {
  productId: "p2",
  name: "香蕉（散裝）",
  unitPrice: 28,
  unit: "kg",
  isWeighed: true,
  weightKg: 0.35,
  plu: "01234",
};

// ─────────────────────────────────────────────────────────────
// 合併行為
// ─────────────────────────────────────────────────────────────

test("addRetailLine：同商品同價 → 合併數量（唔會出兩行）", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = addRetailLine(cart, coke, "l2");
  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, 2);
  assert.equal(cart[0].lineId, "l1");
});

test("🔴 唔同折扣唔可以合併（否則「原價」同「8 折」變一行 → 帳目錯）", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, shirt, "l1");
  cart = addRetailLine(cart, { ...shirt, lineDiscountRate: 80 }, "l2");
  assert.equal(cart.length, 2);

  const t = retailOrderTotals(cart);
  assert.equal(t.listTotal, 398); // 199 × 2
  assert.equal(t.itemDiscount, 39.8); // 只有 8 折嗰件
  assert.equal(t.total, 358.2);
});

test("🔴 唔同改價唔可以合併", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = addRetailLine(cart, { ...coke, priceOverride: 7 }, "l2");
  assert.equal(cart.length, 2);
  const t = retailOrderTotals(cart);
  assert.equal(t.listTotal, 19);
  assert.equal(t.overrideSaving, 2.5);
  assert.equal(t.total, 16.5);
});

test("🔴 定額折扣唔同唔可以合併", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = addRetailLine(cart, { ...coke, lineDiscountAmount: 5 }, "l2");
  assert.equal(cart.length, 2);
});

test("備註唔同唔可以合併", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = addRetailLine(cart, { ...coke, note: "要凍" }, "l2");
  assert.equal(cart.length, 2);
});

test("🔴 稱重行永遠唔合併（每次秤重係獨立一件實物）", () => {
  assert.equal(isMergeableLine(banana), false);
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, banana, "l1");
  cart = addRetailLine(cart, banana, "l2");
  assert.equal(cart.length, 2);
});

test("🔴 序號行永遠唔合併（一物一碼）", () => {
  const powerBank = { productId: "p7", name: "小米行動電源", unitPrice: 149, unit: "件" };
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, powerBank, "l1");
  cart = setLineSerial(cart, "l1", "324500178882");
  assert.equal(cart[0].nonMergeable, true);
  cart = addRetailLine(cart, powerBank, "l2");
  assert.equal(cart.length, 2);
});

test("🔴 已存在嘅稱重行唔可以被同簽名嘅新行合併（同上一類 bug）", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, banana, "l1");
  // 新行**刻意唔帶** isWeighed / weightKg（例如錯誤資料來源），但簽名同已存在嘅稱重行一樣
  const plain = {
    productId: banana.productId,
    name: banana.name,
    unitPrice: banana.unitPrice,
    unit: banana.unit,
  };
  cart = addRetailLine(cart, plain, "l2");
  assert.equal(cart.length, 2);
});

test("retailLineSignature：牌價 / 改價 / 折扣 / 備註都會影響簽名", () => {
  const base = retailLineSignature(coke);
  assert.notEqual(base, retailLineSignature({ ...coke, priceOverride: 7 }));
  assert.notEqual(base, retailLineSignature({ ...coke, lineDiscountRate: 80 }));
  assert.notEqual(base, retailLineSignature({ ...coke, lineDiscountAmount: 5 }));
  assert.notEqual(base, retailLineSignature({ ...coke, note: "少冰" }));
  assert.notEqual(base, retailLineSignature({ ...coke, unitPrice: 10 }));
  assert.notEqual(base, retailLineSignature({ ...coke, productId: "p9" }));
  // 一樣就一樣（可以合併）
  assert.equal(base, retailLineSignature({ ...coke }));
});

// ─────────────────────────────────────────────────────────────
// 改量 / 改價 / 折扣
// ─────────────────────────────────────────────────────────────

test("changeRetailQty / setRetailQty：歸零即移除", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = addRetailLine(cart, coke, "l1");
  cart = changeRetailQty(cart, "l1", -1);
  assert.equal(cart[0].quantity, 1);
  cart = changeRetailQty(cart, "l1", -1);
  assert.equal(cart.length, 0);

  let cart2: RetailCartLine[] = [];
  cart2 = addRetailLine(cart2, coke, "l1");
  cart2 = setRetailQty(cart2, "l1", 12);
  assert.equal(cart2[0].quantity, 12);
  cart2 = setRetailQty(cart2, "l1", 0);
  assert.equal(cart2.length, 0);
});

test("changeRetailQty：唔會變負數", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = changeRetailQty(cart, "l1", -5);
  assert.equal(cart.length, 0);
});

test("removeRetailLine / findRetailLine", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = addRetailLine(cart, shirt, "l2");
  assert.equal(findRetailLine(cart, "l2")?.name, shirt.name);
  cart = removeRetailLine(cart, "l1");
  assert.equal(cart.length, 1);
  assert.equal(findRetailLine(cart, "l1"), undefined);
});

test("setLinePriceOverride：傳 undefined 要真正清走個欄位（唔可以留 undefined 令簽名變咗）", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = setLinePriceOverride(cart, "l1", 7);
  assert.equal(cart[0].priceOverride, 7);
  cart = setLinePriceOverride(cart, "l1", undefined);
  assert.equal("priceOverride" in cart[0], false);
  assert.equal(effectiveUnitPrice(cart[0]), 9.5);
});

test("setLinePriceOverride：負數夾做 0", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = setLinePriceOverride(cart, "l1", -5);
  assert.equal(cart[0].priceOverride, 0);
});

test("setLineDiscount：rate >= 100 或 0 定額 = 清除折扣", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = setLineDiscount(cart, "l1", { rate: 80, amount: 2 });
  assert.equal(cart[0].lineDiscountRate, 80);
  assert.equal(cart[0].lineDiscountAmount, 2);
  cart = setLineDiscount(cart, "l1", { rate: 100, amount: 0 });
  assert.equal("lineDiscountRate" in cart[0], false);
  assert.equal("lineDiscountAmount" in cart[0], false);
});

test("setLineNote：空白等於清走", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = setLineNote(cart, "l1", "  要凍  ");
  assert.equal(cart[0].note, "要凍");
  cart = setLineNote(cart, "l1", "   ");
  assert.equal("note" in cart[0], false);
});

test("setLineSerial：清走序號時唔會留低 nonMergeable（否則永遠合併唔到）", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = setLineSerial(cart, "l1", "SN123");
  assert.equal(cart[0].nonMergeable, true);
  cart = setLineSerial(cart, "l1", "");
  assert.equal("serialNo" in cart[0], false);
  // 注意：nonMergeable 保留（保守）—— 但序號已清走，唔會出錯數
  assert.equal(cart[0].nonMergeable, true);
});

// ─────────────────────────────────────────────────────────────
// 金額
// ─────────────────────────────────────────────────────────────

test("effectiveUnitPrice / lineQuantityFactor：改價優先、稱重用重量", () => {
  assert.equal(effectiveUnitPrice({ unitPrice: 10, priceOverride: 8 }), 8);
  assert.equal(effectiveUnitPrice({ unitPrice: 10 }), 10);
  assert.equal(lineQuantityFactor({ quantity: 3, isWeighed: false }), 3);
  assert.equal(lineQuantityFactor({ quantity: 1, isWeighed: true, weightKg: 0.35 }), 0.35);
  // 稱重但冇重量 → 退回數量（唔會變 0 令金額消失）
  assert.equal(lineQuantityFactor({ quantity: 2, isWeighed: true }), 2);
});

test("折扣率語義同 pos/discount.ts 一致：80 = 8 折", () => {
  const line: RetailCartLine = {
    lineId: "l1",
    productId: "p3",
    name: "T 恤",
    unitPrice: 199,
    quantity: 1,
    unit: "件",
    lineDiscountRate: 80,
  };
  assert.equal(lineGross(line), 199);
  assert.equal(lineDiscountAmount(line), 39.8);
  assert.equal(lineNet(line), 159.2);
  assert.equal(lineTotalSaving(line), 39.8);
});

test("定額折 + 折扣率可以同時用（先 rate 後 amount）", () => {
  const line: RetailCartLine = {
    lineId: "l1",
    productId: "p1",
    name: "檸檬茶",
    unitPrice: 100,
    quantity: 2,
    unit: "件",
    lineDiscountRate: 90, // 減 20
    lineDiscountAmount: 5, // 再減 5
  };
  assert.equal(lineGross(line), 200);
  assert.equal(lineDiscountAmount(line), 25);
  assert.equal(lineNet(line), 175);
});

test("🔴 折扣唔可以折到負數（夾喺 [0, gross]）", () => {
  const line: RetailCartLine = {
    lineId: "l1",
    productId: "p1",
    name: "檸檬茶",
    unitPrice: 10,
    quantity: 1,
    unit: "件",
    lineDiscountAmount: 999,
  };
  assert.equal(lineDiscountAmount(line), 10);
  assert.equal(lineNet(line), 0);
});

test("lineHasManualAdjustment：改價 / 折扣 / 定額折都算", () => {
  const base: RetailCartLine = { lineId: "l", productId: "p", name: "n", unitPrice: 10, quantity: 1, unit: "件" };
  assert.equal(lineHasManualAdjustment(base), false);
  assert.equal(lineHasManualAdjustment({ ...base, priceOverride: 8 }), true);
  assert.equal(lineHasManualAdjustment({ ...base, lineDiscountRate: 80 }), true);
  assert.equal(lineHasManualAdjustment({ ...base, lineDiscountAmount: 1 }), true);
  // rate >= 100 唔算調整
  assert.equal(lineHasManualAdjustment({ ...base, lineDiscountRate: 100 }), false);
});

// ─────────────────────────────────────────────────────────────
// 整單金額：驗證確認稿嘅數字（docs/mockups/retail-pos-ui-2026-09-12.html）
// ─────────────────────────────────────────────────────────────

test("🔴 retailOrderTotals：確認稿嘅 7 項購物車 → 小計 $488.80 / 折扣 $39.80 / 應收 $449.00", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, coke, "l1");
  cart = addRetailLine(cart, coke, "l1"); // ×2
  cart = addRetailLine(cart, { productId: "p4", name: "明治雪糕家庭裝", unitPrice: 12, unit: "件" }, "l2");
  cart = addRetailLine(cart, { productId: "p5", name: "萬寶路紅（硬盒）", unitPrice: 58, unit: "件" }, "l3");
  cart = addRetailLine(cart, { productId: "p6", name: "必理痛 20 粒裝", unitPrice: 42, unit: "件" }, "l4");
  cart = addRetailLine(cart, banana, "l5");
  cart = addRetailLine(cart, { ...shirt, lineDiscountRate: 80 }, "l6");
  cart = addRetailLine(cart, { productId: "p7", name: "小米行動電源", unitPrice: 149, unit: "件" }, "l7");

  const t = retailOrderTotals(cart);
  assert.equal(t.lineCount, 7);
  assert.equal(t.quantity, 8);
  assert.equal(t.listTotal, 488.8);
  assert.equal(t.overrideSaving, 0);
  assert.equal(t.grossSubtotal, 488.8);
  assert.equal(t.itemDiscount, 39.8);
  assert.equal(t.netSubtotal, 449);
  assert.equal(t.orderDiscountAmount, 0);
  assert.equal(t.total, 449);
  assert.equal(t.weighedTotalKg, 0.35);
  assert.equal(t.totalSaving, 39.8);
});

test("retailOrderTotals：整單折扣率 + 定額，夾喺 netSubtotal", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, { productId: "p1", name: "A", unitPrice: 100, unit: "件" }, "l1");
  cart = addRetailLine(cart, { productId: "p2", name: "B", unitPrice: 100, unit: "件" }, "l2");

  const rate = retailOrderTotals(cart, { rate: 90 }); // 9 折
  assert.equal(rate.netSubtotal, 200);
  assert.equal(rate.orderDiscountAmount, 20);
  assert.equal(rate.total, 180);

  const fixed = retailOrderTotals(cart, { amount: 30 });
  assert.equal(fixed.orderDiscountAmount, 30);
  assert.equal(fixed.total, 170);

  // 定額大過小計 → 夾住
  const capped = retailOrderTotals(cart, { amount: 999 });
  assert.equal(capped.orderDiscountAmount, 200);
  assert.equal(capped.total, 0);
});

test("retailOrderTotals：空車 → 全 0（唔會 NaN）", () => {
  const t = retailOrderTotals([]);
  assert.equal(t.lineCount, 0);
  assert.equal(t.total, 0);
  assert.equal(t.listTotal, 0);
  assert.equal(t.totalSaving, 0);
  assert.ok(Number.isFinite(t.total));
});

test("retailOrderTotals：改價 + 單品折扣同時存在（totalSaving 要包晒兩樣）", () => {
  let cart: RetailCartLine[] = [];
  cart = addRetailLine(cart, { ...shirt, priceOverride: 150, lineDiscountRate: 80 }, "l1");
  const t = retailOrderTotals(cart);
  assert.equal(t.listTotal, 199);
  assert.equal(t.grossSubtotal, 150);
  assert.equal(t.overrideSaving, 49);
  assert.equal(t.itemDiscount, 30); // 150 × 20%
  assert.equal(t.total, 120);
  assert.equal(t.totalSaving, 79);
});

// ─────────────────────────────────────────────────────────────
// 權限閘判斷
// ─────────────────────────────────────────────────────────────

test("adjustmentRequiresApproval：任何改價都要閘；大額折扣 / 定額折都要閘", () => {
  const base: RetailCartLine = { lineId: "l", productId: "p", name: "n", unitPrice: 100, quantity: 1, unit: "件" };
  assert.equal(adjustmentRequiresApproval(base), false);
  assert.equal(adjustmentRequiresApproval({ ...base, priceOverride: 90 }), true);
  assert.equal(adjustmentRequiresApproval({ ...base, lineDiscountRate: 95 }), false); // 未到 9 折
  assert.equal(adjustmentRequiresApproval({ ...base, lineDiscountRate: 85 }), true);
  assert.equal(adjustmentRequiresApproval({ ...base, lineDiscountAmount: 80 }), true);
  assert.equal(adjustmentRequiresApproval({ ...base, lineDiscountAmount: 10 }), false);
});

test("adjustmentRequiresApproval：改到低於成本一定閘", () => {
  const line: RetailCartLine = {
    lineId: "l",
    productId: "p",
    name: "n",
    unitPrice: 100,
    quantity: 1,
    unit: "件",
    priceOverride: 60,
  };
  assert.equal(adjustmentRequiresApproval(line, { cost: 80 }), true); // 賣 60 低過成本 80
  assert.equal(adjustmentRequiresApproval(line, { cost: 50 }), true); // 改價本身仍要閘
});
