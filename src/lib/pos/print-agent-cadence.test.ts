// 回歸測試（2026-09-22 第三次覆核）：打印中繼 claim 嘅節奏決策。
//
// 核心契約：
//   ① 回傳值**永遠**落喺 5_000 ~ 180_000 —— 呢個係同 APK 嘅硬性合約
//      （APK：`optNextPollMs.takeIf { it in 5_000..180_000 }`，超出會靜默 fallback 30 秒）；
//   ② 有 job → 快（backlog 5 秒／active 15 秒）；
//   ③ 連續冇 job → 逐級退避，**上限 180 秒**（唔可以超過 POS 網頁「5 分鐘＝疑似離線」）；
//   ④ 一有 job 就要**即刻回復**正常節奏（唔可以留喺退避狀態）。
//
// 跑法：node --test src/lib/pos/print-agent-cadence.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLAIM_ACTIVE_MS,
  CLAIM_BACKLOG_MS,
  CLAIM_IDLE_LADDER_MS,
  CLAIM_MAX_MS,
  CLAIM_MIN_MS,
  claimCadenceLabel,
  nextClaimPollMs,
  nextEmptyStreak,
} from "./print-agent-cadence.ts";

describe("claim 節奏 ── 合約值域", () => {
  it("🔴 所有常數都落喺 5 秒 ~ 180 秒（APK 有效範圍 ＋ 網頁疑似離線閾值）", () => {
    const all = [CLAIM_BACKLOG_MS, CLAIM_ACTIVE_MS, ...CLAIM_IDLE_LADDER_MS];
    for (const ms of all) {
      assert.ok(ms >= CLAIM_MIN_MS && ms <= CLAIM_MAX_MS, `${ms} 超出 5_000..180_000`);
    }
    assert.equal(CLAIM_MAX_MS, 180_000);
    assert.equal(CLAIM_MIN_MS, 5_000);
  });

  it("🔴 任何輸入都唔會跌破 5 秒／超過 180 秒（包括亂數／負數／NaN）", () => {
    const cases = [
      { claimed: 0, limit: 5, emptyStreak: 0 },
      { claimed: 0, limit: 5, emptyStreak: 1 },
      { claimed: 0, limit: 5, emptyStreak: 9999 },
      { claimed: 999, limit: 5, emptyStreak: 0 },
      { claimed: -3, limit: 5, emptyStreak: -7 },
      { claimed: Number.NaN, limit: 5, emptyStreak: Number.NaN },
      { claimed: 5, limit: 0, emptyStreak: 0 },
      { claimed: 1, limit: 1, emptyStreak: 0 },
    ];
    for (const c of cases) {
      const ms = nextClaimPollMs(c);
      assert.ok(ms >= CLAIM_MIN_MS && ms <= CLAIM_MAX_MS, `${JSON.stringify(c)} ⇒ ${ms}`);
      assert.ok(Number.isFinite(ms));
    }
  });
});

describe("claim 節奏 ── 三檔同退避階梯", () => {
  it("取滿 limit（有積壓）→ 5 秒", () => {
    assert.equal(nextClaimPollMs({ claimed: 5, limit: 5 }), CLAIM_BACKLOG_MS);
    assert.equal(nextClaimPollMs({ claimed: 7, limit: 5 }), CLAIM_BACKLOG_MS);
  });

  it("有取得 job（未滿）→ 15 秒", () => {
    assert.equal(nextClaimPollMs({ claimed: 1, limit: 5 }), CLAIM_ACTIVE_MS);
    assert.equal(nextClaimPollMs({ claimed: 4, limit: 5 }), CLAIM_ACTIVE_MS);
  });

  it("🔴 連續冇 job → 逐級退避 30 → 60 → 120 → 180（封頂）", () => {
    assert.equal(nextClaimPollMs({ claimed: 0, limit: 5, emptyStreak: 1 }), 30_000);
    assert.equal(nextClaimPollMs({ claimed: 0, limit: 5, emptyStreak: 2 }), 60_000);
    assert.equal(nextClaimPollMs({ claimed: 0, limit: 5, emptyStreak: 3 }), 120_000);
    assert.equal(nextClaimPollMs({ claimed: 0, limit: 5, emptyStreak: 4 }), 180_000);
    assert.equal(nextClaimPollMs({ claimed: 0, limit: 5, emptyStreak: 50 }), 180_000);
  });

  it("一有 job 就即刻回復正常節奏（唔可以留喺退避）", () => {
    let streak = 0;
    for (let i = 0; i < 6; i += 1) streak = nextEmptyStreak(streak, 0);
    assert.equal(streak, 6);
    assert.equal(nextClaimPollMs({ claimed: 0, limit: 5, emptyStreak: streak }), 180_000);
    // 有一張 job
    streak = nextEmptyStreak(streak, 1);
    assert.equal(streak, 0);
    assert.equal(nextClaimPollMs({ claimed: 1, limit: 5, emptyStreak: streak }), CLAIM_ACTIVE_MS);
  });

  it("`nextEmptyStreak` 唔會被負數／NaN 破壞", () => {
    assert.equal(nextEmptyStreak(0, 0), 1);
    assert.equal(nextEmptyStreak(-5, 0), 1);
    assert.equal(nextEmptyStreak(Number.NaN, 0), 1);
    assert.equal(nextEmptyStreak(3, 2), 0);
    assert.equal(nextEmptyStreak(3, Number.NaN), 4);
    assert.ok(nextEmptyStreak(9999, 0) <= 9999);
  });

  it("診斷標籤同實際決策一致", () => {
    assert.equal(claimCadenceLabel(5, 5), "backlog");
    assert.equal(claimCadenceLabel(2, 5), "active");
    assert.equal(claimCadenceLabel(0, 5), "idle");
  });

  it("🔴 空閒店嘅日均請求數要明顯低過固定 30 秒（量化「關店唔應該 call」）", () => {
    const perDay = (ms: number) => Math.round((24 * 3600 * 1000) / ms);
    const fixed30 = perDay(30_000);
    const idleSteady = perDay(CLAIM_IDLE_LADDER_MS[CLAIM_IDLE_LADDER_MS.length - 1]);
    assert.equal(fixed30, 2_880);
    assert.equal(idleSteady, 480);
    assert.ok(idleSteady < fixed30 * 0.2, "退避之後應該少過兩成");
  });
});
