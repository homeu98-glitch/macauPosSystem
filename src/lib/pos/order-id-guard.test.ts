import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NON_ORDER_ID_PREFIXES,
  isNonOrderId,
  splitNonOrderRows,
} from "./order-id-guard.ts";

/**
 * 《orders store id 命名空間守衛》（2026-09-22 實案：隔離區 111 張 `print-xxxxxxxx`）。
 *
 * 呢個檔用 `node:test` 直接跑 ⇒ import 一定要**相對路徑 + 顯式 `.ts`**（唔認 `@/` 別名）。
 */
describe("isNonOrderId：認得出「唔係訂單」嘅 id", () => {
  it("PrintJob / QueueEvent 嘅命名空間一律當非訂單", () => {
    assert.equal(isNonOrderId("print-8d940feb"), true);
    assert.equal(isNonOrderId("print-c1772dbe"), true);
    assert.equal(isNonOrderId("evt-a1b2c3d4"), true);
    assert.equal(isNonOrderId("q-1234"), true);
  });

  it("真訂單 id 一律唔准誤判（四個合法命名空間）", () => {
    for (const id of ["order-41ccd63c", "staff-abc123", "kiosk-9f8e7d6c", "ledger-416102ae-18f7-4454-a30a-3265f15232ef"]) {
      assert.equal(isNonOrderId(id), false, `${id} 被誤判為非訂單`);
    }
  });

  it("邊界：空字串／非字串／只有前綴相似但唔成立", () => {
    assert.equal(isNonOrderId(""), false);
    assert.equal(isNonOrderId(null), false);
    assert.equal(isNonOrderId(undefined), false);
    assert.equal(isNonOrderId("print"), false, "冇 dash 唔算");
    assert.equal(isNonOrderId("printer-1"), false, "printer- 唔等於 print-");
    assert.equal(isNonOrderId("  "), false);
  });

  it("黑名單本身唔可以包含訂單前綴（防日後改壞）", () => {
    for (const p of NON_ORDER_ID_PREFIXES) {
      assert.ok(!["order-", "staff-", "kiosk-", "ledger-"].includes(p), `${p} 撞咗合法訂單前綴`);
    }
  });
});

describe("splitNonOrderRows：分出真訂單同垃圾", () => {
  it("垃圾分開、真訂單保留、次序不變", () => {
    const rows = [
      { id: "order-a", localOrderNo: "訂單01" },
      { id: "print-8d940feb", tableName: "MFOOD1", total: 0 },
      { id: "staff-b", localOrderNo: "訂單02" },
      { id: "print-c1772dbe", tableName: "MFOOD1", total: 0 },
    ];
    const { orders, junk } = splitNonOrderRows(rows);
    assert.deepEqual(
      orders.map((r) => r.id),
      ["order-a", "staff-b"],
    );
    assert.deepEqual(
      junk.map((r) => r.id),
      ["print-8d940feb", "print-c1772dbe"],
    );
  });

  it("null / undefined / 空陣列 → 兩邊都空（唔可以 throw）", () => {
    assert.deepEqual(splitNonOrderRows(null), { orders: [], junk: [] });
    assert.deepEqual(splitNonOrderRows(undefined), { orders: [], junk: [] });
    assert.deepEqual(splitNonOrderRows([]), { orders: [], junk: [] });
  });
});
