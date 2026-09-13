import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PIN_FREE_WINDOW_MS,
  avosToMop,
  buildDeductIdempotencyKey,
  formatElapsed,
  formatRetryClock,
  isPinFree,
  mopToAvos,
  pinFreeRemainingMs,
} from "./member-pay.ts";

test("冪等鍵格式必須係 scan-debit:{merchant}:{order}", () => {
  const key = buildDeductIdempotencyKey("zymdemjflsckicwcinxl", "kiosk-a1b2c3d4");
  assert.equal(key, "scan-debit:zymdemjflsckicwcinxl:kiosk-a1b2c3d4");
});

test("冪等鍵符合 Ledger 字符集 [A-Za-z0-9._:-]{8,128}", () => {
  const key = buildDeductIdempotencyKey("store_1", "kiosk-1234abcd");
  assert.match(key, /^[A-Za-z0-9._:-]{8,128}$/);
});

test("非法字元會被換成 dash 而唔會 throw", () => {
  const key = buildDeductIdempotencyKey("store/1", "kiosk 1234#x");
  assert.match(key, /^[A-Za-z0-9._:-]{8,128}$/);
  assert.ok(!key.includes("/"));
  assert.ok(!key.includes(" "));
  assert.ok(!key.includes("#"));
});

test("超長 key 會被截到 128 字", () => {
  const key = buildDeductIdempotencyKey("s".repeat(200), "o".repeat(200));
  assert.equal(key.length, 128);
});

test("免 PIN：登入後即時免 PIN", () => {
  const loggedInAt = 1_700_000_000_000;
  assert.equal(isPinFree(loggedInAt, loggedInAt), true);
  assert.equal(pinFreeRemainingMs(loggedInAt, loggedInAt), PIN_FREE_WINDOW_MS);
});

test("免 PIN：179.9 秒仍然免、180 秒起失效", () => {
  const loggedInAt = 1_700_000_000_000;
  assert.equal(isPinFree(loggedInAt, loggedInAt + 179_900), true);
  assert.equal(isPinFree(loggedInAt, loggedInAt + PIN_FREE_WINDOW_MS), false);
  assert.equal(isPinFree(loggedInAt, loggedInAt + PIN_FREE_WINDOW_MS + 1), false);
});

test("免 PIN：未登入（null）一律要 PIN", () => {
  assert.equal(isPinFree(null, 1_700_000_000_000), false);
  assert.equal(pinFreeRemainingMs(null, 1_700_000_000_000), 0);
});

test("免 PIN：時間倒退（時鐘異常）唔會變成負數", () => {
  const loggedInAt = 1_700_000_000_000;
  assert.equal(isPinFree(loggedInAt, loggedInAt - 60_000), true);
});

test("formatElapsed：只顯示分同秒", () => {
  assert.equal(formatElapsed(0), "0 秒");
  assert.equal(formatElapsed(45_000), "45 秒");
  assert.equal(formatElapsed(132_000), "2 分 12 秒");
  assert.equal(formatElapsed(180_000), "3 分 0 秒");
});

test("formatElapsed：負數 / NaN 當 0 秒", () => {
  assert.equal(formatElapsed(-5000), "0 秒");
  assert.equal(formatElapsed(Number.NaN), "0 秒");
});

test("mopToAvos 用 round 而唔係 floor（浮點誤差）", () => {
  assert.equal(mopToAvos(70), 7000);
  assert.equal(mopToAvos(128.5), 12850);
  assert.equal(mopToAvos(0.1 + 0.2), 30);
  assert.equal(mopToAvos(Number.NaN), 0);
});

test("avosToMop 反算一致", () => {
  assert.equal(avosToMop(7000), 70);
  assert.equal(avosToMop(12850), 128.5);
  assert.equal(avosToMop(Number.NaN), 0);
});

test("formatRetryClock 用本地時鐘砌 HH:MM", () => {
  // 2026-09-13 14:22:00 本地 → 900 秒後 = 14:37
  const base = new Date(2026, 8, 13, 14, 22, 0, 0).getTime();
  assert.equal(formatRetryClock(900, base), "14:37");
  assert.equal(formatRetryClock(0, base), "14:22");
});
