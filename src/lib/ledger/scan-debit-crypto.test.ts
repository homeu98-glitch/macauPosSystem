import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PIN_WINDOW_MS,
  SCAN_DEBIT_MAX_SKEW_SECONDS,
  buildPinWindowToken,
  scanDebitTimestamp,
  signScanDebitBody,
  verifyPinWindowToken,
  verifyScanDebitSignature,
} from "./scan-debit-crypto.ts";

const SECRET = "uat-secret-abc123";
const PEPPER = "pepper-xyz";
const CID = "6f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8";
const T0 = 1_700_000_000_000;

test("簽名係 hex-64，且決定性（同輸入同輸出）", () => {
  const a = signScanDebitBody("1700000000", '{"a":1}', SECRET);
  const b = signScanDebitBody("1700000000", '{"a":1}', SECRET);
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("換 secret / timestamp / body 任一項都應該變簽名", () => {
  const base = signScanDebitBody("1700000000", '{"a":1}', SECRET);
  assert.notEqual(base, signScanDebitBody("1700000001", '{"a":1}', SECRET));
  assert.notEqual(base, signScanDebitBody("1700000000", '{"a":2}', SECRET));
  assert.notEqual(base, signScanDebitBody("1700000000", '{"a":1}', SECRET + "x"));
});

test("簽名綁 body 字串本身：key 順序唔同 = 唔同簽名（證明一定簽原始字串）", () => {
  const t = "1700000000";
  assert.notEqual(
    signScanDebitBody(t, '{"merchantId":"m","amountAvos":100}', SECRET),
    signScanDebitBody(t, '{"amountAvos":100,"merchantId":"m"}', SECRET),
  );
});

test("驗簽：正確通過", () => {
  const ts = "1700000000";
  const body = '{"merchantId":"m"}';
  const sig = signScanDebitBody(ts, body, SECRET);
  assert.equal(verifyScanDebitSignature(ts, body, sig, SECRET, 1_700_000_000), true);
});

test("驗簽：容許 sha256= 前綴", () => {
  const ts = "1700000000";
  const body = "{}";
  const sig = "sha256=" + signScanDebitBody(ts, body, SECRET);
  assert.equal(verifyScanDebitSignature(ts, body, sig, SECRET, 1_700_000_000), true);
});

test("驗簽：超過 5 分鐘即失效", () => {
  const ts = "1700000000";
  const body = "{}";
  const sig = signScanDebitBody(ts, body, SECRET);
  assert.equal(
    verifyScanDebitSignature(ts, body, sig, SECRET, 1_700_000_000 + SCAN_DEBIT_MAX_SKEW_SECONDS),
    true,
    "剛剛到 5 分鐘邊界應該仍然接受",
  );
  assert.equal(
    verifyScanDebitSignature(ts, body, sig, SECRET, 1_700_000_000 + SCAN_DEBIT_MAX_SKEW_SECONDS + 1),
    false,
  );
});

test("驗簽：body 被改（replay 後改金額）即失效", () => {
  const ts = "1700000000";
  const sig = signScanDebitBody(ts, '{"amountAvos":100}', SECRET);
  assert.equal(verifyScanDebitSignature(ts, '{"amountAvos":999}', sig, SECRET, 1_700_000_000), false);
});

test("時戳用 unix 秒字串", () => {
  assert.equal(scanDebitTimestamp(T0), "1700000000");
});

test("免 PIN 令牌：簽發後即刻有效，180 秒後失效", () => {
  const token = buildPinWindowToken(CID, T0 + PIN_WINDOW_MS, PEPPER);
  assert.deepEqual(verifyPinWindowToken(token, CID, PEPPER, T0), { valid: true });
  assert.deepEqual(verifyPinWindowToken(token, CID, PEPPER, T0 + PIN_WINDOW_MS - 1), { valid: true });
  assert.deepEqual(verifyPinWindowToken(token, CID, PEPPER, T0 + PIN_WINDOW_MS + 1), {
    valid: false,
    reason: "expired",
  });
});

test("免 PIN 令牌：唔可以換人用（customerId 綁死）", () => {
  const token = buildPinWindowToken(CID, T0 + PIN_WINDOW_MS, PEPPER);
  const other = "00000000-0000-0000-0000-000000000000";
  assert.deepEqual(verifyPinWindowToken(token, other, PEPPER, T0), {
    valid: false,
    reason: "mismatch",
  });
});

test("免 PIN 令牌：改過期時間會壞簽名", () => {
  const token = buildPinWindowToken(CID, T0 + PIN_WINDOW_MS, PEPPER);
  const parts = token.split(".");
  const forged = `${parts[0]}.${T0 + 999_999_999}.${parts[2]}`;
  assert.deepEqual(verifyPinWindowToken(forged, CID, PEPPER, T0), {
    valid: false,
    reason: "bad-signature",
  });
});

test("免 PIN 令牌：換 pepper 即失效", () => {
  const token = buildPinWindowToken(CID, T0 + PIN_WINDOW_MS, PEPPER);
  assert.deepEqual(verifyPinWindowToken(token, CID, "other-pepper", T0), {
    valid: false,
    reason: "bad-signature",
  });
});

test("免 PIN 令牌：格式唔對（少段 / 多段）一律 malformed", () => {
  assert.deepEqual(verifyPinWindowToken("abc", CID, PEPPER, T0), { valid: false, reason: "malformed" });
  assert.deepEqual(verifyPinWindowToken("a.b.c.d", CID, PEPPER, T0), {
    valid: false,
    reason: "malformed",
  });
  assert.deepEqual(verifyPinWindowToken(`${CID}.notanumber.sig`, CID, PEPPER, T0), {
    valid: false,
    reason: "malformed",
  });
});

test("🔴 唔可以用 pepper 直接簽（派生密鑰必須唔等於 pepper 本身）", () => {
  const token = buildPinWindowToken(CID, T0 + PIN_WINDOW_MS, PEPPER);
  const sig = token.split(".")[2];
  // 若誤用 pepper 直接做 key，簽名會等於下面呢個 —— 必須唔相等。
  const naive = signScanDebitBody(`${CID}.${T0 + PIN_WINDOW_MS}`, "", PEPPER);
  assert.notEqual(sig, naive);
});
