import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";

import {
  MOBILE_QR_CODE_ALPHABET,
  MOBILE_QR_CODE_LENGTH,
  MOBILE_QR_CODE_PATTERN,
  MOBILE_QR_DEFAULT_TTL_SECONDS,
  MOBILE_QR_MAX_TTL_SECONDS,
  MOBILE_QR_MIN_TTL_SECONDS,
  base64UrlEncode,
  buildMobileQrClaims,
  clampTtlSeconds,
  createExpenseMobileQrStore,
  generateMobileQrCode,
  issueMobileQrSession,
  sanitizeShopName,
  signHs256Jwt,
  type MobileQrCodeRow,
  type MobileQrCodeStore,
} from "./expense-mobile-qr.ts";

/**
 * 手機版庫存表 QR session 簽發（2026-10-22）。
 *
 * 覆蓋：claims 規格（對方 `verifyMacauLedgerSsoToken()` 嘅必填項）、HS256 簽名
 * round-trip、TTL clamp、短碼格式、store port 行為、缺表降級。
 */

const STORE_ID = "d564b932-0c91-45e9-86fd-0ec8e2711f13";
const ACCOUNT = "63936541";
const SECRET = "unit-test-secret-not-real";

/** 記錄 insert 咗咩嘅假 store。 */
function recordingStore(): MobileQrCodeStore & { rows: MobileQrCodeRow[] } {
  const rows: MobileQrCodeRow[] = [];
  return {
    rows,
    async insert(row: MobileQrCodeRow) {
      rows.push(row);
    },
  };
}

describe("buildMobileQrClaims ── expenseRecorder verify 規格", () => {
  const nowMs = 1_787_000_000_000; // 固定時鐘，斷言先可以穩定
  const { claims } = buildMobileQrClaims({
    storeId: STORE_ID,
    storeName: "表嫂美食",
    account: ACCOUNT,
    ttlSeconds: 300,
    nowMs,
  });

  it("必填 claims 齐全（iss/aud/sub/jti/iat/exp/role/shop.shopId）", () => {
    assert.equal(claims.iss, "macau-ledger");
    assert.equal(claims.aud, "expense-recorder");
    assert.equal(claims.sub, `owner:${STORE_ID}`);
    assert.ok(claims.jti.length > 0);
    assert.equal(claims.iat, Math.floor(nowMs / 1000));
    assert.equal(claims.exp, claims.iat + 300);
    assert.equal(claims.role, "owner");
    assert.equal(claims.shop.shopId, STORE_ID);
    assert.equal(claims.shop.shopName, "表嫂美食");
    assert.equal(claims.owner.phone, ACCOUNT);
    assert.equal(claims.redirect.path, "/");
  });

  it("iss/aud 可被 env 覆蓋", () => {
    const { claims: c } = buildMobileQrClaims({
      storeId: STORE_ID,
      storeName: "x",
      account: ACCOUNT,
      issuer: "custom-iss",
      audience: "custom-aud",
      nowMs,
    });
    assert.equal(c.iss, "custom-iss");
    assert.equal(c.aud, "custom-aud");
  });

  it("空店名 → 回退 店號 <account>（INSERT 路徑要非空）", () => {
    const { claims: c } = buildMobileQrClaims({
      storeId: STORE_ID,
      storeName: "   ",
      account: ACCOUNT,
      nowMs,
    });
    assert.equal(c.shop.shopName, `店號 ${ACCOUNT}`);
  });

  it("jti 每次唔同（防重放靠佢）", () => {
    const a = buildMobileQrClaims({ storeId: STORE_ID, storeName: "x", account: ACCOUNT, nowMs });
    const b = buildMobileQrClaims({ storeId: STORE_ID, storeName: "x", account: ACCOUNT, nowMs });
    assert.notEqual(a.claims.jti, b.claims.jti);
  });
});

