import "server-only";

import { verifyMemberQrToken } from "@/lib/ledger/member-qr-crypto";

/**
 * POS server 端驗會員碼嘅唯一入口（`AUTH_PIN_PEPPER` 唔可以離開 server）。
 *
 * 純運算放 `member-qr-crypto.ts`（可單測），呢層只負責由 env 拎 pepper，
 * 並用 `server-only` 標記擋住 client import。同 Ledger 共用同一顆 pepper，
 * 所以 POS 可以本地驗章，唔使打 Ledger Web Server Action（契約 §1.2 禁止）。
 */
export function verifyMemberQrTokenFromEnv(token: unknown) {
  return verifyMemberQrToken(token, process.env.AUTH_PIN_PEPPER);
}

export type { VerifyMemberQrResult } from "@/lib/ledger/member-qr-crypto";
