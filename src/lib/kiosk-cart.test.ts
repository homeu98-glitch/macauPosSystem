// 回歸測試：掃碼點餐購物車 + 金額口徑（docs/reviews/qr-self-order-audit-2026-09-10.md P1-3 / P3-1）
// 用 Node 內建 test runner，唔引入新依賴：node --test src/lib/kiosk-cart.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { changeCartQty, computeOrderTotals, lineSignature, mergeCartLine, type CartLine } from "./kiosk-cart.ts";

const base = {
  menuItemId: "dish-1",
  name: "乾炒牛河",
  price: 48,
  printerGroup: "kitchen" as const,
};

const withSpecs = (optionId: string) => ({
  ...base,
  selectedSpecs: [
    { groupId: "g1", groupName: "辣度", optionId, optionLabel: optionId, priceDelta: 0 },
  ],
});

test("lineSignature：規格選擇次序唔影響簽名（先 A 後 B == 先 B 後 A）", () => {
  const a = { ...base, selectedSpecs: [
    { groupId: "g1", groupName: "辣度", optionId: "opt-a", optionLabel: "小辣", priceDelta: 0 },
    { groupId: "g2", groupName: "走冰", optionId: "opt-b", optionLabel: "走冰", priceDelta: 0 },
  ] };
  const b = { ...base, selectedSpecs: [
    { groupId: "g2", groupName: "走冰", optionId: "opt-b", optionLabel: "走冰", priceDelta: 0 },
    { groupId: "g1", groupName: "辣度", optionId: "opt-a", optionLabel: "小辣", priceDelta: 0 },
  ] };
  assert.equal(lineSignature(a), lineSignature(b));
});

test("lineSignature：規格 / 備註唔同就唔會合併", () => {
  assert.notEqual(lineSignature(withSpecs("小辣")), lineSignature(withSpecs("大辣")));
  assert.notEqual(lineSignature(base), lineSignature({ ...base, note: "少油" }));
});

test("mergeCartLine：同菜同規格自動合併數量（唔會出兩行）", () => {
  let cart: CartLine[] = [];
  cart = mergeCartLine(cart, base, "line-1");
  cart = mergeCartLine(cart, base, "line-2");
  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, 2);
  assert.equal(cart[0].lineId, "line-1"); // 重用第一行

  // 加一個唔同規格 → 新開一行
  cart = mergeCartLine(cart, withSpecs("大辣"), "line-3");
  assert.equal(cart.length, 2);
});

test("changeCartQty：減到 0 就移除該行", () => {
  const cart = mergeCartLine([], base, "line-1");
  assert.equal(changeCartQty(cart, "line-1", -1).length, 0);
});

test("computeOrderTotals：總計 = 小計 + 服務費 + 稅（同 buildKioskOrder 同源）", () => {
  const items = [
    { price: 100, quantity: 2 }, // 200
    { price: 50, quantity: 1 }, // 50
  ];
  const totals = computeOrderTotals(items, { taxRate: 0.05, serviceChargeRate: 0.1 });
  assert.equal(totals.subtotal, 250);
  assert.equal(totals.serviceChargeAmount, 25); // 250 * 10%
  assert.equal(totals.taxAmount, 12.5); // 250 * 5%
  assert.equal(totals.total, 287.5);
});

test("computeOrderTotals：冇設稅 / 服務費（或 rules 為 null）→ 總計 == 小計", () => {
  const totals = computeOrderTotals([{ price: 36.3, quantity: 3 }], null);
  // 36.3 * 3 喺 IEEE754 下係 108.89999999999999 —— 呢個正正係審查 P2-3 講嘅浮點噪音。
  // 函式**刻意唔做四捨五入**（同寫入 DB 嘅金額一致），顯示層一律用 `toFixed(2)` / `money2()`。
  assert.equal(totals.subtotal.toFixed(2), "108.90");
  assert.equal(totals.taxAmount, 0);
  assert.equal(totals.serviceChargeAmount, 0);
  assert.equal(totals.total.toFixed(2), "108.90");
});
