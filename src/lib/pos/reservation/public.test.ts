import assert from "node:assert/strict";
import test from "node:test";

import {
  maskPhone,
  phoneTail,
  publicReservationView,
  toPublicSettings,
} from "./public.ts";
import { defaultReservationSettings } from "./types.ts";
import type { PosReservation } from "./types.ts";

function fakeReservation(overrides: Partial<PosReservation> = {}): PosReservation {
  return {
    id: "res-1",
    storeId: "store-a",
    code: "R1106-018",
    bizDate: "2026-11-06",
    slotAt: "2026-11-06T11:00:00.000Z",
    partySize: 6,
    guestName: "陳先生",
    guestPhone: "+853 6612 3456",
    guestNote: "有小朋友",
    status: "confirmed",
    source: "ledger",
    tableId: null,
    tableName: null,
    orderId: null,
    orderNo: null,
    items: [],
    itemsSubtotal: 304,
    discountAmount: 31,
    payableAmount: 273,
    paidAmount: 273,
    paidAt: null,
    paymentRef: "TXN-SECRET-123",
    paymentMethod: "balance",
    refundAmount: 0,
    refundedAt: null,
    memberId: "member-secret-uuid",
    memberDiscountRate: 90,
    createdAt: "2026-11-06T02:00:00.000Z",
    confirmedAt: null,
    arrivedAt: null,
    seatedAt: null,
    canceledAt: null,
    cancelReason: null,
    updatedAt: "2026-11-06T02:00:00.000Z",
    ...overrides,
  };
}

test("phoneTail 認得澳門常見電話格式", () => {
  assert.equal(phoneTail("+853 6612 3456"), "3456");
  assert.equal(phoneTail("66123456"), "3456");
  assert.equal(phoneTail("(6612) 3456"), "3456");
  assert.equal(phoneTail("123"), "");
  assert.equal(phoneTail(null), "");
});

test("maskPhone 只留尾 4 位，唔會完整輸出", () => {
  assert.equal(maskPhone("+853 6612 3456"), "**** 3456");
  assert.equal(maskPhone("123"), "");
  assert.doesNotMatch(maskPhone("66123456"), /6612/);
});

test("publicReservationView 唔可以洩漏內部欄位", () => {
  const view = publicReservationView(fakeReservation());
  const json = JSON.stringify(view);

  assert.equal(view.code, "R1106-018");
  assert.equal(view.guestPhoneMasked, "**** 3456");
  // 🔴 呢幾個一旦外洩就係個資／對帳資料事故
  for (const forbidden of [
    "6612 3456",
    "member-secret-uuid",
    "TXN-SECRET-123",
    "memberId",
    "paymentRef",
    "res-1",
    "store-a",
  ]) {
    assert.equal(json.includes(forbidden), false, `唔應該出現 ${forbidden}`);
  }
});

test("publicReservationView 預點菜只輸出顯示需要嘅欄位", () => {
  const view = publicReservationView(
    fakeReservation({
      items: [
        {
          menuItemId: "m1",
          name: "蜜汁叉燒",
          specText: "少甜",
          specs: { g1: ["o1"] },
          qty: 2,
          unitPrice: 88,
          memberPrice: 79,
          discountRate: null,
          snapshotAt: "2026-11-06T02:00:00.000Z",
        },
      ],
    }),
  );
  const items = view.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0].name, "蜜汁叉燒");
  assert.equal(items[0].specs, undefined);
  assert.equal(items[0].snapshotAt, undefined);
});

test("toPublicSettings 係白名單，唔會帶出商業敏感設定", () => {
  const settings = defaultReservationSettings("store-a");
  const view = toPublicSettings({
    ...settings,
    depositRequired: true,
    depositAmount: 500,
    refundCutoffMinutes: 999,
  });
  const keys = Object.keys(view).sort();
  assert.deepEqual(keys, [
    "autoConfirm",
    "cancelCutoffMinutes",
    "enabled",
    "largePartyThreshold",
    "leadDaysMax",
    "leadMinutesMin",
    "maxPartySize",
    "minPartySize",
    "notice",
    "serviceHours",
    "slotIntervalMinutes",
    "slotQuota",
    "turnMinutes",
  ]);
  assert.equal((view as Record<string, unknown>).depositAmount, undefined);
  assert.equal((view as Record<string, unknown>).storeId, undefined);
});
