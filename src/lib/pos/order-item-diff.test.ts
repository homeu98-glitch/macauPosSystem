import assert from "node:assert/strict";
import { test } from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
import { addedItemsSignature, diffAddedItems, diffReducedItems, orderItemKey, refundRecordCount, totalItemQuantity } from "./order-item-diff.ts";
import type { OrderItem } from "../types.ts";

function item(over: Partial<OrderItem> & Pick<OrderItem, "menuItemId" | "name">): OrderItem {
  return {
    quantity: 1,
    price: 65,
    printerGroup: "kitchen",
    ...over,
  } as OrderItem;
}

test("orderItemKey：規格次序唔影響身分（sort 後連接）", () => {
  const a = item({
    menuItemId: "m1",
    name: "牛肋條麵",
    selectedSpecs: [
      { groupId: "g1", groupName: "麵", optionId: "o1", optionLabel: "細麵", priceDelta: 0 },
      { groupId: "g2", groupName: "菜", optionId: "o2", optionLabel: "青菜", priceDelta: 0 },
    ],
  });
  const b = item({
    menuItemId: "m1",
    name: "牛肋條麵",
    selectedSpecs: [
      { groupId: "g2", groupName: "菜", optionId: "o2", optionLabel: "青菜", priceDelta: 0 },
      { groupId: "g1", groupName: "麵", optionId: "o1", optionLabel: "細麵", priceDelta: 0 },
    ],
  });
  assert.equal(orderItemKey(a), orderItemKey(b));
});

test("orderItemKey：價錢 / 備註 / 規格唔同 → 身分唔同", () => {
  const base = item({ menuItemId: "m1", name: "A" });
  assert.notEqual(orderItemKey(base), orderItemKey({ ...base, price: 70 }));
  assert.notEqual(orderItemKey(base), orderItemKey({ ...base, note: "少辣" }));
  assert.notEqual(
    orderItemKey(base),
    orderItemKey({
      ...base,
      selectedSpecs: [{ groupId: "g1", groupName: "麵", optionId: "o9", optionLabel: "寬麵", priceDelta: 0 }],
    }),
  );
});

test("diffAddedItems：全新單（base 空）→ 全部當新增", () => {
  const next = [item({ menuItemId: "m1", name: "A", quantity: 2 })];
  const added = diffAddedItems([], next);
  assert.equal(added.length, 1);
  assert.equal(added[0].quantity, 2);
});

test("diffAddedItems：加單（原本 1 項，加 2 項）→ 只回新增嘅 2 項", () => {
  const base = [item({ menuItemId: "m1", name: "牛肋條麵" })];
  const next = [
    item({ menuItemId: "m1", name: "牛肋條麵" }),
    item({ menuItemId: "m2", name: "酸白菜牛肉麵", price: 85 }),
    item({ menuItemId: "m3", name: "人氣半筋半肉麵", price: 90 }),
  ];
  const added = diffAddedItems(base, next);
  assert.deepEqual(
    added.map((i) => i.menuItemId),
    ["m2", "m3"],
  );
});

test("diffAddedItems：同一款加數量 → 回差額（唔係總數）", () => {
  const base = [item({ menuItemId: "m1", name: "A", quantity: 1 })];
  const next = [item({ menuItemId: "m1", name: "A", quantity: 3 })];
  const added = diffAddedItems(base, next);
  assert.equal(added.length, 1);
  assert.equal(added[0].quantity, 2);
});

test("diffAddedItems：減菜 / 冇變 → 回空（唔會退單）", () => {
  const base = [
    item({ menuItemId: "m1", name: "A", quantity: 2 }),
    item({ menuItemId: "m2", name: "B", quantity: 2 }),
  ];
  assert.equal(diffAddedItems(base, [item({ menuItemId: "m1", name: "A", quantity: 1 })]).length, 0);
  assert.equal(diffAddedItems(base, base).length, 0);
  assert.equal(diffAddedItems(undefined, undefined).length, 0);
});

test("addedItemsSignature：次序無關、內容敏感（去重比對用）", () => {
  const x = [item({ menuItemId: "m2", name: "B" }), item({ menuItemId: "m1", name: "A" })];
  const y = [item({ menuItemId: "m1", name: "A" }), item({ menuItemId: "m2", name: "B" })];
  assert.equal(addedItemsSignature(x), addedItemsSignature(y));
  assert.notEqual(addedItemsSignature(x), addedItemsSignature([item({ menuItemId: "m1", name: "A" })]));
  assert.equal(addedItemsSignature([]), "");
});

