import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SCAN_MODE, normalizeScanMode } from "./kiosk-settings.ts";

/**
 * 掃碼點餐模式（docs/115）嘅**正常化讀取**規則。
 *
 * 呢條規則係「靜默錯就出事」嘅地方：`scan_mode` 係 0031 migration 新加嘅欄位，
 * 舊 DB row / code 先上 migration 後上嘅窗口期，讀到嘅可能係 `undefined` 或者
 * 第啲未知值。一旦當成 `quick`，鋪頭就會由「逐枱一碼」靜靜變成「全店一碼」
 * —— 桌台碼全部失效，客人掃碼會落一批冇枱嘅單。
 */
describe("normalizeScanMode", () => {
  it("DB 有明確值 → 照用", () => {
    assert.equal(normalizeScanMode("dine_in"), "dine_in");
    assert.equal(normalizeScanMode("quick"), "quick");
  });

  it("undefined / null / 空字串（欄位未存在 / 未設定）→ dine_in（向後兼容）", () => {
    assert.equal(normalizeScanMode(undefined), "dine_in");
    assert.equal(normalizeScanMode(null), "dine_in");
    assert.equal(normalizeScanMode(""), "dine_in");
  });

  it("未知值（打錯字 / 舊版本殘留）→ 一律 dine_in，唔會誤當快餐", () => {
    assert.equal(normalizeScanMode("QUICK"), "dine_in");
    assert.equal(normalizeScanMode("counter"), "dine_in");
    assert.equal(normalizeScanMode(1), "dine_in");
    assert.equal(normalizeScanMode({}), "dine_in");
  });

  it("預設模式係堂食（現存店鋪行為不變）", () => {
    assert.equal(DEFAULT_SCAN_MODE, "dine_in");
  });
});
