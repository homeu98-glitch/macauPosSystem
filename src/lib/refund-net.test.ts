// 回歸測試：退款「淨額口徑」（2026-09-17 商家實案）。
//
// 【問題】原本報表（`isSaleCountable()`）同交班（`summarizeClosedOrders()`）
// 都係「退款單整張剔走」口徑 ⇒「賣 100、退 30」正確實收 70，兩頁都當 0，
// 實收**偏低**。商家要求兩頁見同一套數。
//
// 【口徑】**淨營業額 = 已計銷售單實收 − 退款總額**。
// 呢個測試鎖死 `refundTotalOf()` 嘅三件事：
//   ① 只認 `refunded` / `partially_refunded`（其他狀態即使有欄位都唔計）；
//   ② `refundedAmount` 為 0 / 缺失時 fallback 去累加 `refundRecords[].amount`；
//   ③ 金額四捨五入到分（避免浮點尾巴）。
//
// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping。
// 亦因為呢個原因，測試對象**唔可以**係 `.tsx`（`ERR_UNKNOWN_FILE_EXTENSION`）——
// 所以純計算邏輯抽咗去 `src/lib/refund-net.ts`，唔留喺報表元件檔。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isRefundedOrderStatus,
  netOf,
  refundAmountOf,
  refundOrderCountOf,
  refundTotalOf,
} from "./refund-net.ts";
import type { PosOrder } from "./types.ts";

function order(patch: Partial<PosOrder> & { id: string }): PosOrder {
  return {
    localOrderNo: patch.id,
    tableId: "counter",
    tableName: "快餐",
    status: "settled",
    items: [],
    subtotal: 0,
    taxAmount: 0,
    serviceChargeAmount: 0,
    discountAmount: 0,
    total: 0,
    createdAt: "2026-09-17T10:00:00.000Z",
    updatedAt: "2026-09-17T10:00:00.000Z",
    ...patch,
  };
}

test("refundTotalOf：無退款單 → 0", () => {
  const orders = [order({ id: "o1", status: "settled", total: 100 })];
  assert.equal(refundTotalOf(orders), 0);
  assert.equal(refundTotalOf([]), 0);
  assert.equal(refundTotalOf(undefined as unknown as PosOrder[]), 0);
});

test("refundTotalOf：部分退款單 → 只計 refundedAmount（唔計全額 total）", () => {
  // 賣 100、退 30 ⇒ 退款總額 30（唔係 100）
  const orders = [order({ id: "o1", status: "partially_refunded", total: 100, refundedAmount: 30 })];
  assert.equal(refundTotalOf(orders), 30);
});

test("refundTotalOf：全額退款單 → 計全額", () => {
  const orders = [order({ id: "o1", status: "refunded", total: 100, refundedAmount: 100 })];
  assert.equal(refundTotalOf(orders), 100);
});

test("refundTotalOf：多張退款單累加", () => {
  const orders = [
    order({ id: "o1", status: "partially_refunded", total: 100, refundedAmount: 30 }),
    order({ id: "o2", status: "refunded", total: 80, refundedAmount: 80 }),
    order({ id: "o3", status: "settled", total: 50 }),
  ];
  // 30 + 80 = 110（settled 單唔計）
  assert.equal(refundTotalOf(orders), 110);
});

test("refundTotalOf：refundedAmount 為 0 / 缺失 → fallback 累加 refundRecords", () => {
  // 全額折扣單退貨實退 0 元：refundedAmount 可能係 0，要靠 records 補
  const viaRecords = [
    order({
      id: "o1",
      status: "refunded",
      total: 0,
      refundRecords: [
        { id: "r1", amount: 0, reason: "全額折扣單退回", createdAt: "2026-09-17T11:00:00.000Z" },
      ],
    }),
  ];
  assert.equal(refundTotalOf(viaRecords), 0);

  // refundedAmount 缺失（遷移未跑）但有 records → 用 records 加總
  const missingField = [
    order({
      id: "o2",
      status: "partially_refunded",
      total: 100,
      refundRecords: [
        { id: "r1", amount: 20, reason: "退菜", createdAt: "2026-09-17T11:00:00.000Z" },
        { id: "r2", amount: 15, reason: "退菜", createdAt: "2026-09-17T11:05:00.000Z" },
      ],
    }),
  ];
  assert.equal(refundTotalOf(missingField), 35);
});

test("refundTotalOf：非退款狀態即使有 refundedAmount 都唔計（收窄範圍，防髒資料）", () => {
  const orders = [
    order({ id: "o1", status: "settled", total: 100, refundedAmount: 30 }),
    order({ id: "o2", status: "paid", total: 100, refundedAmount: 30 }),
    order({ id: "o3", status: "cancelled", total: 100, refundedAmount: 30 }),
  ];
  assert.equal(refundTotalOf(orders), 0);
});