describe("signHs256Jwt ── 簽名 round-trip", () => {
  it("簽出嚟嘅 JWT 可以用同一條 HMAC 反驗（3 段 + base64url）", () => {
    const { claims } = buildMobileQrClaims({
      storeId: STORE_ID,
      storeName: "表嫂美食",
      account: ACCOUNT,
      nowMs: 1_787_000_000_000,
    });
    const jwt = signHs256Jwt(claims as unknown as Record<string, unknown>, SECRET);
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);
    // header
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    assert.deepEqual(header, { alg: "HS256", typ: "JWT" });
    // payload 解返原 claims
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    assert.equal(payload.sub, `owner:${STORE_ID}`);
    assert.equal(payload.role, "owner");
    // signature = HMAC-SHA256(secret, header.payload)
    const expected = crypto.createHmac("sha256", SECRET).update(`${parts[0]}.${parts[1]}`).digest("base64url");
    assert.equal(parts[2], expected);
  });

  it("唔同 secret → 簽名唔同", () => {
    const claims = { iss: "macau-ledger", aud: "expense-recorder" };
    assert.notEqual(signHs256Jwt(claims, "a"), signHs256Jwt(claims, "b"));
  });

  it("base64UrlEncode：URL 安全（無 + / =）", () => {
    const enc = base64UrlEncode("??????");
    assert.ok(!/[+/=]/.test(enc));
    assert.equal(Buffer.from(enc, "base64url").toString("utf8"), "??????");
  });
});

describe("clampTtlSeconds", () => {
  it("預設 300", () => {
    assert.equal(clampTtlSeconds(undefined), MOBILE_QR_DEFAULT_TTL_SECONDS);
  });
  it("非數字 → 預設", () => {
    assert.equal(clampTtlSeconds(Number.NaN), MOBILE_QR_DEFAULT_TTL_SECONDS);
  });
  it("太低 → 下限 60", () => {
    assert.equal(clampTtlSeconds(1), MOBILE_QR_MIN_TTL_SECONDS);
  });
  it("太高 → 上限 900", () => {
    assert.equal(clampTtlSeconds(99999), MOBILE_QR_MAX_TTL_SECONDS);
  });
  it("小數 → 向下取整", () => {
    assert.equal(clampTtlSeconds(120.9), 120);
  });
});

describe("generateMobileQrCode", () => {
  it("10 位、Crockford 字母表、格式 regex 匹配", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateMobileQrCode();
      assert.equal(code.length, MOBILE_QR_CODE_LENGTH);
      assert.ok(MOBILE_QR_CODE_PATTERN.test(code), `短碼唔喺 alphabet: ${code}`);
      for (const ch of code) assert.ok(MOBILE_QR_CODE_ALPHABET.includes(ch));
    }
  });
  it("連續生成唔重複（實測 500 粒零碰撞）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateMobileQrCode());
    assert.equal(seen.size, 500);
  });
});

describe("sanitizeShopName", () => {
  it("正常名照用", () => {
    assert.equal(sanitizeShopName("表嫂美食", ACCOUNT), "表嫂美食");
  });
  it("超長 → 截 60", () => {
    assert.equal(sanitizeShopName("A".repeat(100), ACCOUNT).length, 60);
  });
  it("空 → 店號", () => {
    assert.equal(sanitizeShopName("", ACCOUNT), `店號 ${ACCOUNT}`);
  });
});

