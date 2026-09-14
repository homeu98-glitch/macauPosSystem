// 回歸測試：結帳目標解析（2026-09-14 實案：「A03 結帳去咗第二張枱」）。
//
// 鐵律：**永不跨枱**。冇明確指定時，只可以揀
//   ①當前工作台 / ②`activeOrderId` 載入嘅單 / ③當前枱嘅單；全店其他枱一律唔准。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSettleTargetOrder, type SettleTargetCandidate } from "./settle-target.ts";

function order(patch: Partial<SettleTargetCandidate> & { id: string }): SettleTargetCandidate {
  return {
    tableId: "table-a03",
    status: "sent_to_kitchen",
    updatedAt: "2026-09-14T01:00:00.000Z",
    ...patch,
  };
}

describe("resolveSettleTargetOrder：明確指定", () => {
  it("有指定 id → 用嗰張（即使係另一張枱，屬線上面板正常流程）", () => {
    const other = order({ id: "o-b01", tableId: "table-b01" });
    const picked = resolveSettleTargetOrder({
      orders: [order({ id: "o-a03" }), other],
      explicitId: "o-b01",
      activeTableId: "table-a03",
    });
    assert.equal(picked?.id, "o-b01");
  });

  it("指定 id 已經唔存在 → 落下面幾層（唔可以 null 就走數）", () => {
    const picked = resolveSettleTargetOrder({
      orders: [order({ id: "o-a03" })],
      explicitId: "o-deleted",
      activeTableId: "table-a03",
    });
    assert.equal(picked?.id, "o-a03");
  });
});

describe("resolveSettleTargetOrder：永不跨枱", () => {
  it("🔴 當前枱冇可結帳單 → null，唔准揀另一張枱（實案 regression）", () => {
    const picked = resolveSettleTargetOrder({
      orders: [
        order({ id: "o-a03", status: "settled" }), // 已結帳，唔可結
        order({ id: "o-b01", tableId: "table-b01", status: "sent_to_kitchen" }),
      ],
      activeTableId: "table-a03",
    });
    assert.equal(picked, null);
  });

  it("當前枱冇任何單（空枱）＋ 全店有其他可結帳單 → 仍然 null", () => {
    const picked = resolveSettleTargetOrder({
      orders: [order({ id: "o-b01", tableId: "table-b01" })],
      activeTableId: "table-a03",
    });
    assert.equal(picked, null);
  });

  it("同一枱多張單 → 揀最新嗰張（快餐 counter 可並存 / 掃碼單 + 本地單）", () => {
    const picked = resolveSettleTargetOrder({
      orders: [
        order({ id: "o-old", updatedAt: "2026-09-14T00:10:00.000Z" }),
        order({ id: "o-new", updatedAt: "2026-09-14T01:10:00.000Z" }),
      ],
      activeTableId: "table-a03",
    });
    assert.equal(picked?.id, "o-new");
  });

  it("activeTableId 冇帶 → 只有工作台層可以命中", () => {
    assert.equal(resolveSettleTargetOrder({ orders: [order({ id: "o-a03" })] }), null);
    assert.equal(
      resolveSettleTargetOrder({
        orders: [order({ id: "o-a03" })],
        activeOrder: order({ id: "o-a03" }),
      })?.id,
      "o-a03",
    );
  });
});

describe("resolveSettleTargetOrder：已收款堂食單（paid ＋ 真枱）", () => {
  it("🔴 掃碼已付單（冇 onlineOrderId）→ 可結帳（實案：舊判準唔認 → 彈「沒有待結帳訂單」）", () => {
    const paidScan = order({ id: "o-a03", status: "paid", tableId: "table-a03" });
    const picked = resolveSettleTargetOrder({
      orders: [paidScan],
      activeOrder: paidScan,
      activeTableId: "table-a03",
    });
    assert.equal(picked?.id, "o-a03");
  });

  it("快餐 counter 已付單唔會經呢條路", () => {
    const picked = resolveSettleTargetOrder({
      orders: [order({ id: "o-counter", tableId: "counter", status: "paid" })],
      activeTableId: "counter",
    });
    assert.equal(picked, null);
  });
});

describe("resolveSettleTargetOrder：工作台層", () => {
  it("activeOrder 唔可結帳（已結帳 deep-link）但 workspaceOrder 可結帳 → 用 workspaceOrder", () => {
    const picked = resolveSettleTargetOrder({
      orders: [order({ id: "o-a03", status: "reopened" })],
      activeTableId: "table-a03",
      workspaceOrder: order({ id: "o-a03", status: "reopened" }),
    });
    assert.equal(picked?.id, "o-a03");
  });

  it("工作台單本身已結帳 → 唔會用（避免雙重結帳）", () => {
    const picked = resolveSettleTargetOrder({
      orders: [order({ id: "o-a03", status: "settled" })],
      activeTableId: "table-a03",
      workspaceOrder: order({ id: "o-a03", status: "settled" }),
    });
    assert.equal(picked, null);
  });
});
