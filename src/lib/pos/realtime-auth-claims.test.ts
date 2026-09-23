import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REALTIME_AUTH_FAILURE_COOLDOWN_MS,
  REALTIME_AUTH_SKEW_MS,
  decideRealtimeAuth,
  decodeJwtPayload,
  isAnonymousClaims,
  isUsableBoundToken,
  readExpiryMs,
  readStoreIdFromClaims,
} from "./realtime-auth-claims.ts";

/**
 * 《Realtime per-store 憑證 —— 純決策》守衛（2026-09-23，第 2 階段）。
 *
 * ## 為何呢幾條一定要守住（後果係災難級而唔係效能級）
 *
 * 呢個 module 嘅決策錯，唔會令任何嘢 crash —— 但會令 Realtime 用錯身份，
 * 而 Supabase **唔會報錯**（channel 照樣 `SUBSCRIBED`）：
 *   · 判得太保守（明明可以重用卻去登入）→ 用戶表爆炸 + 每次重連多打幾個請求；
 *   · 判得太進取（token 冇 store claim 都照交出去）→ **一個事件都唔推**
 *     ⇒ 出紙失去即時喚醒（退化成最長 180 秒）、訂單唔再自動彈出。
 *
 * ⇒ 一律「唔肯定就回 unavailable／唔交出去」，最壞情況等於今日（anon）。
 */

