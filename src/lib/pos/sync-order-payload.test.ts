import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addedItemsOfEventPayload, unwrapOrderEventPayload } from "./sync-order-payload.ts";

/**
 * `/api/pos/sync` 訂單事件 payload 拆解規則（2026-09-16 事故鎖死）。
 *
 * 呢個模組存在嘅唯一原因：舊版 route 有**兩處**各自實作拆解、規則唔一致，
 * 而線上單橋接嘅 ORDER_CREATED 用 `{ order }` ⇒ 兩處都攞唔到 id ⇒ 永久 400。
 * 所以下面第 3 條係**迴歸測試**，改壞佢會令「同步健康檢查」再次卡死。
 */

const POS_ORDER = { id: "order-251dfe1a", status: "sent_to_kitchen", source: "pos" };

describe("unwrapOrderEventPayload", () => {
  it("1. 裸 order（kiosk / 掃碼 / 收銀台落單）→ 回 payload 本身", () => {
    assert.deepEqual(unwrapOrderEventPayload(POS_ORDER), POS_ORDER);
    assert.equal(unwrapOrderEventPayload(POS_ORDER).id, "order-251dfe1a");
  });

  it("2. `{ order, addedItems }`（收銀台加單）→ 回 .order", () => {
    const payload = { order: POS_ORDER, addedItems: [{ menuItemId: "m1" }] };
    assert.equal(unwrapOrderEventPayload(payload).id, "order-251dfe1a");
  });

  it("3. `{ order }` ＋ type=ORDER_CREATED（線上單橋接）→ 一定要回 .order（迴歸）", () => {
    // 呢個就係 2026-09-16 卡死 6 筆 ledger-<uuid> 事件嘅形狀。
    const ledgerOrder = { id: "ledger-37074691-08be-461a-97ef-44c64bb11d32", source: "pos" };
    assert.equal(unwrapOrderEventPayload({ order: ledgerOrder }).id, ledgerOrder.id);
  });

  it("4. `.order` 唔係 plain object（null / 陣列 / 字串）→ 唔當 nested，回 payload 本身", () => {
    assert.equal(unwrapOrderEventPayload({ order: null, id: "order-1" }).id, "order-1");
    assert.equal(unwrapOrderEventPayload({ order: [1, 2], id: "order-1" }).id, "order-1");
    assert.equal(unwrapOrderEventPayload({ order: "order-9", id: "order-1" }).id, "order-1");
  });

  it("5. 空 / 非 object payload → 回 {}（route 會判缺 id → 400，行為不變）", () => {
    assert.deepEqual(unwrapOrderEventPayload({}), {});
    assert.deepEqual(unwrapOrderEventPayload(null), {});
    assert.deepEqual(unwrapOrderEventPayload(undefined), {});
    assert.deepEqual(unwrapOrderEventPayload("nope"), {});
    assert.deepEqual(unwrapOrderEventPayload([{ id: "x" }]), {});
  });

  it("6. PosOrder 自身冇 `order` 欄 ⇒ 裸單永遠唔會被誤當 nested", () => {
    const order = { ...POS_ORDER, orderNote: "少油", tableId: "counter" };
    assert.deepEqual(unwrapOrderEventPayload(order), order);
  });
});

describe("addedItemsOfEventPayload", () => {
  it("有陣列就原樣回；缺欄 / 唔係陣列回 null", () => {
    const items = [{ menuItemId: "m1", quantity: 2 }];
    assert.deepEqual(addedItemsOfEventPayload({ order: POS_ORDER, addedItems: items }), items);
    assert.equal(addedItemsOfEventPayload({ order: POS_ORDER }), null);
    assert.equal(addedItemsOfEventPayload({ addedItems: "nope" }), null);
    assert.equal(addedItemsOfEventPayload(null), null);
  });
});
