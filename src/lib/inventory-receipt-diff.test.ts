// 回歸測試：收據品項 content-diff（取代 delete-then-insert，修「原有品項無故消失」）。
// 純函式，node --test 直接跑。
// node --test src/lib/inventory-receipt-diff.test.ts
//
// ⚠️ 唔可以 import 任何 `@/` 或 `.tsx`：`node --test` 兩者都唔認。
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffReceiptItems, type ExistingReceiptItem, type ReceiptItemContent } from "./inventory-receipt-diff.ts";

const ex = (id: string, name: string, unit_price: number, quantity: number, quantity_unit = ""): ExistingReceiptItem => ({
  id,
  name,
  unit_price,
  quantity,
  quantity_unit,
});

const de = (name: string, unit_price: number, quantity: number, quantity_unit = ""): ReceiptItemContent => ({
  name,
  unit_price,
  quantity,
  quantity_unit,
});

test("完全無變更 → 三個動作都係空", () => {
  const existing = [ex("a", "魚", 17, 2, "kg"), ex("b", "豬肉", 30, 1, "包")];
  const desired = [de("魚", 17, 2, "kg"), de("豬肉", 30, 1, "包")];
  const out = diffReceiptItems(existing, desired);
  assert.equal(out.toInsert.length, 0);
  assert.equal(out.toUpdate.length, 0);
  assert.equal(out.toDelete.length, 0);
});

test("新增品項（原有保持不變，只 insert 新行）", () => {
  const existing = [ex("a", "魚", 17, 2, "kg")];
  const desired = [de("魚", 17, 2, "kg"), de("蔥", 5, 3, "包")];
  const out = diffReceiptItems(existing, desired);
  assert.equal(out.toInsert.length, 1, "應該只 insert 一條新行");
  assert.deepEqual(out.toInsert[0], de("蔥", 5, 3, "包"));
  assert.equal(out.toUpdate.length, 0, "原有品項唔可以變成 update（否則舊單會被改寫）");
  assert.equal(out.toDelete.length, 0, "原有品項唔可以被 delete");
});

test("修改某項單價 → 只 update 該行", () => {
  const existing = [ex("a", "魚", 17, 2, "kg"), ex("b", "豬肉", 30, 1, "包")];
  const desired = [de("魚", 20, 2, "kg"), de("豬肉", 30, 1, "包")];
  const out = diffReceiptItems(existing, desired);
  assert.equal(out.toUpdate.length, 1);
  assert.equal(out.toUpdate[0].id, "a");
  assert.equal(out.toUpdate[0].unit_price, 20);
  assert.equal(out.toInsert.length, 0);
  assert.equal(out.toDelete.length, 0);
});

test("刪除最後一項 → 只 delete 最後", () => {
  const existing = [ex("a", "魚", 17, 2, "kg"), ex("b", "豬肉", 30, 1, "包")];
  const desired = [de("魚", 17, 2, "kg")];
  const out = diffReceiptItems(existing, desired);
  assert.deepEqual(out.toDelete, ["b"]);
  assert.equal(out.toUpdate.length, 0);
  assert.equal(out.toInsert.length, 0);
});

test("刪除中間一項 → 最終狀態正確，唔會誤刪仲要用嘅行", () => {
  // 原有 A,B,C,D；用家刪咗 B（中間）→ desired = [A,C,D]
  const existing = [ex("a", "A", 1, 1), ex("b", "B", 2, 1), ex("c", "C", 3, 1), ex("d", "D", 4, 1)];
  const desired = [de("A", 1, 1), de("C", 3, 1), de("D", 4, 1)];
  const out = diffReceiptItems(existing, desired);
  // 最終：A 不變、C/D 仍然喺（B 被 update 成 C、C 被 update 成 D、D 被 delete）
  // 關鍵守衛：要 delete 嘅係最後嗰行（id "d"），唔可以係中間被改寫嘅 "b"。
  assert.deepEqual(out.toDelete, ["d"], "只可以刪多咗出嚟嘅最後一行");
  const updatedIds = out.toUpdate.map((u) => u.id).sort();
  assert.deepEqual(updatedIds, ["b", "c"], "中間兩行係 update，唔係 delete");
  // 最終 DB 內容（套用 update + delete）必須＝ desired
  assert.equal(out.toInsert.length, 0);
});

test("末尾新增多項 + 中間修改 → insert 排晒尾、update 只改變動行", () => {
  const existing = [ex("a", "A", 1, 1), ex("b", "B", 2, 1)];
  const desired = [de("A", 1, 1), de("B", 9, 1), de("C", 3, 1), de("D", 4, 1)];
  const out = diffReceiptItems(existing, desired);
  assert.equal(out.toUpdate.length, 1);
  assert.equal(out.toUpdate[0].id, "b");
  assert.equal(out.toUpdate[0].unit_price, 9);
  assert.equal(out.toInsert.length, 2);
  assert.deepEqual(out.toDelete, []);
});

test("空 desired（全部刪清）→ 全部 delete，唔 insert 唔 update", () => {
  const existing = [ex("a", "A", 1, 1), ex("b", "B", 2, 1)];
  const out = diffReceiptItems(existing, []);
  assert.deepEqual(out.toDelete, ["a", "b"]);
  assert.equal(out.toInsert.length, 0);
  assert.equal(out.toUpdate.length, 0);
});

test("空 existing（全新增）→ 全部 insert", () => {
  const desired = [de("A", 1, 1), de("B", 2, 1)];
  const out = diffReceiptItems([], desired);
  assert.equal(out.toInsert.length, 2);
  assert.equal(out.toUpdate.length, 0);
  assert.equal(out.toDelete.length, 0);
});

test("空對空 → 無任何動作", () => {
  const out = diffReceiptItems([], []);
  assert.equal(out.toInsert.length, 0);
  assert.equal(out.toUpdate.length, 0);
  assert.equal(out.toDelete.length, 0);
});
