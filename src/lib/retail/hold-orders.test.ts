// 零售掛單 / 取單測試（docs/124 §3.1 I-3）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";

import assert from "node:assert/strict";

import {
  createHoldOrder,
  describeHold,
  MAX_HOLD_ORDERS,
  nextHoldSeq,
  pruneStaleHolds,
  removeHoldOrder,
  renameHoldOrder,
  sortHolds,
  takeHoldOrder,
  type RetailHoldOrder,
} from "./hold-orders.ts";
import type { RetailCartLine } from "./retail-cart.ts";

function line(over: Partial<RetailCartLine> = {}): RetailCartLine {
  return {
    lineId: "l1",
    productId: "p1",
    name: "維他檸檬茶",
    unitPrice: 9.5,
    quantity: 2,
    unit: "件",
    ...over,
  };
}

const AT = new Date("2026-09-13T10:00:00.000Z");

// ─────────────────────────────────────────────────────────────
// createHoldOrder
// ─────────────────────────────────────────────────────────────

test("createHoldOrder：正常掛單 → 計出應收同件數", () => {
  const r = createHoldOrder([], { lines: [line()], now: AT, makeId: () => "h1" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.hold.total, 19);
  assert.equal(r.hold.itemCount, 2);
  assert.equal(r.hold.label, "掛-01");
  assert.equal(r.holds.length, 1);
});

test("createHoldOrder：空購物車 → 拒絕（唔可以掛 $0 空單）", () => {
  const r = createHoldOrder([], { lines: [], now: AT });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /空/);
  assert.equal(r.holds.length, 0);
});

test("createHoldOrder：數量 0 嘅行唔算（唔可以留低幽靈行）", () => {
  const r = createHoldOrder([], { lines: [line({ quantity: 0 })], now: AT });
  assert.equal(r.ok, false);
});

test("createHoldOrder：稱重行算 1 件（唔可以用 kg 當件數）", () => {
  const r = createHoldOrder([], {
    lines: [line({ isWeighed: true, weightKg: 1.5, unit: "kg", unitPrice: 28 })],
    now: AT,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.hold.itemCount, 1);
  assert.equal(r.hold.total, 42); // 1.5 × 28
});

test("createHoldOrder：深拷貝購物車行（之後改購物車唔會改到掛單）", () => {
  const cart = [line()];
  const r = createHoldOrder([], { lines: cart, now: AT });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  cart[0].quantity = 99;
  assert.equal(r.hold.lines[0].quantity, 2);
});

test("createHoldOrder：保留整單折扣並反映落 total", () => {
  const r = createHoldOrder([], {
    lines: [line()],
    orderDiscount: { rate: 80 },
    now: AT,
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.hold.total, 15.2); // 19 × 0.8
  assert.deepEqual(r.hold.orderDiscount, { rate: 80 });
});

test("createHoldOrder：到上限 → 明確拒絕（唔可以靜默丟最舊）", () => {
  const holds: RetailHoldOrder[] = Array.from({ length: MAX_HOLD_ORDERS }, (_, i) => ({
    id: `h${i}`,
    label: `掛-${String(i + 1).padStart(2, "0")}`,
    lines: [line()],
    total: 19,
    itemCount: 2,
    createdAt: AT.toISOString(),
  }));
  const r = createHoldOrder(holds, { lines: [line()], now: AT });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.reason, /上限/);
  assert.equal(r.holds.length, MAX_HOLD_ORDERS); // 冇被改動
});

test("createHoldOrder：備註只有空白 → 當冇備註", () => {
  const r = createHoldOrder([], { lines: [line()], note: "   ", now: AT });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.hold.note, undefined);
});

// ─────────────────────────────────────────────────────────────
// nextHoldSeq
// ─────────────────────────────────────────────────────────────

test("nextHoldSeq：空 → 1", () => {
  assert.equal(nextHoldSeq([]), 1);
});

test("nextHoldSeq：刪咗中間一張唔會重複派號", () => {
  const holds: RetailHoldOrder[] = [
    { id: "a", label: "掛-01", lines: [], total: 0, itemCount: 0, createdAt: AT.toISOString() },
    { id: "c", label: "掛-03", lines: [], total: 0, itemCount: 0, createdAt: AT.toISOString() },
  ];
  // 有 2 張但序號最大係 3 → 應該派 04，唔係 03
  assert.equal(nextHoldSeq(holds), 4);
});

test("nextHoldSeq：label 格式唔符（人手改過）→ 唔會當成 0 而撞號", () => {
  const holds: RetailHoldOrder[] = [
    { id: "a", label: "掛-07", lines: [], total: 0, itemCount: 0, createdAt: AT.toISOString() },
    { id: "b", label: "臨時單", lines: [], total: 0, itemCount: 0, createdAt: AT.toISOString() },
  ];
  assert.equal(nextHoldSeq(holds), 8);
});

// ─────────────────────────────────────────────────────────────
// take / remove / rename
// ─────────────────────────────────────────────────────────────

