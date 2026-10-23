import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  POS_STAFF_ACTION_IDS,
  POS_STAFF_PAGE_IDS,
  POS_STAFF_ROLE_IDS,
  canDoAction,
  canSeePage,
  defaultPosStaffPermissions,
  isWeakPin,
  normalizePosStaffPermissions,
  normalizeStaffNo,
  ownerPermissions,
  permissionsForOperator,
  validatePosStaffDraft,
} from "./staff-core.ts";

const CORE_PATH = "src/lib/pos/staff-core.ts";
const MODULE_CATALOG_PATH = "src/lib/pos/module-catalog.ts";

describe("pos staff core", () => {
  it("🔴 唔可以有 import（node --test 契約）", () => {
    const src = readFileSync(CORE_PATH, "utf8");
    const offenders = src
      .split(/\r?\n/)
      .filter((line) => /^\s*import\s/.test(line) || /require\(/.test(line));
    assert.deepEqual(offenders, []);
  });

  it("🔴 頁面 id 必須同 module-catalog 的側欄模組一致（兩邊唔可以漂移）", () => {
    const catalog = readFileSync(MODULE_CATALOG_PATH, "utf8");
    const block = catalog.slice(catalog.indexOf("export const SIDEBAR_MODULES"));
    const ids = [...block.matchAll(/\{\s*id:\s*"([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, [...POS_STAFF_PAGE_IDS]);
  });

  it("角色只有 manager / cashier（店主唔入呢張表）", () => {
    assert.deepEqual([...POS_STAFF_ROLE_IDS], ["manager", "cashier"]);
  });

  it("manager 預設全開；cashier 預設保留今日實際行為", () => {
    const manager = defaultPosStaffPermissions("manager");
    assert.equal(Object.values(manager.pages).every(Boolean), true);
    assert.equal(Object.values(manager.actions).every(Boolean), true);

    const cashier = defaultPosStaffPermissions("cashier");
    assert.equal(cashier.pages.order, true);
    assert.equal(cashier.pages.members, true);
    assert.equal(cashier.pages.reports, false);
    assert.equal(cashier.pages.inventory, false);
    // 今日實際行為：收銀可以補打、可以交班、可以返結（只強制填原因）
    assert.equal(cashier.actions.reprintReceipt, true);
    assert.equal(cashier.actions.closeShift, true);
    assert.equal(cashier.actions.reopenOrder, true);
    // 高風險一律收緊
    assert.equal(cashier.actions.voidItem, false);
    assert.equal(cashier.actions.refundOrder, false);
    assert.equal(cashier.actions.applyDiscount, false);
    assert.equal(cashier.actions.deviceSettings, false);
  });

  it("normalize：未知 key 靜靜丟棄、缺欄用角色預設（唔會變全 false）", () => {
    const raw = {
      pages: { order: false, reports: true, view_vip: true },
      actions: { voidItem: true, launchedMissile: true },
    };
    const normalized = normalizePosStaffPermissions(raw, "cashier");
    assert.equal(normalized.pages.order, false);
    assert.equal(normalized.pages.reports, true);
    // 缺欄 → 角色預設
    assert.equal(normalized.pages.members, true);
    assert.equal(normalized.actions.voidItem, true);
    assert.equal(normalized.actions.refundOrder, false);
    // 未知 id 唔會出現喺結果
    assert.equal((normalized.pages as Record<string, unknown>).view_vip, undefined);
    assert.equal((normalized.actions as Record<string, unknown>).launchedMissile, undefined);
  });

  it("normalize：兼容舊式扁平 action map", () => {
    const normalized = normalizePosStaffPermissions({ refundOrder: true }, "cashier");
    assert.equal(normalized.actions.refundOrder, true);
    assert.equal(normalized.actions.voidItem, false);
  });

  it("normalize：非物件輸入唔會 throw", () => {
    for (const input of [null, undefined, "x", 42, []]) {
      const normalized = normalizePosStaffPermissions(input, "cashier");
      assert.equal(normalized.pages.order, true);
      assert.equal(normalized.actions.refundOrder, false);
    }
  });

  it("ownerPermissions = 全開", () => {
    const owner = ownerPermissions();
    assert.equal(Object.values(owner.pages).every(Boolean), true);
    assert.equal(Object.values(owner.actions).every(Boolean), true);
    for (const id of POS_STAFF_PAGE_IDS) assert.equal(owner.pages[id], true);
    for (const id of POS_STAFF_ACTION_IDS) assert.equal(owner.actions[id], true);
  });

  it("canSeePage / canDoAction fail closed", () => {
    assert.equal(canSeePage(null, "reports"), false);
    assert.equal(canDoAction(undefined, "refundOrder"), false);
    assert.equal(canSeePage(defaultPosStaffPermissions("cashier"), "reports"), false);
    assert.equal(canDoAction(defaultPosStaffPermissions("manager"), "refundOrder"), true);
    assert.equal(canSeePage({} as unknown as ReturnType<typeof ownerPermissions>, "reports"), false);
  });

  it("permissionsForOperator：冇操作員 = 店主全開", () => {
    const asOwner = permissionsForOperator(null);
    assert.equal(asOwner.actions.refundOrder, true);
    const asCashier = permissionsForOperator({ role: "cashier", permissions: {} });
    assert.equal(asCashier.actions.refundOrder, false);
    const asOwnerRole = permissionsForOperator({ role: "owner" });
    assert.equal(asOwnerRole.actions.refundOrder, true);
  });

  it("工號正規化", () => {
    assert.equal(normalizeStaffNo("  01 "), "01");
    assert.equal(normalizeStaffNo("A 0 1"), "A01");
    assert.equal(normalizeStaffNo("ABCDEFGHIJKLMN"), "ABCDEFGHIJKL");
    assert.equal(normalizeStaffNo(null), "");
  });

  it("弱 PIN 一律攔截（含連續／重複／keypad 直線）", () => {
    for (const pin of ["0000", "1111", "1234", "4321", "3456", "6543", "7890", "2580"]) {
      assert.equal(isWeakPin(pin), true, `${pin} 應該算弱`);
    }
    for (const pin of ["1358", "9274", "0715"]) {
      assert.equal(isWeakPin(pin), false, `${pin} 應該通過`);
    }
  });

  it("validate：建立時必須有 PIN，編輯時可以留空", () => {
    const base = {
      staffNo: "01",
      name: "阿明",
      role: "cashier",
      permissions: { actions: { voidItem: true } },
    };
    const missing = validatePosStaffDraft(base, { requirePin: true });
    assert.equal(missing.ok, false);

    const created = validatePosStaffDraft({ ...base, pin: "1358" }, { requirePin: true });
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.value.pin, "1358");
      assert.equal(created.value.role, "cashier");
      // 前端只送一個 action，其餘用角色預設補齊
      assert.equal(created.value.permissions.actions.voidItem, true);
      assert.equal(created.value.permissions.actions.reprintReceipt, true);
      assert.equal(created.value.active, true);
    }

    const edited = validatePosStaffDraft({ ...base, name: "阿明（夜更）" }, { requirePin: false });
    assert.equal(edited.ok, true);
    if (edited.ok) assert.equal(edited.value.pin, undefined);
  });

  it("validate：角色／工號／姓名字段驗證", () => {
    const ok = { staffNo: "02", name: "Sara", role: "manager", pin: "1358" };
    assert.equal(validatePosStaffDraft({ ...ok, role: "owner" }, { requirePin: true }).ok, false);
    assert.equal(validatePosStaffDraft({ ...ok, staffNo: "工號" }, { requirePin: true }).ok, false);
    assert.equal(validatePosStaffDraft({ ...ok, name: "   " }, { requirePin: true }).ok, false);
    assert.equal(validatePosStaffDraft({ ...ok, pin: "12" }, { requirePin: true }).ok, false);
    assert.equal(validatePosStaffDraft({ ...ok, pin: "1234" }, { requirePin: true }).ok, false);
    assert.equal(validatePosStaffDraft(null, { requirePin: true }).ok, false);
  });
});
