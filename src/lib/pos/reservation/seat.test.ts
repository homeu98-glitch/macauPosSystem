// 入座帶入：`SeatLine` → `OrderItem` 的轉換測試。
//
// 呢個轉換係「預點菜變成正式訂單」嘅最後一哩，錯了嘅後果：
//   · printerGroup 錯 → 廚房單去錯機房（出唔到紙）
//   · 規格丟失 → 廚房做錯（少冰變正常冰）
//   · 折扣丟失 → 收銀重算變原價，同客人睇到嘅金額對唔上

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSelectedSpecs, toOrderItems } from "./seat.ts";
import type { SeatLine } from "./items.ts";
import type { MenuItem } from "../../types.ts";

const specGroups = [
  {
    id: "ice",
    name: "冰量",
    selectionMode: "single" as const,
    required: false,
    options: [
      { id: "normal", label: "正常冰", priceDelta: 0 },
      { id: "less", label: "少冰", priceDelta: 0 },
    ],
  },
  {
    id: "extra",
    name: "加料",
    selectionMode: "multi" as const,
    required: false,
    options: [{ id: "lemon", label: "加檸檬", priceDelta: 3 }],
  },
];

function menuItem(over: Partial<MenuItem> & { id: string }): MenuItem {
  return {
    categoryId: "drink",
    name: "凍檸茶",
    price: 22,
    printerGroup: "kitchen",
    ...over,
  } as MenuItem;
}

function seatLine(over: Partial<SeatLine>): SeatLine {
  return {
    menuItemId: "m1",
    name: "凍檸茶",
    qty: 2,
    unitPrice: 22,
    netPrice: 22,
    memberPrice: null,
    discountRate: null,
    specs: {},
    specText: "",
    ...over,
  };
}

describe("規格還原", () => {
  it("把 optionId 還原成完整 selectedSpecs（含名稱與加價）", () => {
    const out = buildSelectedSpecs(specGroups, { ice: ["less"], extra: ["lemon"] });
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], {
      groupId: "ice",
      groupName: "冰量",
      optionId: "less",
      optionLabel: "少冰",
      priceDelta: 0,
    });
    assert.equal(out[1]?.priceDelta, 3);
  });

  it("未知 option 被忽略（不會產生空行）", () => {
    const out = buildSelectedSpecs(specGroups, { ice: ["ghost"] });
    assert.deepEqual(out, []);
  });

  it("沒有 specGroups 時回空陣列", () => {
    assert.deepEqual(buildSelectedSpecs(undefined, { ice: ["less"] }), []);
  });
});

describe("入座帶入", () => {
  const menu = [menuItem({ id: "m1", printerGroup: "kitchen" }), menuItem({ id: "m2", printerGroup: "bar" })];

  it("基本轉換：帶 printerGroup / 數量 / 單價", () => {
    const { items, missing } = toOrderItems([seatLine({ menuItemId: "m2" })], menu);
    assert.equal(missing.length, 0);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.printerGroup, "bar");
    assert.equal(items[0]?.quantity, 2);
    assert.equal(items[0]?.price, 22);
  });

  it("會員價優先帶入 memberPrice，不另設 discountRate", () => {
    const { items } = toOrderItems(
      [seatLine({ menuItemId: "m1", unitPrice: 88, netPrice: 79, memberPrice: 79 })],
      menu,
    );
    assert.equal(items[0]?.memberPrice, 79);
    assert.equal(items[0]?.discountRate, undefined);
  });

  it("沒有會員價時帶 discountRate", () => {
    const { items } = toOrderItems(
      [seatLine({ menuItemId: "m1", unitPrice: 88, netPrice: 79.2, discountRate: 90 })],
      menu,
    );
    assert.equal(items[0]?.discountRate, 90);
    assert.equal(items[0]?.memberPrice, undefined);
  });

  it("規格寫入 selectedSpecs", () => {
    const { items } = toOrderItems(
      [seatLine({ menuItemId: "m1", specs: { ice: ["less"] }, specText: "少冰" })],
      [menuItem({ id: "m1", specGroups })],
    );
    assert.equal(items[0]?.selectedSpecs?.length, 1);
    assert.equal(items[0]?.selectedSpecs?.[0]?.optionLabel, "少冰");
    // 有 selectedSpecs 就不再重複寫 note
    assert.equal(items[0]?.note, undefined);
  });

  it("沒有規格但有 specText 時寫入 note", () => {
    const { items } = toOrderItems([seatLine({ menuItemId: "m1", specText: "少冰 · 少甜" })], menu);
    assert.equal(items[0]?.note, "少冰 · 少甜");
  });

  it("菜單找不到的菜列入 missing，不靜默丟棄", () => {
    const { items, missing } = toOrderItems(
      [seatLine({ menuItemId: "gone", name: "已下架菜" }), seatLine({ menuItemId: "m1" })],
      menu,
    );
    assert.equal(items.length, 1);
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.menuItemId, "gone");
    assert.equal(missing[0]?.name, "已下架菜");
  });
});
