import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.TOPUP_SITEA_SSO_SECRET = "test-secret-for-unit";

import {
  createTopupSessionStore,
  extractSessionCookie,
  readSessionCookieFromResponse,
  TOPUP_SESSION_COOKIE,
} from "./owner-session.server.ts";

/**
 * topUpAutomation 店主 session 換票（2026-10-13）。
 *
 * 為何要用測試鎖死：macau-pos 嘅「會員充值審核」原生面板曾經 **100% 報
 * 「請先以店主身份登入」**，但用戶其實已經正常登入 POS —— 真兇係已部署嘅 topup
 * `/api/owner/*` 只認 `topup_session` cookie、唔讀 `Authorization`。呢個 store 就係嗰條
 * 修復嘅核心，而它有幾個**靜默**失效模式，全部要鎖：
 *   · **唔換票／只帶 Bearer** → 又返 401，但 UI 睇落好似「用戶冇登入」，好難查。
 *   · **重用同一支 JWT** → topup 嘅 `membership_token_logins` 對 `jti` unique，第二次開始
 *     全部「登入 token 已被使用」。
 *   · **快取永不失效** → session 被踢就永久壞死（要有 401 → refresh 通道）。
 */

const IDENTITY = { shopId: "60000001", shopName: "測試舖", ownerLogin: "60000001" };

function jsonResponse(status: number, payload: unknown, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(payload), { status, headers });
}

function decodeJwt(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

describe("extractSessionCookie", () => {
  it("淨係認 topup_session，並掉晒 Path／HttpOnly 等 attribute", () => {
    assert.equal(
      extractSessionCookie(`${TOPUP_SESSION_COOKIE}=abc.def; Path=/; HttpOnly; SameSite=None; Secure`),
      `${TOPUP_SESSION_COOKIE}=abc.def`,
    );
  });

  it("其他 cookie／垃圾一律當冇（唔可以認錯名）", () => {
    assert.equal(extractSessionCookie("other_session=abc"), "");
    assert.equal(extractSessionCookie(""), "");
    assert.equal(extractSessionCookie("topup_sessionX=abc"), "");
  });
});

describe("readSessionCookieFromResponse", () => {
  it("多條 Set-Cookie 裡面揀中 topup_session 嗰條", () => {
    const res = jsonResponse(200, {}, ["other=1; Path=/", `${TOPUP_SESSION_COOKIE}=hit; Path=/`]);
    assert.equal(readSessionCookieFromResponse(res), `${TOPUP_SESSION_COOKIE}=hit`);
  });

  it("冇 set-cookie → 空字串（唔可以當成功）", () => {
    assert.equal(readSessionCookieFromResponse(jsonResponse(200, {})), "");
  });
});

describe("createTopupSessionStore", () => {
  it("第一次 get 會打 sso-login 換票；第二次（未過期）直接重用", async () => {
    let calls = 0;
    const store = createTopupSessionStore({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, { user: { role: "owner" } }, [`${TOPUP_SESSION_COOKIE}=s1`]);
      },
    });

    assert.equal(await store.get(IDENTITY), `${TOPUP_SESSION_COOKIE}=s1`);
    assert.equal(await store.get(IDENTITY), `${TOPUP_SESSION_COOKIE}=s1`);
    assert.equal(calls, 1, "快取期內唔可以重複換票（每次換票都會寫一筆 membership_token_logins）");
  });

  it("🔴 每次換票都用新 jti（topup 嘅 jti 係 unique，重用會被拒）", async () => {
    const tokens: string[] = [];
    const store = createTopupSessionStore({
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body ?? "{}")) as { ssoToken?: string };
        tokens.push(String(body.ssoToken ?? ""));
        return jsonResponse(200, {}, [`${TOPUP_SESSION_COOKIE}=s${tokens.length}`]);
      },
    });

    await store.refresh(IDENTITY);
    await store.refresh(IDENTITY);

    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
    assert.notEqual(decodeJwt(tokens[0]).jti, decodeJwt(tokens[1]).jti, "jti 必須每次唔同");
  });

  it("TTL 過期 → 重新換票（session 唔可以永久重用）", async () => {
    let now = 1_000_000;
    let serial = 0;
    const store = createTopupSessionStore({
      now: () => now,
      ttlMs: 1000,
      fetchImpl: async () => {
        serial += 1;
        return jsonResponse(200, {}, [`${TOPUP_SESSION_COOKIE}=s${serial}`]);
      },
    });

    assert.equal(await store.get(IDENTITY), `${TOPUP_SESSION_COOKIE}=s1`);
    now += 2000;
    assert.equal(await store.get(IDENTITY), `${TOPUP_SESSION_COOKIE}=s2`, "過期要換新票");
  });

  it("401 之後 refresh 會掉舊票換新嘅", async () => {
    let serial = 0;
    const store = createTopupSessionStore({
      fetchImpl: async () => {
        serial += 1;
        return jsonResponse(200, {}, [`${TOPUP_SESSION_COOKIE}=s${serial}`]);
      },
    });

    assert.equal(await store.get(IDENTITY), `${TOPUP_SESSION_COOKIE}=s1`);
    assert.equal(await store.refresh(IDENTITY), `${TOPUP_SESSION_COOKIE}=s2`);
    assert.equal(await store.get(IDENTITY), `${TOPUP_SESSION_COOKIE}=s2`);
  });

  it("remember 會用 owner API 回應嘅新 cookie 更新快取", async () => {
    const store = createTopupSessionStore({
      fetchImpl: async () => jsonResponse(200, {}, [`${TOPUP_SESSION_COOKIE}=old`]),
    });

    assert.equal(await store.get(IDENTITY), `${TOPUP_SESSION_COOKIE}=old`);
    store.remember(IDENTITY.shopId, jsonResponse(200, { rows: [] }, [`${TOPUP_SESSION_COOKIE}=refreshed`]));
    assert.equal(await store.get(IDENTITY), `${TOPUP_SESSION_COOKIE}=refreshed`);
  });

  it("換票失敗要帶 topup 嘅中文原因出嚟（唔可以食錯做 Network error）", async () => {
    const store = createTopupSessionStore({
      fetchImpl: async () => jsonResponse(400, { error: "登入 token 驗證失敗" }),
    });

    await assert.rejects(() => store.get(IDENTITY), /登入 token 驗證失敗/);
  });

  it("200 但冇 cookie → 都當失敗（否則會拎住空 cookie 去打 owner API）", async () => {
    const store = createTopupSessionStore({
      fetchImpl: async () => jsonResponse(200, { user: { role: "owner" } }),
    });

    await assert.rejects(() => store.get(IDENTITY), /未能取得店主 session/);
  });
});
