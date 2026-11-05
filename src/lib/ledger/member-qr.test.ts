import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyScannedCode,
  GROUP_BUY_CODE_PATTERN,
  maskCouponCode,
  REWARD_COUPON_CODE_PATTERN,
  UNRECOGNIZED_QR_MESSAGE,
  UNSUPPORTED_GROUP_BUY_MESSAGE,
} from "./member-qr-client.ts";
import { createMemberQrToken, verifyMemberQrToken } from "./member-qr-crypto.ts";

const PEPPER = "test-only-pepper-do-not-use-in-prod";
const UID = "d564b932-0c91-45e9-86fd-0ec8e2711f13";

test("分類：rc_ + 32 hex 係優惠券碼", () => {
  const code = `rc_${"a1b2c3d4".repeat(4)}`;
  assert.equal(code.length, 35);
  assert.equal(classifyScannedCode(code), "rewardCoupon");
  assert.equal(classifyScannedCode(code.toUpperCase().replace("RC_", "rc_")), "rewardCoupon");
  assert.match(code, REWARD_COUPON_CODE_PATTERN);
});

test("分類：gb_ 明確標為團購券，唔好靜默當普通券", () => {
  assert.equal(classifyScannedCode("gb_9f3c2a1b4d5e6f"), "groupBuy");
  assert.match("gb_abc", GROUP_BUY_CODE_PATTERN);
  assert.ok(UNSUPPORTED_GROUP_BUY_MESSAGE.includes("團購券"));
});

test("分類：會員碼候選、亂碼、過長都唔會誤判做券", () => {
  assert.equal(classifyScannedCode("A".repeat(55)), "memberCandidate");
  assert.equal(classifyScannedCode("https://example.com/x"), "unrecognized");
  assert.equal(classifyScannedCode(""), "unrecognized");
  assert.equal(classifyScannedCode("x".repeat(200)), "unrecognized");
  // 少一位 hex / 多一位都唔應該認做券碼（fail-closed）
  assert.equal(classifyScannedCode(`rc_${"a".repeat(31)}`), "unrecognized");
  assert.equal(classifyScannedCode(`rc_${"a".repeat(33)}`), "unrecognized");
  assert.ok(UNRECOGNIZED_QR_MESSAGE.length > 0);
});

test("券碼遮罩：唔好喺彈窗印晒成個 QR 內容", () => {
  const code = `rc_${"a1b2c3d4".repeat(4)}`;
  assert.equal(maskCouponCode(code), "rc_a1b2c3d…");
  assert.equal(maskCouponCode("abc"), "abc");
});

test("會員碼驗章：同 Ledger 位元組格式對齊（41 bytes / v1 / 120s）", () => {
  const token = createMemberQrToken(UID, "66223344", 120, PEPPER);
  const raw = Buffer.from(token, "base64url");
  assert.equal(raw.length, 41);
  assert.equal(raw.readUInt8(0), 1);
  assert.equal(token.length, 55);

  const result = verifyMemberQrToken(token, PEPPER);
  assert.deepEqual(result, { ok: true, phone: "66223344" });
});

test("會員碼驗章：電話補足 8 位", () => {
  const token = createMemberQrToken(UID, "123456", 120, PEPPER);
  assert.deepEqual(verifyMemberQrToken(token, PEPPER), { ok: true, phone: "00123456" });
});

test("會員碼驗章：錯 pepper／改過／過期／冇設定一律 fail-closed", () => {
  const token = createMemberQrToken(UID, "66223344", 120, PEPPER);
  assert.equal(verifyMemberQrToken(token, "another-pepper").ok, false);
  assert.equal(verifyMemberQrToken(token, "").ok, false);
  assert.equal(verifyMemberQrToken(token, null).ok, false);
  assert.equal(
    (verifyMemberQrToken(token, null) as { reason: string }).reason,
    "not_configured",
  );

  const tampered = Buffer.from(token, "base64url");
  tampered[20] ^= 0x01;
  assert.equal(verifyMemberQrToken(tampered.toString("base64url"), PEPPER).ok, false);

  const expired = createMemberQrToken(UID, "66223344", -10, PEPPER);
  assert.equal(
    (verifyMemberQrToken(expired, PEPPER) as { reason: string }).reason,
    "expired",
  );
});

test("會員碼驗章：亂碼／URL／超長唔會拋錯", () => {
  for (const bad of ["", "hello", "https://example.com/not-a-token", "A".repeat(200), 12345]) {
    assert.equal(verifyMemberQrToken(bad, PEPPER).ok, false);
  }
});
