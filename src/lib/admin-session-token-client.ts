/**
 * 管理員 token 嘅【客戶端】解碼器。
 *
 * 同 `admin-session-token.ts` 嘅分別：呢個 module **無 `server-only`**、**唔使 server secret**、
 * **唔做 HMAC 簽名驗證**——只做「解碼 payload + 讀 expiry」。原因：HMAC 密鑰係 server-only，
 * 瀏覽器冇法亦唔應該有，所以客戶端冇辦法驗簽。
 *
 * ⚠️ 重要：客戶端解碼**絕對唔可以當作授權證明**——任何人都可以偽造 payload。
 *   真正嘅授權由 server 端 `verifyAdminSessionToken()`（HMAC 驗簽）把關，
 *   每個 admin API route 都會行一次。呢度嘅解碼只係為咗兩件事：
 *     (1) admin panel 頂部顯示「我依家係邊個 admin 帳號」；
 *     (2) 客戶端 gate 用 expiry 做 UX 判斷（過期就彈返登入頁，避免用家瞥到過期頁面）。
 *   即使客戶端放過咗，server 都會拒絕真正嘅 API call，唔會因為客戶端放過而漏嘢。
 *
 * token 格式（同 server 端 `issueAdminSessionToken` 一致）：
 *   `base64url(payload).signature`，其中
 *   payload = base64url(JSON.stringify({ v: "v1", account, role, exp }))
 */

import { UserRole } from "@/lib/types";

export type AdminSessionDisplayClaims = {
  /** 8 位員工帳號（登入嗰陣輸入、server 驗證過嘅那個） */
  account: string;
  /** 簽發當刻嘅角色（只作顯示用） */
  role: UserRole;
  /** 到期時間 epoch ms */
  exp: number;
};

/** base64url → UTF-8 string（瀏覽器冇 Buffer，用 atob + TextDecoder）。 */
function base64urlDecodeToUtf8(input: string): string {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad) b64 += "=".repeat(4 - pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * 解碼 admin token 嘅 payload（**唔驗簽**）。任何異常／格式唔對都返 null，
 * 交返畀 call 方決定（通常＝彈去登入頁）。
 */
export function decodeAdminSessionToken(token: string | null | undefined): AdminSessionDisplayClaims | null {
  if (!token || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  try {
    const decoded = JSON.parse(base64urlDecodeToUtf8(payload)) as Partial<AdminSessionDisplayClaims> & {
      v?: string;
    };
    if (decoded?.v !== "v1") return null;
    if (typeof decoded.account !== "string" || !decoded.account) return null;
    if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return null;
    return {
      account: decoded.account,
      role: (decoded.role ?? "admin") as UserRole,
      exp: decoded.exp,
    };
  } catch {
    return null;
  }
}

/** 是否已過期（用本地時間，純 UX 判斷；真正授權由 server 端把關）。 */
export function isAdminSessionTokenExpired(
  claims: AdminSessionDisplayClaims | null,
  nowMs: number = Date.now(),
): boolean {
  if (!claims) return true;
  return nowMs > claims.exp;
}

/** 仲有幾耐過期（ms），過期／無效返 0。 */
export function adminSessionTokenRemainingMs(
  claims: AdminSessionDisplayClaims | null,
  nowMs: number = Date.now(),
): number {
  if (!claims) return 0;
  return Math.max(0, claims.exp - nowMs);
}
