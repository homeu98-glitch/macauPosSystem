// 回歸測試：訂單合併嘅「付款階段 / 終態」優先序 + 快餐出餐狀態判斷。
//
// 對應實案（2026-09-12 用戶反映）：
//   ① 「撳咗『可取餐』但狀態冇變、掣唔消失」→ 出餐階段唯一真源係 `fulfillmentStatus`。
//   ② 「已結帳」閃一下變返「未結帳」→ 合併用錯鐘域（server 蓋章 vs iPad 鐘）+
//      已收款狀態冇守門，被一條舊 open snapshot 蓋走。
//
// 用 Node 內建 test runner（`npm run test`），唔引入新依賴。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterQuickActionBarOrders,
  getPaymentBadge,
  isLocalOrTransferredDineIn,
  isPaidOrderStatus,
  isQuickCounterOrder,
  isQuickOrderReady,
  localOrderStatusLabel,
  matchesLocalOrderPanelTab,
  mergeOrderLists,
  mergeTimestamp,
  type OrderStatusBadge,
} from "./pos-order-filters.ts";
import type { PosOrder } from "./types.ts";

/** 最小可行訂單建構器（只填測試需要嘅欄位）。 */
function order(patch: Partial<PosOrder> & { id: string }): PosOrder {
  return {
    localOrderNo: patch.id,
    tableId: "counter",
    tableName: "快餐",
    status: "sent_to_kitchen",
    items: [],
    subtotal: 0,
    taxAmount: 0,
    serviceChargeAmount: 0,
    discountAmount: 0,
    total: 0,
    createdAt: "2026-09-12T10:00:00.000Z",
    updatedAt: "2026-09-12T10:00:00.000Z",
    ...patch,
  };
}

const T1 = "2026-09-12T10:00:05.000Z";
const T2 = "2026-09-12T10:00:09.000Z";

describe("isQuickOrderReady（快餐出餐階段唯一真源）", () => {
  it("只看 fulfillmentStatus：sent_to_kitchen + ready 都算「可取餐」", () => {
    // 收銀台快餐單可以「未收款先出餐」（docs/87 §6.3）→ 唔可以再夾 status === "paid"
    assert.equal(isQuickOrderReady(order({ id: "o1", status: "sent_to_kitchen", fulfillmentStatus: "ready" })), true);
    assert.equal(isQuickOrderReady(order({ id: "o2", status: "paid", fulfillmentStatus: "ready" })), true);
  });

  it("preparing / 未設定 → 唔算", () => {
    assert.equal(isQuickOrderReady(order({ id: "o3", fulfillmentStatus: "preparing" })), false);
    assert.equal(isQuickOrderReady(order({ id: "o4" })), false);
  });

  it("終態殘留 ready 唔會令張單變「待取餐」（只有進行中單睇出餐階段）", () => {
    const cancelled = order({ id: "o5", status: "cancelled", fulfillmentStatus: "ready" });
    // isQuickOrderReady 本身係純出餐判斷（ready 就 true）…
    assert.equal(isQuickOrderReady(cancelled), true);
    // …但標籤 / 分頁一定用終態口徑，唔可以被殘留 ready 蓋過
    assert.equal(localOrderStatusLabel(cancelled), "已取消");
    assert.equal(matchesLocalOrderPanelTab(cancelled, "ready"), false);
  });
});

describe("getPaymentBadge（快餐付款維度）", () => {
  it("paid / settled 都係「已結帳」", () => {
    assert.equal(getPaymentBadge(order({ id: "p1", status: "paid" })).label, "已結帳");
    assert.equal(getPaymentBadge(order({ id: "p2", status: "settled" })).label, "已結帳");
  });

  it("draft / sent_to_kitchen 係「未結帳」", () => {
    assert.equal(getPaymentBadge(order({ id: "p3", status: "sent_to_kitchen" })).label, "未結帳");
    assert.equal(getPaymentBadge(order({ id: "p4", status: "draft" })).label, "未結帳");
  });
});

