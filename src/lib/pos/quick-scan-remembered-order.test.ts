import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  QUICK_SCAN_LAST_ORDER_MAX_AGE_MS,
  quickScanRememberedOrderIsFresh,
} from "./quick-scan-remembered-order.ts";

/**
 * 快餐掃碼「記住取餐號」嘅**有效性規則**（docs/115 §11.4）。
 *
 * 呢條規則係「靜默錯就令客人企喺櫃檯 show 錯號」嘅地方：
 *   - 唔驗 counter → 客人喺快餐 link 上見到一張枱單嘅號；
 *   - 唔驗時間 → 隔夜 reload 仲見到舊號（客人以為係今張單）。
 */

const NOW = Date.parse("2026-09-10T22:00:00.000Z");

function counterOrder(createdAt: string) {
  return { id: "o1", tableId: "counter", tableName: "自取", createdAt };
}

describe("quickScanRememberedOrderIsFresh", () => {
  it("剛落嘅快餐 counter 單 → 有效", () => {
    assert.equal(quickScanRememberedOrderIsFresh(counterOrder("2026-09-10T21:55:00.000Z"), NOW), true);
  });

  it("冇 id / null / undefined → 無效", () => {
    assert.equal(quickScanRememberedOrderIsFresh(null, NOW), false);
    assert.equal(quickScanRememberedOrderIsFresh(undefined, NOW), false);
    assert.equal(quickScanRememberedOrderIsFresh({ ...counterOrder("2026-09-10T21:55:00.000Z"), id: "" }, NOW), false);
  });

  it("枱單（唔係 counter）→ 無效：唔可以喺快餐 link 顯示枱單號碼", () => {
    assert.equal(
      quickScanRememberedOrderIsFresh({ id: "o1", tableId: "t-a01", createdAt: "2026-09-10T21:55:00.000Z" }, NOW),
      false,
    );
    assert.equal(
      quickScanRememberedOrderIsFresh({ id: "o1", tableId: null, createdAt: "2026-09-10T21:55:00.000Z" }, NOW),
      false,
    );
  });

  it("超過有效期（預設 6 小時）→ 無效；邊界值仍然有效", () => {
    const justInside = new Date(NOW - QUICK_SCAN_LAST_ORDER_MAX_AGE_MS).toISOString();
    const tooOld = new Date(NOW - QUICK_SCAN_LAST_ORDER_MAX_AGE_MS - 1000).toISOString();
    assert.equal(quickScanRememberedOrderIsFresh(counterOrder(justInside), NOW), true);
    assert.equal(quickScanRememberedOrderIsFresh(counterOrder(tooOld), NOW), false);
  });

  it("createdAt 壞 / 缺失 → 無效（寧可唔顯示，都唔好顯示一個唔知幾時嘅號）", () => {
    assert.equal(quickScanRememberedOrderIsFresh(counterOrder(""), NOW), false);
    assert.equal(quickScanRememberedOrderIsFresh(counterOrder("not-a-date"), NOW), false);
  });
});
