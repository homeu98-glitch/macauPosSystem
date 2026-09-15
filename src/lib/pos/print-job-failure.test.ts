/**
 * P4 打印失敗原因分類回歸測試（2026-09-15）。
 *
 * 純函式、零依賴 → 本機可以直接跑：
 *   node --test src/lib/pos/print-job-failure.test.ts
 * （環境冇 npm / vitest，所以用 Node 內建 test runner + `node:` import。）
 */
import assert from "node:assert/strict";
import test from "node:test";

import { classifyPrintJobFailure } from "./print-job-failure.ts";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const minsAgo = (m: number) => new Date(NOW - m * 60 * 1000).toISOString();
const secsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();

test("printed 一律唔算失敗", () => {
  assert.equal(classifyPrintJobFailure({ status: "printed", nowMs: NOW }), null);
});

test("pending 未夠 6 分鐘 → 唔告警（等印中）", () => {
  assert.equal(
    classifyPrintJobFailure({ status: "pending", createdAt: minsAgo(3), nowMs: NOW }),
    null,
  );
});

test("pending 超過 6 分鐘 → TIMEOUT_CLAIM（中繼機離線）", () => {
  assert.equal(
    classifyPrintJobFailure({ status: "pending", createdAt: minsAgo(7), nowMs: NOW }),
    "TIMEOUT_CLAIM",
  );
});

test("printing 90 秒內 → 唔告警（正常印緊）", () => {
  assert.equal(
    classifyPrintJobFailure({ status: "printing", claimedAt: secsAgo(30), nowMs: NOW }),
    null,
  );
});

test("printing 超過 90 秒 → TIMEOUT_STALE（中繼機中斷）", () => {
  assert.equal(
    classifyPrintJobFailure({ status: "printing", claimedAt: secsAgo(120), nowMs: NOW }),
    "TIMEOUT_STALE",
  );
});

test("有 error 原文 → AGENT_FAILED（打印機問題）", () => {
  assert.equal(
    classifyPrintJobFailure({
      status: "failed",
      attempts: 2,
      lastError: "AGENT_FAILED: printer offline",
      nowMs: NOW,
    }),
    "AGENT_FAILED",
  );
});

test("attempts 用完 → ATTEMPTS_EXHAUSTED（優先於 AGENT_FAILED）", () => {
  assert.equal(
    classifyPrintJobFailure({
      status: "failed",
      attempts: 5,
      lastError: "AGENT_FAILED: printer offline",
      nowMs: NOW,
    }),
    "ATTEMPTS_EXHAUSTED",
  );
});

test("VOID_STALE 前綴 → 作廢（最高優先）", () => {
  assert.equal(
    classifyPrintJobFailure({
      status: "failed",
      attempts: 5,
      lastError: "VOID_STALE: 已逾營業日",
      nowMs: NOW,
    }),
    "VOID_STALE",
  );
});

test("🔴 當日事故重演：58 張 pending 6 小時 → 全部 TIMEOUT_CLAIM", () => {
  const reason = classifyPrintJobFailure({
    status: "pending",
    createdAt: minsAgo(60 * 6),
    nowMs: NOW,
  });
  assert.equal(reason, "TIMEOUT_CLAIM");
});

test("printing 但冇 claimed_at → TIMEOUT_STALE（資料異常當作 stale）", () => {
  assert.equal(
    classifyPrintJobFailure({ status: "printing", claimedAt: null, nowMs: NOW }),
    "TIMEOUT_STALE",
  );
});
