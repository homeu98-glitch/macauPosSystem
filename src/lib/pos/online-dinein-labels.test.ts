// 回歸測試：線上訂單「枱位 / 付款」派生標籤。
//
// 對應需求（2026-09-12 商家）：
//   ① 堂食模式：線上堂食單要可以「排位」，未有枱顯示「待安排座位」。
//   ② 線上已付款 → 顯示綠色「已結帳」（**唔可以**為咗顯示而新增 status 值）。
//   ③ 快餐模式：收到 `dine_in` 線上單一律當快餐單（出餐口自取），**唔會**排位。
//   ④ 已經有人坐嘅枱唔可以揀（商家明確要求：唔係「提示後仍可強制」）。
//
// 用 Node 內建 test runner（`npm run test`），唔引入新依賴。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasTableAssigned,
  isOnlineDineIn,
  isTableSelectable,
  needsTableAssignment,
  onlinePaymentBadge,
  onlineTableAssignLabel,
  onlineTableBadge,
  type OnlineTableInfo,
} from "./online-dinein-labels.ts";

function online(patch: Partial<OnlineTableInfo>): OnlineTableInfo {
  return { tabType: "dine_in", paymentMode: "balance", paymentStatus: "paid", ...patch };
}

describe("線上單：枱位維度", () => {
  it("堂食模式 + 線上堂食單 + 未排位 → 待安排座位（橙）", () => {
    const order = online({});
    assert.equal(needsTableAssignment(order, { quickMode: false }), true);
    const badge = onlineTableBadge(order, { quickMode: false });
    assert.equal(badge.label, "待安排座位");
    assert.equal(badge.bgClass, "bg-amber-50");
  });

  it("已排位 → 顯示枱名（綠），並且唔再需要排位", () => {
    const order = online({ tableId: "table-a01", tableName: "A01" });
    assert.equal(hasTableAssigned(order), true);
    assert.equal(needsTableAssignment(order, { quickMode: false }), false);
    assert.equal(onlineTableBadge(order, { quickMode: false }).label, "A01");
    assert.equal(onlineTableBadge(order, { quickMode: false }).bgClass, "bg-emerald-50");
  });

  it("tableId = counter 唔算「已排位」（快餐／自取／外賣都用 counter）", () => {
    const order = online({ tableId: "counter", tableName: "堂食取餐" });
    assert.equal(hasTableAssigned(order), false);
    assert.equal(needsTableAssignment(order, { quickMode: false }), true);
  });

  it("🔴 快餐模式：dine_in 線上單唔排位 → 出餐口自取（唔可以顯示待安排座位）", () => {
    const order = online({});
    assert.equal(needsTableAssignment(order, { quickMode: true }), false);
    assert.equal(onlineTableBadge(order, { quickMode: true }).label, "出餐口自取");
  });

  it("自取 / 外賣單永遠唔需要排位", () => {
    for (const tabType of ["pickup", "self_delivery"]) {
      const order = online({ tabType });
      assert.equal(isOnlineDineIn(order), false);
      assert.equal(needsTableAssignment(order, { quickMode: false }), false);
    }
    assert.equal(onlineTableBadge(online({ tabType: "pickup" }), { quickMode: false }).label, "自取");
    assert.equal(
      onlineTableBadge(online({ tabType: "self_delivery" }), { quickMode: false }).label,
      "外賣",
    );
  });

  it("枱名空白時退回落「已排位」（唔可以顯示空白藥丸）", () => {
    const order = online({ tableId: "table-a01", tableName: "   " });
    assert.equal(onlineTableBadge(order, { quickMode: false }).label, "已排位");
  });

  it("排位掣文案：未排位 = 排位；已排位 = 改枱", () => {
    assert.equal(onlineTableAssignLabel(online({})), "排位");
    assert.equal(onlineTableAssignLabel(online({ tableId: "table-a01", tableName: "A01" })), "改枱");
  });
});

describe("線上單：付款維度", () => {
  it("線上已付（餘額扣點）→ 已結帳（綠）", () => {
    const badge = onlinePaymentBadge(online({ paymentMode: "balance", paymentStatus: "paid" }));
    assert.equal(badge.label, "已結帳");
    assert.equal(badge.bgClass, "bg-emerald-50");
  });

  it("到店付款未收錢 → 未結帳（文案要短，唔可以逼爆 280px 快捷操作欄）", () => {
    const badge = onlinePaymentBadge(online({ paymentMode: "in_store", paymentStatus: "unpaid" }));
    assert.equal(badge.label, "未結帳");
    assert.notEqual(badge.bgClass, "bg-emerald-50");
  });

  it("付款狀態大小寫 / 缺失都唔會誤判成已結帳", () => {
    assert.equal(onlinePaymentBadge(online({ paymentStatus: "UNPAID" })).label, "未結帳");
    assert.equal(onlinePaymentBadge(online({ paymentStatus: null })).label, "未結帳");
    assert.equal(onlinePaymentBadge(online({ paymentStatus: undefined })).label, "未結帳");
    assert.equal(onlinePaymentBadge(online({ paymentStatus: "Paid" })).label, "已結帳");
  });
});

describe("枱可選性（商家：已佔用一律唔可以揀）", () => {
  const occupied = ["table-a01", "table-b02"];

  it("已被佔用 → 唔可以揀", () => {
    assert.equal(isTableSelectable("table-a01", occupied), false);
    assert.equal(isTableSelectable("table-b02", occupied), false);
  });

  it("空枱 → 可以揀", () => {
    assert.equal(isTableSelectable("table-a03", occupied), true);
    assert.equal(isTableSelectable("table-a03", []), true);
  });
});
