import assert from "node:assert/strict";
import { test } from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
import { resolveMenuItemPriceInput } from "./menu-item-price.ts";

/**
 * 菜品價格輸入守衛（2026-10-20 回歸）。
 *
 * 要守住嘅核心不變量：
 *   ① **商家打咗幾多，就存幾多**（唔可以因為「時價菜」勾住而靜靜變 0）；
 *   ② 時價菜可以完全唔填（落單時由店員輸入）；
 *   ③ 非時價菜唔可以冇價；
 *   ④ 格式錯要報錯（唔可以吞成 NaN → 存 0）。
 */
test("非時價菜：正常價錢照存", () => {
  assert.deepEqual(resolveMenuItemPriceInput("70", false), { ok: true, price: 70 });
  assert.deepEqual(resolveMenuItemPriceInput("12.5", false), { ok: true, price: 12.5 });
});

test("🔴 時價菜：填咗價錢唔可以被清成 0（原本嘅 bug）", () => {
  assert.deepEqual(resolveMenuItemPriceInput("70", true), { ok: true, price: 70 });
});

test("時價菜：留空＝0（落單時由店員輸入）", () => {
  assert.deepEqual(resolveMenuItemPriceInput("", true), { ok: true, price: 0 });
  assert.deepEqual(resolveMenuItemPriceInput("   ", true), { ok: true, price: 0 });
});

test("非時價菜：留空要報錯（唔可以靜靜存 0）", () => {
  const result = resolveMenuItemPriceInput("", false);
  assert.equal(result.ok, false);
});

test("前後空白要 trim", () => {
  assert.deepEqual(resolveMenuItemPriceInput("  70  ", false), { ok: true, price: 70 });
});

test("0 元菜合法（贈品／免費項目）", () => {
  assert.deepEqual(resolveMenuItemPriceInput("0", false), { ok: true, price: 0 });
});

test("負數／非數字要報錯", () => {
  for (const bad of ["-5", "abc", "7o", "1,2"]) {
    const result = resolveMenuItemPriceInput(bad, false);
    assert.equal(result.ok, false, `${bad} 應該被擋`);
  }
});
