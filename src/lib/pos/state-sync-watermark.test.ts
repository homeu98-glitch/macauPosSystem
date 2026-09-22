// 回歸測試（2026-09-22 P1 egress 優化）：`/api/pos/state` 增量拉取嘅水位決策。
//
// 核心契約：**有可用水位才傳 `since`；任何一個例外情況都必須退回全量**
// （漏一次全量只係多流量；誤用增量而漏單 ＝ 收銀見到「少咗單」）。
//
// 跑法：node --test src/lib/pos/state-sync-watermark.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  STATE_SYNC_MAX_AGE_MS,
  STATE_SYNC_SAFETY_MS,
  isIncrementalTruncated,
  resolveSince,
  watermarkAfterPull,
} from "./state-sync-watermark.ts";

const NOW = Date.parse("2026-09-22T13:00:00.000Z");
const fresh = new Date(NOW - 60_000).toISOString(); // 1 分鐘前

describe("增量同步水位 ── 幾時可以傳 since", () => {
  it("有新鮮水位 ＋ 本機有資料 → 傳 since（回帶安全邊際）", () => {
    const d = resolveSince({ lastSyncedAt: fresh, hasLocalData: true, nowMs: NOW });
    assert.equal(d.reason, "incremental");
    assert.equal(d.fullPull, false);
    assert.equal(d.since, new Date(Date.parse(fresh) - STATE_SYNC_SAFETY_MS).toISOString());
  });

  it("🔴 本機完全冇資料（空機 / 清過 cache）→ 一定要全量", () => {
    const d = resolveSince({ lastSyncedAt: fresh, hasLocalData: false, nowMs: NOW });
    assert.equal(d.reason, "no-local-data");
    assert.equal(d.since, null);
    assert.equal(d.fullPull, true);
  });

  it("🔴 冇水位（第一次用）→ 全量", () => {
    for (const lastSyncedAt of [null, undefined, ""]) {
      const d = resolveSince({ lastSyncedAt, hasLocalData: true, nowMs: NOW });
      assert.equal(d.reason, "no-watermark");
      assert.equal(d.since, null);
      assert.equal(d.fullPull, true);
    }
  });

  it("🔴 水位解析唔到（被改壞 / 舊格式）→ 全量", () => {
    const d = resolveSince({ lastSyncedAt: "not-a-date", hasLocalData: true, nowMs: NOW });
    assert.equal(d.reason, "bad-watermark");
    assert.equal(d.since, null);
    assert.equal(d.fullPull, true);
  });

  it("🔴 水位太舊（> 6 小時）→ 全量（否則會撞穿 limit 而靜默漏單）", () => {
    const old = new Date(NOW - STATE_SYNC_MAX_AGE_MS - 1).toISOString();
    const d = resolveSince({ lastSyncedAt: old, hasLocalData: true, nowMs: NOW });
    assert.equal(d.reason, "stale-watermark");
    assert.equal(d.since, null);
    assert.equal(d.fullPull, true);
  });

  it("水位剛好喺 6 小時界線 → 仍然可以用增量（唔可以提早退化）", () => {
    const edge = new Date(NOW - STATE_SYNC_MAX_AGE_MS).toISOString();
    const d = resolveSince({ lastSyncedAt: edge, hasLocalData: true, nowMs: NOW });
    assert.equal(d.reason, "incremental");
    assert.equal(d.fullPull, false);
  });

  it("🔴 水位喺未來（時鐘回撥 / 被人改大）→ 全量", () => {
    const future = new Date(NOW + 60_000).toISOString();
    const d = resolveSince({ lastSyncedAt: future, hasLocalData: true, nowMs: NOW });
    assert.equal(d.reason, "stale-watermark");
    assert.equal(d.since, null);
    assert.equal(d.fullPull, true);
  });

  it("forceFull（手動「更新」／修復）→ 一定全量，就算水位新鮮", () => {
    const d = resolveSince({ lastSyncedAt: fresh, hasLocalData: true, nowMs: NOW, forceFull: true });
    assert.equal(d.reason, "force-full");
    assert.equal(d.since, null);
    assert.equal(d.fullPull, true);
  });

  it("任何一個例外情況都一定 fullPull=true（唔可以出現「半增量」）", () => {
    const cases = [
      resolveSince({ lastSyncedAt: null, hasLocalData: true, nowMs: NOW }),
      resolveSince({ lastSyncedAt: fresh, hasLocalData: false, nowMs: NOW }),
      resolveSince({ lastSyncedAt: "x", hasLocalData: true, nowMs: NOW }),
      resolveSince({ lastSyncedAt: fresh, hasLocalData: true, nowMs: NOW, forceFull: true }),
    ];
    for (const c of cases) {
      assert.equal(c.fullPull, true, c.reason);
      assert.equal(c.since, null, c.reason);
    }
  });
});

describe("增量同步水位 ── 新水位同截斷", () => {
  it("新水位 ＝ 請求開始時間（唔係回應時間）", () => {
    const started = NOW - 3_000;
    assert.equal(watermarkAfterPull(started), new Date(started).toISOString());
  });

  it("非法輸入唔會爆，會回一個合法 ISO", () => {
    assert.equal(watermarkAfterPull(Number.NaN, NOW), new Date(NOW).toISOString());
  });

  it("🔴 增量結果撞到 limit ＝ 有嘢未拉到 ⇒ 要清水位（下次走全量）", () => {
    assert.equal(isIncrementalTruncated(200, 200), true);
    assert.equal(isIncrementalTruncated(201, 200), true);
    assert.equal(isIncrementalTruncated(199, 200), false);
    assert.equal(isIncrementalTruncated(0, 200), false);
    assert.equal(isIncrementalTruncated(Number.NaN, 200), false);
    assert.equal(isIncrementalTruncated(5, 0), false);
  });
});
