/**
 * `unfinished-orders.ts` 單元測試 —— 交班前「未完成訂單」判定（2026-11-03）。
 *
 * 商家口徑：**任何未完成狀態都要提**（線下＋線上、已付款＋未付款）；
 * 平台單（澳覓／MFood）唔提；同一張單本地／線上唔可以重複列。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectUnfinishedOrders,
  isUnfinishedLocalOrder,
  isUnfinishedOnlineOrder,
} from "./unfinished-orders.ts";

test("本地單：四個未完成狀態；已結帳／已取消／退款唔算", () => {
  for (const status of ["draft", "sent_to_kitchen", "paid", "reopened"]) {
    assert.equal(isUnfinishedLocalOrder({ status }), true, `${status} 應該算未完成`);
  }
  for (const status of ["settled", "cancelled", "refunded", "partially_refunded", ""]) {
    assert.equal(isUnfinishedLocalOrder({ status }), false, `${status} 唔應該算未完成`);
  }
});

test("平台單（aomi / mfood）一律唔提 —— 否則每班誤報", () => {
  assert.equal(isUnfinishedLocalOrder({ status: "sent_to_kitchen", source: "aomi" }), false);
  assert.equal(isUnfinishedLocalOrder({ status: "paid", source: "mfood" }), false);
  assert.equal(isUnfinishedLocalOrder({ status: "paid", source: "pos" }), true);
});

test("線上單：非終態就係未完成（唔理付款狀態）", () => {
  for (const status of ["pending", "accepted", "preparing", "ready", "delivering"]) {
    assert.equal(isUnfinishedOnlineOrder({ status }), true, `${status} 應該算未完成`);
  }
  for (const status of ["completed", "cancelled", "canceled", "refunded", "partially_refunded", ""]) {
    assert.equal(isUnfinishedOnlineOrder({ status }), false, `${status} 唔應該算未完成`);
  }
  // 未付款都要提（客人落咗單冇人接，比未完成更嚴重）
  assert.equal(isUnfinishedOnlineOrder({ status: "pending" }), true);
  // 大小寫 + 前後空白
  assert.equal(isUnfinishedOnlineOrder({ status: "  Pending " }), true);
  assert.equal(isUnfinishedOnlineOrder({ status: "COMPLETED" }), false);
});

test("🔴 本地有投影就唔可以再列 Ledger 嗰行（避免重複／避免同步滯後誤報）", () => {
  const summary = collectUnfinishedOrders({
    localOrders: [
      {
        id: "pos-1",
        status: "settled",
        onlineOrderId: "ledger-1", // 本地已完成、Ledger 未 completed
        localOrderNo: "訂單01",
        total: 38,
        settledAt: "2026-11-03T21:00:00+08:00",
      },
      {
        id: "pos-2",
        status: "paid",
        onlineOrderId: "ledger-2", // 本地已付款未完成
        localOrderNo: "訂單02",
        total: 52,
        prepaidAmount: 52,
        updatedAt: "2026-11-03T21:10:00+08:00",
      },
    ],
    onlineOrders: [
      { id: "ledger-1", status: "accepted", paymentStatus: "paid", total: 38 },
      { id: "ledger-2", status: "accepted", paymentStatus: "paid", total: 52 },
      { id: "ledger-3", status: "pending", paymentStatus: "unpaid", total: 60 },
    ],
  });

  assert.deepEqual(
    summary.items.map((item) => `${item.source}:${item.id}`),
    ["local:pos-2", "online:ledger-3"],
    "本地已完成嘅 ledger-1 唔提；ledger-2 只列本地一次；ledger-3 純線上要列",
  );
  assert.equal(summary.total, 2);
  assert.equal(summary.localCount, 1);
  assert.equal(summary.onlineCount, 1);
  assert.equal(summary.paidCount, 1);
  assert.equal(summary.paidAmount, 52);
  assert.equal(summary.unpaidCount, 1);
});

test("排序：已付款優先，再按事件時間舊→新", () => {
  const summary = collectUnfinishedOrders({
    localOrders: [
      { id: "a", status: "sent_to_kitchen", localOrderNo: "A", updatedAt: "2026-11-03T20:30:00+08:00" },
      { id: "b", status: "paid", localOrderNo: "B", prepaidAmount: 10, updatedAt: "2026-11-03T22:30:00+08:00" },
      { id: "c", status: "draft", localOrderNo: "C", updatedAt: "2026-11-03T20:10:00+08:00" },
      { id: "d", status: "paid", localOrderNo: "D", prepaidAmount: 20, updatedAt: "2026-11-03T21:30:00+08:00" },
    ],
    onlineOrders: [],
  });

  assert.deepEqual(summary.items.map((item) => item.id), ["d", "b", "c", "a"]);
});

test("本地 paid 但冇 prepaidAmount 都算已付款（狀態為準）", () => {
  const summary = collectUnfinishedOrders({
    localOrders: [{ id: "x", status: "paid", localOrderNo: "X", total: 99 }],
    onlineOrders: [],
  });
  assert.equal(summary.items[0]?.paid, true);
  assert.equal(summary.paidAmount, 99);
});

test("線上重複 id 只列一次（已付款＋未付款兩條清單可能重疊）", () => {
  const summary = collectUnfinishedOrders({
    localOrders: [],
    onlineOrders: [
      { id: "dup", status: "accepted", paymentStatus: "paid", total: 10 },
      { id: "dup", status: "accepted", paymentStatus: "unpaid", total: 10 },
    ],
  });
  assert.equal(summary.total, 1);
});

test("空資料 → 全 0（呼叫端可以直接 if total === 0 跳過彈窗）", () => {
  const summary = collectUnfinishedOrders({ localOrders: [], onlineOrders: [] });
  assert.equal(summary.total, 0);
  assert.equal(summary.paidAmount, 0);
  assert.deepEqual(summary.items, []);
});
