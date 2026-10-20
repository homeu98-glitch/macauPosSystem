import assert from "node:assert/strict";
import { test } from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
import {
  hasMemberBenefit,
  isValidMemberDiscountRate,
  isValidMemberPrice,
  memberOrderTotals,
  memberUnitPrice,
  memberUnitPriceForMenuItem,
} from "./member-price.ts";

/**
 * 會員價計價（2026-10-20 J 拍板）。
 *
 * 要守住嘅核心不變量：
 *   ① **逐項各自計**：有單品會員價用單品價，冇就跟全店率，最後加總；
 *      唔可以寫成「先加總再打折」（會令單品價再被乘一次）。
 *   ② 單品會員價**只可以更便宜**：等於或大於原價一律當冇設（唔可以收貴過原價）。
 *   ③ rate 100 / 0 / 負數 / undefined 一律當「冇會員折扣」。
 *   ④ 規格加價**唔打折**（同 `priceWithSpecs` 一致：規格加錢屬菜品本身）。
 */

test("單品會員價 override 全店百分比", () => {
  // 原價 38、單品會員價 30、全店 95 折 → 一定係 30，唔係 30×0.95 = 28.5
  assert.equal(memberUnitPrice(38, 30, 95), 30);
});

test("冇單品會員價就跟全店百分比", () => {
  assert.equal(memberUnitPrice(26, undefined, 95), 24.7);
  assert.equal(memberUnitPrice(10, undefined, 95), 9.5);
});

test("兩者都冇就收原價", () => {
  assert.equal(memberUnitPrice(26, undefined, undefined), 26);
  assert.equal(memberUnitPrice(26, undefined, 100), 26);
});

test("會員價等於或大於原價 → 當冇設，跟全店率（唔可以收貴過原價）", () => {
  // 原價由 38 減到 28，但會員價仲寫住 30（設定滯後）
  assert.equal(memberUnitPrice(28, 30, 95), 26.6); // 跟 95 折，唔用 30
  // 會員價等於原價 = 冇優惠，唔應該當「會員價」
  assert.equal(memberUnitPrice(38, 38, 95), 36.1);
});

test("rate 邊界：100 / 0 / 負數 / NaN 一律當冇折扣", () => {
  assert.equal(isValidMemberDiscountRate(100), false);
  assert.equal(isValidMemberDiscountRate(0), false);
  assert.equal(isValidMemberDiscountRate(-5), false);
  assert.equal(isValidMemberDiscountRate(Number.NaN), false);
  assert.equal(isValidMemberDiscountRate(undefined), false);
  assert.equal(isValidMemberDiscountRate(95), true);
  // 99.9 都算有效（極端但合法）
  assert.equal(memberUnitPrice(100, undefined, 99.9), 99.9);
});

test("規格加價唔打折，直接加", () => {
  // 原價 38 + 大碗加 5 = 43；會員價 30 + 5 = 35（唔係 35×0.95）
  assert.equal(memberUnitPrice(38, 30, 95, 5), 35);
  // 冇單品價：base 38 打折 + 加價 5 照加 = 36.1 + 5 = 41.1
  // （如果連加價都打折就係 43 × 0.95 = 40.85 —— 刻意唔係咁，規格加錢屬菜品本身）
  assert.equal(memberUnitPrice(38, undefined, 95, 5), 41.1);
});

test("四捨五入到分", () => {
  // 26 × 0.95 = 24.7
  assert.equal(memberUnitPrice(26, undefined, 95), 24.7);
  // 33.33 × 0.95 = 31.6635 → 31.66
  assert.equal(memberUnitPrice(33.33, undefined, 95), 31.66);
});

test("混合單：逐項各自計 ＋ 加總（唔可以先加總再打折）", () => {
  const totals = memberOrderTotals(
    [
      { price: 38, quantity: 1, memberPrice: 30 }, // 單品會員價
      { price: 26, quantity: 1 }, // 跟全店 95 折 → 24.7
    ],
    95,
  );
  assert.equal(totals.original, 64);
  assert.equal(totals.member, 54.7);
  assert.equal(totals.saving, 9.3);

  // 反證：如果寫成 (64 × 0.95) = 60.8 —— 呢個就係「先加總再打折」嘅錯數
  assert.notEqual(totals.member, 60.8);
});

test("混合單：冇任何會員設定時，member == original、saving == 0", () => {
  const totals = memberOrderTotals([{ price: 38, quantity: 2 }], undefined);
  assert.equal(totals.original, 76);
  assert.equal(totals.member, 76);
  assert.equal(totals.saving, 0);
});

test("數量 ×N 要逐行乘，唔可以只計一件", () => {
  const totals = memberOrderTotals(
    [
      { price: 38, quantity: 2, memberPrice: 30 }, // 60
      { price: 26, quantity: 3 }, // 74.1
    ],
    95,
  );
  assert.equal(totals.original, 76 + 78); // 154
  assert.equal(totals.member, 60 + 74.1); // 134.1
  assert.equal(totals.saving, 19.9);
});

test("hasMemberBenefit：冇優惠就唔顯示「會員價」", () => {
  // 有單品價 → 有優惠
  assert.equal(hasMemberBenefit({ price: 38, memberPrice: 30 }, undefined), true);
  // 只有全店率 → 有優惠
  assert.equal(hasMemberBenefit({ price: 38 }, 95), true);
  // 乜都冇 → 唔應該顯示（避免「原價 38、會員 38」）
  assert.equal(hasMemberBenefit({ price: 38 }, undefined), false);
  assert.equal(hasMemberBenefit({ price: 38 }, 100), false);
  // 單品價設定錯（> 原價）而全店又冇率 → 冇優惠
  assert.equal(hasMemberBenefit({ price: 28, memberPrice: 30 }, undefined), false);
});

test("memberUnitPriceForMenuItem 等價於 memberUnitPrice", () => {
  assert.equal(memberUnitPriceForMenuItem({ price: 38, memberPrice: 30 }, 95), 30);
  assert.equal(memberUnitPriceForMenuItem({ price: 26 }, 95), 24.7);
  assert.equal(memberUnitPriceForMenuItem({ price: 26 }, undefined), 26);
});

test("isValidMemberPrice 嚴格細於原價才算有效", () => {
  assert.equal(isValidMemberPrice(30, 38), true);
  assert.equal(isValidMemberPrice(38, 38), false); // 等於 = 冇優惠
  assert.equal(isValidMemberPrice(40, 38), false); // 大過 = 設定錯
  assert.equal(isValidMemberPrice(0, 38), false);
  assert.equal(isValidMemberPrice(-1, 38), false);
  assert.equal(isValidMemberPrice(undefined, 38), false);
});
