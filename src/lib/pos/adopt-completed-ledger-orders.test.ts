import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isAdoptableCompletedOrder,
  isCompletedLedgerOrderLike,
  mergeAdoptedOnlineIds,
  parseAdoptedOnlineIds,
  pickAdoptableOrders,
} from "./adopt-completed-ledger-orders.ts";

/**
 * 自動補建純判定（2026-09-27）。
 *
 * ## 呢個模組係咩
 *
 * 「Ledger 已完成＋已付款、但 POS 冇記錄」嘅線上單，以前要商家手動撳「補建入 POS」。
 * 商家口徑：「商家不應該需要按這個」⇒ 改為**系統自動**補建，判定邏輯收喺
 * `adopt-completed-ledger-orders.ts`（零 import，可被 `node --test` 直接載入）。
 *
 * ## 🔴 兩條唔可以違反嘅安全閘
 *
 * 1. **未付款／未完成一律唔補** —— 補上去 ＝ 向報表謊報收入（造數）。
 * 2. **雲端／本機任何一邊話「已有」⇒ 唔補** —— 否則會覆蓋店內加菜（2026-09-24 事故）。
 */

describe("自動補建 ── 安全閘（未付款／未完成一律唔補）", () => {
  it("已付款 ＋ completed ⇒ 可以補", () => {
    assert.equal(
      isAdoptableCompletedOrder({ id: "o1", paymentStatus: "paid", status: "completed" }),
      true,
    );
  });

  it("🔴 未付款 ⇒ 唔可以補（造數）", () => {
    assert.equal(
      isAdoptableCompletedOrder({ id: "o2", paymentStatus: "unpaid", status: "completed" }),
      false,
    );
  });

  it("🔴 未完成 ⇒ 唔可以補（單仲喺廚房做）", () => {
    assert.equal(
      isAdoptableCompletedOrder({ id: "o3", paymentStatus: "paid", status: "preparing" }),
      false,
    );
  });

  it("🔴 已取消 ⇒ 唔可以補（即使 paid ＋ completed）", () => {
    assert.equal(
      isAdoptableCompletedOrder({ id: "o4", paymentStatus: "paid", status: "completed_cancelled" }),
      false,
    );
    assert.equal(
      isAdoptableCompletedOrder({ id: "o5", paymentStatus: "paid", status: "cancelled" }),
      false,
    );
  });

  it("冇 id ⇒ 唔可以補", () => {
    assert.equal(
      isAdoptableCompletedOrder({ id: "", paymentStatus: "paid", status: "completed" }),
      false,
    );
  });

  it("大小寫／變體都要認（Ledger 回過唔同寫法）", () => {
    for (const status of ["completed", "COMPLETED", "complete", "Completed"]) {
      assert.equal(
        isCompletedLedgerOrderLike({ id: "x", status }),
        true,
        `status=${status} 應該當完成`,
      );
    }
    assert.equal(isCompletedLedgerOrderLike({ id: "x", status: "completed_at_store" }), true);
    assert.equal(isCompletedLedgerOrderLike({ id: "x", status: "pending" }), false);
    assert.equal(isCompletedLedgerOrderLike({ id: "x", status: undefined }), false);
  });
});

describe("自動補建 ── 併集去重（唔可以覆蓋已有單）", () => {
  it("本機有 / 雲端有 ⇒ 兩邊任何一邊有都要擋", () => {
    const merged = mergeAdoptedOnlineIds(["a", "b"], ["b", "c"]);
    assert.deepEqual([...merged].sort(), ["a", "b", "c"]);
  });

  it("雲端空集合 ⇒ 唔會影響本機集合（fail-open 路徑）", () => {
    const merged = mergeAdoptedOnlineIds(["a"], []);
    assert.deepEqual([...merged], ["a"]);
  });

  it("空字串 / 空值要濾走", () => {
    const merged = mergeAdoptedOnlineIds([], ["", "ok"]);
    assert.deepEqual([...merged], ["ok"]);
  });
});

describe("自動補建 ── 篩選（已試過唔再試，避免迴圈）", () => {
  const orders = [
    { id: "p1", paymentStatus: "paid", status: "completed" },
    { id: "p2", paymentStatus: "paid", status: "completed" },
    { id: "p3", paymentStatus: "paid", status: "pending" },
    { id: "p4", paymentStatus: "unpaid", status: "completed" },
  ];

  it("只揀 paid ＋ completed", () => {
    const picked = pickAdoptableOrders(orders, new Set());
    assert.deepEqual(picked.map((o) => o.id), ["p1", "p2"]);
  });

  it("🔴 已試過嘅唔再揀（否則每次 render 都重試 ⇒ 迴圈）", () => {
    const picked = pickAdoptableOrders(orders, new Set(["p1"]));
    assert.deepEqual(picked.map((o) => o.id), ["p2"]);
  });

  it("原物件要保留（唔可以換成新物件，呼叫端要靠 identity 傳落 bridge）", () => {
    const picked = pickAdoptableOrders(orders, new Set());
    assert.equal(picked[0], orders[0]);
  });
});

describe("自動補建 ── 雲端回應解析（fail-open）", () => {
  it("正常回應 ⇒ 抽出 id", () => {
    assert.deepEqual(parseAdoptedOnlineIds({ onlineOrderIds: ["a", "b"] }), ["a", "b"]);
  });

  it("🔴 任何唔符形狀 ⇒ 空集合（唔可以 throw，否則補建會停擺）", () => {
    for (const bad of [
      null,
      undefined,
      0,
      "",
      "oops",
      {},
      { onlineOrderIds: null },
      { onlineOrderIds: "a,b" },
      { onlineOrderIds: { a: 1 } },
    ]) {
      assert.deepEqual(parseAdoptedOnlineIds(bad), [], `payload=${JSON.stringify(bad)} 應該回空`);
    }
  });

  it("陣列內非字串元素要濾走", () => {
    assert.deepEqual(parseAdoptedOnlineIds({ onlineOrderIds: ["a", 1, null, "", "b"] }), ["a", "b"]);
  });
});
