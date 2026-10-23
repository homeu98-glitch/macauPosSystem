import assert from "node:assert/strict";
import test from "node:test";

import {
  describeIdentity,
  describeIdentityGap,
  staffNoFromAccount,
  storeAccountOf,
  type LoginIdentity,
} from "./login-identities.ts";

/**
 * 身份清單嘅純函數（docs/161）。
 *
 * 呢幾個函數都係「錯咗都唔會爆」嘅類型 —— 畫面照樣出，只係查錯店／講錯原因，
 * 所以更加要用測試鎖住。
 */

test("storeAccountOf：只認 8 位純數字店舖帳號", () => {
  assert.equal(storeAccountOf("60000002"), "60000002");
  assert.equal(storeAccountOf("6000 0002"), "60000002");
  assert.equal(storeAccountOf("1234567"), "");
  assert.equal(storeAccountOf(""), "");
  assert.equal(storeAccountOf(null), "");
  assert.equal(storeAccountOf(undefined), "");
});

test("storeAccountOf：店員 account 一律唔可以當成店舖帳號", () => {
  // 🔴 呢個係重點：`staff:12345678` 抽數字之後**正好**係 8 位。
  //    唔擋就會攞住工號去查店，然後靜靜登入咗第二間舖（或者查唔到）。
  assert.equal(storeAccountOf("staff:01"), "");
  assert.equal(storeAccountOf("staff:12345678"), "");
});

test("staffNoFromAccount：只抽 staff: 前綴", () => {
  assert.equal(staffNoFromAccount("staff:01"), "01");
  assert.equal(staffNoFromAccount("staff:A12"), "A12");
  assert.equal(staffNoFromAccount("60000002"), "");
  assert.equal(staffNoFromAccount(null), "");
});

test("describeIdentity：店主同店員文案唔可以一樣", () => {
  const owner: LoginIdentity = { kind: "owner", id: "owner", name: "店主", role: "owner" };
  const manager: LoginIdentity = {
    kind: "staff",
    id: "s1",
    staffNo: "01",
    name: "小紅",
    role: "manager",
  };
  const cashier: LoginIdentity = {
    kind: "staff",
    id: "s2",
    staffNo: "02",
    name: "小明",
    role: "cashier",
  };

  assert.equal(describeIdentity(owner), "店主 · 全部權限");
  assert.equal(describeIdentity(manager), "工號 01 · 店長");
  assert.equal(describeIdentity(cashier), "工號 02 · 收銀員");
});

test("describeIdentityGap：多過一個身份就唔使解釋", () => {
  assert.equal(
    describeIdentityGap({
      identities: [
        { kind: "owner", id: "owner", name: "店主", role: "owner" },
        { kind: "staff", id: "s1", staffNo: "01", name: "小紅", role: "cashier" },
      ],
      known: true,
      staffTotal: 1,
      staffActive: 1,
    }),
    null,
  );
});

test("describeIdentityGap：三種「得店主一個」要講得出分別", () => {
  const onlyOwner = [{ kind: "owner", id: "owner", name: "店主", role: "owner" }] as LoginIdentity[];

  const firstTime = describeIdentityGap({ identities: onlyOwner, known: false });
  assert.match(String(firstTime), /第一次用/);

  const noTable = describeIdentityGap({
    identities: onlyOwner,
    known: true,
    staffTableMissing: true,
  });
  assert.match(String(noTable), /0072/);

  const noStaff = describeIdentityGap({ identities: onlyOwner, known: true, staffTotal: 0 });
  assert.match(String(noStaff), /仲未加入店員/);

  const allDisabled = describeIdentityGap({
    identities: onlyOwner,
    known: true,
    staffTotal: 3,
    staffActive: 0,
  });
  assert.match(String(allDisabled), /全部已停用/);

  // 三個原因一定要係三句唔同嘅話，唔可以撞
  assert.equal(
    new Set([String(firstTime), String(noTable), String(noStaff), String(allDisabled)]).size,
    4,
  );
});