describe("mergeTimestamp（同一鐘域：client 鐘優先）", () => {
  it("有 clientUpdatedAt 就用佢，唔理 server 蓋章嘅 updatedAt", () => {
    const row = order({ id: "m1", clientUpdatedAt: T1, updatedAt: T2 });
    assert.equal(mergeTimestamp(row), Date.parse(T1));
  });

  it("冇 clientUpdatedAt（本機新建未上雲 / 舊 row）→ 退回 updatedAt", () => {
    const row = order({ id: "m2", updatedAt: T2 });
    assert.equal(mergeTimestamp(row), Date.parse(T2));
  });
});

describe("mergeOrderLists：付款階段單向閘（2026-09-12 實案）", () => {
  it("已結帳（paid）唔會被「雲端扮新」嘅未結帳 snapshot 蓋走 —— 就算 updatedAt 較新", () => {
    // 本機：剛結帳（client 鐘 T1），同一刻 server 蓋章時間未知
    const local = order({ id: "a1", status: "paid", clientUpdatedAt: T1, updatedAt: T1 });
    // 雲端 / realtime echo：舊狀態（sent_to_kitchen），但 updated_at 係 server 蓋章（較「新」）
    const stale = order({ id: "a1", status: "sent_to_kitchen", updatedAt: T2 });

    const merged = mergeOrderLists([local], [stale]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].status, "paid", "已結帳唔可以被打返未結帳");
  });

  it("就算 incoming 帶埋較新嘅 client 鐘，已收款狀態仍然唔會被降級（防跨機時鐘偏移）", () => {
    const local = order({ id: "a2", status: "paid", clientUpdatedAt: T1, updatedAt: T1 });
    const staleButFastClock = order({ id: "a2", status: "sent_to_kitchen", clientUpdatedAt: T2, updatedAt: T2 });

    const merged = mergeOrderLists([local], [staleButFastClock]);
    assert.equal(merged[0].status, "paid");
  });

  it("反向：雲端已收款、本機仲係 open → 收款（前進）一定贏，並保留本機單號", () => {
    const local = order({ id: "a3", localOrderNo: "快餐01", status: "sent_to_kitchen", updatedAt: T1 });
    const cloud = order({ id: "a3", localOrderNo: "快餐84", status: "paid", updatedAt: T1 });

    const merged = mergeOrderLists([local], [cloud]);
    assert.equal(merged[0].status, "paid");
    assert.equal(merged[0].localOrderNo, "快餐01", "B4：server 版覆寫時要保留本機真單號");
  });

  it("合法降級照通：取消結帳（cancelled 係終態）可以贏過已收款單", () => {
    const local = order({ id: "a4", status: "paid", updatedAt: T1 });
    const cancelled = order({ id: "a4", status: "cancelled", updatedAt: T1 });

    const merged = mergeOrderLists([local], [cancelled]);
    assert.equal(merged[0].status, "cancelled");
  });

  it("合法反轉照通：返結（reopened）可以反轉已結帳單（LWW 決定）", () => {
    const local = order({ id: "a5", status: "settled", updatedAt: T1 });
    const reopened = order({ id: "a5", status: "reopened", updatedAt: T2 });

    const merged = mergeOrderLists([local], [reopened]);
    assert.equal(merged[0].status, "reopened");
  });

  it("終態優先仍然有效：settled 唔會被 open snapshot 蓋走", () => {
    const local = order({ id: "a6", status: "settled", updatedAt: T1 });
    const stale = order({ id: "a6", status: "sent_to_kitchen", clientUpdatedAt: T2, updatedAt: T2 });

    const merged = mergeOrderLists([local], [stale]);
    assert.equal(merged[0].status, "settled");
  });

  it("兩個 open 版本照行 LWW，而且用 client 鐘（唔會被 server 蓋章時間騙）", () => {
    const older = order({ id: "a7", status: "sent_to_kitchen", clientUpdatedAt: T1, updatedAt: T2 });
    const newer = order({ id: "a7", status: "sent_to_kitchen", orderNote: "加咗辣", clientUpdatedAt: T2, updatedAt: T1 });

    const merged = mergeOrderLists([older], [newer]);
    assert.equal(merged[0].orderNote, "加咗辣", "client 鐘較新者勝（T2 > T1）");
  });

  it("多來源（本機 + React state + 雲端 backfill）唔會丟單 / 唔會重複", () => {
    const a = order({ id: "b1", status: "draft" });
    const b = order({ id: "b2", status: "paid", clientUpdatedAt: T1 });

    const merged = mergeOrderLists([a, b], [a], [b]);
    assert.equal(merged.length, 2);
  });
});

