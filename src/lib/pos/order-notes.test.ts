import assert from "node:assert/strict";
import { test } from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
import { buildOnlineOrderDetailNotes, buildOrderDetailNotes } from "./order-notes.ts";
import type { OrderItem, PosOrder } from "../types.ts";

/**
 * 折扣備註推導（2026-09-11 需求 #2）。
 *
 * 呢個模組係報表明細 / 交班明細 / 訂單紀錄三處嘅**唯一**推導入口，
 * 所以最緊要守住三件事：
 *   ① 有折扣但冇原因 → 唔可以當「有原因」（唔會無中生有造一段文字出嚟）；
 *   ② 免單同折扣**唔會同時**出現（免單係全額減免，原因由 compNote 承載）；
 *   ③ 同一段文字唔會出兩個 chip（單品同全單揀咗同一個原因嘅時候）。
 */

function item(over: Partial<OrderItem> = {}): OrderItem {
  return { menuItemId: "m1", name: "菜", quantity: 1, price: 65, printerGroup: "kitchen", ...over } as OrderItem;
}

function order(over: Partial<PosOrder> = {}): PosOrder {
  return {
    id: "o1",
    storeId: "s1",
    tableId: "A3",
    tableName: "A3",
    status: "settled",
    items: [],
    discountAmount: 0,
    total: 0,
    updatedAt: "2026-09-11T04:00:00.000Z",
    ...over,
  } as PosOrder;
}

test("全單折扣有原因 → 出一個 discount chip", () => {
  assert.deepEqual(buildOrderDetailNotes(order({ discountAmount: 28.8, discountNote: "員工優惠" })), [
    { kind: "discount", text: "員工優惠" },
  ]);
});

test("冇任何調整 → 空陣列（唔可以無中生有）", () => {
  assert.deepEqual(buildOrderDetailNotes(order({ total: 88 })), []);
});

test("有折扣金額但冇原因（舊單 / 功能上線前）→ 唔會造假文字", () => {
  assert.deepEqual(buildOrderDetailNotes(order({ discountAmount: 20, total: 80 })), []);
});

test("免單：原因由 compNote 承載，唔會讀 discountNote", () => {
  assert.deepEqual(
    buildOrderDetailNotes(
      order({ paymentMethod: "免單", discountAmount: 96, total: 0, compNote: "客人投訴補償", discountNote: "員工優惠" }),
    ),
    [{ kind: "comp", text: "客人投訴補償" }],
  );
});

test("單品折扣原因逐件讀，同一原因多件只出一次", () => {
  const notes = buildOrderDetailNotes(
    order({
      items: [
        item({ menuItemId: "m1", discountRate: 85, discountNote: "員工優惠" }),
        item({ menuItemId: "m2", discountRate: 85, discountNote: "員工優惠" }),
        item({ menuItemId: "m3", discountRate: 90, discountNote: "熟客優惠" }),
      ],
    }),
  );
  assert.deepEqual(notes, [
    { kind: "discount", text: "員工優惠" },
    { kind: "discount", text: "熟客優惠" },
  ]);
});

test("全單同單品揀咗同一原因 → 只出一個 chip（去重）", () => {
  const notes = buildOrderDetailNotes(
    order({
      discountAmount: 28.8,
      discountNote: "員工優惠",
      items: [item({ discountRate: 85, discountNote: "員工優惠" })],
    }),
  );
  assert.deepEqual(notes, [{ kind: "discount", text: "員工優惠" }]);
});

test("冇折扣率嘅菜（discountRate undefined 或 >= 100）唔算折扣", () => {
  const notes = buildOrderDetailNotes(
    order({
      items: [
        item({ menuItemId: "m1", discountNote: "員工優惠" }),
        item({ menuItemId: "m2", discountRate: 100, discountNote: "員工優惠" }),
      ],
    }),
  );
  assert.deepEqual(notes, []);
});

test("系統抹零：有金額先出，固定文案，排到最後", () => {
  const notes = buildOrderDetailNotes(
    order({ roundingAmount: 0.5, discountAmount: 28.8, discountNote: "員工優惠" }),
  );
  assert.deepEqual(notes, [
    { kind: "discount", text: "員工優惠" },
    { kind: "round", text: "系統抹零" },
  ]);
});

test("抹零金額為 0 / undefined → 唔出抹零 chip", () => {
  assert.deepEqual(buildOrderDetailNotes(order({ roundingAmount: 0 })), []);
});

test("原因頭尾空白會 trim，純空白當冇填", () => {
  assert.deepEqual(buildOrderDetailNotes(order({ discountAmount: 10, discountNote: "  員工優惠  " })), [
    { kind: "discount", text: "員工優惠" },
  ]);
  assert.deepEqual(buildOrderDetailNotes(order({ discountAmount: 10, discountNote: "   " })), []);
});

test("Ledger 線上單：有折扣金額 → 「線上優惠」；冇 → 空陣列", () => {
  assert.deepEqual(buildOnlineOrderDetailNotes(12.5), [{ kind: "discount", text: "線上優惠" }]);
  assert.deepEqual(buildOnlineOrderDetailNotes(0), []);
  assert.deepEqual(buildOnlineOrderDetailNotes(undefined), []);
});
