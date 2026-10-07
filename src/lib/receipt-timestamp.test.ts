/**
 * 收據時間戳格式化測試。
 *
 * 🔴 呢個檔案**只可以** import 零依賴嘅純函式模組（`node --test` 唔認 `@/` alias）。
 * 🔴 重點保護：**澳門時區邊界** —— 呢個係歷史上反覆出錯嘅位
 *    （`getHours()` / `toISOString()` 喺 Vercel UTC 環境必然差 8 小時）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  slashDate,
  macauTimeOfDay,
  formatReceiptStamp,
  isBackdatedReceipt,
  receiptStampLabel,
} from "./receipt-timestamp.ts";

// ─────────────────────────────────────────────────────────────
// slashDate
// ─────────────────────────────────────────────────────────────
test("slashDate: YYYY-MM-DD → YYYY/MM/DD", () => {
  assert.equal(slashDate("2026-10-07"), "2026/10/07");
  assert.equal(slashDate("2026-01-01"), "2026/01/01");
});

test("slashDate: 帶時間嘅 ISO 只取日期段", () => {
  assert.equal(slashDate("2026-10-07T06:00:00Z"), "2026/10/07");
  assert.equal(slashDate("2026-10-07 06:00:00"), "2026/10/07");
});

test("slashDate: 已經係斜線格式 → 唔會被改壞", () => {
  assert.equal(slashDate("2026/10/07"), "2026/10/07");
});

test("slashDate: 空值 → 空字串", () => {
  assert.equal(slashDate(""), "");
  assert.equal(slashDate("   "), "");
});

test("slashDate: 唔似 ISO → 原樣回（唔好亂改）", () => {
  assert.equal(slashDate("garbage"), "garbage");
  assert.equal(slashDate("07/10/2026"), "07/10/2026");
});

// ─────────────────────────────────────────────────────────────
// macauTimeOfDay —— 澳門時區核心
// ─────────────────────────────────────────────────────────────
test("macauTimeOfDay: UTC 時間 +8 小時", () => {
  assert.equal(macauTimeOfDay("2026-10-07T06:32:05Z"), "14:32:05");
  assert.equal(macauTimeOfDay("2026-10-07T00:00:00Z"), "08:00:00");
});

test("macauTimeOfDay: 🔴 澳門午夜 0 點（UTC 前一日 16:00）→ 00:00:00 唔可以出 24", () => {
  assert.equal(macauTimeOfDay("2026-10-06T16:00:00Z"), "00:00:00");
});

test("macauTimeOfDay: 澳門一日嘅頭尾邊界", () => {
  assert.equal(macauTimeOfDay("2026-10-06T16:00:01Z"), "00:00:01");
  assert.equal(macauTimeOfDay("2026-10-07T15:59:59Z"), "23:59:59");
});

test("macauTimeOfDay: 帶微秒 + offset 嘅 Supabase timestamptz 格式", () => {
  assert.equal(macauTimeOfDay("2026-10-07T06:32:05.123456+00:00"), "14:32:05");
});

test("macauTimeOfDay: 解析失敗 → null（唔可以出 Invalid Date）", () => {
  assert.equal(macauTimeOfDay(null), null);
  assert.equal(macauTimeOfDay(undefined), null);
  assert.equal(macauTimeOfDay(""), null);
  assert.equal(macauTimeOfDay("bad"), null);
  assert.equal(macauTimeOfDay("2026-13-45T99:99:99Z"), null);
});

test("macauTimeOfDay: 秒數有補零（唔可以出 14:3:5）", () => {
  assert.equal(macauTimeOfDay("2026-10-07T06:03:05Z"), "14:03:05");
});

// ─────────────────────────────────────────────────────────────
// formatReceiptStamp —— UI 主顯示
// ─────────────────────────────────────────────────────────────
test("formatReceiptStamp: 完整格式 YYYY/MM/DD HH:mm:ss", () => {
  assert.equal(
    formatReceiptStamp("2026-10-07", "2026-10-07T06:32:05Z"),
    "2026/10/07 14:32:05",
  );
});

test("formatReceiptStamp: 冇 created_at（舊資料）→ 只出日期", () => {
  assert.equal(formatReceiptStamp("2026-10-07", null), "2026/10/07");
  assert.equal(formatReceiptStamp("2026-10-07", undefined), "2026/10/07");
});

test("formatReceiptStamp: created_at 非法 → 只出日期", () => {
  assert.equal(formatReceiptStamp("2026-10-07", "not-a-date"), "2026/10/07");
});

test("formatReceiptStamp: 冇 receipt_date 但有 created_at → 至少出時間", () => {
  assert.equal(formatReceiptStamp(null, "2026-10-07T06:32:05Z"), "14:32:05");
});

test("formatReceiptStamp: 🔴 兩者皆無 → 「—」佔位，唔可以出空白或 0", () => {
  assert.equal(formatReceiptStamp(null, null), "—");
  assert.equal(formatReceiptStamp("", ""), "—");
  assert.equal(formatReceiptStamp(undefined, undefined), "—");
});

test("formatReceiptStamp: 補登舊單 → 日期用單據日期、時間用錄入時間", () => {
  // 單據日期 10-01，但 10-07 才錄入
  assert.equal(
    formatReceiptStamp("2026-10-01", "2026-10-07T06:00:00Z"),
    "2026/10/01 14:00:00",
  );
});

// ─────────────────────────────────────────────────────────────
// isBackdatedReceipt —— 補登偵測
// ─────────────────────────────────────────────────────────────
test("isBackdatedReceipt: 同日 → false", () => {
  assert.equal(isBackdatedReceipt("2026-10-07", "2026-10-07T06:32:05Z"), false);
});

test("isBackdatedReceipt: 🔴 澳門午夜邊界 —— 單據日 = 錄入日（澳門）→ false", () => {
  // createdAt = UTC 10-06 16:00 = 澳門 10-07 00:00 ⇒ 同 10-07 同一日
  assert.equal(isBackdatedReceipt("2026-10-07", "2026-10-06T16:00:00Z"), false);
  // createdAt = UTC 10-07 15:59 = 澳門 10-07 23:59 ⇒ 仍然同一日
  assert.equal(isBackdatedReceipt("2026-10-07", "2026-10-07T15:59:59Z"), false);
});

test("isBackdatedReceipt: 跨日 → true", () => {
  assert.equal(isBackdatedReceipt("2026-10-01", "2026-10-07T06:00:00Z"), true);
  // UTC 10-07 16:00 = 澳門 10-08 ⇒ 同 10-07 唔同日
  assert.equal(isBackdatedReceipt("2026-10-07", "2026-10-07T16:00:00Z"), true);
});

test("isBackdatedReceipt: 缺資料 → false（唔可以亂標「補登」）", () => {
  assert.equal(isBackdatedReceipt(null, "2026-10-07T06:00:00Z"), false);
  assert.equal(isBackdatedReceipt("2026-10-07", null), false);
  assert.equal(isBackdatedReceipt("2026-10-07", "bad"), false);
});

// ─────────────────────────────────────────────────────────────
// receiptStampLabel —— UI 註解
// ─────────────────────────────────────────────────────────────
test("receiptStampLabel: 有時間 → 附「時間為錄入時間」", () => {
  const r = receiptStampLabel("2026-10-07", "2026-10-07T06:32:05Z");
  assert.equal(r.primary, "2026/10/07 14:32:05");
  assert.equal(r.note, "時間為錄入時間");
});

test("receiptStampLabel: 補登 → 註解帶上單據日期", () => {
  const r = receiptStampLabel("2026-10-01", "2026-10-07T06:00:00Z");
  assert.equal(r.primary, "2026/10/01 14:00:00");
  assert.match(r.note ?? "", /補登|單據日期 2026\/10\/01/);
});

test("receiptStampLabel: 冇時間 → note 為 null（唔加無意義註解）", () => {
  const r = receiptStampLabel("2026-10-07", null);
  assert.equal(r.primary, "2026/10/07");
  assert.equal(r.note, null);
});
