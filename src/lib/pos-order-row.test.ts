import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  POS_ORDER_DB_COLUMNS,
  POS_ORDER_DB_SELECT,
  POS_ORDER_VERIFY_SELECT,
  mapOrderRow,
  type PosOrderDbRow,
} from "./pos-order-row.ts";

/**
 * `pos_orders` 投影欄位清單 ↔ mapper 嘅一致性鎖（2026-09-21 egress 優化）。
 *
 * ## 為咩要鎖
 *
 * `/api/pos/state` 由 `select("*")` 改成明確投影（省 PostgREST egress）。
 * 呢個改動有一個**靜默**失效模式：
 *   · 漏一欄 → mapper 用 `?? 0` / `?? undefined` 兜底 → **唔會報錯**，
 *     只係報表／交班靜默少數（本專案歷史上中過兩次：`discount_note`、`reopen_*`）。
 *   · 多一欄（DB 未跑 migration）→ PostgREST 42703 → 整個查詢失敗。
 *
 * 所以呢度用「**source 解析 type 欄位 ↔ 陣列雙向比對**」將兩者焊死：
 * 將來任何人為 `PosOrderDbRow` 加欄而唔加落清單（或反之），呢個 test 即刻紅。
 *
 * 注意：type 喺 runtime 會被抹走，所以唯有讀 source 檔解析 —— 呢個係刻意的，
 * 唔想為咗測試而將 type 改成 runtime 物件（會拖動整條型別鏈）。
 */

/** 讀同目錄嘅 source 檔（測試檔同被測檔同一個 folder）。 */
function readOwnSource(): string {
  return readFileSync(new URL("./pos-order-row.ts", import.meta.url), "utf8");
}

/** 由 source 抽出 `export type PosOrderDbRow = { ... };` 嘅欄位名。 */
function extractTypeKeys(source: string): string[] {
  const block = source.match(/export type PosOrderDbRow = \{([\s\S]*?)\n\};/);
  assert.ok(block, "喺 pos-order-row.ts 搵唔到 PosOrderDbRow 型別定義（test 需要更新）");
  const body = block[1];
  return [...body.matchAll(/^\s{2}([a-z_][a-z0-9_]*)\??:/gm)].map((m) => m[1]);
}

/** 完整嘅代表性 row（30 欄全帶值，模擬 PostgREST 回傳）。 */
function fullRow(): PosOrderDbRow {
  return {
    id: "order-1",
    store_id: "store-1",
    local_order_no: "A0001",
    table_id: "t-01",
    table_name: "A1",
    status: "settled",
    fulfillment_status: "served",
    sent_to_kitchen_at: "2026-09-20T04:12:33.123Z",
    served_at: "2026-09-20T04:31:02.000Z",
    items: [{ menuItemId: "m1", name: "凍檸茶", quantity: 1, price: 38, printerGroup: "kitchen" }],
    order_note: "唔要蔥",
    subtotal: 152,
    tax_amount: 0,
    service_charge_amount: 15.2,
    discount_amount: 0,
    total: 167.2,
    prepaid_amount: 0,
    online_order_id: null,
    source: "pos",
    party_size: 2,
    comp_note: null,
    comped_at: null,
    discount_note: null,
    payment_method: "cash",
    created_at: "2026-09-20T04:12:30.000Z",
    updated_at: "2026-09-20T04:31:02.500Z",
    client_updated_at: "2026-09-20T04:31:02.400Z",
    reopen_count: 1,
    reopened_at: "2026-09-20T05:00:00.000Z",
    reopen_reason: "客人改單",
  };
}

describe("pos_orders 投影欄位清單", () => {
  it("清單同 PosOrderDbRow 型別**雙向**一致（漏欄／多欄都會即刻捉到）", () => {
    const typeKeys: string[] = extractTypeKeys(readOwnSource()).sort();
    const listKeys: string[] = [...POS_ORDER_DB_COLUMNS].sort();

    assert.ok(typeKeys.length > 20, `型別欄位解析似有問題（只抽到 ${typeKeys.length} 個）`);
    assert.deepEqual(
      listKeys,
      typeKeys,
      "POS_ORDER_DB_COLUMNS 同 PosOrderDbRow 唔一致：\n" +
        `  只喺 type 有：${typeKeys.filter((k) => !listKeys.includes(k)).join(", ") || "（無）"}\n` +
        `  只喺清單有：${listKeys.filter((k) => !typeKeys.includes(k)).join(", ") || "（無）"}`,
    );
  });

  it("POS_ORDER_DB_SELECT 就係清單 join（唔可以手寫第二份）", () => {
    assert.equal(POS_ORDER_DB_SELECT, POS_ORDER_DB_COLUMNS.join(","));
    assert.ok(!POS_ORDER_DB_SELECT.includes(" "), "投影字串唔應該有空格");
  });

  it("核實用嘅最小投影係清單嘅子集（唔可以引用唔存在嘅欄）", () => {
    const verify = POS_ORDER_VERIFY_SELECT.split(",");
    assert.ok(verify.length >= 2, "核實投影至少要有 id 同 status");
    for (const col of verify) {
      assert.ok(
        (POS_ORDER_DB_COLUMNS as readonly string[]).includes(col),
        `POS_ORDER_VERIFY_SELECT 帶咗清單以外嘅欄：${col}`,
      );
    }
    // 守護只比對狀態 → status 必須在；items 刻意唔帶（1 469 B → 91 B 嘅關鍵）
    assert.ok(verify.includes("status"), "核實投影一定要有 status");
    assert.ok(!verify.includes("items"), "核實投影唔應該帶 items（egress 主因）");
  });
});

describe("投影等價性（證明收窄欄位唔會改變 mapper 輸出）", () => {
  it("row 帶額外欄（mapper 唔讀嘅）→ 輸出完全一樣", () => {
    const row = fullRow();
    const withExtras = {
      ...row,
      // 真實 DB 有、但 PosOrderDbRow / mapper 唔讀嘅欄
      member_customer_id: "cust-1",
      member_deduction_avos: 16720,
      member_deduct_txn_id: "txn-1",
      kitchen_printed_at: "2026-09-20T04:13:00.000Z",
      some_future_column: "x",
    } as PosOrderDbRow;

    assert.deepEqual(
      mapOrderRow(withExtras),
      mapOrderRow(row),
      "額外欄位影響咗 mapper 輸出 —— 即係投影收窄會有副作用，唔可以改",
    );
  });

  it("清單內嘅每一欄都真係有被 mapper 讀到（防止『講就話要、其實冇用』）", () => {
    const row = fullRow();
    const mapped = mapOrderRow(row) as Record<string, unknown>;
    // 逐欄刪走，至少要有**一欄**會令輸出改變（＝清單唔係全垃圾欄）
    let changedCount = 0;
    for (const col of POS_ORDER_DB_COLUMNS) {
      const mutated = { ...row } as Record<string, unknown>;
      delete mutated[col];
      const out = mapOrderRow(mutated as PosOrderDbRow) as Record<string, unknown>;
      if (JSON.stringify(out) !== JSON.stringify(mapped)) changedCount += 1;
    }
    assert.ok(
      changedCount >= 20,
      `只有 ${changedCount} 欄影響 mapper 輸出，清單可能有冗餘（請人手覆核）`,
    );
  });

  it("缺欄唔會 throw（降級路徑要安全）", () => {
    const partial = { id: "order-1", status: "settled" } as PosOrderDbRow;
    const out = mapOrderRow(partial);
    assert.equal(out.id, "order-1");
    assert.equal(out.status, "settled");
    assert.equal(out.total, 0);
    assert.deepEqual(out.items, []);
  });
});
