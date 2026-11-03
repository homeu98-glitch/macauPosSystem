/**
 * `order-merge.ts` 單元測試 —— 終態優先（2026-11-03）。
 *
 * 核心迴歸：**雲端一條遲到嘅「未完成」舊版本，唔可以蓋走本地「已結帳」**
 * （否則交班會靜靜少錢）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { isTerminalOrderStatus, mergeOrdersPreferTerminal } from "./order-merge.ts";

const at = (iso: string) => iso;

test("終態定義：settled / refunded / partially_refunded / cancelled；reopened 唔算", () => {
  for (const status of ["settled", "refunded", "partially_refunded", "cancelled"]) {
    assert.equal(isTerminalOrderStatus(status), true, `${status} 應該係終態`);
  }
  for (const status of ["draft", "sent_to_kitchen", "paid", "reopened", ""]) {
    assert.equal(isTerminalOrderStatus(status), false, `${status} 唔應該係終態`);
  }
});

test("🔴 迴歸：雲端『未完成』updatedAt 較新，都唔可以蓋走本地 settled", () => {
  const merged = mergeOrdersPreferTerminal(
    [{ id: "o1", status: "settled", updatedAt: at("2026-11-03T21:00:00+08:00") }],
    [{ id: "o1", status: "sent_to_kitchen", updatedAt: at("2026-11-03T21:05:00+08:00") }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.status, "settled", "已結帳唔可以被舊 queue event 蓋走");
});

test("反向：雲端已完成、本地仲係 open → 採雲端（即使雲端 updatedAt 較舊）", () => {
  const merged = mergeOrdersPreferTerminal(
    [{ id: "o1", status: "paid", updatedAt: at("2026-11-03T21:00:00+08:00") }],
    [{ id: "o1", status: "settled", updatedAt: at("2026-11-03T20:00:00+08:00") }],
  );
  assert.equal(merged[0]?.status, "settled");
});

test("同級：updatedAt 較新者贏（本地 vs 雲端都係未完成）", () => {
  const merged = mergeOrdersPreferTerminal(
    [{ id: "o1", status: "sent_to_kitchen", updatedAt: at("2026-11-03T20:00:00+08:00") }],
    [{ id: "o1", status: "paid", updatedAt: at("2026-11-03T21:00:00+08:00") }],
  );
  assert.equal(merged[0]?.status, "paid");
});

test("同級但時間相同 → incoming 贏（雲端同刻以雲端為準，維持舊行為）", () => {
  const merged = mergeOrdersPreferTerminal(
    [{ id: "o1", status: "sent_to_kitchen", updatedAt: at("2026-11-03T20:00:00+08:00") }],
    [{ id: "o1", status: "paid", updatedAt: at("2026-11-03T20:00:00+08:00") }],
  );
  assert.equal(merged[0]?.status, "paid");
});

test("新 id 直接加入；舊 id 冇 incoming 就保留", () => {
  const merged = mergeOrdersPreferTerminal(
    [
      { id: "keep", status: "paid", updatedAt: at("2026-11-03T20:00:00+08:00") },
      { id: "dup", status: "settled", updatedAt: at("2026-11-03T20:00:00+08:00") },
    ],
    [{ id: "new", status: "sent_to_kitchen", updatedAt: at("2026-11-03T21:00:00+08:00") }],
  );
  assert.deepEqual(merged.map((o) => o.id).sort(), ["dup", "keep", "new"]);
});

test("冇 updatedAt 嘅髒資料：同級時 incoming 贏，但終態規則優先", () => {
  const merged = mergeOrdersPreferTerminal(
    [{ id: "o1", status: "settled" }],
    [{ id: "o1", status: "paid" }],
  );
  assert.equal(merged[0]?.status, "settled");
});

test("唔會 mutate 輸入陣列／物件", () => {
  const base = [{ id: "o1", status: "settled", updatedAt: "2026-11-03T20:00:00+08:00" }];
  const incoming = [{ id: "o1", status: "paid", updatedAt: "2026-11-03T21:00:00+08:00" }];
  mergeOrdersPreferTerminal(base, incoming);
  assert.equal(base[0]?.status, "settled");
  assert.equal(incoming[0]?.status, "paid");
});
