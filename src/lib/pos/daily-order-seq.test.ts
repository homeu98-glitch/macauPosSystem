import assert from "node:assert/strict";
import { test } from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
import { computeNextDailySeq, maxDailySeqFromOrders, padDailySeq } from "./daily-order-seq.ts";

/** 假嘅日期 key：直接用 ISO 日期部分當 Macau 日 —— 呢個測試只驗證「按日過濾」邏輯。 */
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

const T = (iso: string) => ({ createdAt: iso, updatedAt: iso });

test("回歸（2026-09-10 訂單03 重複）：本機計數器歸零時，由眼前訂單推導下限", () => {
  // 情境：iOS 清過 localStorage → 本機 localDailySeq = 0（甚至冇 entry）。
  // 眼前有兩張已派過號嘅單（訂單02 / 訂單03）。
  // 舊行為：Math.max(0, 0) + 1 = 1 → 派「訂單01」…但 01/02/03 其實已經用過。
  // 新行為：下限由訂單推導 = 3 → 派「訂單04」。
  const orders = [
    { localOrderNo: "訂單02", ...T("2026-09-10T01:51:07.710Z") },
    { localOrderNo: "訂單03", ...T("2026-09-10T02:00:00.000Z") },
  ];
  const used = maxDailySeqFromOrders(orders, "訂單", "2026-09-10", dayKey);
  assert.equal(used, 3);
  assert.equal(padDailySeq(computeNextDailySeq(0, used)), "04");
});

test("下限取「本機計數器」同「眼前最大號」較大者", () => {
  assert.equal(computeNextDailySeq(0, 3), 4); // 計數器歸零 → 靠訂單下限
  assert.equal(computeNextDailySeq(7, 3), 8); // 計數器跑前 → 靠計數器（已刪單唔會令號重複）
  assert.equal(computeNextDailySeq(3, 3), 4);
});

test("計數器 / 下限係垃圾值（NaN / 負數）都唔會派 0 號或負號", () => {
  assert.equal(computeNextDailySeq(Number.NaN, 0), 1);
  assert.equal(computeNextDailySeq(-5, -9), 1);
  assert.equal(computeNextDailySeq(2.7, 0), 3); // 小數向下取整
});

test("跨日唔會互相推高：尋日嘅 訂單12 唔影響今日下限", () => {
  const orders = [
    { localOrderNo: "訂單12", ...T("2026-09-09T03:00:00.000Z") }, // 尋日
    { localOrderNo: "訂單02", ...T("2026-09-10T01:00:00.000Z") }, // 今日
  ];
  assert.equal(maxDailySeqFromOrders(orders, "訂單", "2026-09-10", dayKey), 2);
});

test("冇時間戳嘅單保守計入（寧可跳號，唔可撞號）", () => {
  const orders = [{ localOrderNo: "訂單09" }];
  assert.equal(maxDailySeqFromOrders(orders, "訂單", "2026-09-10", dayKey), 9);
});

test("前綴唔可以互相污染：自取12 唔會推高 訂單 嘅下限", () => {
  const orders = [
    { localOrderNo: "自取12", ...T("2026-09-10T01:00:00.000Z") },
    { localOrderNo: "訂單03", ...T("2026-09-10T01:00:00.000Z") },
    { localOrderNo: "外賣07", ...T("2026-09-10T01:00:00.000Z") },
  ];
  assert.equal(maxDailySeqFromOrders(orders, "訂單", "2026-09-10", dayKey), 3);
  assert.equal(maxDailySeqFromOrders(orders, "自取", "2026-09-10", dayKey), 12);
});

test("前綴係子字串都要精確匹配（訂單 vs 訂單A）", () => {
  const orders = [
    { localOrderNo: "訂單A05", ...T("2026-09-10T01:00:00.000Z") },
    { localOrderNo: "訂單04", ...T("2026-09-10T01:00:00.000Z") },
  ];
  assert.equal(maxDailySeqFromOrders(orders, "訂單", "2026-09-10", dayKey), 4);
});

test("冇 localOrderNo / 空陣列 / 唔匹配格式 → 全部回 0", () => {
  assert.equal(maxDailySeqFromOrders([], "訂單", "2026-09-10", dayKey), 0);
  assert.equal(
    maxDailySeqFromOrders(
      [
        { localOrderNo: "", ...T("2026-09-10T01:00:00.000Z") },
        { localOrderNo: null, ...T("2026-09-10T01:00:00.000Z") },
        { localOrderNo: "A01", ...T("2026-09-10T01:00:00.000Z") }, // 台號，唔係單號
        { localOrderNo: "訂單", ...T("2026-09-10T01:00:00.000Z") }, // 冇數字
      ],
      "訂單",
      "2026-09-10",
      dayKey,
    ),
    0,
  );
});

test("超過 99 唔會截斷（訂單100 → 101）", () => {
  const orders = [{ localOrderNo: "訂單100", ...T("2026-09-10T01:00:00.000Z") }];
  const used = maxDailySeqFromOrders(orders, "訂單", "2026-09-10", dayKey);
  assert.equal(used, 100);
  assert.equal(padDailySeq(computeNextDailySeq(0, used)), "101");
});
