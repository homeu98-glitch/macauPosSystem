import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { customerOrderStatusLabel } from "./order-status-label.ts";

/**
 * 客人端訂單狀態文案（2026-09-10 掃碼需求 1：「顯示下單狀態」）。
 *
 * 呢啲文案會直接顯示喺客人手機，所以：
 *   ① 唔可以露出 DB 枚舉值；
 *   ② 一定要**永遠**有回傳值（未知狀態唔可以變空白 / undefined）；
 *   ③ 出餐狀態（fulfillmentStatus）嘅優先級要高過單據狀態。
 */
describe("customerOrderStatusLabel", () => {
  it("draft（未經店員確認）→ 明確講清楚要等店員", () => {
    assert.equal(customerOrderStatusLabel({ status: "draft" }), "已送出 · 待店員確認");
  });

  it("已送廚房 + 未開始做 → 已送廚房", () => {
    assert.equal(customerOrderStatusLabel({ status: "sent_to_kitchen" }), "已送廚房");
  });

  it("製作中（fulfillmentStatus=preparing）→ 製作中", () => {
    assert.equal(
      customerOrderStatusLabel({ status: "sent_to_kitchen", fulfillmentStatus: "preparing" }),
      "製作中",
    );
  });

  it("可取餐優先過單據狀態（即使單據已付款）", () => {
    assert.equal(customerOrderStatusLabel({ status: "paid", fulfillmentStatus: "ready" }), "可取餐");
    assert.equal(
      customerOrderStatusLabel({ status: "sent_to_kitchen", fulfillmentStatus: "ready" }),
      "可取餐",
    );
  });

  it("付款 / 完成 / 取消 / 退款各自有客人聽得明嘅講法", () => {
    assert.equal(customerOrderStatusLabel({ status: "paid" }), "已付款");
    assert.equal(customerOrderStatusLabel({ status: "settled" }), "已完成");
    assert.equal(customerOrderStatusLabel({ status: "cancelled" }), "已取消");
    assert.equal(customerOrderStatusLabel({ status: "refunded" }), "已退款");
    assert.equal(customerOrderStatusLabel({ status: "partially_refunded" }), "部分退款");
  });

  it("reopened / 未知狀態 → 一律回「進行中」，唔會露出枚舉值或空白", () => {
    assert.equal(customerOrderStatusLabel({ status: "reopened" }), "進行中");
    // 防禦：日後加新狀態但漏咗呢個 map，都唔會喺客人面前顯示內部值。
    assert.equal(customerOrderStatusLabel({ status: "some_future_status" as never }), "進行中");
  });
});
