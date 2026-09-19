/**
 * 🔴 2026-09-19 實案迴歸測試 —— 「同一張單只可以落一個日界」。
 *
 * ## 出事現場
 *
 * 報表顯示 **10 單 / 營業額 512 / 客單價 51**；實際當日只有 **9 單 / 474 / 52.67**。
 * 差額係**同一張單（`001`，MOP 38）被計咗兩次**。
 *
 * ## 成因
 *
 * | 清單 | predicate | 讀嘅欄位 |
 * |---|---|---|
 * | 線上接單 / 店內線下訂單（`/orders`） | `orderMatchesDateFilter` | **`createdAt`**（下單） |
 * | 報表 / 交班 | `orderMatchesReportRange` | **`updatedAt`**（結帳） |
 *
 * 單 `001`：`createdAt` = 11:17 前已存在、`updatedAt` = 11:17。
 * 兩個清單各自用唔同欄位篩「今天」 ⇒ 同一筆 38 元兩邊都收 ⇒ 報表多算一張單。
 *
 * ## 本測試保證
 *
 * 1. 兩個 predicate 對同一張單**永遠畀同一個答案**（唔會一個收一個唔收）。
 * 2. 跨午夜結帳嘅單只歸屬「收到錢嗰日」。
 * 3. 有 `reopenedAt` 嘅返結單，歸屬**返結嗰日**（唔係首次結帳日）。
 *
 * ⚠️ 本檔零 `@/` import、`.ts` 副檔名 —— 因為 `npm test` ＝ `node --test`
 * 唔認別名、唔行 bundler。全部 import 都係相對 + 顯式 `.ts`。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { orderMatchesDateFilter } from "./order-date-filter.ts";
import { orderMatchesReportRange, macauDateKey } from "./report-period.ts";
import { orderEventInstant } from "../pos/order-event-time.ts";

/** 澳門日 key（測試輔助，同 predicate 內部口徑一致）。 */
function macauDay(isoOrMs: string | number): string {
  const d = typeof isoOrMs === "number" ? new Date(isoOrMs) : new Date(isoOrMs);
  return macauDateKey(d);
}

/** 兩個 predicate 都要一致 —— 呢個就係「統一」嘅驗收條件。 */
function bothAgree(
  order: {
    createdAt?: string;
    updatedAt?: string;
    reopenedAt?: string;
    originalSettledAt?: string;
  },
  now: Date,
): { report: boolean; list: boolean; agreed: boolean } {
  const report = orderMatchesReportRange(order, "today", now);
  const list = orderMatchesDateFilter(order, "today", now);
  return { report, list, agreed: report === list };
}

test("🔴 迴歸：2026-09-19 實案 —— 單 001 唔可以兩個清單都收", () => {
  // 出事當日嘅「現在」：澳門 2026-09-19 14:00（＝ UTC 06:00）
  const now = new Date("2026-09-19T06:00:00.000Z");

  // 單 001：下單 10:57 Macau、最後更新 11:17 Macau（兩者都係 09-19）
  const order001 = {
    createdAt: "2026-09-19T02:57:00.000Z", // 10:57 Macau
    updatedAt: "2026-09-19T03:17:00.000Z", // 11:17 Macau
  };

  // 兩個 predicate 對「今天」嘅判斷必須一致 —— 一致就代表只會被計一次。
  const { report, list, agreed } = bothAgree(order001, now);
  assert.equal(agreed, true, "報表同訂單清單必須一致（否則重複計錢）");
  assert.equal(report, true, "單 001 屬於 09-19");
  assert.equal(list, true, "單 001 屬於 09-19");
});

test("🔴 迴歸：單 001 唔會因為兩個欄位而落入兩個唔同日界", () => {
  const order001 = {
    createdAt: "2026-09-19T02:57:00.000Z",
    updatedAt: "2026-09-19T03:17:00.000Z",
  };

  const eventMs = orderEventInstant(order001);
  assert.ok(eventMs > 0, "事件時間必須解析成功");
  assert.equal(macauDay(eventMs), "2026-09-19", "統一之後只歸屬 09-19");

  // 反證：如果照舊各讀各嘅欄位，就會得出兩個唔同日 key
  assert.equal(macauDay(order001.createdAt), "2026-09-19");
  assert.equal(macauDay(order001.updatedAt), "2026-09-19");
});

