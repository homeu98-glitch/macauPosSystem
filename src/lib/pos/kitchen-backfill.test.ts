import assert from "node:assert/strict";
import { test } from "node:test";

// ⚠️ 一定要用**相對路徑 + .ts 副檔名**：`node --test` 用 Node 內建 type-stripping，
// 唔識 tsconfig 嘅 `@/` path alias（會 ERR_MODULE_NOT_FOUND）。
import {
  backfillTimestampMs,
  decideKitchenBackfill,
  KITCHEN_BACKFILL_MAX_AGE_MS,
  normalizeBackfillStatus,
} from "./kitchen-backfill.ts";

/**
 * 線上單廚房單補印窗口（2026-09-14 J 實案：取餐碼 005 接單後零 job）。
 *
 * 鎖死嘅口徑：
 *   - `accepted`／`preparing`／`ready` → 一律補（客人仲等緊）；
 *   - `completed` → **只補最近 1 小時**（治「POS 冇開 / 由另一方接單」嘅缺口，
 *     同時防止一開頁就補印舊單洗版）；
 *   - 已出過紙（含已被打印中心清除嘅）→ 唔補；
 *   - 同一 session 試過 / 正在跑 → 唔補。
 */

const NOW = Date.parse("2026-09-14T20:00:00.000Z");

function decide(overrides: Partial<Parameters<typeof decideKitchenBackfill>[0]> = {}) {
  return decideKitchenBackfill({
    status: "accepted",
    updatedAt: new Date(NOW).toISOString(),
    nowMs: NOW,
    hasJob: false,
    ...overrides,
  });
}

test("accepted / preparing / ready 一律補印（唔受時間窗限制）", () => {
  for (const status of ["accepted", "preparing", "ready"]) {
    assert.equal(decide({ status, updatedAt: "2026-09-13T00:00:00.000Z" }), "print", status);
  }
});

test("✓ 核心缺口：由另一方接單 → 本機只見到 ready/completed 都要補印", () => {
  // POS 冇開 / 由 Sunmi 或 Ledger 側接單：本機第一次見到張單就已經係 ready。
  assert.equal(decide({ status: "ready" }), "print");
  // 更加極端：直接跳到 completed（5 分鐘前完結）都要補。
  assert.equal(
    decide({ status: "completed", updatedAt: new Date(NOW - 5 * 60_000).toISOString() }),
    "print",
  );
});

test("completed 超過 1 小時 → stale（唔補，避免一開頁補印舊單洗版）", () => {
  assert.equal(
    decide({ status: "completed", updatedAt: new Date(NOW - KITCHEN_BACKFILL_MAX_AGE_MS - 1000).toISOString() }),
    "stale",
  );
  // 剛好一小時 → 仍然補（邊界包含）。
  assert.equal(
    decide({ status: "completed", updatedAt: new Date(NOW - KITCHEN_BACKFILL_MAX_AGE_MS).toISOString() }),
    "print",
  );
  // 昨日嘅單 → 一定唔補。
  assert.equal(decide({ status: "completed", updatedAt: "2026-09-13T12:00:00.000Z" }), "stale");
});

test("completed 冇可用時間戳 → 當歷史單（寧少唔多）", () => {
  assert.equal(decide({ status: "completed", updatedAt: null, createdAt: null }), "stale");
  assert.equal(decide({ status: "completed", updatedAt: "not-a-date", createdAt: "" }), "stale");
});

test("completed 缺 updatedAt 時用 createdAt 頂上", () => {
  assert.equal(
    decide({
      status: "completed",
      updatedAt: null,
      createdAt: new Date(NOW - 10 * 60_000).toISOString(),
    }),
    "print",
  );
});

test("pending / cancelled / delivering 唔補（未接單或已作廢）", () => {
  assert.equal(decide({ status: "pending" }), "inactive-status");
  assert.equal(decide({ status: "cancelled" }), "inactive-status");
  assert.equal(decide({ status: "delivering" }), "inactive-status");
  assert.equal(decide({ status: "" }), "inactive-status");
});

test("大小寫 / 空白不拘（Ledger 回 'Completed' 都要認）", () => {
  assert.equal(normalizeBackfillStatus(" Completed "), "completed");
  assert.equal(
    decide({ status: "COMPLETED", updatedAt: new Date(NOW - 60_000).toISOString() }),
    "print",
  );
});

test("已出過紙（本機 job / 帳本）→ 唔補；優先於狀態判定", () => {
  assert.equal(decide({ hasJob: true }), "has-job");
  assert.equal(decide({ status: "completed", hasJob: true }), "has-job");
  assert.equal(decide({ status: "pending", hasJob: true }), "has-job");
});

test("同一 session 已試過 / 正在跑 → in-flight（最先判定，連 hasJob 都唔使查）", () => {
  assert.equal(decide({ inFlight: true }), "in-flight");
  assert.equal(decide({ inFlight: true, hasJob: true, status: "completed" }), "in-flight");
});

test("自訂 maxAgeMs 生效（方便日後調窗口）", () => {
  const tenMinAgo = new Date(NOW - 10 * 60_000).toISOString();
  assert.equal(decide({ status: "completed", updatedAt: tenMinAgo, maxAgeMs: 5 * 60_000 }), "stale");
  assert.equal(decide({ status: "completed", updatedAt: tenMinAgo, maxAgeMs: 30 * 60_000 }), "print");
});

test("backfillTimestampMs：跳過空值／非法值，取第一個合法時間", () => {
  assert.equal(backfillTimestampMs(null, "", "bad", "2026-09-14T12:00:00.000Z"), Date.parse("2026-09-14T12:00:00.000Z"));
  assert.equal(backfillTimestampMs(null, undefined, "bad"), null);
});
