// 回歸測試：庫存主檔顯示次序（供應商／品類）—— 純函式，node --test 直接跑。
// node --test src/lib/inventory-order.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { moveWithin, orderKeys, reorderByStored, usageCount } from "./inventory-order.ts";

type S = { id: string; name: string };
const s = (name: string): S => ({ id: `id-${name}`, name });
const names = (list: S[]) => list.map((x) => x.name);

test("reorderByStored：冇存過次序 ⇒ 原樣（唔可以無中生有）", () => {
  const list = [s("A"), s("B"), s("C")];
  assert.deepEqual(names(reorderByStored(list, [], (x) => x.name)), ["A", "B", "C"]);
});

test("reorderByStored：依存起嘅次序排", () => {
  const list = [s("A"), s("B"), s("C")];
  assert.deepEqual(names(reorderByStored(list, ["C", "A", "B"], (x) => x.name)), ["C", "A", "B"]);
});

test("🔴 reorderByStored：新建立（唔喺 order 入面）嘅項目要排最後，唔可以失蹤", () => {
  const list = [s("新"), s("A"), s("B")];
  const out = reorderByStored(list, ["B", "A"], (x) => x.name);
  assert.deepEqual(names(out), ["B", "A", "新"]);
  assert.equal(out.length, list.length, "唔可以少咗項目");
});

test("reorderByStored：order 入面已被刪嘅名會被忽略，唔會產生空洞", () => {
  const list = [s("A"), s("B")];
  assert.deepEqual(names(reorderByStored(list, ["已刪", "B", "A"], (x) => x.name)), ["B", "A"]);
});

test("reorderByStored：order 有重複 key 時取**第一個**位置（存壞檔都要有確定行為）", () => {
  const list = [s("A"), s("B")];
  assert.deepEqual(names(reorderByStored(list, ["B", "A", "B"], (x) => x.name)), ["B", "A"]);
});

test("reorderByStored：唔可以改動傳入嘅陣列（React state 唔可以原地變）", () => {
  const list = [s("A"), s("B")];
  const before = names(list);
  reorderByStored(list, ["B", "A"], (x) => x.name);
  assert.deepEqual(names(list), before);
});

test("moveWithin：由前向後（0 → 2）", () => {
  assert.deepEqual(moveWithin(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
});

test("moveWithin：由後向前（3 → 1）", () => {
  assert.deepEqual(moveWithin(["a", "b", "c", "d"], 3, 1), ["a", "d", "b", "c"]);
});

test("moveWithin：同一個位／越界都唔會爆，回傳等長陣列", () => {
  assert.deepEqual(moveWithin(["a", "b"], 1, 1), ["a", "b"]); // 同一個位 = 原樣
  assert.deepEqual(moveWithin(["a", "b"], -5, 9), ["a", "b"]); // from 越界 = 唔動（唔可以亂搬）
  assert.deepEqual(moveWithin(["a", "b"], 5, 0), ["a", "b"]); // from 越界 = 唔動
  assert.deepEqual(moveWithin(["a", "b"], 0, 99), ["b", "a"]); // to 越界 = 夾到最尾
  assert.equal(moveWithin(["a", "b"], 0, 99).length, 2); // 長度永遠不變
});

test("moveWithin：唔可以改動原陣列", () => {
  const list = ["a", "b", "c"];
  moveWithin(list, 0, 2);
  assert.deepEqual(list, ["a", "b", "c"]);
});

test("orderKeys：去重、剔空、保留次序（儲存側同讀取側要一致）", () => {
  assert.deepEqual(orderKeys([s("B"), s("A"), s("B"), s("  ")], (x) => x.name), ["B", "A"]);
});

test("usageCount：主檔 key 唔喺用量表 ⇒ 0（唔可以顯示 NaN／undefined）", () => {
  assert.equal(usageCount({ a: 3 }, "b"), 0);
  assert.equal(usageCount(null, "a"), 0);
  assert.equal(usageCount(undefined, "a"), 0);
  assert.equal(usageCount({ a: 3 }, ""), 0);
});

test("usageCount：字串數字／小數／負數都收斂成非負整數", () => {
  assert.equal(usageCount({ a: 14 }, "a"), 14);
  assert.equal(usageCount({ a: "7" as unknown as number }, "a"), 7);
  assert.equal(usageCount({ a: 2.9 }, "a"), 2);
  assert.equal(usageCount({ a: -1 }, "a"), 0);
  assert.equal(usageCount({ a: Number.NaN }, "a"), 0);
});
