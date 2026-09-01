import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Ledger → POS 入站 webhook 嘅 HMAC 簽名驗證（docs/92 §5.3）。
 *
 * 簽名規格（要交畀 Ledger 團隊）：
 * ```
 * signing_string = X-Pos-Timestamp + "." + raw_body
 * signature      = HMAC_SHA256(LEDGER_WEBHOOK_SECRET, signing_string)  → hex
 * header         = X-Pos-Signature: sha256=<hex>
 * ```
 *
 * 點解要 timestamp 入 signing string：純簽 body 會被重放（replay attack）——
 * 攞到一個合法 request 就可以無限重發。加 timestamp + 時間窗（5 分鐘）先堵到。
 */

/** 容許嘅時間偏移：5 分鐘。 */
export const SIGNATURE_MAX_SKEW_SECONDS = 300;

export const SIGNATURE_TIMESTAMP_HEADER = "x-pos-timestamp";
export const SIGNATURE_HEADER = "x-pos-signature";

function resolveSecret(): string | null {
  return process.env.LEDGER_WEBHOOK_SECRET?.trim() || null;
}

/** 常數時間比對，防 timing attack。 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function computeSignature(timestamp: string, rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing-secret" | "missing-header" | "bad-timestamp" | "expired" | "bad-signature" };

/**
 * 驗證入站 request。
 *
 * ⚠️ caller **必須**傳 `rawBody`（`await request.text()`），
 * 唔可以傳 `JSON.stringify(await request.json())` —— 重新 serialize 會改咗 bytes，
 * 簽名一定對唔上。
 */
export function verifyLedgerSignature(headers: Headers, rawBody: string): VerifyResult {
  const secret = resolveSecret();
  if (!secret) return { ok: false, reason: "missing-secret" };

  const timestamp = headers.get(SIGNATURE_TIMESTAMP_HEADER)?.trim();
  const provided = headers.get(SIGNATURE_HEADER)?.trim();
  if (!timestamp || !provided) return { ok: false, reason: "missing-header" };

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "bad-timestamp" };

  const skew = Math.abs(Math.floor(Date.now() / 1000) - seconds);
  if (skew > SIGNATURE_MAX_SKEW_SECONDS) return { ok: false, reason: "expired" };

  const expected = computeSignature(timestamp, rawBody, secret);

  // 容許 caller 帶唔帶 `sha256=` prefix
  const candidate = provided.startsWith("sha256=") ? provided.slice("sha256=".length) : provided;

  return safeEqual(expected, candidate) ? { ok: true } : { ok: false, reason: "bad-signature" };
}
