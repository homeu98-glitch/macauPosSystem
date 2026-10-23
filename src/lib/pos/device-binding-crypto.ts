/**
 * 裝置授權嘅純密碼學工具（零 import、零 env）—— 方便單元測試。
 *
 * ## 為何要抽呢一層
 *
 * `device-binding-server.ts` 係 `import "server-only"`，喺 `node --test` 入面
 * import 唔到（`server-only` 喺純 Node 會 throw）。但加密／雜湊係最容易靜靜壞、
 * 又最需要測試嘅部分（解密失敗 = 全部已授權裝置一夜失效）。
 *
 * ⇒ 金鑰由呼叫端（server）傳入，呢個檔只做純計算。
 *
 * ## 格式
 *
 * `v1.<iv base64url>.<tag base64url>.<ciphertext base64url>`（AES-256-GCM）
 * 版本前綴係為咗日後換算法時可以並存解密。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENC_VERSION = "v1";
const ENC_ALGO = "aes-256-gcm";

/** 由任意 secret 派生 32-byte AES key（固定 salt 前綴，避免同 pv1/sv1 簽名用途撞）。 */
export function deriveBindingKey(secret: string): Buffer | null {
  const value = String(secret ?? "").trim();
  if (!value) return null;
  return createHash("sha256").update(`pos-device-binding:v1:${value}`).digest();
}

/** 32 bytes 高熵 secret（base64url，43 字元）。 */
export function newBindingSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBindingSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function bindingSecretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashBindingSecret(secret), "utf8");
  const b = Buffer.from(String(storedHash ?? ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function encryptWithKey(key: Buffer, plain: string): string | null {
  if (!key || key.length !== 32 || !plain) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENC_ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    ENC_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptWithKey(key: Buffer, enc: string): string | null {
  if (!key || key.length !== 32) return null;
  const parts = String(enc ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== ENC_VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    const decipher = createDecipheriv(ENC_ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
