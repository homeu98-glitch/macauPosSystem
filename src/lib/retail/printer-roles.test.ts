// 打印機角色集合測試（docs/124 §R5「一機兩用」）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canPrintLabel,
  canPrintReceipt,
  describePrinterRoles,
  hasPrinterRole,
  isDualRolePrinter,
  isZonePrinter,
  printerRolesOf,
  sanitizeRoles,
  withRoles,
  type PrinterRoleLike,
} from "./printer-roles.ts";

test("sanitizeRoles：去重 / 保序 / 剔走非法值", () => {
  assert.deepEqual(sanitizeRoles(["receipt", "label", "receipt"]), ["receipt", "label"]);
  assert.deepEqual(sanitizeRoles(["bogus", "label", 123, null, "zone"]), ["label", "zone"]);
  assert.deepEqual(sanitizeRoles([]), []);
  assert.deepEqual(sanitizeRoles(undefined), []);
  assert.deepEqual(sanitizeRoles(null), []);
});

test("🔴 printerRolesOf：舊設定（只有單值 role）要照樣推導到 —— 唔使遷移", () => {
  assert.deepEqual(printerRolesOf({ role: "receipt" }), ["receipt"]);
  assert.deepEqual(printerRolesOf({ role: "label" }), ["label"]);
  assert.deepEqual(printerRolesOf({ role: "zone" }), ["zone"]);
  assert.deepEqual(printerRolesOf({}), []);
  assert.deepEqual(printerRolesOf(null), []);
  assert.deepEqual(printerRolesOf(undefined), []);
});

test("🔴 printerRolesOf：roles 有值就為準，空陣列 = 明確停用（唔可以退回 role）", () => {
  assert.deepEqual(printerRolesOf({ role: "receipt", roles: [] }), []);
  assert.deepEqual(printerRolesOf({ role: "receipt", roles: ["label"] }), ["label"]);
  assert.deepEqual(printerRolesOf({ role: "receipt", roles: ["receipt", "label"] }), [
    "receipt",
    "label",
  ]);
});

test("hasPrinterRole / canPrintReceipt / canPrintLabel / isZonePrinter", () => {
  const dual = { role: "receipt" as const, roles: ["receipt" as const, "label" as const] };
  assert.equal(hasPrinterRole(dual, "receipt"), true);
  assert.equal(hasPrinterRole(dual, "label"), true);
  assert.equal(hasPrinterRole(dual, "zone"), false);
  assert.equal(canPrintReceipt(dual), true);
  assert.equal(canPrintLabel(dual), true);
  assert.equal(isZonePrinter(dual), false);

  const labelOnly = { role: "label" as const };
  assert.equal(canPrintReceipt(labelOnly), false);
  assert.equal(canPrintLabel(labelOnly), true);
});

test("isDualRolePrinter：一機兩用要認得出", () => {
  assert.equal(isDualRolePrinter({ role: "receipt", roles: ["receipt", "label"] }), true);
  assert.equal(isDualRolePrinter({ role: "receipt" }), false);
  assert.equal(isDualRolePrinter({ role: "label" }), false);
  assert.equal(isDualRolePrinter(null), false);
});

test("withRoles：roles 一定寫明確值，而 role 同步成第一個（令未讀 roles 嘅舊代碼行為合理）", () => {
  const before = { id: "p1", role: "receipt" as const };
  assert.deepEqual(withRoles(before, ["receipt", "label"]), {
    id: "p1",
    role: "receipt",
    roles: ["receipt", "label"],
  });
  assert.deepEqual(withRoles(before, ["label"]), { id: "p1", role: "label", roles: ["label"] });
  // 清空角色 → role 保留原值（唔會變 undefined 令舊代碼當成「冇角色」）
  assert.deepEqual(withRoles(before, []), { id: "p1", role: "receipt", roles: [] });
  // 非法值剔走後空 → 一樣保留 role
  // （runtime 上雲端 DB 可能存咗垃圾值，所以故意用 cast 繞過型別去測防呆）
  assert.deepEqual(withRoles(before, ["bogus"] as unknown as PrinterRoleLike[]), {
    id: "p1",
    role: "receipt",
    roles: [],
  });
});

test("describePrinterRoles：講人話，一機兩用要一眼睇得出", () => {
  assert.equal(describePrinterRoles({ role: "receipt" }), "收據單");
  assert.equal(describePrinterRoles({ role: "label" }), "標籤單");
  assert.equal(describePrinterRoles({ role: "receipt", roles: ["receipt", "label"] }), "收據＋標籤（一機兩用）");
  assert.equal(describePrinterRoles({}), "未分配");
  assert.equal(describePrinterRoles(null), "未分配");
});
