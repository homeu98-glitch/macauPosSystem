/**
 * 會員碼（Ledger `member-qr.ts`）嘅純驗章運算，**唔讀 env、唔碰 network**。
 *
 * 拆出嚟係為咗 `node --test` 可以直接測位元組格式（上層 `member-qr.server.ts`
 * 有 `import "server-only"`，node 直接跑唔到）。呢個檔只可以由 server 端呼叫：
 * 用咗 `node:crypto`，萬一被 client component import 咗，Next build 會直接失敗。
 *
 * ## 格式（同 Ledger `src/lib/member-qr.ts` 位元組對位元組一致）
 *   [version(1) | uid(16) | phone(uint32 BE,4) | exp(uint32 BE,4)] + sig(16)
 *   共 41 bytes → base64url ≈ 55 字元；sig = HMAC-SHA256(key, body) 截前 16 bytes。
 *   key = HMAC-SHA256(AUTH_PIN_PEPPER, "member-qr-v1")。
 *
 * token 係**不透明**字串，QR 入面唔含明碼電話；120 秒到期，防止截圖長期重放。
 * 🔴 呼籲：pepper 只可以由 server env 傳入，唔好落 client／log／測試快照。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const SIG_BYTES = 16;
const BODY_BYTES = 1 + 16 + 4 + 4;
const TOKEN_BYTES = BODY_BYTES + SIG_BYTES;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
export const MEMBER_QR_TOKEN_MAX_LEN = 128;

function signingKey(pepper: string): Buffer {
  return createHmac("sha256", pepper).update("member-qr-v1").digest();
}

function sign(body: Buffer, pepper: string): Buffer {
  return createHmac("sha256", signingKey(pepper))
    .update(body)
    .digest()
    .subarray(0, SIG_BYTES);
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return Buffer.alloc(16);
  return Buffer.from(hex, "hex");
}

/**
 * 只供測試／日後 POS 自己簽會員碼用。正式驗章只用 `verifyMemberQrToken()`。
 * 導出係為咗單元測試可以同 Ledger 格式對齊（唔使硬抄一條 token）。
 */
export function createMemberQrToken(
  uid: string,
  phone: string,
  ttlSec: number,
  pepper: string,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = Buffer.alloc(BODY_BYTES);
  body.writeUInt8(VERSION, 0);
  uuidToBytes(uid).copy(body, 1);
  body.writeUInt32BE(Number(phone.replace(/\D/g, "")) >>> 0, 17);
  body.writeUInt32BE(exp >>> 0, 21);
  return Buffer.concat([body, sign(body, pepper)]).toString("base64url");
}

export type VerifyMemberQrResult =
  | { ok: true; phone: string }
  | { ok: false; reason: "not_configured" | "format" | "signature" | "expired" };

/**
 * 驗章。**唔拋錯、唔 log token／phone**（契約 §7.2：個資只可當次用）。
 * 失敗原因只喺 server 內部區分；對外一律同一句「無法辨識」，避免變 oracle。
 */
export function verifyMemberQrToken(
  token: unknown,
  pepper: string | null | undefined,
): VerifyMemberQrResult {
  const secret = typeof pepper === "string" ? pepper.trim() : "";
  if (!secret) return { ok: false, reason: "not_configured" };
  if (typeof token !== "string" || !token || token.length > MEMBER_QR_TOKEN_MAX_LEN) {
    return { ok: false, reason: "format" };
  }
  if (!BASE64URL_PATTERN.test(token)) return { ok: false, reason: "format" };

  let raw: Buffer;
  try {
    raw = Buffer.from(token, "base64url");
  } catch {
    return { ok: false, reason: "format" };
  }
  if (raw.length !== TOKEN_BYTES) return { ok: false, reason: "format" };

  const body = raw.subarray(0, BODY_BYTES);
  const sig = raw.subarray(BODY_BYTES);
  if (body.readUInt8(0) !== VERSION) return { ok: false, reason: "format" };

  const expected = sign(body, secret);
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return { ok: false, reason: "signature" };
  }

  const exp = body.readUInt32BE(21);
  if (exp * 1000 < Date.now()) return { ok: false, reason: "expired" };

  return { ok: true, phone: String(body.readUInt32BE(17)).padStart(8, "0") };
}
