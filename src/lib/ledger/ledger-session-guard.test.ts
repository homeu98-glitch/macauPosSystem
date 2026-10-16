import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《Ledger 店員 session 請求量》不可回退約束守衛（2026-10-16，對應 Ledger PR#40）。
 *
 * ## 為咩要呢個檔
 *
 * `ensureLedgerSession()` 之前每次呼叫都 `setSession()`，supabase-js 2.112 喺 token
 * 未過期時固定打 `GET /auth/v1/user` ⇒ 晚市一台 iPad 154 次／時。
 * 修法（single-flight + 分流）如果冇測試釘住，下一個「順手改順啲」嘅人就會改返回去，
 * 而且**唔會有任何 error**——只係 Ledger 配額靜靜地燒。
 *
 * 斷言全部讀**未註釋**原始碼（註解會提及 API 名稱，唔剝會假失敗）。
 * 用 `node --test` 直接跑：只認 node 內建模組，一律讀原始碼做字串斷言。
 */

const SRC = new URL("../../", import.meta.url);

function readSrc(rel: string): string {
  return readFileSync(new URL(rel, SRC), "utf8");
}

/** 剝走 TypeScript 註釋行（`//`、`*`、`/*` 開頭）；順手正則化 CRLF。 */
function stripTsComments(src: string): string {
  return src
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

function readSrcCode(rel: string): string {
  return stripTsComments(readSrc(rel));
}

/** 數「未註釋碼」入面某 pattern 出現次數。 */
function countMatches(haystack: string, needle: RegExp): number {
  return haystack.match(needle)?.length ?? 0;
}

describe("Ledger session egress 守衛 ── session.ts 分流（PR#40）", () => {
  const code = readSrcCode("lib/ledger/session.ts");

  it("決策必須經純函式 decideLedgerSessionAction（唔可以內聯湧返落 session.ts）", () => {
    assert.ok(
      code.includes("decideLedgerSessionAction"),
      "session.ts 冇用 decideLedgerSessionAction ⇒ 分流判斷會漂移，而且 node --test 覆蓋唔到",
    );
  });

  it("一定要 single-flight（7 個 mount 併發 + refresh token rotation race）", () => {
    assert.match(
      code,
      /sessionInFlight/,
      "冇 single-flight 閂 ⇒ 開頁 7 個 restoreLedgerSession 併發，而且 refresh／bootstrap " +
        "競態會誤彈登出（舊 refresh token 已被輪換）",
    );
  });

  it("🔴 session.ts 入面只可以有一處 client.auth.setSession( 呼叫（每頁最多一次）", () => {
    const n = countMatches(code, /client\.auth\.setSession\(/g);
    assert.equal(
      n,
      1,
      `session.ts 有 ${n} 處 setSession —— 每多一處就意味住「每次呼叫都打 ` +
        "GET /auth/v1/user」嘅風暴可能翻生（supabase-js 2.112 未過期都驗票）",
    );
  });

  it("快取路徑一定要 getSession()、刷新路徑一定要 refreshSession()", () => {
    assert.match(code, /client\.auth\.getSession\(/, "冇 getSession() ⇒ 冇零網路快取路徑");
    assert.match(code, /client\.auth\.refreshSession\(/, "冇 refreshSession() ⇒ 過期票會打出去 401");
  });
});

describe("Ledger session egress 守衛 ── 核銷券 operator id（PR#40）", () => {
  const code = readSrcCode("lib/ledger/rewards.ts");

  it("🔴 核銷券唔可以再打 client.auth.getUser()（每次核銷多一次 GET /auth/v1/user）", () => {
    assert.ok(
      !code.includes("auth.getUser"),
      "rewards.ts 仍然呼叫 auth.getUser() —— user.id 等同 JWT sub，應該本地解碼",
    );
  });

  it("p_operator_id 要保留（唔可以為咗省請求而傳空）", () => {
    assert.ok(code.includes("p_operator_id"), "p_operator_id 唔見咗 ⇒ 核銷審計線斷返");
  });
});

describe("Ledger session egress 守衛 ── ensure-customer 票源（PR#40）", () => {
  const code = readSrcCode("lib/ledger/ensure-customer.ts");

  it("唔可以直讀 storage 舊票（getLedgerAccessToken）——刷新過會用过期票", () => {
    assert.ok(
      !code.includes("getLedgerAccessToken"),
      "ensure-customer.ts 仍然直讀 storage 舊票 ⇒ library 刷新／另一分頁刷新後會 401",
    );
  });

  it("要經 ensureLedgerSession() 拎最新票", () => {
    assert.ok(code.includes("ensureLedgerSession()"), "ensure-customer.ts 冇行 ensureLedgerSession()");
  });
});

describe("Ledger session egress 守衛 ── realtime 換票保險（PR#40 第 4 點）", () => {
  const code = readSrcCode("lib/ledger/supabase-client.ts");

  it("一定要顯式掛 onAuthStateChange（library 內置行為係私有，升級會靜默壞）", () => {
    assert.ok(
      code.includes("onAuthStateChange"),
      "冇顯式 listener ⇒ 靠 supabase-js 私有 _handleTokenChanged；升級換行為就會出現 " +
        "「開超過 1 小時畫面顯示已連線、新單唔進來」且零 error",
    );
  });

  it("listener 要認 TOKEN_REFRESHED（autoRefresh 只更新 REST，WebSocket 唔會自己換票）", () => {
    assert.match(code, /TOKEN_REFRESHED/, "listener 唔認 TOKEN_REFRESHED ⇒ Realtime 永遠用舊票");
  });

  it("client 創建時要註冊換票同步", () => {
    assert.ok(
      code.includes("registerLedgerAuthTokenSync(ledgerClient)"),
      "創建 client 嗰陣冇註冊 registerLedgerAuthTokenSync ⇒ listener 根本冇掛上",
    );
  });
});

describe("Ledger session egress 守衛 ── 9 月守衛唔可以碰（PR#40 第 5 點）", () => {
  const ordersHook = readSrcCode("lib/ledger/use-ledger-orders-realtime.ts");
  const productsHook = readSrcCode("lib/ledger/use-ledger-products-realtime.ts");

  it("CLOSED 要當斷線處理（2026-09-15 加固：入 CLOSED 永久靜默收唔到新單）", () => {
    for (const [name, code] of [
      ["orders", ordersHook],
      ["products", productsHook],
    ] as const) {
      assert.ok(
        /CHANNEL_ERROR/.test(code) && /TIMED_OUT/.test(code) && /CLOSED/.test(code),
        `${name} hook 唔再處理 CLOSED ⇒ 斷線後永久靜默`,
      );
    }
  });

  it("channel !== ch 守衛要在（自己 removeChannel 送嘅 CLOSED 唔可以當斷線）", () => {
    for (const [name, code] of [
      ["orders", ordersHook],
      ["products", productsHook],
    ] as const) {
      assert.ok(
        /channel !== ch/.test(code),
        `${name} hook 冇咗 channel !== ch ⇒ 回前景移除舊 channel 會形成死循環燒配額`,
      );
    }
  });
});