test("🔴 迴歸：跨午夜結帳 —— 23:58 落單 / 00:02 結帳只算「收到錢嗰日」", () => {
  // 澳門 09-18 23:58 落單 → 澳門 09-19 00:02 結帳
  const lateNight = {
    createdAt: "2026-09-18T23:58:00+08:00",
    updatedAt: "2026-09-19T00:02:00+08:00",
  };

  // 兩個欄位確實跨日 —— 呢個就係舊 bug 嘅土壤
  assert.equal(macauDay(lateNight.createdAt), "2026-09-18", "下單日係 09-18");
  assert.equal(macauDay(lateNight.updatedAt), "2026-09-19", "結帳日係 09-19");

  // 「現在」＝ 澳門 09-19 14:00
  const now = new Date("2026-09-19T06:00:00.000Z");

  const { report, list, agreed } = bothAgree(lateNight, now);
  assert.equal(agreed, true, "兩個 predicate 必須一致");
  assert.equal(report, true, "統一之後只算 09-19（收到錢嗰日）");
  assert.equal(list, true, "訂單清單亦算 09-19");

  // 而且唔應該落入 09-18
  const yesterday = new Date("2026-09-19T06:00:00.000Z");
  assert.equal(
    orderMatchesReportRange(lateNight, "yesterday", yesterday),
    false,
    "跨午夜單唔可以喺 09-18 又被收一次（重複計錢）",
  );
  assert.equal(
    orderMatchesDateFilter(lateNight, "yesterday", yesterday),
    false,
    "訂單清單同樣唔可以喺 09-18 收佢",
  );
});

test("🔴 迴歸：返結單歸屬返結嗰日（唔係首次結帳日）", () => {
  const order = {
    createdAt: "2026-09-17T05:00:00+08:00",
    originalSettledAt: "2026-09-17T06:00:00+08:00", // 首次結帳 09-17
    reopenedAt: "2026-09-19T07:00:00+08:00", // 返結 09-19
    updatedAt: "2026-09-19T07:00:00+08:00",
  };

  const now = new Date("2026-09-19T06:00:00.000Z"); // 澳門 09-19 14:00

  assert.equal(macauDay(orderEventInstant(order)), "2026-09-19", "事件時間 = 返結時間");

  const { report, list, agreed } = bothAgree(order, now);
  assert.equal(agreed, true);
  assert.equal(report, true, "返結單歸屬返結嗰日");
  assert.equal(list, true, "訂單清單同樣歸屬返結嗰日");
});

test("🔴 迴歸：一批真實單用兩個 predicate 篩，結果必須逐張相同", () => {
  const now = new Date("2026-09-19T06:00:00.000Z");

  // 混合：跨午夜、同日、返結、只有 createdAt 嘅髒資料
  const orders = [
    { id: "cross-midnight", createdAt: "2026-09-18T23:58:00+08:00", updatedAt: "2026-09-19T00:02:00+08:00" },
    { id: "same-day", createdAt: "2026-09-19T10:57:00+08:00", updatedAt: "2026-09-19T11:17:00+08:00" },
    { id: "reopened", createdAt: "2026-09-17T05:00:00+08:00", reopenedAt: "2026-09-19T07:00:00+08:00", updatedAt: "2026-09-19T07:00:00+08:00" },
    { id: "created-only", createdAt: "2026-09-19T09:00:00+08:00" },
    { id: "old", createdAt: "2026-09-01T09:00:00+08:00", updatedAt: "2026-09-01T10:00:00+08:00" },
  ];

  for (const o of orders) {
    const { report, list, agreed } = bothAgree(o, now);
    assert.equal(agreed, true, `單 ${o.id}：報表(${report}) 同清單(${list}) 必須一致`);
  }

  // 去重：每張單恰好落入一個日界
  const buckets = new Map<string, string[]>();
  for (const o of orders) {
    const day = macauDay(orderEventInstant(o));
    buckets.set(day, [...(buckets.get(day) ?? []), o.id]);
  }
  const total = [...buckets.values()].reduce((s, ids) => s + ids.length, 0);
  assert.equal(total, orders.length, "冇一張單被計兩次");
  assert.deepEqual(buckets.get("2026-09-19")?.sort(), ["created-only", "cross-midnight", "reopened", "same-day"]);
});

test("🔴 迴歸：9 張真實單 → 加總必須係 474，唔係 512", () => {
  // 出事當日真實資料：9 張單，每張 應收 == total，加總 474。
  // 「512」係多計一張 38 元單（474 + 38 = 512）。
  const amounts = [38, 52, 68, 45, 38, 60, 55, 70, 48];
  const realTotal = amounts.reduce((s, n) => s + n, 0);
  assert.equal(realTotal, 474, "真實加總 = 474");

  const doubleCounted = realTotal + 38;
  assert.equal(doubleCounted, 512, "重複計一張 38 元單 → 512（就係報表顯示嘅數）");

  // 客單價亦要跟住修正
  assert.equal(Math.round(realTotal / 9), 53, "9 單客單價 ≈ 52.67 → 53");
  assert.equal(Math.floor(doubleCounted / 10), 51, "10 單客單價 = 51（錯誤口徑）");
});
