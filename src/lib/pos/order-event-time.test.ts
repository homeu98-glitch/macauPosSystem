import assert from "node:assert/strict";
import test from "node:test";

import { orderEventInstant, orderEventISO } from "./order-event-time.ts";

const T = {
  reopenedAt: "2026-09-19T03:00:00.000Z",
  originalSettledAt: "2026-09-19T02:00:00.000Z",
  updatedAt: "2026-09-19T01:00:00.000Z",
  createdAt: "2026-09-19T00:00:00.000Z",
};

test("orderEventInstant：優先序 reopenedAt → originalSettledAt → updatedAt → createdAt", () => {
  assert.equal(orderEventInstant(T), Date.parse(T.reopenedAt), "四個都有 → 用 reopenedAt");
  assert.equal(
    orderEventInstant({ ...T, reopenedAt: null }),
    Date.parse(T.originalSettledAt),
    "冇返結 → 用 originalSettledAt",
  );
  assert.equal(
    orderEventInstant({ ...T, reopenedAt: null, originalSettledAt: undefined }),
    Date.parse(T.updatedAt),
    "冇結帳紀錄 → 用 updatedAt",
  );
  assert.equal(
    orderEventInstant({ createdAt: T.createdAt }),
    Date.parse(T.createdAt),
    "只有 createdAt → 兜底用佢",
  );
});

test("orderEventInstant：`originalSettledAt` 缺席時唔可以令 `updatedAt` 被跳過", () => {
  assert.equal(
    orderEventInstant({ updatedAt: T.updatedAt, createdAt: T.createdAt }),
    Date.parse(T.updatedAt),
  );
});

test("orderEventInstant：空／非法／缺欄一律 0（唔會拋）", () => {
  assert.equal(orderEventInstant(null), 0);
  assert.equal(orderEventInstant(undefined), 0);
  assert.equal(orderEventInstant({}), 0);
  assert.equal(orderEventInstant({ updatedAt: "" }), 0);
  assert.equal(orderEventInstant({ updatedAt: "   " }), 0);
  assert.equal(orderEventInstant({ updatedAt: "not-a-date" }), 0);
  assert.equal(orderEventInstant({ reopenedAt: "bad", updatedAt: T.updatedAt }), Date.parse(T.updatedAt));
  assert.equal(orderEventInstant({ updatedAt: "0" }), 0, "epoch 0 當「唔知」");
});

test("orderEventInstant：只認字串，唔會將非字串欄位當有效", () => {
  // @ts-expect-error 刻意傳錯型別，確認 runtime 唔會炸
  assert.equal(orderEventInstant({ updatedAt: 12345 }), 0);
  // @ts-expect-error 同上
  assert.equal(orderEventInstant({ updatedAt: {} }), 0, "物件唔可以被當成時間字串");
  assert.equal(orderEventInstant({ updatedAt: null }), 0, "null 唔算有效時間");
});

test("orderEventISO：回傳原本字串（唔重新格式化）", () => {
  assert.equal(orderEventISO(T), T.reopenedAt);
  assert.equal(orderEventISO({ updatedAt: T.updatedAt }), T.updatedAt);
  assert.equal(orderEventISO(null), "");
  assert.equal(orderEventISO({}), "");
  assert.equal(orderEventISO({ updatedAt: "0" }), "", "「0」唔算有效時間");
});

test("orderEventISO：同 orderEventInstant 揀同一個欄位", () => {
  const order = { reopenedAt: T.reopenedAt, updatedAt: T.updatedAt };
  assert.equal(Date.parse(orderEventISO(order)), orderEventInstant(order));
});

/**
 * 🔴 2026-09-19 實案迴歸測試 —— 呢個係本檔案存在嘅理由。
 *
 * 單 `001`：`createdAt` 10:57 Macau、`updatedAt` 11:17 Macau。
 * 用 `createdAt` 同用 `updatedAt` 會得出**唔同嘅「今天」歸屬**（跨午夜時），
 * 舊寫法令同一筆錢兩個清單都收 ⇒ 報表多算一張 38 元單。
 */
test("迴歸：跨午夜結帳嘅單只歸屬一個範圍（唔會兩邊都收）", () => {
  // 澳門 2026-09-18 23:58 落單 → 澳門 2026-09-19 00:02 結帳
  const lateNight = {
    createdAt: "2026-09-18T23:58:00+08:00",
    updatedAt: "2026-09-19T00:02:00+08:00",
  };

  const c = new Date(lateNight.createdAt);
  const u = new Date(lateNight.updatedAt);

  const macau = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(d);

  assert.equal(macau(c), "2026-09-18", "下單日係 09-18");
  assert.equal(macau(u), "2026-09-19", "結帳日係 09-19");
  assert.notEqual(macau(c), macau(u), "兩個欄位確實會跨日 —— 呢個就係舊 bug 嘅土壤");

  const event = new Date(orderEventInstant(lateNight));
  assert.equal(macau(event), "2026-09-19", "統一之後：只算 09-19（收到錢嗰日）");
});

test("迴歸：同一批單用 orderEventInstant 篩選，每張只會落一個日界", () => {
  const orders = [
    { id: "a", createdAt: "2026-09-18T23:58:00+08:00", updatedAt: "2026-09-19T00:02:00+08:00" },
    { id: "b", createdAt: "2026-09-19T10:57:00+08:00", updatedAt: "2026-09-19T11:17:00+08:00" },
    { id: "c", createdAt: "2026-09-19T11:00:00+08:00", updatedAt: "2026-09-19T23:50:00+08:00" },
  ];
  const macau = (ts: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(new Date(ts));

  const buckets = new Map<string, string[]>();
  for (const o of orders) {
    const day = macau(orderEventInstant(o));
    buckets.set(day, [...(buckets.get(day) ?? []), o.id]);
  }

  assert.deepEqual(buckets.get("2026-09-18"), undefined, "冇單應該落入 09-18");
  assert.deepEqual(buckets.get("2026-09-19"), ["a", "b", "c"]);

  const total = [...buckets.values()].reduce((s, ids) => s + ids.length, 0);
  assert.equal(total, orders.length, "去重後總數 = 訂單數（冇一張被計兩次）");
});