describe("isPaidOrderStatus", () => {
  it("覆蓋所有已收款 / 收款後結局，唔包括 open 同 cancelled / reopened", () => {
    for (const s of ["paid", "settled", "refunded", "partially_refunded"] as const) {
      assert.equal(isPaidOrderStatus(s), true, `${s} 應該算已收款`);
    }
    for (const s of ["draft", "sent_to_kitchen", "cancelled", "reopened"] as const) {
      assert.equal(isPaidOrderStatus(s), false, `${s} 唔應該算已收款`);
    }
  });
});

describe("getPaymentBadge 型別契約", () => {
  it("回傳完整 badge token（bg / text / dot），UI 可以直接套 className", () => {
    const badge: OrderStatusBadge = getPaymentBadge(order({ id: "z1", status: "paid" }));
    assert.ok(badge.bgClass && badge.textClass && badge.dotClass);
  });
});

describe("快餐模式採納線上單（2026-09-12：isQuickCounterOrder 放寬）", () => {
  const onlineCounter = () =>
    order({ id: "ledger-a", tableId: "counter", tableName: "自取", onlineOrderId: "a", status: "paid" });

  it("線上單採納成 counter 單之後算「快餐 counter 單」（要入快餐 strip 行可取餐→完成）", () => {
    // 舊寫法 `isLocalPosOrder(order) && tableId === "counter"` 會令呢批單冇可取餐掣
    assert.equal(isQuickCounterOrder(onlineCounter()), true);
  });

  it("線上 counter 單唔會入「店內線下訂單」（分工：快餐 strip 管）", () => {
    assert.equal(isLocalOrTransferredDineIn(onlineCounter()), false);
    // 反例：已排到真枱嘅線上堂食單 → 當本地單管理（「排位」之後）
    assert.equal(
      isLocalOrTransferredDineIn(order({ id: "ledger-b", tableId: "table-a01", onlineOrderId: "b" })),
      true,
    );
  });

  it("本地 counter 單 / 真枱堂食單行為不變（放寬唔可以誤傷）", () => {
    assert.equal(isQuickCounterOrder(order({ id: "l1" })), true);
    assert.equal(isQuickCounterOrder(order({ id: "l2", tableId: "table-a01" })), false);
  });

  it("線上已付快餐單：「已結帳」+ 出餐階段照正常流程（製作中 → 待取餐）", () => {
    const o = onlineCounter();
    assert.equal(getPaymentBadge(o).label, "已結帳");
    assert.equal(localOrderStatusLabel(o), "製作中");
    assert.equal(localOrderStatusLabel({ ...o, fulfillmentStatus: "ready" }), "待取餐");
    assert.equal(matchesLocalOrderPanelTab({ ...o, fulfillmentStatus: "ready" }, "ready"), true);
  });

  it("未收款（到店付款）嘅線上快餐單係「未結帳」", () => {
    assert.equal(
      getPaymentBadge(
        order({ id: "ledger-c", tableId: "counter", onlineOrderId: "c", status: "sent_to_kitchen" }),
      ).label,
      "未結帳",
    );
  });

  it("終態（settled）唔會再出現喺快餐 strip", () => {
    const settled = order({ id: "ledger-d", tableId: "counter", onlineOrderId: "d", status: "settled" });
    assert.equal(filterQuickActionBarOrders([settled]).length, 0);
    assert.equal(filterQuickActionBarOrders([onlineCounter()]).length, 1);
  });
});
