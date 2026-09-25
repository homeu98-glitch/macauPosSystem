import { timingSafeEqual } from "node:crypto";

/**
 * 外賣平台插件（Transaction Grabber）入站端點嘅**共享密鑰**驗證。
 *
 * ## 為什麼要抽成一支獨立模組
 * 密鑰驗證本來內嵌喺 `api/integration/grabber/orders/route.ts`。加第二條端點
 * （`grabber/store`，供插件查店名）之後，如果各自抄一份，就會出現
 * 「一條 route 補咗加固（例如 constant-time 比對），另一條冇」嘅靜默分歧
 * —— 本專案反覆中過嘅一類病。
 *
 * ## 契約
 * - header 名：`X-Grabber-Secret`（同插件 `background.js` 嘅 `grabPush()` 一致）
 * - 比對用 `timingSafeEqual` —— **唔可以用 `===`**，否則可以由回應時間逐字猜密鑰。
 * - 長度不同要先短circuit（`timingSafeEqual` 對唔同長度會 throw）。
 *
 * ⚠️ 環境變數名 `GRABBER_SHARED_SECRET`（Vercel）；插件側係 `POS_SHARED_SECRET` 常數。
 *    兩邊要一樣。
 */

export const GRABBER_SECRET_HEADER = "x-grabber-secret";

/** 共享密鑰來源（route 同測試共用同一個入口，唔好各自讀 `process.env`）。 */
export function readGrabberSharedSecret(): string | null {
  const value = process.env.GRABBER_SHARED_SECRET;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** constant-time 比對。任一邊空 → false（唔可以因為「大家都係空」而放行）。 */
export function grabberSecretsMatch(given: unknown, expected: unknown): boolean {
  const a = Buffer.from(typeof given === "string" ? given : "");
  const b = Buffer.from(typeof expected === "string" ? expected : "");
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 由請求抽密鑰（缺 header → 空字串）。 */
export function readGrabberSecretFromRequest(request: Request): string {
  return request.headers.get(GRABBER_SECRET_HEADER) ?? "";
}
