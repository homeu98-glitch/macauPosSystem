import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_STORES_PER_ACCOUNT,
  PROTECTED_PLATFORM_ACCOUNT,
  isProtectedAccount,
  validateNewAccountInput,
  validatePinInput,
  validateStoreIdsInput,
} from "./admin-accounts-core.ts";

/**
 * 帳號管理純驗證（2026-10-21 · P2）。
 *
 * 呢組規則係「唯一可以製造新後台身份」嘅閘門，所以逐條邊界都要有測試：
 *   · 8 位帳號 / 4 位 PIN（格式唔啱唔應該浪費一次 DB 查詢）
 *   · 店舖級必須 1–20 間店（0 間 = 登入會被拒，不如建立時就報錯）
 *   · 平台級刻意**唔綁店**（佢嘅範圍係全部，綁定只會造成誤解）
 *   · 總管理帳號 60000000 唔可以停用（停咗冇人救得返）
 */
describe("admin-accounts-core ── 建號驗證", () => {
  const base = { account: "60000099", pin: "1234", name: "表嫂（老闆）" };

  it("店舖級 + 1 間店 → OK", () => {
    const r = validateNewAccountInput({ ...base, kind: "owner", storeIds: ["store-a"] });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value.storeIds, ["store-a"]);
  });

  it("🔴 店舖級 0 間店 → 報錯（否則登入會被 session 的 no_scope 擋）", () => {
    const r = validateNewAccountInput({ ...base, kind: "owner", storeIds: [] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /至少要綁 1 間店/);
  });

  it(`🔴 店舖級 ${MAX_STORES_PER_ACCOUNT + 1} 間店 → 報錯（D5 上限 20）`, () => {
    const ids = Array.from({ length: MAX_STORES_PER_ACCOUNT + 1 }, (_, i) => `store-${i}`);
    const r = validateNewAccountInput({ ...base, kind: "owner", storeIds: ids });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /最多綁 20 間/);
  });

  it("正好 20 間店 → OK（邊界）", () => {
    const ids = Array.from({ length: MAX_STORES_PER_ACCOUNT }, (_, i) => `store-${i}`);
    const r = validateNewAccountInput({ ...base, kind: "owner", storeIds: ids });
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.storeIds.length, 20);
  });

  it("平台級：即使前端傳 storeIds 都會被清空（範圍＝全部，綁定只會誤導）", () => {
    const r = validateNewAccountInput({ ...base, kind: "platform", storeIds: ["store-a"] });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value.storeIds, []);
  });

  it("帳號格式：必須 8 位數字", () => {
    assert.equal(validateNewAccountInput({ ...base, account: "6000009", kind: "owner", storeIds: ["a"] }).ok, false);
    assert.equal(validateNewAccountInput({ ...base, account: "6000009a", kind: "owner", storeIds: ["a"] }).ok, false);
    assert.equal(validateNewAccountInput({ ...base, account: " 60000099 ", kind: "owner", storeIds: ["a"] }).ok, true);
  });

  it("PIN 格式：必須 4 位數字", () => {
    assert.equal(validateNewAccountInput({ ...base, pin: "123", kind: "owner", storeIds: ["a"] }).ok, false);
    assert.equal(validateNewAccountInput({ ...base, pin: "12345", kind: "owner", storeIds: ["a"] }).ok, false);
  });

  it("名稱：唔可以空白，最長 40 字", () => {
    assert.equal(validateNewAccountInput({ ...base, name: "   ", kind: "owner", storeIds: ["a"] }).ok, false);
    assert.equal(
      validateNewAccountInput({ ...base, name: "長".repeat(41), kind: "owner", storeIds: ["a"] }).ok,
      false,
    );
  });

  it("storeIds 去重 + 去空白", () => {
    const r = validateNewAccountInput({
      ...base,
      kind: "owner",
      storeIds: [" a ", "a", "", null, "b"],
    });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value.storeIds, ["a", "b"]);
  });
});

describe("admin-accounts-core ── 改綁店 / 重設 PIN", () => {
  it("validateStoreIdsInput：空 → 報錯；21 → 報錯；重複 → 去重", () => {
    assert.equal(validateStoreIdsInput([]).ok, false);
    assert.equal(validateStoreIdsInput(Array.from({ length: 21 }, (_, i) => `s${i}`)).ok, false);
    const r = validateStoreIdsInput(["a", "a", "b"]);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value, ["a", "b"]);
  });

  it("validatePinInput", () => {
    assert.ok(validatePinInput("1234").ok);
    assert.equal(validatePinInput("123").ok, false);
    assert.equal(validatePinInput(1234).ok, false);
    assert.equal(validatePinInput(null).ok, false);
  });

  it("🔴 總管理帳號唔可以被停用（否則全平台冇人管得到帳號）", () => {
    assert.equal(isProtectedAccount(PROTECTED_PLATFORM_ACCOUNT), true);
    assert.equal(isProtectedAccount(" 60000000 "), true);
    assert.equal(isProtectedAccount("60000099"), false);
  });
});
