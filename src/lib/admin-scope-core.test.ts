import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_SCOPE_STORES,
  dedupeStoreIds,
  isMissingColumnError,
  isPlatformPermissions,
  platformScope,
  scopeAllows,
  scopeSummary,
  scopedScope,
  storeFilterFor,
  type AdminScope,
} from "./admin-scope-core.ts";

/**
 * Admin scope 純邏輯（2026-10-21 · 多店 P1）。
 *
 * 呢組測試嘅重點唔係「功能啱唔啱」，而係**三條唔可以破嘅不變量**：
 *   ① `storeIds: []` ≠ 「全部」（空 scope 必須乜都睇唔到）
 *   ② 唔帶店參數 ≠ 「全部」（只有 platform 才可以用 null）
 *   ③ 指定越權店 = 403，唔可以降級
 * 呢三條任意一條破，就係跨租戶資料洩漏，而且症狀係「畫面正常、數字錯」。
 */
describe("admin-scope-core ── 三條不變量", () => {
  const platform: AdminScope = platformScope();
  const owner: AdminScope = scopedScope(["store-a", "store-b"]);
  const nobody: AdminScope = scopedScope([]);

  it("① 平台 + 冇指定店 ⇒ null（＝唔加 store filter，全平台）", () => {
    assert.deepEqual(storeFilterFor(platform, null), { ok: true, storeIds: null });
    assert.deepEqual(storeFilterFor(platform, ""), { ok: true, storeIds: null });
    assert.deepEqual(storeFilterFor(platform, "   "), { ok: true, storeIds: null });
  });

  it("① 店主 + 冇指定店 ⇒ 自己嘅店（唔會變成 null）", () => {
    assert.deepEqual(storeFilterFor(owner, null), { ok: true, storeIds: ["store-a", "store-b"] });
  });

  it("🔴 ① 空 scope + 冇指定店 ⇒ **空陣列**，唔可以係 null（否則＝睇晒全平台）", () => {
    const result = storeFilterFor(nobody, null);
    assert.deepEqual(result, { ok: true, storeIds: [] });
    assert.notEqual(result.ok && result.storeIds, null);
  });

  it("② 平台指定某一店 ⇒ 只查該店", () => {
    assert.deepEqual(storeFilterFor(platform, "store-z"), { ok: true, storeIds: ["store-z"] });
  });

  it("② 店主指定自己店 ⇒ 只查該店", () => {
    assert.deepEqual(storeFilterFor(owner, "store-b"), { ok: true, storeIds: ["store-b"] });
  });

  it("🔴 ② 店主指定別人店 ⇒ out-of-scope（403），唔可以靜默降級", () => {
    assert.deepEqual(storeFilterFor(owner, "store-z"), { ok: false, reason: "out-of-scope" });
    assert.equal(storeFilterFor(nobody, "store-a").ok, false);
  });

  it("③ 前後空白要 trim（前端／URL 常見）", () => {
    assert.deepEqual(storeFilterFor(owner, " store-a "), { ok: true, storeIds: ["store-a"] });
  });
});

describe("admin-scope-core ── 其他", () => {
  it("空 scope 仍然係合法 scope（唔係錯誤），但 scopeAllows 全 false", () => {
    const nobody = scopedScope([]);
    assert.equal(scopeAllows(nobody, "store-a"), false);
    assert.equal(scopeAllows(platformScope(), "store-a"), true);
    assert.equal(scopeAllows(scopedScope(["store-a"]), "store-a"), true);
  });

  it("dedupeStoreIds：去重、去空、保持順序", () => {
    assert.deepEqual(dedupeStoreIds(["a", "b", "a", "", null, undefined, "  ", "c"]), ["a", "b", "c"]);
  });

  it("isPlatformPermissions：scopeAllStores 或 manageAccounts 都算平台（後者為過渡推導）", () => {
    assert.equal(isPlatformPermissions({ scopeAllStores: true }), true);
    assert.equal(isPlatformPermissions({ manageAccounts: true }), true);
    assert.equal(isPlatformPermissions({ manageAccounts: false, refundOrder: true }), false);
    assert.equal(isPlatformPermissions(null), false);
    assert.equal(isPlatformPermissions(undefined), false);
    assert.equal(isPlatformPermissions("admin"), false);
    // 只有 scopeAllStores: false 而 manageAccounts 未設 → 唔係平台
    assert.equal(isPlatformPermissions({ scopeAllStores: false }), false);
  });

  it("scopeSummary：平台唔會 enumerate 全部店（返空陣列），店主返自己店", () => {
    assert.deepEqual(scopeSummary(platformScope()), { all: true, storeIds: [] });
    assert.deepEqual(scopeSummary(scopedScope(["b", "a"])), { all: false, storeIds: ["b", "a"] });
  });

  it("D5：上限 20（建號／綁店驗證用）", () => {
    assert.equal(MAX_SCOPE_STORES, 20);
  });

  it("回傳嘅陣列係副本（呼叫端改咗唔會污染 scope）", () => {
    const scope = scopedScope(["a"]);
    const filter = storeFilterFor(scope, null);
    assert.ok(filter.ok);
    (filter.storeIds as string[]).push("hacked");
    assert.deepEqual(scope.storeIds, ["a"]);
  });

  it("isMissingColumnError：認得 42703 同訊息（migration 0024 未跑時要 503 而唔係靜默空白）", () => {
    assert.equal(isMissingColumnError({ code: "42703", message: "column x does not exist" }), true);
    assert.equal(isMissingColumnError({ message: 'column "merchant_id" does not exist' }), true);
    assert.equal(isMissingColumnError({ code: "PGRST116", message: "no rows" }), false);
    assert.equal(isMissingColumnError(null), false);
    assert.equal(isMissingColumnError(undefined), false);
    assert.equal(isMissingColumnError("boom"), false);
  });
});
