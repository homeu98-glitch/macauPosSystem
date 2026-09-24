import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  CLIENT_PRESENCE_RPC,
  POS_CLIENT_ID,
  buildClientPresenceParams,
  isUuidLike,
  sanitizePosAppVersion,
} from "./client-presence-params.ts";
import {
  CLIENT_PRESENCE_TIMEOUT_MS,
  reportPosClientPresence,
  resetClientPresenceWarningForTest,
  type ClientPresenceRpcClient,
} from "./client-presence.ts";

/**
 * Ledger 商戶端活躍上報（契約 §4.6）。
 *
 * 呢度每條規則都係「靜默錯就出事」：
 * · 上報失敗當成登入失敗 ⇒ 全店返唔到工；
 * · 上報用錯 merchant_id ⇒ Ledger Admin 顯示錯店活躍；
 * · 版本字串漏咗電話號碼 ⇒ 個資寫入對方 log；
 * · 超時冇兜住 ⇒ Ledger 打嗝拖死登入。
 */

const MERCHANT = "8291f843-6c1d-4a34-9a2f-0f3d5b7c9e11";

type RpcCall = { fn: string; args: Record<string, unknown> };

function stubClient(
  reply: { error?: { code?: string; message?: string } | null } | "throw" | "reject" | "thenable",
  calls: RpcCall[] = [],
): ClientPresenceRpcClient {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (reply === "throw") throw new Error("boom");
      if (reply === "reject") return Promise.reject(new Error("network down"));
      if (reply === "thenable") {
        const thenable = {
          then(resolve: (value: unknown) => void) {
            resolve({ error: null });
          },
        };
        return thenable as never;
      }
      return Promise.resolve(reply);
    },
  };
}

/** 永不 settle 嘅 client（用嚟驗超時）。 */
function neverSettlingClient(calls: RpcCall[] = []): ClientPresenceRpcClient {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return {
        then() {
          /* 永唔 resolve —— 模擬 Ledger 唔回應 */
        },
      } as never;
    },
  };
}

afterEach(() => {
  resetClientPresenceWarningForTest();
});

describe("sanitizePosAppVersion", () => {
  it("接受正常建置識別碼", () => {
    assert.equal(sanitizePosAppVersion("1a2b3c4"), "1a2b3c4");
    assert.equal(sanitizePosAppVersion("dev"), "dev");
    assert.equal(sanitizePosAppVersion("1.2.0"), "1.2.0");
    assert.equal(sanitizePosAppVersion("dpl_abc-123"), "dpl_abc-123");
  });

  it("去除前後空白", () => {
    assert.equal(sanitizePosAppVersion("  1a2b3c4  "), "1a2b3c4");
  });

  it("非字串／空白字串／過長 ⇒ null", () => {
    assert.equal(sanitizePosAppVersion(undefined), null);
    assert.equal(sanitizePosAppVersion(null), null);
    assert.equal(sanitizePosAppVersion(123), null);
    assert.equal(sanitizePosAppVersion("   "), null);
    assert.equal(sanitizePosAppVersion("a".repeat(41)), null);
    assert.equal(sanitizePosAppVersion("a".repeat(40)), "a".repeat(40));
  });

  it("含不正常字元 ⇒ null", () => {
    assert.equal(sanitizePosAppVersion("1.2.0 (PIN 1234)"), null);
    assert.equal(sanitizePosAppVersion("v1/2"), null);
    assert.equal(sanitizePosAppVersion("版 1"), null);
  });

  it("疑似電話號碼 ⇒ null（契約禁止把電話／PIN 放進 p_app_version）", () => {
    assert.equal(sanitizePosAppVersion("60000002"), null);
    assert.equal(sanitizePosAppVersion("a60000002"), null);
    assert.equal(sanitizePosAppVersion("1.2.0-60000002"), null);
  });
});

describe("isUuidLike", () => {
  it("標準 UUID 通過（大小寫、前後空白皆可）", () => {
    assert.equal(isUuidLike(MERCHANT), true);
    assert.equal(isUuidLike(`  ${MERCHANT.toUpperCase()}  `), true);
  });

  it("非 UUID ⇒ false", () => {
    assert.equal(isUuidLike("8291f843"), false);
    assert.equal(isUuidLike(""), false);
    assert.equal(isUuidLike(undefined), false);
    assert.equal(isUuidLike("print-11e37b9e"), false);
  });
});

