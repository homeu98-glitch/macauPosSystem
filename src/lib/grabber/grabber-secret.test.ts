import assert from "node:assert/strict";
import test from "node:test";

import {
  GRABBER_SECRET_HEADER,
  grabberSecretsMatch,
  readGrabberSecretFromRequest,
  readGrabberSharedSecret,
} from "./grabber-secret.ts";

/**
 * 插件入站端點嘅共享密鑰驗證（2026-09-25）。
 *
 * 為什麼值得鎖死：呢個係**唯一**嘅授權閘。放行得太寬 = 任何人可以寫訂單入生產 DB；
 * 太嚴 = 商家靜默收唔到單（兩邊都係災難）。而且佢而家由兩條 route 共用
 * （`grabber/orders` ＋ `grabber/store`），任何改動都影響兩邊。
 */

test("header 名同插件送嘅一致（X-Grabber-Secret，小寫比對）", () => {
  assert.equal(GRABBER_SECRET_HEADER, "x-grabber-secret");
  const req = new Request("https://example.test/x", {
    method: "POST",
    headers: { "X-Grabber-Secret": "abc123" },
  });
  assert.equal(readGrabberSecretFromRequest(req), "abc123");
});

test("冇 header → 空字串（呼叫端據此回 401）", () => {
  const req = new Request("https://example.test/x", { method: "POST" });
  assert.equal(readGrabberSecretFromRequest(req), "");
});

test("比對：正確 → true", () => {
  assert.equal(grabberSecretsMatch("s3cret-key-value", "s3cret-key-value"), true);
});

test("🔴 差一個字元 / 大小寫 → false", () => {
  assert.equal(grabberSecretsMatch("s3cret-key-valuE", "s3cret-key-value"), false);
  assert.equal(grabberSecretsMatch("", "s3cret-key-value"), false);
  assert.equal(grabberSecretsMatch("s3cret", "s3cret-key-value"), false);
});

test("🔴 兩邊都空 / 非字串 → 一律 false（唔可以「大家都空」而放行）", () => {
  assert.equal(grabberSecretsMatch("", ""), false);
  assert.equal(grabberSecretsMatch(undefined, undefined), false);
  assert.equal(grabberSecretsMatch(null, ""), false);
  assert.equal(grabberSecretsMatch(0, 0), false);
  assert.equal(grabberSecretsMatch({}, {}), false);
  assert.equal(grabberSecretsMatch("abc", undefined), false);
});

test("非字串 given 唔會 throw（防禦：header 可能係 undefined）", () => {
  assert.doesNotThrow(() => grabberSecretsMatch(undefined, "abc"));
  assert.equal(grabberSecretsMatch(undefined, "abc"), false);
});

test("環境變數未設定 → null（唔可以回空字串令呼叫端以為設好咗）", () => {
  const before = process.env.GRABBER_SHARED_SECRET;
  try {
    delete process.env.GRABBER_SHARED_SECRET;
    assert.equal(readGrabberSharedSecret(), null);
    process.env.GRABBER_SHARED_SECRET = "";
    assert.equal(readGrabberSharedSecret(), null, "空字串當未設定");
    process.env.GRABBER_SHARED_SECRET = "real-secret";
    assert.equal(readGrabberSharedSecret(), "real-secret");
  } finally {
    if (before === undefined) delete process.env.GRABBER_SHARED_SECRET;
    else process.env.GRABBER_SHARED_SECRET = before;
  }
});
