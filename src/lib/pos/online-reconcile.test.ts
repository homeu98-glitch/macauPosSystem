import assert from "node:assert/strict";
import test from "node:test";

import {
  isCancelledLedgerOrder,
  onlineFetchWarning,
  reconcileOnlineOrders,
  unadoptedNotice,
} from "./online-reconcile.ts";

/**
 * 線上單對數迴歸（2026-09-24）。
 *
 * 真實案例：表嫂美食取餐碼 **001**（MOP 43、餘額扣點、預約單）在 Ledger 已完成＋已付款，
 * 但 POS `pos_orders` 完全冇 ⇒ 報表／交班明細見唔到，而且零提示。
 */

const LEDGER = [
  // ① 已入 POS（有 onlineOrderId 對應）—— 正常
  { id: "2cc9593f", paymentStatus: "paid", status: "completed", total: 40, pickupCode: "002" },
  // ② 🔴 未入 POS（Ledger 有、POS 冇）—— 事故單
  { id: "f74b4a98", paymentStatus: "paid", status: "completed", total: 43, pickupCode: "001" },
  // ③ 未付款 —— 唔算錢
  { id: "unpaid-1", paymentStatus: "unpaid", status: "pending", total: 99 },
  // ④ 已取消 —— 剔
  { id: "cancel-1", paymentStatus: "paid", status: "cancelled", total: 77 },
];

const POS = [{ onlineOrderId: "2cc9593f" }, { onlineOrderId: null }, {}];

test("對數：只列出『已付款（非取消）但 POS 冇記錄』嘅線上單", () => {
  const r = reconcileOnlineOrders({ ledgerOrders: LEDGER, posOrders: POS });
  assert.deepEqual(
    r.unadopted.map((o) => o.id),
    ["f74b4a98"],
  );
  assert.equal(r.unadoptedCount, 1);
  assert.equal(r.unadoptedAmountMop, 43);
  assert.equal(r.paidCount, 2, "已付款非取消：002 + 001");
  assert.equal(r.paidAmountMop, 83, "40 + 43");
});

test("對數：全部已入帳 → 未入帳 0 張（唔會誤報）", () => {
  const r = reconcileOnlineOrders({
    ledgerOrders: [LEDGER[0]],
    posOrders: POS,
  });
  assert.equal(r.unadoptedCount, 0);
  assert.equal(r.unadoptedAmountMop, 0);
  assert.equal(unadoptedNotice(r), null);
});

test("對數：未付款同已取消都唔會被當成『漏帳』", () => {
  const r = reconcileOnlineOrders({
    ledgerOrders: [LEDGER[2], LEDGER[3]],
    posOrders: [],
  });
  assert.equal(r.unadoptedCount, 0);
  assert.equal(r.paidCount, 0);
});

test("對數：冇 id／金額壞值唔會拋，亦唔會污染合計", () => {
  const r = reconcileOnlineOrders({
    ledgerOrders: [
      { id: "", paymentStatus: "paid", status: "completed", total: 10 },
      { id: "bad", paymentStatus: "paid", status: "completed", total: Number.NaN },
    ],
    posOrders: [],
  });
  assert.equal(r.unadoptedCount, 1, "冇 id 嘅單無得補，跳過");
  assert.equal(r.unadoptedAmountMop, 0);
});

test("isCancelledLedgerOrder：任何含 cancel 嘅狀態（大小寫不拘）", () => {
  assert.equal(isCancelledLedgerOrder({ id: "a", status: "cancelled" }), true);
  assert.equal(isCancelledLedgerOrder({ id: "a", status: "CANCELLED_BY_USER" }), true);
  assert.equal(isCancelledLedgerOrder({ id: "a", status: "completed" }), false);
  assert.equal(isCancelledLedgerOrder({ id: "a" }), false);
});

test("提示文案：有未入帳單先出，否則 null", () => {
  const r = reconcileOnlineOrders({ ledgerOrders: [LEDGER[1]], posOrders: [] });
  const notice = unadoptedNotice(r);
  assert.ok(notice && notice.includes("1 張") && notice.includes("43"));
  assert.equal(unadoptedNotice({ unadopted: [], unadoptedCount: 0, unadoptedAmountMop: 0, paidCount: 0, paidAmountMop: 0 }), null);
});

test("🔴 抓取警示：error 同 skipped 都一定要有文案（舊寫法 skipped 完全靜默）", () => {
  assert.match(String(onlineFetchWarning("error", "Ledger 登入已過期")), /抓取失敗/);
  assert.match(String(onlineFetchWarning("error")), /抓取失敗/);
  assert.match(String(onlineFetchWarning("skipped", "尚未登入 Ledger")), /未載入/);
  assert.equal(onlineFetchWarning("success"), null, "成功唔應該出警示");
  assert.equal(onlineFetchWarning("loading"), null);
  assert.equal(onlineFetchWarning("idle"), null);
});