describe("buildClientPresenceParams", () => {
  it("砌出 PostgREST 具名參數，p_client 固定 pos", () => {
    assert.deepEqual(buildClientPresenceParams(MERCHANT, "1a2b3c4"), {
      p_merchant_id: MERCHANT,
      p_client: POS_CLIENT_ID,
      p_app_version: "1a2b3c4",
    });
    assert.equal(POS_CLIENT_ID, "pos");
  });

  it("版本讀唔到 ⇒ 仍上報，但 p_app_version 係 null（唔用空字串）", () => {
    assert.deepEqual(buildClientPresenceParams(MERCHANT, ""), {
      p_merchant_id: MERCHANT,
      p_client: "pos",
      p_app_version: null,
    });
  });

  it("merchant_id 唔似 UUID ⇒ null（＝唔應該呼叫）", () => {
    assert.equal(buildClientPresenceParams("", "dev"), null);
    assert.equal(buildClientPresenceParams(null, "dev"), null);
    assert.equal(buildClientPresenceParams("d564b932", "dev"), null);
  });
});

describe("reportPosClientPresence", () => {
  it("成功 ⇒ true，並用正確 RPC 名同參數", async () => {
    const calls: RpcCall[] = [];
    const ok = await reportPosClientPresence({
      client: stubClient({ error: null }, calls),
      merchantId: MERCHANT,
      appVersion: "1a2b3c4",
      source: "login",
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, CLIENT_PRESENCE_RPC);
    assert.equal(calls[0].fn, "record_merchant_client_login");
    assert.deepEqual(calls[0].args, {
      p_merchant_id: MERCHANT,
      p_client: "pos",
      p_app_version: "1a2b3c4",
    });
  });

  it("supabase-js 嘅 thenable（唔係真 Promise）一樣處理得", async () => {
    const ok = await reportPosClientPresence({
      client: stubClient("thenable"),
      merchantId: MERCHANT,
      source: "restore",
    });
    assert.equal(ok, true);
  });

  it("RPC 回錯誤 ⇒ false，唔 throw", async () => {
    const ok = await reportPosClientPresence({
      client: stubClient({ error: { message: "not authorized" } }),
      merchantId: MERCHANT,
      source: "restore",
    });
    assert.equal(ok, false);
  });

  it("Ledger 未部署 RPC（PGRST202）⇒ false，唔 throw", async () => {
    const ok = await reportPosClientPresence({
      client: stubClient({ error: { code: "PGRST202", message: "Could not find the function" } }),
      merchantId: MERCHANT,
      source: "login",
    });
    assert.equal(ok, false);
  });

  it("client 同步 throw / promise reject ⇒ false，唔 throw", async () => {
    assert.equal(
      await reportPosClientPresence({
        client: stubClient("throw"),
        merchantId: MERCHANT,
        source: "login",
      }),
      false,
    );
    assert.equal(
      await reportPosClientPresence({
        client: stubClient("reject"),
        merchantId: MERCHANT,
        source: "restore",
      }),
      false,
    );
  });

  it("超時 ⇒ 限時內回 false（唔可以吊死登入）", async () => {
    const calls: RpcCall[] = [];
    const startedAt = Date.now();
    const ok = await reportPosClientPresence({
      client: neverSettlingClient(calls),
      merchantId: MERCHANT,
      source: "login",
      timeoutMs: 30,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(ok, false);
    assert.equal(calls.length, 1);
    assert.ok(elapsed < 1_000, `耗時 ${elapsed}ms，超時冇生效`);
  });

  it("冇 client / merchant_id 唔合法 ⇒ 唔會呼叫", async () => {
    const calls: RpcCall[] = [];
    assert.equal(
      await reportPosClientPresence({
        client: null,
        merchantId: MERCHANT,
        source: "restore",
      }),
      false,
    );
    assert.equal(
      await reportPosClientPresence({
        client: stubClient({ error: null }, calls),
        merchantId: "not-a-uuid",
        source: "restore",
      }),
      false,
    );
    assert.equal(calls.length, 0);
  });

  it("版本似電話號碼 ⇒ 一樣上報，但唔會漏個號碼出去", async () => {
    const calls: RpcCall[] = [];
    const ok = await reportPosClientPresence({
      client: stubClient({ error: null }, calls),
      merchantId: MERCHANT,
      appVersion: "60000002",
      source: "login",
    });
    assert.equal(ok, true);
    assert.equal(calls[0].args.p_app_version, null);
  });

  it("「Ledger 未部署」只嘈一次，唔會洗版", async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      for (let i = 0; i < 3; i += 1) {
        await reportPosClientPresence({
          client: stubClient({ error: { code: "PGRST202", message: "not found" } }),
          merchantId: MERCHANT,
          source: "restore",
        });
      }
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
  });

  it("超時上限有預設值（唔會係 0／undefined）", () => {
    assert.ok(CLIENT_PRESENCE_TIMEOUT_MS > 0);
    assert.ok(CLIENT_PRESENCE_TIMEOUT_MS <= 10_000);
  });
});
