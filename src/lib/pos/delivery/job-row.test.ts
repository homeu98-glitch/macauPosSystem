// 回歸測試：`pos_delivery_jobs` row 投影。
//
// 重點唔係「欄位有冇抄齊」（呢個睇 code 就知），而係：
//   ① DB 出現奇怪值（舊版／人手改 DB）時，UI 唔會收到未定義狀態；
//   ② 金額／誰付／平台 三個欄位係「有預設」嘅，唔可以變成 undefined。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mapDeliveryJobRow, type PosDeliveryJobRow } from "./job-row.ts";
import { isActiveJobStatus } from "./types.ts";

function row(overrides: Partial<PosDeliveryJobRow> = {}): PosDeliveryJobRow {
  return {
    id: "job-1",
    store_id: "store-1",
    order_source: "pos",
    order_ref: "order-1",
    order_no_snapshot: "外賣 003",
    platform: null,
    delivery_mode: "merchant",
    provider: "siteb",
    provider_order_id: null,
    ledger_dispatch_id: null,
    status: "new",
    last_event: "order.created",
    customer_name: "陳小姐",
    customer_phone: "66123456",
    customer_address: "黑沙環中街 88 號",
    customer_lat: 22.2001,
    customer_lng: 113.5483,
    customer_note: "管理處交收",
    fee_amount_avos: 3000,
    fee_paid_by: "shop",
    cod_amount_avos: 12800,
    created_by: "staff-1",
    created_at: "2026-10-31T04:00:00+00:00",
    updated_at: "2026-10-31T04:05:00+00:00",
    delivered_at: null,
    ...overrides,
  };
}

describe("mapDeliveryJobRow", () => {
  it("正常 row 完整投影", () => {
    const job = mapDeliveryJobRow(row());
    assert.equal(job.id, "job-1");
    assert.equal(job.orderSource, "pos");
    assert.equal(job.orderNoSnapshot, "外賣 003");
    assert.equal(job.deliveryMode, "merchant");
    assert.equal(job.status, "new");
    assert.equal(job.feeAmountAvos, 3000);
    assert.equal(job.feePaidBy, "shop");
    assert.equal(job.codAmountAvos, 12800);
    assert.equal(job.customerLat, 22.2001);
  });

  it("ledger 單：order_source='ledger'", () => {
    assert.equal(mapDeliveryJobRow(row({ order_source: "ledger" })).orderSource, "ledger");
  });

  it("奇怪 order_source → 當 pos（唔好漏去 UI）", () => {
    assert.equal(mapDeliveryJobRow(row({ order_source: "???" })).orderSource, "pos");
  });

  it("未知 delivery_mode → unknown", () => {
    assert.equal(mapDeliveryJobRow(row({ delivery_mode: "teleport" })).deliveryMode, "unknown");
  });

  it("未知 status → draft（唔會出現未定義狀態）", () => {
    assert.equal(mapDeliveryJobRow(row({ status: "落地" })).status, "draft");
  });

  it("platform 只認 aomi / mfood", () => {
    assert.equal(mapDeliveryJobRow(row({ platform: "aomi" })).platform, "aomi");
    assert.equal(mapDeliveryJobRow(row({ platform: "mfood" })).platform, "mfood");
    assert.equal(mapDeliveryJobRow(row({ platform: "ubereats" })).platform, undefined);
    assert.equal(mapDeliveryJobRow(row({ platform: null })).platform, undefined);
  });

  it("fee_paid_by 只認 customer，其餘當 shop", () => {
    assert.equal(mapDeliveryJobRow(row({ fee_paid_by: "customer" })).feePaidBy, "customer");
    assert.equal(mapDeliveryJobRow(row({ fee_paid_by: null })).feePaidBy, "shop");
  });

  it("金額 null → 0（唔好變 NaN）", () => {
    const job = mapDeliveryJobRow(row({ fee_amount_avos: null, cod_amount_avos: null }));
    assert.equal(job.feeAmountAvos, 0);
    assert.equal(job.codAmountAvos, 0);
  });

  it("冇 order_no_snapshot → 空字串（UI 自己 fallback）", () => {
    assert.equal(mapDeliveryJobRow(row({ order_no_snapshot: null })).orderNoSnapshot, "");
  });
});

describe("isActiveJobStatus", () => {
  it("draft / queued / new / accepted / picked_up 算進行中", () => {
    for (const status of ["draft", "queued", "new", "accepted", "picked_up"]) {
      assert.equal(isActiveJobStatus(status), true, status);
    }
  });

  it("delivered / canceled / failed 唔算", () => {
    for (const status of ["delivered", "canceled", "failed"]) {
      assert.equal(isActiveJobStatus(status), false, status);
    }
  });
});