test("takeHoldOrder：取單 → 回傳該單並由列表移除", () => {
  const r = createHoldOrder([], { lines: [line()], now: AT, makeId: () => "h1" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const t = takeHoldOrder(r.holds, "h1");
  assert.ok(t.hold);
  assert.equal(t.hold.lines.length, 1);
  assert.equal(t.holds.length, 0);
});

test("takeHoldOrder：對唔中 id → 唔會 throw，列表原樣", () => {
  const r = createHoldOrder([], { lines: [line()], now: AT, makeId: () => "h1" });
  if (!r.ok) return;
  const t = takeHoldOrder(r.holds, "nope");
  assert.equal(t.hold, null);
  assert.equal(t.holds.length, 1);
});

test("removeHoldOrder：刪除指定掛單", () => {
  const r = createHoldOrder([], { lines: [line()], now: AT, makeId: () => "h1" });
  if (!r.ok) return;
  assert.equal(removeHoldOrder(r.holds, "h1").length, 0);
});

test("renameHoldOrder：改備註；空字串清走備註", () => {
  const r = createHoldOrder([], { lines: [line()], now: AT, makeId: () => "h1" });
  if (!r.ok) return;
  const named = renameHoldOrder(r.holds, "h1", "陳小姐");
  assert.equal(named[0].note, "陳小姐");
  const cleared = renameHoldOrder(named, "h1", "  ");
  assert.equal(cleared[0].note, undefined);
});

// ─────────────────────────────────────────────────────────────
// sortHolds
// ─────────────────────────────────────────────────────────────

test("sortHolds：最新掛嘅排最前", () => {
  const older: RetailHoldOrder = {
    id: "a", label: "掛-01", lines: [], total: 0, itemCount: 0,
    createdAt: "2026-09-13T09:00:00.000Z",
  };
  const newer: RetailHoldOrder = {
    id: "b", label: "掛-02", lines: [], total: 0, itemCount: 0,
    createdAt: "2026-09-13T10:00:00.000Z",
  };
  const sorted = sortHolds([older, newer]);
  assert.equal(sorted[0].id, "b");
});

test("sortHolds：同一時間 → 按 label 降序（穩定，唔會亂跳）", () => {
  const a: RetailHoldOrder = { id: "a", label: "掛-01", lines: [], total: 0, itemCount: 0, createdAt: AT.toISOString() };
  const b: RetailHoldOrder = { id: "b", label: "掛-02", lines: [], total: 0, itemCount: 0, createdAt: AT.toISOString() };
  const sorted = sortHolds([a, b]);
  assert.equal(sorted[0].label, "掛-02");
});

test("sortHolds：唔會改動原陣列", () => {
  const list: RetailHoldOrder[] = [
    { id: "a", label: "掛-01", lines: [], total: 0, itemCount: 0, createdAt: "2026-09-13T09:00:00.000Z" },
    { id: "b", label: "掛-02", lines: [], total: 0, itemCount: 0, createdAt: "2026-09-13T10:00:00.000Z" },
  ];
  sortHolds(list);
  assert.equal(list[0].id, "a");
});

// ─────────────────────────────────────────────────────────────
// describeHold
// ─────────────────────────────────────────────────────────────

test("describeHold：件數 + 金額", () => {
  const h: RetailHoldOrder = {
    id: "a", label: "掛-01", lines: [], total: 449, itemCount: 8,
    createdAt: AT.toISOString(),
  };
  assert.equal(describeHold(h), "8 件 · $449.00");
});

// ─────────────────────────────────────────────────────────────
// pruneStaleHolds
// ─────────────────────────────────────────────────────────────

test("pruneStaleHolds：超過 24 小時嘅掛單清走", () => {
  const old: RetailHoldOrder = {
    id: "a", label: "掛-01", lines: [], total: 0, itemCount: 0,
    createdAt: "2026-09-11T10:00:00.000Z",
  };
  const fresh: RetailHoldOrder = {
    id: "b", label: "掛-02", lines: [], total: 0, itemCount: 0,
    createdAt: "2026-09-13T09:00:00.000Z",
  };
  const r = pruneStaleHolds([old, fresh], { now: AT });
  assert.equal(r.holds.length, 1);
  assert.equal(r.holds[0].id, "b");
  assert.deepEqual(r.removed, ["掛-01"]);
});

test("pruneStaleHolds：自訂有效期", () => {
  const h: RetailHoldOrder = {
    id: "a", label: "掛-01", lines: [], total: 0, itemCount: 0,
    createdAt: "2026-09-13T08:00:00.000Z",
  };
  // 只保留 1 小時 → 2 小時前嘅要清
  assert.equal(pruneStaleHolds([h], { now: AT, maxAgeHours: 1 }).holds.length, 0);
  assert.equal(pruneStaleHolds([h], { now: AT, maxAgeHours: 5 }).holds.length, 1);
});

test("pruneStaleHolds：時間戳壞掉 → 當過期清走（唔可以永遠留住）", () => {
  const bad: RetailHoldOrder = {
    id: "a", label: "掛-01", lines: [], total: 0, itemCount: 0, createdAt: "唔係日期",
  };
  assert.equal(pruneStaleHolds([bad], { now: AT }).holds.length, 0);
});

test("pruneStaleHolds：空陣列唔會 throw", () => {
  assert.deepEqual(pruneStaleHolds([], { now: AT }), { holds: [], removed: [] });
});
