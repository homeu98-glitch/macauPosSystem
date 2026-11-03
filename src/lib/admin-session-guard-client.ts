"use client";

import {
  decodeAdminSessionToken,
  isAdminSessionTokenExpired,
  type AdminSessionDisplayClaims,
} from "@/lib/admin-session-token-client";
import { clearAdminSessionToken, loadAuthSession } from "@/lib/storage";

/**
 * admin 後台【客戶端】憑證狀態 —— 單一真源。
 *
 * ## 為何要獨立一個 module（2026-11-03 事故）
 *
 * Vercel 免費額度一夜之間被 810K CDN Requests 打爆（1,011,747 / 1,000,000），
 * 全部集中喺 5 條路徑、每個 68K：
 *
 * ```
 * /admin  /admin/dashboard  /api/admin/me  /api/admin/merchants  /api/admin/orders
 * ```
 *
 * 五條 **1:1:1:1:1** ⇒ 同一個迴圈，每輪 5 個請求。成因係三個地方各自用唔同口徑
 * 判斷「登入咗未」：
 *
 * | 位置 | 舊行為 | 後果 |
 * |---|---|---|
 * | `app/admin/page.tsx` | 只睇 token **存在**就跳 dashboard | 過期票一樣當登入 |
 * | `components/admin-shell.tsx` | 見到過期就跳返 `/admin`，**冇清票** | 票一直留住 |
 * | `app/admin/dashboard/page.tsx` | 3 個 fetch 喺 shell 之外，mount 即打 | 每輪燒 3 個 401 |
 *
 * ⇒ dashboard →（過期）→ `/admin` →（見到票）→ dashboard → … 永不停止，
 *   直到有人關 tab 或者額度用完。
 *
 * ## 設計約束
 *
 * 1. **只有一個判斷函式**（`readAdminSessionState`）—— 唔可以再喺頁面自己寫
 *    `if (session?.adminSessionToken)`，呢句正是事故根源。
 * 2. **發現無效 = 即刻清走**（`clearAdminSessionIfInvalid`）—— 判斷同清理唔可以分家，
 *    分家就會出現「A 判定過期跳走、B 見到票又跳返」。
 * 3. **只清 admin token**，保留 POS 收銀 session（見 `clearAdminSessionToken()` 註釋）。
 * 4. 客戶端解碼只係 **UX 判斷**，真正授權永遠由 server `verifyAdminSessionToken()` 把關。
 */

export type AdminSessionState =
  | { valid: true; token: string; claims: AdminSessionDisplayClaims }
  | { valid: false; token: string | null; reason: "missing" | "unreadable" | "expired" };

/**
 * 讀 admin token 並驗 expiry。
 *
 * `valid: true` 只代表「本地睇落未過期」；server 仍可能因為簽名／撤銷而回 401，
 * 所以每個 fetch 之後一樣要處理 401（見 `AdminShell`）。
 */
export function readAdminSessionState(nowMs: number = Date.now()): AdminSessionState {
  const token = loadAuthSession()?.adminSessionToken;
  if (typeof token !== "string" || !token) {
    return { valid: false, token: null, reason: "missing" };
  }
  const claims = decodeAdminSessionToken(token);
  if (!claims) return { valid: false, token, reason: "unreadable" };
  if (isAdminSessionTokenExpired(claims, nowMs)) {
    return { valid: false, token, reason: "expired" };
  }
  return { valid: true, token, claims };
}

/**
 * 憑證無效就**即刻清走**，回傳「今次有冇清」。
 *
 * 🔴 呢個函式係止住無限迴圈嘅關鍵：`/admin` 同 `/admin/dashboard` 兩邊都要call，
 *    確保任何一邊發現無效之後，另一邊**唔會再見到張票**。
 */
export function clearAdminSessionIfInvalid(nowMs: number = Date.now()): boolean {
  const state = readAdminSessionState(nowMs);
  if (state.valid) return false;
  if (!state.token) return false;
  clearAdminSessionToken();
  return true;
}