test("refundTotalOf：負數 / NaN 髒資料唔會拖低總額", () => {
  const orders = [
    order({ id: "o1", status: "partially_refunded", total: 100, refundedAmount: -50 }),
    order({ id: "o2", status: "partially_refunded", total: 100, refundedAmount: Number.NaN }),
  ];
  // 負數唔 > 0 ⇒ 走 records fallback；NaN 同理。兩者 records 都冇 → 計 0。
  // 重點：唔可以變成 -50 令總額無端變細。
  assert.equal(refundTotalOf(orders), 0);
});

test("refundTotalOf：金額四捨五入到分（浮點尾巴）", () => {
  const orders = [
    order({ id: "o1", status: "partially_refunded", total: 100, refundedAmount: 0.1 }),
    order({ id: "o2", status: "partially_refunded", total: 100, refundedAmount: 0.2 }),
  ];
  // 0.1 + 0.2 = 0.30000000000000004 → 應該變返 0.3
  assert.equal(refundTotalOf(orders), 0.3);
});

test("淨營業額口徑：賣 100 退 30 → 毛 100、淨 70（商家核心要求）", () => {
  // 模擬報表邏輯：revenue 只計 settled（退貨單 100 被剔走）→ 100
  const settled = order({ id: "o1", status: "settled", total: 100 });
  const refunded = order({ id: "o2", status: "partially_refunded", total: 100, refundedAmount: 30 });
  const orders = [settled, refunded];
  const revenue = orders.filter((o) => o.status === "settled").reduce((s, o) => s + o.total, 0);
  const refundTotal = refundTotalOf(orders);
  const netRevenue = netOf(revenue, refundTotal);
  assert.equal(revenue, 100);
  assert.equal(refundTotal, 30);
  assert.equal(netRevenue, 70);
});

test("isRefundedOrderStatus：只認 refunded / partially_refunded", () => {
  assert.equal(isRefundedOrderStatus("refunded"), true);
  assert.equal(isRefundedOrderStatus("partially_refunded"), true);
  for (const s of ["settled", "paid", "draft", "sent_to_kitchen", "reopened", "cancelled", "", undefined, null]) {
    assert.equal(isRefundedOrderStatus(s), false, `status=${String(s)} 唔應該當退款`);
  }
});

test("refundOrderCountOf：只數退款單（唔關金額事）", () => {
  const orders = [
    order({ id: "o1", status: "settled", total: 100 }),
    order({ id: "o2", status: "partially_refunded", total: 100, refundedAmount: 30 }),
    order({ id: "o3", status: "refunded", total: 0 }), // 實退 0 但係退款單
  ];
  assert.equal(refundOrderCountOf(orders), 2);
  assert.equal(refundOrderCountOf([]), 0);
  assert.equal(refundOrderCountOf(undefined), 0);
});

test("refundAmountOf：單張取值優先序（欄位 > records）+ 髒資料防護", () => {
  // 欄位有效 → 用欄位，唔理 records
  assert.equal(
    refundAmountOf(
      order({
        id: "o1",
        status: "partially_refunded",
        refundedAmount: 30,
        refundRecords: [{ id: "r", amount: 999, reason: "x", createdAt: "2026-09-17T11:00:00.000Z" }],
      }),
    ),
    30,
  );
  // 欄位為 0 → 走 records
  assert.equal(
    refundAmountOf(
      order({
        id: "o2",
        status: "refunded",
        refundedAmount: 0,
        refundRecords: [{ id: "r", amount: 25, reason: "x", createdAt: "2026-09-17T11:00:00.000Z" }],
      }),
    ),
    25,
  );
  // 空 / undefined → 0
  assert.equal(refundAmountOf(undefined), 0);
  assert.equal(refundAmountOf(null), 0);
  assert.equal(refundAmountOf(order({ id: "o3" })), 0);
});

test("netOf：NaN / 非有限值一律當 0，唔會產生 NaN 金額", () => {
  assert.equal(netOf(100, 30), 70);
  assert.equal(netOf(Number.NaN, 30), -30);
  assert.equal(netOf(100, Number.NaN), 100);
  assert.equal(netOf(Number.NaN, Number.NaN), 0);
  // 浮點尾巴
  assert.equal(netOf(0.3, 0.1), 0.2);
  // 退款大過毛額（理論上唔應該，但唔可以爆負 NaN）
  assert.equal(netOf(50, 80), -30);
});
