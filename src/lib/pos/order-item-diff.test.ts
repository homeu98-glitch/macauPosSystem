import assert from "node:assert/strict";
import { test } from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
import { addedItemsSignature, diffAddedItems, orderItemKey, totalItemQuantity } from "./order-item-diff.ts";
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