test("totalItemQuantity：加總件數", () => {
  assert.equal(
    totalItemQuantity([item({ menuItemId: "m1", name: "A", quantity: 2 }), item({ menuItemId: "m2", name: "B", quantity: 3 })]),
    5,
  );
  assert.equal(totalItemQuantity(undefined), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// diffReducedItems（2026-09-17 退貨修復）
// 用途：偵測「items 變少」＝疑似退貨／退菜，配合 refundRecordCount 判真偽。
// ─────────────────────────────────────────────────────────────────────────────

test("diffReducedItems：退掉一整行 → 回該行原數量", () => {
  const base = [
    item({ menuItemId: "m1", name: "牛肋條麵" }),
    item({ menuItemId: "m2", name: "酸白菜牛肉麵", price: 85 }),
  ];
  const next = [item({ menuItemId: "m1", name: "牛肋條麵" })];
  const reduced = diffReducedItems(base, next);
  assert.equal(reduced.length, 1);
  assert.equal(reduced[0].menuItemId, "m2");
  assert.equal(reduced[0].quantity, 1);
});

test("diffReducedItems：同一行減數量（x3 → x1）→ 回差額 x2", () => {
  const base = [item({ menuItemId: "m1", name: "A", quantity: 3 })];
  const next = [item({ menuItemId: "m1", name: "A", quantity: 1 })];
  const reduced = diffReducedItems(base, next);
  assert.equal(reduced.length, 1);
  assert.equal(reduced[0].quantity, 2);
});

test("diffReducedItems：加菜 / 無變化 / 空值 → 一律回空", () => {
  const base = [item({ menuItemId: "m1", name: "A" })];
  const grown = [item({ menuItemId: "m1", name: "A", quantity: 3 })];
  assert.equal(diffReducedItems(base, grown).length, 0);
  assert.equal(diffReducedItems(base, base).length, 0);
  assert.equal(diffReducedItems(undefined, base).length, 0);
  assert.equal(diffReducedItems(undefined, undefined).length, 0);
});

test("diffReducedItems：換菜（刪 A 加 B）→ 只回 A 減少嘅部分，唔會誤報 B", () => {
  const base = [item({ menuItemId: "m1", name: "A" })];
  const next = [item({ menuItemId: "m2", name: "B", price: 85 })];
  const reduced = diffReducedItems(base, next);
  assert.deepEqual(
    reduced.map((i) => i.menuItemId),
    ["m1"],
  );
});

test("diffReducedItems：規格唔同視為兩款菜（同 orderItemKey 口徑一致）", () => {
  const base = [
    item({
      menuItemId: "m1",
      name: "麵",
      selectedSpecs: [{ groupId: "g1", groupName: "麵", optionId: "o1", optionLabel: "細麵", priceDelta: 0 }],
    }),
  ];
  const next = [
    item({
      menuItemId: "m1",
      name: "麵",
      selectedSpecs: [{ groupId: "g1", groupName: "麵", optionId: "o2", optionLabel: "寬麵", priceDelta: 0 }],
    }),
  ];
  const reduced = diffReducedItems(base, next);
  assert.equal(reduced.length, 1);
  assert.equal(reduced[0].selectedSpecs?.[0]?.optionId, "o1");
});

// ─────────────────────────────────────────────────────────────────────────────
// refundRecordCount（2026-09-17 退貨修復）
// 用途：`refund_records` 單調遞增 ⇒ 筆數增加 = 可靠嘅「今次係退貨」信號。
// 為何唔用金額：全額折扣單退貨實退 0 元，用金額會漏判。
// ─────────────────────────────────────────────────────────────────────────────

test("refundRecordCount：正常陣列回長度", () => {
  assert.equal(refundRecordCount([]), 0);
  assert.equal(refundRecordCount([{ amount: 30 }]), 1);
  assert.equal(refundRecordCount([{ amount: 30 }, { amount: 0 }]), 2);
});

test("refundRecordCount：遷移未跑（undefined / null）＋ 髒資料 → 一律回 0，唔拋錯", () => {
  assert.equal(refundRecordCount(undefined), 0);
  assert.equal(refundRecordCount(null), 0);
  // 雲端 jsonb 有機會係物件 / 字串（歷史髒資料）→ 當 0，唔可以 throw
  assert.equal(refundRecordCount({ amount: 30 }), 0);
  assert.equal(refundRecordCount("[]"), 0);
  assert.equal(refundRecordCount(0), 0);
});
