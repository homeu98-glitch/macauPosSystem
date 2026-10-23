import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bindingSecretMatches,
  decryptWithKey,
  deriveBindingKey,
  encryptWithKey,
  hashBindingSecret,
  newBindingSecret,
} from "./device-binding-crypto.ts";

/**
 * 裝置授權嘅密碼學部分（docs/160 §10）。
 *
 * 為何要測：呢層一壞，**所有已授權裝置會一夜之間全部失效**（解密失敗 ⇒ 要店主
 * 逐部重新授權），而且症狀係「授權已失效」，查唔到原因。所以要釘住：
 *   ① roundtrip 一定得；
 *   ② 換 key / 改 ciphertext 一定解唔到（唔可以靜靜回半截）；
 *   ③ secret 比對係 constant-time + 錯一個字都 false。
 */

const KEY_A = deriveBindingKey("test-secret-a")!;
const KEY_B = deriveBindingKey("test-secret-b")!;

describe("device binding crypto", () => {
  it("deriveBindingKey：同 secret 穩定、空 secret = null", () => {
    assert.equal(deriveBindingKey("abc")!.length, 32);
    assert.equal(deriveBindingKey("abc")!.toString("hex"), deriveBindingKey("abc")!.toString("hex"));
    assert.notEqual(deriveBindingKey("abc")!.toString("hex"), deriveBindingKey("abd")!.toString("hex"));
    assert.equal(deriveBindingKey(""), null);
    assert.equal(deriveBindingKey("   "), null);
  });

  it("加密／解密 roundtrip（refresh token 有特殊字元）", () => {
    const token = "v2.eyJhbGciOiJIUzI1NiJ9.abc-_.~+/=中文";
    const enc = encryptWithKey(KEY_A, token);
    assert.ok(enc);
    assert.match(enc!, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.notEqual(enc, token);
    assert.equal(decryptWithKey(KEY_A, enc!), token);
  });

  it("每次加密 IV 都唔同（同明文唔會出同一條 ciphertext）", () => {
    const a = encryptWithKey(KEY_A, "same");
    const b = encryptWithKey(KEY_A, "same");
    assert.notEqual(a, b);
    assert.equal(decryptWithKey(KEY_A, a!), "same");
    assert.equal(decryptWithKey(KEY_A, b!), "same");
  });

  it("換 key 解唔到（換 secret = 所有裝置失效，係預期行為）", () => {
    const enc = encryptWithKey(KEY_A, "token-123")!;
    assert.equal(decryptWithKey(KEY_B, enc), null);
  });

  it("ciphertext 被改 ⇒ GCM 認證失敗，回 null（唔可以回半截明文）", () => {
    const enc = encryptWithKey(KEY_A, "token-123")!;
    const parts = enc.split(".");
    const tampered = [parts[0], parts[1], parts[2], `${parts[3].slice(0, -2)}AA`].join(".");
    assert.equal(decryptWithKey(KEY_A, tampered), null);
  });

  it("格式錯 / 版本錯 / 空值一律 fail closed", () => {
    assert.equal(decryptWithKey(KEY_A, ""), null);
    assert.equal(decryptWithKey(KEY_A, "v1.abc"), null);
    assert.equal(decryptWithKey(KEY_A, "v0.a.b.c"), null);
    assert.equal(decryptWithKey(KEY_A, "garbage"), null);
    assert.equal(encryptWithKey(KEY_A, ""), null);
    assert.equal(encryptWithKey(Buffer.alloc(16), "x"), null);
  });

  it("secret 雜湊／比對", () => {
    const secret = newBindingSecret();
    assert.equal(secret.length >= 40, true);
    const hash = hashBindingSecret(secret);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(bindingSecretMatches(secret, hash), true);
    assert.equal(bindingSecretMatches(`${secret}x`, hash), false);
    assert.equal(bindingSecretMatches("", hash), false);
    assert.equal(bindingSecretMatches(secret, ""), false);
    // 兩次生成唔會撞
    assert.notEqual(newBindingSecret(), newBindingSecret());
  });
});