describe("issueMobileQrSession ── 輸入校驗", () => {
  const baseOpts = {
    storeId: STORE_ID,
    storeName: "表嫂美食",
    account: ACCOUNT,
    secret: SECRET,
    nowMs: 1_787_000_000_000,
  };

  it("缺少 storeId → 400", async () => {
    const r = await issueMobileQrSession(recordingStore(), { ...baseOpts, storeId: "" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it("account 唔係 8 位 → 400", async () => {
    const r = await issueMobileQrSession(recordingStore(), { ...baseOpts, account: "123" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
  });

  it("secret 空白 → 500 + SSO_SECRET_MISSING（唔好寫落表）", async () => {
    const store = recordingStore();
    const r = await issueMobileQrSession(store, { ...baseOpts, secret: "  " });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 500);
      assert.equal(r.code, "SSO_SECRET_MISSING");
    }
    assert.equal(store.rows.length, 0);
  });
});

describe("issueMobileQrSession ── 成功路徑", () => {
  const store = recordingStore();
  const nowMs = 1_787_000_000_000;

  it("寫入一行 mobile_qr_sessions（短碼 + JWT + expires_at = JWT exp）", async () => {
    const r = await issueMobileQrSession(store, {
      storeId: STORE_ID,
      storeName: "表嫂美食",
      account: ACCOUNT,
      secret: SECRET,
      ttlSeconds: 300,
      nowMs,
    });
    assert.equal(r.ok, true);
    assert.equal(store.rows.length, 1);
    const row = store.rows[0];
    assert.ok(MOBILE_QR_CODE_PATTERN.test(row.code));
    assert.equal(row.external_shop_id, STORE_ID);
    assert.equal(row.expires_at, new Date((Math.floor(nowMs / 1000) + 300) * 1000).toISOString());
    if (r.ok) {
      // 回傳嘅 JWT 就係寫落表嗰粒
      assert.equal(r.ssoToken, row.sso_token);
      assert.equal(r.ttlSeconds, 300);
      assert.equal(r.claims.shop.shopId, STORE_ID);
      // 表內 JWT 解得返、簽名都對
      const parts = row.sso_token.split(".");
      assert.equal(parts.length, 3);
      const expected = crypto
        .createHmac("sha256", SECRET)
        .update(`${parts[0]}.${parts[1]}`)
        .digest("base64url");
      assert.equal(parts[2], expected);
    }
  });

  it("兩次簽發 → 兩個唔同短碼（每人打開彈窗都係新碼）", async () => {
    const s2 = recordingStore();
    const opts = {
      storeId: STORE_ID,
      storeName: "表嫂美食",
      account: ACCOUNT,
      secret: SECRET,
      nowMs,
    };
    const a = await issueMobileQrSession(s2, opts);
    const b = await issueMobileQrSession(s2, opts);
    assert.equal(a.ok && b.ok, true);
    assert.notEqual(s2.rows[0].code, s2.rows[1].code);
  });
});

describe("issueMobileQrSession ── 缺表降級", () => {
  it("insert 撞 42P01（mobile_qr_sessions 未跑 migration）→ QR_TABLE_MISSING", async () => {
    const store: MobileQrCodeStore = {
      async insert() {
        const err = new Error('relation "mobile_qr_sessions" does not exist') as Error & { code?: string };
        err.code = "42P01";
        throw err;
      },
    };
    const r = await issueMobileQrSession(store, {
      storeId: STORE_ID,
      storeName: "x",
      account: ACCOUNT,
      secret: SECRET,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, "QR_TABLE_MISSING");
      assert.equal(r.status, 500);
    }
  });

  it("insert 撞 PGRST205（schema cache）同樣當缺表", async () => {
    const store: MobileQrCodeStore = {
      async insert() {
        const err = new Error("Could not find the table") as Error & { code?: string };
        err.code = "PGRST205";
        throw err;
      },
    };
    const r = await issueMobileQrSession(store, {
      storeId: STORE_ID,
      storeName: "x",
      account: ACCOUNT,
      secret: SECRET,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "QR_TABLE_MISSING");
  });

  it("其他 DB 錯 → 一般 500（唔可以亂當缺表）", async () => {
    const store: MobileQrCodeStore = {
      async insert() {
        const err = new Error("network down") as Error & { code?: string };
        err.code = "57014";
        throw err;
      },
    };
    const r = await issueMobileQrSession(store, {
      storeId: STORE_ID,
      storeName: "x",
      account: ACCOUNT,
      secret: SECRET,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 500);
      assert.equal(r.code, undefined);
    }
  });
});

describe("createExpenseMobileQrStore ── adapter 拋錯語意", () => {
  it("insert 成功 → 唔拋；supabase 回 error → 原樣拋（交番畀上層分類）", async () => {
    let insertArg: MobileQrCodeRow | null = null;
    let throwOnNext = false;
    const fakeClient = {
      from() {
        return {
          insert(row: MobileQrCodeRow) {
            if (throwOnNext) {
              return Promise.resolve({ error: { code: "23505", message: "dup" } });
            }
            insertArg = row;
            return Promise.resolve({ error: null });
          },
        };
      },
    };
    const store = createExpenseMobileQrStore(fakeClient as never);
    await store.insert({
      code: "ABCDEFGHKM",
      sso_token: "t",
      external_shop_id: STORE_ID,
      expires_at: new Date(0).toISOString(),
    });
    const captured = insertArg as MobileQrCodeRow | null;
    assert.equal(captured?.code, "ABCDEFGHKM");

    throwOnNext = true;
    await assert.rejects(() =>
      store.insert({ code: "X", sso_token: "t", external_shop_id: STORE_ID, expires_at: "" }),
    );
  });
});
