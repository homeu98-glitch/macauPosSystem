import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LEDGER_REFRESH_SKEW_MS,
  decideLedgerSessionAction,
  type LedgerSessionDecisionInput,
} from "./ledger-session-decision.ts";

/**
 * 《Ledger 店員 session 分流決策》守衛（2026-10-16，對應 Ledger PR#40）。
 *
 * 決策錯嘅後果（全部係**靜默**型，Supabase 唔會報錯）：
 *   · 每次都判 bootstrap ⇒ `GET /auth/v1/user` 風暴翻生（晚市 iPad 154 次／時）；
 *   · 該 refresh 唔 refresh ⇒ 過期票打出去 ⇒ RPC 401「登入已過期」；
 *   · 該 bootstrap 唔 bootstrap ⇒ 另一分頁登入過，呢頁停留舊身份；
 *   · client 先醒 refresh 過（rotation）卻去 bootstrap ⇒ 舊 refresh token 已死 ⇒ 誤彈登出。
 */

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function base(overrides: Partial<LedgerSessionDecisionInput> = {}): LedgerSessionDecisionInput {
  return {
    storedAccessToken: "stored.jwt.token",
    storedExpiresAtMs: NOW + HOUR,
    clientAccessToken: "stored.jwt.token",
    clientExpiresAtMs: NOW + HOUR,
    nowMs: NOW,
    ...overrides,
  };
}

describe("ledger-session-decision ── 常量", () => {
  it("刷新提前量係 5 分鐘（提案口徑）", () => {
    assert.equal(LEDGER_REFRESH_SKEW_MS, 5 * 60 * 1000);
  });
});

describe("ledger-session-decision ── 未登入", () => {
  it("storage 冇 token ⇒ unauthorized（上層 return null）", () => {
    assert.deepEqual(decideLedgerSessionAction(base({ storedAccessToken: null })), {
      action: "unauthorized",
    });
  });

  it("storage 冇 token，就算 client 有 session 都唔放行（已登出要踢全端）", () => {
    assert.deepEqual(
      decideLedgerSessionAction(base({ storedAccessToken: null, clientAccessToken: "x.jwt.y" })),
      { action: "unauthorized" },
    );
  });
});

describe("ledger-session-decision ── bootstrap（每頁一次 setSession）", () => {
  it("client 未接管過 session ⇒ bootstrap", () => {
    assert.deepEqual(decideLedgerSessionAction(base({ clientAccessToken: null })), {
      action: "bootstrap",
    });
  });

  it("storage 張仍然有效但同 client 唔同 ⇒ bootstrap（另一分頁登入過，要換身份）", () => {
    assert.deepEqual(
      decideLedgerSessionAction(
        base({ storedAccessToken: "new-staff.jwt", clientAccessToken: "old-staff.jwt" }),
      ),
      { action: "bootstrap" },
    );
  });

  it("storage 張仍有效、client 張快過期 ⇒ 都係 bootstrap（storage 係新身份）", () => {
    assert.deepEqual(
      decideLedgerSessionAction(
        base({
          storedAccessToken: "new-staff.jwt",
          clientAccessToken: "old-staff.jwt",
          clientExpiresAtMs: NOW + 60_000,
        }),
      ),
      { action: "bootstrap" },
    );
  });
});

describe("ledger-session-decision ── reuse（零網路）", () => {
  it("同一張票、未過期 ⇒ reuse", () => {
    assert.deepEqual(decideLedgerSessionAction(base()), { action: "reuse" });
  });

  it("剛剛過刷新線外 1ms ⇒ reuse（≤ 先 refresh，> 先重用）", () => {
    assert.deepEqual(
      decideLedgerSessionAction(base({ clientExpiresAtMs: NOW + LEDGER_REFRESH_SKEW_MS + 1 })),
      { action: "reuse" },
    );
  });

  it("client 先醒 refresh 過（storage 舊票已過期）⇒ 以 client 為準 reuse", () => {
    assert.deepEqual(
      decideLedgerSessionAction(
        base({
          storedAccessToken: "old.jwt",
          storedExpiresAtMs: NOW - 1_000,
          clientAccessToken: "rotated.jwt",
          clientExpiresAtMs: NOW + HOUR,
        }),
      ),
      { action: "reuse" },
    );
  });

  it("storage 到期時間讀唔到 + 票唔同 ⇒ 唔可以 bootstrap（舊票可能已死），以 client 為準", () => {
    assert.deepEqual(
      decideLedgerSessionAction(
        base({
          storedAccessToken: "old.jwt",
          storedExpiresAtMs: null,
          clientAccessToken: "rotated.jwt",
          clientExpiresAtMs: NOW + HOUR,
        }),
      ),
      { action: "reuse" },
    );
  });
});

describe("ledger-session-decision ── refresh（≤5 分鐘）", () => {
  it("同一張票、4 分鐘後到期 ⇒ refresh", () => {
    assert.deepEqual(decideLedgerSessionAction(base({ clientExpiresAtMs: NOW + 4 * 60 * 1000 })), {
      action: "refresh",
    });
  });

  it("剛剛到刷新線（相等）⇒ refresh（<= 語意）", () => {
    assert.deepEqual(
      decideLedgerSessionAction(base({ clientExpiresAtMs: NOW + LEDGER_REFRESH_SKEW_MS })),
      { action: "refresh" },
    );
  });

  it("已過期 ⇒ refresh", () => {
    assert.deepEqual(decideLedgerSessionAction(base({ clientExpiresAtMs: NOW - 1 })), {
      action: "refresh",
    });
  });

  it("client 到期時間讀唔到 ⇒ 唔好博，refresh", () => {
    assert.deepEqual(decideLedgerSessionAction(base({ clientExpiresAtMs: null })), {
      action: "refresh",
    });
  });

  it("client 先醒 refresh 過但新票又快到期的罕見路 ⇒ refresh（唔可以 reuse 過期票）", () => {
    assert.deepEqual(
      decideLedgerSessionAction(
        base({
          storedAccessToken: "old.jwt",
          storedExpiresAtMs: NOW - 1_000,
          clientAccessToken: "rotated.jwt",
          clientExpiresAtMs: NOW + 60_000,
        }),
      ),
      { action: "refresh" },
    );
  });
});
