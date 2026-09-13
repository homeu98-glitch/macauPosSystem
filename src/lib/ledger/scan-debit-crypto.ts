import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * v3.5 掃碼自助扣餘額（`scan-debit/quote|commit`）嘅**純加密邏輯**。
 *
 * 零 runtime 依賴（只 `node:crypto`）→ 可以 `node --test`。
 * Secret 一律**由 caller 傳入**（唔喺模組內讀 `process.env`），令測試唔使 mock env。
 *
 * 權威來源：[`docs/integration/pos-v3.5-partner-handover-scan-debit.md`](../../../docs/integration/pos-v3.5-partner-handover-scan-debit.md)
 *
 * 🔴 三條唔可以錯嘅：
 *   1. **簽原始 body 字串** —— 唔可以 parse 再 `JSON.stringify`（key 順序會變，簽名對唔上）。
 *   2. **唔可以用 `AUTH_PIN_PEPPER` 或 `LEDGER_WEBHOOK_SECRET` 簽** —— 交接文檔明文。
 *      `POS_SCAN_DEBIT_SECRET` 係獨立一把（UAT／正式各一）。
 *   3. 時戳用 **unix 秒**，容差 **5 分鐘**。
 */

/** 簽名時戳容差（秒）—— 同 Ledger 一致。 */
export const SCAN_DEBIT_MAX_SKEW_SECONDS = 300;

/** 免 PIN 窗口（毫秒）—— 交接文檔：「登入後 3 分鐘內可免再 PIN」。 */
export const PIN_WINDOW_MS = 180_000;

/** 用嚟由 `AUTH_PIN_PEPPER` 派生一把**獨立**嘅子密鑰（key derivation）。
 *  🔴 唔可以直接用 pepper 簽 —— 同一把密鑰做兩件事（PIN 派生 + 簽名）係典型密碼學錯誤。 */
const PIN_WINDOW_KDF_LABEL = "pos-pin-window-v1";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * `X-Pos-Signature` = `HMAC-SHA256(secret, timestamp + "." + rawBody).hex`
 *
 * @param timestamp 通常係 unix 秒字串（Ledger 亦接受毫秒 / ISO）
 * @param rawBody **原始** JSON 字串（唔可以重新 serialize）
 */
export function signScanDebitBody(timestamp: string, rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** 驗簽（多數用唔到 —— POS 係 caller；留返做 UAT / 自測）。 */
export function verifyScanDebitSignature(
  timestamp: string,
  rawBody: string,
  signature: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  if (Math.abs(nowSeconds - seconds) > SCAN_DEBIT_MAX_SKEW_SECONDS) return false;
  const candidate = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
  return safeEqual(signScanDebitBody(timestamp, rawBody, secret), candidate);
}

// ─────────────────────────────────────────────────────────────
// 免 PIN 窗口令牌（P3）
// ─────────────────────────────────────────────────────────────
//
// 🔴 為咩要 server 簽而唔係 client 傳 `loggedInAt`：
//    Ledger **完全唔驗 PIN**（契約 Q5）→ 「登入後 3 分鐘免 PIN」係**唯一**二次確認防線。
//    如果 client 自己講「我 30 秒前登入」，客人（或拎到手機嘅人）改個數字就永遠免 PIN。
//    所以窗口必須由 server 簽發、server 驗證 —— client 只係持票人。

function derivePinWindowKey(pepper: string): Buffer {
  return createHmac("sha256", pepper).update(PIN_WINDOW_KDF_LABEL).digest();
}

/**
 * 簽發免 PIN 窗口令牌。
 *
 * 格式：`<customerId>.<expiresAtMs>.<hexSig>`
 * （customerId 本身係 uuid，唔含 `.`，所以可以安全用 `.` 分隔。）
 */
export function buildPinWindowToken(customerId: string, expiresAtMs: number, pepper: string): string {
  const payload = `${customerId}.${Math.floor(expiresAtMs)}`;
  const sig = createHmac("sha256", derivePinWindowKey(pepper)).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export type PinWindowCheck =
  | { valid: true }
  | { valid: false; reason: "malformed" | "expired" | "mismatch" | "bad-signature" };

/**
 * 驗證免 PIN 窗口令牌。
 *
 * @param nowMs 現在時間（傳入以便測試）。
 */
export function verifyPinWindowToken(
  token: string,
  customerId: string,
  pepper: string,
  nowMs: number,
): PinWindowCheck {
  const parts = String(token).split(".");
  if (parts.length !== 3) return { valid: false, reason: "malformed" };
  const [tokenCustomerId, expiresRaw, sig] = parts;

  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs)) return { valid: false, reason: "malformed" };

  const expected = createHmac("sha256", derivePinWindowKey(pepper))
    .update(`${tokenCustomerId}.${Math.floor(expiresAtMs)}`)
    .digest("hex");
  if (!safeEqual(expected, sig)) return { valid: false, reason: "bad-signature" };

  // 簽名先驗（唔可以喺驗簽前就用 token 內嘅 customerId 做判斷 —— 咁等於信未驗證嘅資料）。
  if (tokenCustomerId !== customerId) return { valid: false, reason: "mismatch" };
  if (nowMs > expiresAtMs) return { valid: false, reason: "expired" };

  return { valid: true };
}

/**
 * 砌 `X-Pos-Signature` 所需嘅時戳（unix **秒**，字串）。
 * Ledger 亦接受毫秒／ISO，但 POS 現有驗簽邏輯用秒 → 統一用秒。
 */
export function scanDebitTimestamp(nowMs: number = Date.now()): string {
  return String(Math.floor(nowMs / 1000));
}
