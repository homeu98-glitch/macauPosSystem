import { getTopupBaseUrl, signTopupOwnerSsoToken } from "./sso.server.ts";

/**
 * topUpAutomation 嘅店主 session（2026-10-13 抽出嚟，配合 `/api/topup/owner/*` proxy）。
 *
 * 🔴 行為背景（唔好「簡化」走任何一步）：已部署嘅 topup 係 `api/index.js` catch-all →
 *   `routes/owner/*.js`，嗰啲 route 用 `readSession(req)` **只認 `topup_session` cookie**，
 *   完全唔讀 `Authorization`。所以 macau-pos 一定要先 `POST /api/auth/sso-login` 換 cookie，
 *   再用 `Cookie` 頭打 `/api/owner/*` —— 呢個就係鏡像 `owner.html?ssoToken=` 嘅瀏覽器行為。
 *
 * 🔴 每次換票都要**重簽** JWT：topup 嘅 `membership_token_logins` 對 `jti` 係 unique，
 *   重用同一支 token 會返「登入 token 已被使用，請重新從主系統進入」。
 */

export type TopupOwnerIdentity = {
  shopId: string;
  shopName: string;
  ownerLogin: string;
};

/** topup `lib/session.js` 嘅 COOKIE_NAME。 */
export const TOPUP_SESSION_COOKIE = "topup_session";

/**
 * 快取有效期。topup cookie 本身 7 日，但每次換票都會寫一筆 `membership_token_logins`，
 * 換太密會堆垃圾 —— 6 小時一次足夠。
 */
export const TOPUP_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/** 由 Set-Cookie 抽出 `topup_session=...`（淨係要 value，掉晒 Path／HttpOnly 等 attribute）。 */
export function extractSessionCookie(headerValue: string): string {
  const pair = String(headerValue ?? "")
    .split(";")[0]
    ?.trim();
  return pair && pair.startsWith(`${TOPUP_SESSION_COOKIE}=`) ? pair : "";
}

type SetCookieCapableHeaders = Headers & { getSetCookie?: () => string[] };

export function readSessionCookieFromResponse(res: Response): string {
  const headers = res.headers as SetCookieCapableHeaders;
  const entries = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  if (entries.length) {
    for (const entry of entries) {
      const hit = extractSessionCookie(entry);
      if (hit) return hit;
    }
    return "";
  }
  return extractSessionCookie(res.headers.get("set-cookie") ?? "");
}

export type TopupSessionStoreOptions = {
  /** 測試用注入；生產行 default `fetch`。 */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  ttlMs?: number;
};

export type TopupSessionStore = {
  /** 攞一條可用嘅 session cookie（未過期就重用）。 */
  get: (identity: TopupOwnerIdentity) => Promise<string>;
  /** 強制重新換票（401 之後用）。 */
  refresh: (identity: TopupOwnerIdentity) => Promise<string>;
  /** topup 每次成功都會 `refreshSession` 回一條新 cookie，順手更新快取。 */
  remember: (shopId: string, res: Response) => void;
  invalidate: (shopId: string) => void;
};

export function createTopupSessionStore(options: TopupSessionStoreOptions = {}): TopupSessionStore {
  const fetchImpl =
    options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init as RequestInit));
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? TOPUP_SESSION_TTL_MS;
  const cache = new Map<string, { cookie: string; exp: number }>();

  async function exchange(identity: TopupOwnerIdentity): Promise<string> {
    const ssoToken = signTopupOwnerSsoToken(identity);
    const res = await fetchImpl(`${getTopupBaseUrl()}/api/auth/sso-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssoToken }),
    });

    const cookie = readSessionCookieFromResponse(res);
    if (!res.ok || !cookie) {
      const payload = (await res.json().catch(() => ({}))) as { error?: unknown };
      const reason = typeof payload?.error === "string" ? payload.error.trim() : "";
      throw new Error(reason || "充值審核登入失敗（未能取得店主 session）。");
    }
    return cookie;
  }

  async function refresh(identity: TopupOwnerIdentity): Promise<string> {
    const cookie = await exchange(identity);
    cache.set(identity.shopId, { cookie, exp: now() + ttlMs });
    return cookie;
  }

  async function get(identity: TopupOwnerIdentity): Promise<string> {
    const cached = cache.get(identity.shopId);
    if (cached && cached.exp > now()) return cached.cookie;
    return refresh(identity);
  }

  function remember(shopId: string, res: Response): void {
    const cookie = readSessionCookieFromResponse(res);
    if (!cookie) return;
    cache.set(shopId, { cookie, exp: now() + ttlMs });
  }

  return { get, refresh, remember, invalidate: (shopId) => cache.delete(shopId) };
}
