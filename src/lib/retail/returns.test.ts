/**
 * 零售退換貨單測。
 *
 * 重點鎖住三條紅線：
 *   1. 退款用原單實收口徑（唔可以用牌價）
 *   2. 分次退貨可以累加（唔會超退）
 *   3. 拆分付款退款分攤尾差要對得上
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReturnToOrder,
  computeReturn,
  isRefundableStatus,
  isRetailOrder,
  itemDiscountTotalOfOrder,
  lineNetOfItem,
  lookupReturnableOrders,
  planExchange,
  restockLines,
  returnableLines,
  returnItemKey,
  returnedQtyByKey,
  shouldRestock,
  splitRefundByMethod,
  type ReturnPick,
} from "./returns.ts";

import type { OrderItem, PosOrder } from "@/lib/types";

// ─────────────────────────────────────────────────────────────
// 測試夾具
// ─────────────────────────────────────────────────────────────

function item(patch: Partial<OrderItem> & { name: string }): OrderItem {
  return {
    menuItemId: "p1",
    quantity: 1,
    price: 100,
    printerGroup: "receipt",
    ...patch,
  };
}

function order(patch: Partial<PosOrder> = {}): PosOrder {
  const now = "2026-09-12T10:00:00.000Z";
  return {
    id: "retail-abc",
    storeId: "store-1",
    localOrderNo: "零售07",
    tableId: "counter",
    tableName: "零售",
    status: "settled",
    items: [item({ name: "可樂", menuItemId: "cola", quantity: 3, price: 10 })],
    subtotal: 30,
    taxAmount: 0,
    serviceChargeAmount: 0,
    discountAmount: 0,
    total: 30,
    source: "pos",
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as PosOrder;
}

// ─────────────────────────────────────────────────────────────
// 原單識別
// ─────────────────────────────────────────────────────────────

test("isRetailOrder：counter + 「零售」才算零售單", () => {
  assert.equal(isRetailOrder({ tableId: "counter", tableName: "零售" }), true);
  // 快餐 counter 單唔可以當零售（否則會去回補零售商品庫）
  assert.equal(isRetailOrder({ tableId: "counter", tableName: "快餐" }), false);
  // 堂食枱唔係零售
  assert.equal(isRetailOrder({ tableId: "A01", tableName: "零售" }), false);
});

test("isRefundableStatus：只可以退 settled / partially_refunded", () => {
  assert.equal(isRefundableStatus("settled"), true);
  assert.equal(isRefundableStatus("partially_refunded"), true);
  assert.equal(isRefundableStatus("draft"), false);
  assert.equal(isRefundableStatus("cancelled"), false);
  assert.equal(isRefundableStatus("paid"), false);
});

test("lookupReturnableOrders：按單號命中（容錯『07』）", () => {
  const orders = [order()];
  assert.equal(lookupReturnableOrders(orders, "零售07").length, 1);
  assert.equal(lookupReturnableOrders(orders, "07").length, 1);
  assert.equal(lookupReturnableOrders(orders, "零售07")[0].kind, "order-no");
});

test("lookupReturnableOrders：按序號 / 條碼命中並帶行索引", () => {
  const orders = [
    order({
      items: [
        item({ name: "手機", menuItemId: "phone", serialNo: "SN-8888", price: 3000 }),
        item({ name: "充電線", menuItemId: "cable", barcode: "4890000000012", price: 50 }),
      ],
    }),
  ];
  const bySn = lookupReturnableOrders(orders, "SN-8888");
  assert.equal(bySn.length, 1);
  assert.equal(bySn[0].kind, "serial");
  assert.equal(bySn[0].itemIndex, 0);

  const byCode = lookupReturnableOrders(orders, "4890000000012");
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0].kind, "barcode");
  assert.equal(byCode[0].itemIndex, 1);
});

test("lookupReturnableOrders：唔會撈到餐飲單 / 已取消單", () => {
  const orders = [
    order({ id: "x1", tableName: "快餐" }),
    order({ id: "x2", status: "cancelled" }),
    order({ id: "x3", status: "refunded" }),
  ];
  assert.equal(lookupReturnableOrders(orders, "零售07").length, 0);
});

test("lookupReturnableOrders：空查詢回空", () => {
  assert.deepEqual(lookupReturnableOrders([order()], "   "), []);
});

// ─────────────────────────────────────────────────────────────
// 行實收
// ─────────────────────────────────────────────────────────────

test("lineNetOfItem：基本 price × quantity", () => {
  assert.equal(lineNetOfItem(item({ name: "x", quantity: 3, price: 10 })), 30);
});

test("lineNetOfItem：折扣率 rate 語義（80 = 收 8 成）", () => {
  assert.equal(lineNetOfItem(item({ name: "x", quantity: 1, price: 100, discountRate: 80 })), 80);
});

test("lineNetOfItem：稱重行以 weightKg 為乘數", () => {
  assert.equal(
    lineNetOfItem(item({ name: "蘋果", quantity: 1, price: 20, weightKg: 1.5 })),
    30,
  );
});

test("lineNetOfItem：改價後 price 已係實際價（唔會再乘原始價）", () => {
  const it = item({ name: "x", quantity: 2, price: 80, unitPriceOriginal: 100 });
  assert.equal(lineNetOfItem(it), 160);
});

// ─────────────────────────────────────────────────────────────
// 已退數量累加
// ─────────────────────────────────────────────────────────────

test("returnedQtyByKey：累加多筆紀錄（唔止睇最後一筆）", () => {
  const o = order({
    items: [item({ name: "可樂", menuItemId: "cola", quantity: 3, price: 10 })],
  });
  const key = returnableLines(o)[0].key;
  o.refundRecords = [
    {
      id: "r1",
      amount: 10,
      reason: "壞",
      items: [{ itemKey: key, name: "可樂", quantity: 1, amount: 10 }],
      createdAt: "2026-09-12T11:00:00.000Z",
    },
    {
      id: "r2",
      amount: 10,
      reason: "壞",
      items: [{ itemKey: key, name: "可樂", quantity: 1, amount: 10 }],
      createdAt: "2026-09-12T12:00:00.000Z",
    },
  ];
  const map = returnedQtyByKey(o);
  assert.equal(map.get(key)?.qty, 2);
});

test("returnableLines：剩餘數量 = 售出 − 已退", () => {
  const o = order({
    items: [item({ name: "可樂", menuItemId: "cola", quantity: 3, price: 10 })],
  });
  const key = returnItemKey(o.items![0], 0);
  o.refundRecords = [
    {
      id: "r1",
      amount: 10,
      reason: "壞",
      items: [{ itemKey: key, name: "可樂", quantity: 1, amount: 10 }],
      createdAt: "2026-09-12T11:00:00.000Z",
    },
  ];
  const lines = returnableLines(o);
  assert.equal(lines[0].soldQty, 3);
  assert.equal(lines[0].returnedQty, 1);
  assert.equal(lines[0].remainingQty, 2);
});

test("returnableLines：稱重行剩餘用 kg", () => {
  const o = order({
    items: [item({ name: "蘋果", menuItemId: "apple", quantity: 1, price: 20, weightKg: 1.5 })],
  });
  const key = returnItemKey(o.items![0], 0);
  o.refundRecords = [
    {
      id: "r1",
      amount: 10,
      reason: "唔靚",
      items: [
        {
          itemKey: key,
          name: "蘋果",
          quantity: 0,
          amount: 10,
          // @ts-expect-error 測試刻意帶 extra 欄位
          weightKg: 0.5,
        },
      ],
      createdAt: "2026-09-12T11:00:00.000Z",
    },
  ];
  const line = returnableLines(o)[0];
  assert.equal(line.weightKg, 1.5);
  assert.equal(line.returnedKg, 0.5);
  assert.equal(line.remainingKg, 1);
});

// ─────────────────────────────────────────────────────────────
// computeReturn
// ─────────────────────────────────────────────────────────────

test("computeReturn：整行退 → 退款 = 行實收", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 2, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 2 }]);
  assert.equal(r.ok, true);
  assert.equal(r.totalRefund, 20);
  assert.equal(r.isFullRefund, true);
});

test("computeReturn：部分退（3 件退 1 件 → 退 1/3）", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 3, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 1 }]);
  assert.equal(r.totalRefund, 10);
  assert.equal(r.isFullRefund, false);
});

test("computeReturn：打過折嘅單唔可以退足牌價", () => {
  const o = order({
    items: [item({ name: "T恤", menuItemId: "tee", quantity: 1, price: 199, discountRate: 80 })],
    // 客人實付 159.20
    total: 159.2,
    discountAmount: 39.8,
  });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 1 }]);
  assert.equal(r.goodsRefund, 159.2);
  assert.equal(r.totalRefund, 159.2);
});

test("computeReturn：改價單退實際收嘅價", () => {
  const o = order({
    items: [item({ name: "x", menuItemId: "p1", quantity: 1, price: 80, unitPriceOriginal: 100 })],
    total: 80,
  });
  const key = returnableLines(o)[0].key;
  assert.equal(computeReturn(o, [{ key, qty: 1 }]).totalRefund, 80);
});

test("computeReturn：超出剩餘 → 報 exceeds 唔可以靜默", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 2, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 5 }]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].reason, "exceeds");
  assert.equal(r.totalRefund, 0);
});

test("computeReturn：搵唔到嘅 key → not-found", () => {
  const r = computeReturn(order(), [{ key: "nope", qty: 1 }]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].reason, "not-found");
});

test("computeReturn：數量 0 / 負數 → invalid", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 2, price: 10 })] });
  const key = returnableLines(o)[0].key;
  assert.equal(computeReturn(o, [{ key, qty: 0 }]).errors[0].reason, "invalid");
  assert.equal(computeReturn(o, [{ key, qty: -1 }]).errors[0].reason, "invalid");
});

test("computeReturn：空 pick → 唔 ok", () => {
  assert.equal(computeReturn(order(), []).ok, false);
});

test("computeReturn：稱重行按比例退（1.5kg 退 0.5kg → 退 1/3 錢）", () => {
  const o = order({
    items: [item({ name: "蘋果", menuItemId: "apple", quantity: 1, price: 20, weightKg: 1.5 })],
  });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, kg: 0.5 }]);
  assert.equal(r.ok, true);
  assert.equal(r.goodsRefund, 10);
  assert.equal(r.isFullRefund, false);
});

test("computeReturn：稱重行退足重量 → 全退", () => {
  const o = order({
    items: [item({ name: "蘋果", menuItemId: "apple", quantity: 1, price: 20, weightKg: 1.5 })],
  });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, kg: 1.5 }]);
  assert.equal(r.totalRefund, 30);
  assert.equal(r.isFullRefund, true);
});

test("computeReturn：稱重行超重 → exceeds", () => {
  const o = order({
    items: [item({ name: "蘋果", menuItemId: "apple", quantity: 1, price: 20, weightKg: 1.5 })],
  });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, kg: 2 }]);
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].reason, "exceeds");
});

test("computeReturn：多行部分退 → 各行加總 = 退款總額", () => {
  const o = order({
    items: [
      item({ name: "A", menuItemId: "a", quantity: 2, price: 10 }),
      item({ name: "B", menuItemId: "b", quantity: 3, price: 20 }),
    ],
  });
  const keys = returnableLines(o).map((l) => l.key);
  const r = computeReturn(o, [
    { key: keys[0], qty: 1 },
    { key: keys[1], qty: 2 },
  ]);
  assert.equal(r.ok, true);
  // A: 10, B: 40
  assert.equal(r.lines.reduce((s, l) => s + l.amount, 0), 50);
  assert.equal(r.totalRefund, 50);
});

test("computeReturn：整單折扣按比例回贈（唔可以退足商品價）", () => {
  // 商品 100，整單 9 折 → 客人實付 90
  const o = order({
    items: [item({ name: "x", menuItemId: "p1", quantity: 1, price: 100 })],
    subtotal: 100,
    discountAmount: 10,
    total: 90,
  });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 1 }]);
  assert.equal(r.goodsRefund, 100);
  assert.equal(r.orderDiscountRefund, 10);
  assert.equal(r.totalRefund, 90);
});

test("computeReturn：單品折扣唔會被當成整單折扣重複扣", () => {
  const o = order({
    items: [item({ name: "x", menuItemId: "p1", quantity: 1, price: 100, discountRate: 80 })],
    subtotal: 100,
    discountAmount: 20,
    total: 80,
  });
  assert.equal(itemDiscountTotalOfOrder(o), 20);
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 1 }]);
  // 單品折扣已反映喺 goodsRefund(80)，唔應該再扣一次
  assert.equal(r.orderDiscountRefund, 0);
  assert.equal(r.totalRefund, 80);
});

test("computeReturn：分兩次退可以退足（唔會少退）", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 3, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const first = computeReturn(o, [{ key, qty: 2 }]);
  assert.equal(first.totalRefund, 20);

  // 模擬落帳後再退
  const applied = applyReturnToOrder({
    order: o,
    computation: first,
    reason: "壞",
    now: "2026-09-12T11:00:00.000Z",
  });
  assert.equal(applied.ok, true);
  const second = computeReturn(applied.order!, [{ key, qty: 1 }]);
  assert.equal(second.ok, true);
  assert.equal(second.totalRefund, 10);
  assert.equal(second.isFullRefund, true);
  assert.equal(20 + second.totalRefund, 30);
});

test("computeReturn：分兩次退唔可以超退", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 2, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const first = applyReturnToOrder({
    order: o,
    computation: computeReturn(o, [{ key, qty: 2 }]),
    reason: "壞",
    now: "2026-09-12T11:00:00.000Z",
  }).order!;
  const second = computeReturn(first, [{ key, qty: 1 }]);
  assert.equal(second.ok, false);
  assert.equal(second.errors[0].reason, "exceeds");
});

// ─────────────────────────────────────────────────────────────
// 退款分攤
// ─────────────────────────────────────────────────────────────

test("splitRefundByMethod：單一付款 → 一筆", () => {
  const o = order({ paymentMethod: "現金" });
  const r = splitRefundByMethod(o, 50);
  assert.equal(r.length, 1);
  assert.equal(r[0].amount, 50);
  assert.equal(r[0].label, "現金");
});

test("splitRefundByMethod：拆分付款按比例", () => {
  const o = order({
    splitPayments: [
      { methodId: "cash", label: "現金", amount: 300 },
      { methodId: "card", label: "信用卡", amount: 200 },
    ],
  });
  const r = splitRefundByMethod(o, 100);
  assert.equal(r[0].amount, 60);
  assert.equal(r[1].amount, 40);
  assert.equal(r.reduce((s, e) => s + e.amount, 0), 100);
});

test("splitRefundByMethod：尾差補落最後一筆（總和一定對得上）", () => {
  const o = order({
    splitPayments: [
      { methodId: "a", label: "A", amount: 1 },
      { methodId: "b", label: "B", amount: 1 },
      { methodId: "c", label: "C", amount: 1 },
    ],
  });
  // 100 / 3 = 33.33… 逐筆 round2 會差 0.01
  const r = splitRefundByMethod(o, 100);
  assert.equal(r.reduce((s, e) => s + e.amount, 0), 100);
});

test("splitRefundByMethod：退款 0 → 空清單", () => {
  const o = order({
    splitPayments: [{ methodId: "a", label: "A", amount: 10 }],
  });
  assert.deepEqual(splitRefundByMethod(o, 0), []);
});

test("computeReturn：退款分攤接上原單付款方式", () => {
  const o = order({
    items: [item({ name: "x", menuItemId: "p1", quantity: 1, price: 100 })],
    total: 100,
    splitPayments: [
      { methodId: "cash", label: "現金", amount: 50 },
      { methodId: "card", label: "卡", amount: 50 },
    ],
  });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 1 }]);
  assert.equal(r.refundByMethod.length, 2);
  assert.equal(r.refundByMethod[0].amount, 50);
  assert.equal(r.refundByMethod[1].amount, 50);
});

// ─────────────────────────────────────────────────────────────
// 落帳
// ─────────────────────────────────────────────────────────────

test("applyReturnToOrder：追加 refundRecords（唔覆寫）", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 3, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const r1 = applyReturnToOrder({
    order: o,
    computation: computeReturn(o, [{ key, qty: 1 }]),
    reason: "壞",
    now: "2026-09-12T11:00:00.000Z",
  });
  const r2 = applyReturnToOrder({
    order: r1.order!,
    computation: computeReturn(r1.order!, [{ key, qty: 1 }]),
    reason: "又壞",
    now: "2026-09-12T12:00:00.000Z",
  });
  assert.equal(r2.order!.refundRecords?.length, 2);
  assert.equal(r2.order!.refundedAmount, 20);
});

test("applyReturnToOrder：全退 → status refunded", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 1, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const applied = applyReturnToOrder({
    order: o,
    computation: computeReturn(o, [{ key, qty: 1 }]),
    reason: "壞",
  });
  assert.equal(applied.order!.status, "refunded");
});

test("applyReturnToOrder：部分退 → status partially_refunded", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 3, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const applied = applyReturnToOrder({
    order: o,
    computation: computeReturn(o, [{ key, qty: 1 }]),
    reason: "壞",
  });
  assert.equal(applied.order!.status, "partially_refunded");
});

test("applyReturnToOrder：一定寫 clientUpdatedAt（LWW）", () => {
  const o = order({ items: [item({ name: "x", menuItemId: "p1", quantity: 1, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const applied = applyReturnToOrder({
    order: o,
    computation: computeReturn(o, [{ key, qty: 1 }]),
    reason: "壞",
    now: "2026-09-12T11:30:00.000Z",
  });
  assert.equal(applied.order!.clientUpdatedAt, "2026-09-12T11:30:00.000Z");
  assert.equal(applied.order!.updatedAt, "2026-09-12T11:30:00.000Z");
});

test("applyReturnToOrder：已取消單唔可以退", () => {
  const o = order({ status: "cancelled", items: [item({ name: "x", quantity: 1, price: 10 })] });
  const applied = applyReturnToOrder({
    order: o,
    computation: { ...computeReturn(o, []), ok: true, lines: [{ key: "x", name: "x", qty: 1, kg: 0, amount: 10, restockQty: 1, restockKg: 0 }] },
    reason: "壞",
  });
  assert.equal(applied.ok, false);
});

test("applyReturnToOrder：記低操作人", () => {
  const o = order({ items: [item({ name: "x", menuItemId: "p1", quantity: 1, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const applied = applyReturnToOrder({
    order: o,
    computation: computeReturn(o, [{ key, qty: 1 }]),
    reason: "壞",
    employeeAccount: "kim@shop",
    employeeName: "Kim",
  });
  const rec = applied.order!.refundRecords![0];
  assert.equal(rec.employeeAccount, "kim@shop");
  assert.equal(rec.employeeName, "Kim");
});

// ─────────────────────────────────────────────────────────────
// 庫存回補
// ─────────────────────────────────────────────────────────────

test("restockLines：普通行出件數", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 3, price: 10 })] });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 2 }]);
  const lines = restockLines(r);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].productId, "cola");
  assert.equal(lines[0].quantity, 2);
});

test("restockLines：稱重行出 weightKg + isWeighed", () => {
  const o = order({
    items: [item({ name: "蘋果", menuItemId: "apple", quantity: 1, price: 20, weightKg: 1.5 })],
  });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, kg: 0.5 }]);
  const lines = restockLines(r);
  assert.equal(lines[0].weightKg, 0.5);
  assert.equal(lines[0].isWeighed, true);
});

test("restockLines：帶變體 id", () => {
  const o = order({
    items: [
      item({ name: "T恤", menuItemId: "tee", variantId: "v-l", quantity: 1, price: 100 }),
    ],
  });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 1 }]);
  const lines = restockLines(r);
  assert.equal(lines[0].productId, "tee");
  assert.equal(lines[0].variantId, "v-l");
});

test("shouldRestock：正常原因要回補", () => {
  assert.equal(shouldRestock("客人唔要"), true);
  assert.equal(shouldRestock(""), true);
});

test("shouldRestock：破損 / 過期 / 生鮮唔回補", () => {
  assert.equal(shouldRestock("包裝破損"), false);
  assert.equal(shouldRestock("已過期"), false);
  assert.equal(shouldRestock("生鮮唔可以再賣"), false);
});

// ─────────────────────────────────────────────────────────────
// 換貨
// ─────────────────────────────────────────────────────────────

test("planExchange：補錢", () => {
  const p = planExchange(100, 150);
  assert.equal(p.difference, 50);
  assert.match(p.summary, /補/);
});

test("planExchange：退錢", () => {
  const p = planExchange(150, 100);
  assert.equal(p.difference, -50);
  assert.match(p.summary, /退返客人/);
});

test("planExchange：金額相同", () => {
  const p = planExchange(100, 100);
  assert.equal(p.difference, 0);
  assert.match(p.summary, /唔需找補/);
});

// ─────────────────────────────────────────────────────────────
// 邊界
// ─────────────────────────────────────────────────────────────

test("returnableLines：空 items 唔會爆", () => {
  assert.deepEqual(returnableLines(order({ items: [] })), []);
});

test("returnItemKey：同商品唔同規格分開", () => {
  const a = returnItemKey(item({ name: "T", menuItemId: "tee", variantId: "s", price: 100 }), 0);
  const b = returnItemKey(item({ name: "T", menuItemId: "tee", variantId: "l", price: 100 }), 0);
  assert.notEqual(a, b);
});

test("returnItemKey：同商品同規格同價 = 同一鍵", () => {
  const a = returnItemKey(item({ name: "T", menuItemId: "tee", variantId: "s", price: 100 }), 0);
  const b = returnItemKey(item({ name: "T", menuItemId: "tee", variantId: "s", price: 100 }), 5);
  assert.equal(a, b);
});

test("returnItemKey：冇識別欄位時用索引兜底（唔會空字串）", () => {
  const bare = { name: "x", quantity: 1, price: 0, printerGroup: "receipt" } as OrderItem;
  const k = returnItemKey(bare, 3);
  assert.ok(k.length > 0);
  assert.equal(k, "idx-3");
});

test("computeReturn：唔會改動原 order 物件", () => {
  const o = order({ items: [item({ name: "可樂", menuItemId: "cola", quantity: 3, price: 10 })] });
  const snapshot = JSON.stringify(o);
  const key = returnableLines(o)[0].key;
  computeReturn(o, [{ key, qty: 1 }]);
  assert.equal(JSON.stringify(o), snapshot);
});

test("computeReturn：改價單部分退按實際價均攤", () => {
  const o = order({
    items: [item({ name: "x", menuItemId: "p1", quantity: 2, price: 80, unitPriceOriginal: 100 })],
    total: 160,
  });
  const key = returnableLines(o)[0].key;
  const r = computeReturn(o, [{ key, qty: 1 }]);
  assert.equal(r.totalRefund, 80);
});

const _unused: ReturnPick[] = [];
void _unused;