/** 砌一個「形狀正確但冇簽名」嘅 JWT（只為測 payload 解析；授權唔靠呢個）。 */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64(payload)}.sig`;
}

const STORE = "8291f843-9def-4956-9d0b-1cfef2598306";

describe("realtime-auth-claims ── JWT payload 解析", () => {
  it("解得出 payload（含 UTF-8 中文）", () => {
    const token = fakeJwt({ sub: "u1", note: "澳門收銀台", app_metadata: { store_id: STORE } });
    const claims = decodeJwtPayload(token);
    assert.equal(claims?.["sub"], "u1");
    assert.equal(claims?.["note"], "澳門收銀台");
  });

  it("🔴 解唔到（格式錯／null／亂碼）一律回 null，唔可以 throw", () => {
    for (const bad of [null, undefined, "", "abc", "a.b", "a.!!!not-base64!!!.c"]) {
      assert.doesNotThrow(() => decodeJwtPayload(bad as string | null | undefined));
      assert.equal(decodeJwtPayload(bad as string | null | undefined), null);
    }
  });

  it("payload 唔係物件（例如係 JSON 字串或數字）回 null", () => {
    const b64 = Buffer.from('"just-a-string"', "utf8").toString("base64url");
    assert.equal(decodeJwtPayload(`h.${b64}.s`), null);
  });
});

describe("realtime-auth-claims ── 讀 store / exp / 匿名旗標", () => {
  it("🔴 `app_metadata.store_id` 優先（Supabase Auth 簽發路徑）", () => {
    const claims = decodeJwtPayload(
      fakeJwt({ app_metadata: { store_id: STORE }, store_id: "另一間店" }),
    );
    assert.equal(readStoreIdFromClaims(claims), STORE);
  });

  it("只有頂層 `store_id` 都用（自簽路徑，向後兼容）", () => {
    const claims = decodeJwtPayload(fakeJwt({ store_id: STORE }));
    assert.equal(readStoreIdFromClaims(claims), STORE);
  });

  it("兩者都冇／係空字串 → null（唔可以當成「已綁店」）", () => {
    for (const payload of [{}, { app_metadata: {} }, { store_id: "   " }, { app_metadata: { store_id: null } }]) {
      assert.equal(readStoreIdFromClaims(decodeJwtPayload(fakeJwt(payload))), null);
    }
  });

  it("exp 讀得出秒 → 毫秒；讀唔到回 null（＝唔可以判斷，要當「需要換」）", () => {
    const claims = decodeJwtPayload(fakeJwt({ exp: 1_700_000_000 }));
    assert.equal(readExpiryMs(claims), 1_700_000_000_000);
    assert.equal(readExpiryMs(decodeJwtPayload(fakeJwt({}))), null);
    assert.equal(readExpiryMs(decodeJwtPayload(fakeJwt({ exp: "bad" }))), null);
  });

  it("is_anonymous 只認嚴格 `true`", () => {
    assert.equal(isAnonymousClaims(decodeJwtPayload(fakeJwt({ is_anonymous: true }))), true);
    for (const v of [false, "true", 1, null, undefined]) {
      assert.equal(isAnonymousClaims(decodeJwtPayload(fakeJwt({ is_anonymous: v }))), false);
    }
  });
});

describe("realtime-auth-claims ── decideRealtimeAuth", () => {
  const NOW = 1_700_000_000_000;

  function decide(over: Partial<Parameters<typeof decideRealtimeAuth>[0]> = {}) {
    return decideRealtimeAuth({
      storeId: STORE,
      hasClient: true,
      hasDeviceToken: true,
      coolingDown: false,
      session: null,
      nowMs: NOW,
      ...over,
    });
  }

  it("🔴 冇 store／冇 client／冇終端憑證／冷卻中 → 一律 unavailable（＝保持 anon）", () => {
    assert.deepEqual(decide({ storeId: null }), { action: "unavailable", reason: "no-store" });
    assert.deepEqual(decide({ storeId: "   " }), { action: "unavailable", reason: "no-store" });
    assert.deepEqual(decide({ hasClient: false }), { action: "unavailable", reason: "no-client" });
    // 冇終端憑證 ＝ 綁唔到店（掃碼客人 / Kiosk）⇒ 一定要 fail-safe 保持 anon
    assert.deepEqual(decide({ hasDeviceToken: false }), {
      action: "unavailable",
      reason: "no-device-token",
    });
    assert.deepEqual(decide({ coolingDown: true }), {
      action: "unavailable",
      reason: "cooling-down",
    });
  });

  it("冇 session → sign-in", () => {
    assert.deepEqual(decide(), { action: "sign-in" });
  });

  it("已綁對店而且未到期 → reuse（零請求）", () => {
    const token = fakeJwt({ app_metadata: { store_id: STORE }, exp: (NOW + 30 * 60_000) / 1000 });
    assert.deepEqual(decide({ session: { accessToken: token, claims: decodeJwtPayload(token) } }), {
      action: "reuse",
      token,
    });
  });

  it("🔴 已綁對店但快到期（< skew）→ bind（交上層 refresh，唔可以照用）", () => {
    const token = fakeJwt({
      app_metadata: { store_id: STORE },
      exp: (NOW + REALTIME_AUTH_SKEW_MS - 1000) / 1000,
    });
    assert.deepEqual(decide({ session: { accessToken: token, claims: decodeJwtPayload(token) } }), {
      action: "bind",
      accessToken: token,
    });
  });

  it("🔴 exp 讀唔到 → 當「唔夠新」，走 bind（唔可以博）", () => {
    const token = fakeJwt({ app_metadata: { store_id: STORE } });
    assert.deepEqual(decide({ session: { accessToken: token, claims: decodeJwtPayload(token) } }), {
      action: "bind",
      accessToken: token,
    });
  });

  it("🔴 綁錯店（claim 係另一間）→ bind（唔可以照用，否則 RLS 全拒）", () => {
    const token = fakeJwt({ app_metadata: { store_id: "別店" }, exp: (NOW + 3600_000) / 1000 });
    assert.deepEqual(decide({ session: { accessToken: token, claims: decodeJwtPayload(token) } }), {
      action: "bind",
      accessToken: token,
    });
  });

  it("完全冇 store claim（剛 signInAnonymously 未綁）→ bind", () => {
    const token = fakeJwt({ is_anonymous: true, exp: (NOW + 3600_000) / 1000 });
    assert.deepEqual(decide({ session: { accessToken: token, claims: decodeJwtPayload(token) } }), {
      action: "bind",
      accessToken: token,
    });
  });

  it("session 冇 accessToken（異常形狀）→ 當冇 session，去 sign-in", () => {
    assert.deepEqual(decide({ session: { accessToken: "", claims: null } }), { action: "sign-in" });
  });
});

describe("realtime-auth-claims ── isUsableBoundToken（交出去之前最後一道閘）", () => {
  it("🔴 帶正確 store claim → true", () => {
    assert.equal(isUsableBoundToken(fakeJwt({ app_metadata: { store_id: STORE } }), STORE), true);
    assert.equal(isUsableBoundToken(fakeJwt({ store_id: STORE }), STORE), true);
  });

  it("🔴 冇 claim／錯店／解唔到 → false（寧願保持 anon，都唔可以交出去）", () => {
    const cases = [
      fakeJwt({}),
      fakeJwt({ app_metadata: { store_id: "別店" } }),
      "not-a-jwt",
      "",
    ];
    for (const t of cases) {
      assert.equal(isUsableBoundToken(t, STORE), false, `唔應該接受：${t.slice(0, 24)}`);
    }
  });
});

describe("realtime-auth-claims ── 常數合理性", () => {
  it("skew 同冷卻都要 > 0（0 會令每次都重登入／每次都重試失敗）", () => {
    assert.ok(REALTIME_AUTH_SKEW_MS > 0);
    assert.ok(REALTIME_AUTH_FAILURE_COOLDOWN_MS > 0);
    // skew 唔應該長過 Supabase 預設 1 小時 token TTL，否則永遠都「唔夠新」
    assert.ok(REALTIME_AUTH_SKEW_MS < 30 * 60_000);
  });
});
