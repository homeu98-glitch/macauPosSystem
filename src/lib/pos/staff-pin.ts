import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 店員 PIN 雜湊（server-only；**唔好**喺 client import）。
 *
 * ## 為何唔可以照抄舊 `admin_account_users.pin_code`
 *
 * 舊表曾經**明文**存 PIN、用 `.eq("pin_code", pin)` 比對（見 docs/123 §1）。
 * 4 位 PIN 只有 10⁴ 組合 ⇒ 一次 DB 洩漏等於全店 PIN 公開。
 *
 * 呢度用 PBKDF2-SHA256（120,000 iter）＋ **per-row random salt**：
 * - salt 令兩個員工用同一個 PIN 都產生唔同 hash（彩虹表／批量比對失效）；
 * - 120k iter 令離線爆破成本升到「10⁴ × 120k 次 SHA256」級別；
 * - 另外 API 層有 per-staff 鎖定（5 次錯 → 15 分鐘），擋住線上爆破。
 *
 * ⚠️ 唔可以改用 `deriveLedgerAuthPassword()`：嗰個係 Ledger 契約（phone+pin+pepper）
 *    嘅一部分，改咗會令 L1 登入斷。
 */

export const POS_STAFF_PIN_ALGO = "pbkdf2-sha256-120000";

const ITERATIONS = 120_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

export type PosStaffPinRecord = {
  pinHash: string;
  pinSalt: string;
  pinAlgo: string;
};

/** 產生 PIN 雜湊（建立帳號／改 PIN 時用）。 */
export function hashPosStaffPin(pin: string): PosStaffPinRecord {
  const pinSalt = randomBytes(SALT_BYTES).toString("hex");
  const pinHash = pbkdf2Sync(pin, pinSalt, ITERATIONS, KEY_BYTES, "sha256").toString("hex");
  return { pinHash, pinSalt, pinAlgo: POS_STAFF_PIN_ALGO };
}

/**
 * 驗證 PIN。未知演算法一律 **fail closed**（回 false），
 * 唔好「猜」一個預設演算法去驗 —— 將來換演算法時，錯配會靜靜全部登入唔到。
 */
export function verifyPosStaffPin(input: {
  pin: string;
  pinHash: string;
  pinSalt: string;
  pinAlgo?: string | null;
}): boolean {
  if (!/^\d{4}$/.test(input.pin)) return false;
  const algo = input.pinAlgo || POS_STAFF_PIN_ALGO;
  if (algo !== POS_STAFF_PIN_ALGO) return false;
  if (!input.pinHash || !input.pinSalt) return false;

  const expected = Buffer.from(input.pinHash, "hex");
  if (expected.length !== KEY_BYTES) return false;

  const actual = pbkdf2Sync(input.pin, input.pinSalt, ITERATIONS, KEY_BYTES, "sha256");
  return timingSafeEqual(expected, actual);
}
