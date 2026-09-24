import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapOrderRow, POS_ORDER_DB_COLUMNS, type PosOrderDbRow } from "./pos-order-row.ts";
import { buildSubtotalBlock } from "./receipt/subtotal-block.ts";

/**
 * 外賣平台費用明細嘅**出庫**端到端測試：DB row → `mapOrderRow()` → 收據逐行。
 *
 * ── 為什麼要專門一支（2026-09-24 嘅驗收盲點）──────────────────────
 * 之前我只驗「入庫路徑」（`/api/integration/grabber/orders` → `projectGrabberOrder()`），
 * 睇到 DB 有 `platform_fees` 就當成完成 —— 但**出庫路徑漏抄**：
 * `POS_ORDER_DB_COLUMNS` / `PosOrderDbRow` / `mapOrderRow()` 三個地方都冇 `platform_fees`
 * ⇒ 收銀台拎到嘅 `PosOrder` 冇 `platformFees` ⇒ 收據同詳情嘅費用行全部靜默唔出。
 *
 * ⇒ 教訓：**「寫得入」唔等於「讀得出」。** 兩邊都要各有一條端到端驗證。
 *
 * 呢支測試用真嘅 DB row 形狀（snake_case）行完整條鏈，任何一環漏抄都會紅。
 */

/** 一張真實形狀嘅澳覓平台單 DB row（金額同官方公式自洽）。 */
function aomiDbRow(): PosOrderDbRow {
  return {
    id: "aomi-FAKE-1",
    store_id: "store-1",
    local_order_no: "澳覓#42",
    table_id: "counter",
    table_name: "外賣",
    status: "paid",
    fulfillment_status: null,
    sent_to_kitchen_at: null,
    served_at: null,
    items: [
      { menuItemId: "ext-牛肉炒时菜", name: "牛肉炒时菜", quantity: 1, price: 52, printerGroup: "kitchen" },
      { menuItemId: "ext-表嫂酸菜魚", name: "表嫂酸菜魚", quantity: 1, price: 198, printerGroup: "kitchen" },
    ],
    order_note: null,
    subtotal: 250,
    tax_amount: 0,
    service_charge_amount: 0,
    discount_amount: 0,
    total: 248,
    prepaid_amount: 248,
    online_order_id: null,
    source: "aomi",
    party_size: null,
    comp_note: null,
    comped_at: null,
    discount_note: null,
    payment_method: null,
    created_at: "2026-09-24T09:04:00.000Z",
    updated_at: "2026-09-24T09:04:00.000Z",
    client_updated_at: "2026-09-24T09:04:00.000Z",
    reopen_count: null,
    reopened_at: null,
    reopen_reason: null,
    platform_fees: [
      { label: "餐盒費", amount: 4 },
      { label: "膠袋費", amount: 3 },
      { label: "商家活動支出", amount: -9 },
      { label: "配送費", amount: 7, excluded: true },
    ],
  };
}

describe("平台費用明細：DB row → mapper → 收據（出庫端到端）", () => {
  it("mapper 讀得到 platform_fees（唔可以再漏抄）", () => {
    assert.ok(
      (POS_ORDER_DB_COLUMNS as readonly string[]).includes("platform_fees"),
      "POS_ORDER_DB_COLUMNS 缺 platform_fees",
    );
    const order = mapOrderRow(aomiDbRow());
    assert.deepEqual(order.platformFees, [
      { label: "餐盒費", amount: 4 },
      { label: "膠袋費", amount: 3 },
      { label: "商家活動支出", amount: -9 },
      { label: "配送費", amount: 7, excluded: true },
    ]);
  });

  it("收據真係印得出費用行，而且逐行加返等於總計", () => {
    const order = mapOrderRow(aomiDbRow());
    const lines = buildSubtotalBlock(
      {
        subtotalBefore: order.subtotal,
        serviceCharge: order.serviceChargeAmount,
        tax: order.taxAmount,
        rounding: 0,
        totalDiscount: order.discountAmount,
        orderTotal: order.total,
      },
      (a) => String(a),
      order.platformFees,
    ).split("\n");

    assert.deepEqual(lines, [
      "原價合計: 250",
      "餐盒費: 4",
      "膠袋費: 3",
      "商家活動支出: -9",
      "（以下不計入營業額）",
      "配送費: 7",
    ]);

    // 逐行加返（略過唔計入營業額嗰組）= 總計
    let sum = Number(lines[0].slice("原價合計: ".length));
    let excluded = false;
    for (const line of lines.slice(1)) {
      if (line === "（以下不計入營業額）") {
        excluded = true;
        continue;
      }
      if (excluded) continue;
      sum += Number(line.slice(line.lastIndexOf(": ") + 2));
    }
    assert.equal(sum, order.total, "收據逐行加總 ≠ 總計");
  });

  it("mfood 單一樣：配送費／商家配送費減免只作資訊，唔入加總", () => {
    const order = mapOrderRow({
      ...aomiDbRow(),
      id: "mfood-FAKE-1",
      local_order_no: "MFOOD#7",
      source: "mfood",
      subtotal: 118,
      total: 118,
      platform_fees: [
        { label: "餐盒費", amount: 3 },
        { label: "膠袋費", amount: 1 },
        { label: "商家滿減", amount: -4 },
        { label: "配送費", amount: 12, excluded: true },
        { label: "商家配送費減免", amount: -12, excluded: true },
      ],
    });
    const lines = buildSubtotalBlock(
      {
        subtotalBefore: order.subtotal,
        serviceCharge: 0,
        tax: 0,
        rounding: 0,
        totalDiscount: 0,
        orderTotal: order.total,
      },
      (a) => String(a),
      order.platformFees,
    ).split("\n");

    assert.deepEqual(lines, [
      "原價合計: 118",
      "餐盒費: 3",
      "膠袋費: 1",
      "商家滿減: -4",
      "（以下不計入營業額）",
      "配送費: 12",
      "商家配送費減免: -12",
    ]);
  });

  it("店內單（platform_fees 為 NULL）→ 收據輸出同以前一模一樣", () => {
    const order = mapOrderRow({
      ...aomiDbRow(),
      id: "pos-1",
      local_order_no: "訂單1",
      source: "pos",
      subtotal: 100,
      service_charge_amount: 10,
      total: 110,
      platform_fees: null,
    });
    assert.equal(order.platformFees, undefined);
    const block = buildSubtotalBlock(
      {
        subtotalBefore: order.subtotal,
        serviceCharge: order.serviceChargeAmount,
        tax: 0,
        rounding: 0,
        totalDiscount: 0,
        orderTotal: order.total,
      },
      (a) => String(a),
      order.platformFees,
    );
    assert.equal(block, "原價合計: 100", "店內單唔可以多出任何行");
  });
});
