import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  POLL_IDLE_MS,
  POLL_INTERVAL_DEGRADED_MS,
  POLL_INTERVAL_PUSHED_MS,
  decidePoll,
  idleForMs,
  minIntervalFor,
  type PollGateInput,
} from "./poll-gate.ts";

/**
 * 《輪詢閘》單測（2026-09-21）。
 *
 * 呢支決策控制「幾時唔再打 API」。兩個相反方向嘅事故都要守：
 *   · **太鬆**（應該停但照跑）⇒ 掛機照燒資源。
 *   · **太緊**（唔應該停但停咗）⇒ 店開住但收唔到新單（**比燒錢嚴重得多**），
 *     或者未上雲嘅單永遠上唔到。
 * 所以每組都同時測兩個方向，並特別守住「緊急推單唔可以被閒置／關店擋住」。
 */

const NOW = 1_800_000_000_000;

/** 底稿：正常營業中、有人啱啱掂過、Realtime 通、啱啱打過。 */
const base: PollGateInput = {
  sessionAlive: true,
  visibilityState: "visible",
  lastActivityAtMs: NOW - 1_000,
  nowMs: NOW,
  storeOpen: true,
  onlineChannelOpen: true,
  shiftOpen: true,
  hasPendingSyncEvents: false,
  realtimeConnected: true,
  lastPolledAtMs: NOW - POLL_INTERVAL_PUSHED_MS - 1,
};

describe("decidePoll ── 硬性停止", () => {
  it("冇 session → 即停", () => {
    assert.equal(decidePoll({ ...base, sessionAlive: false }).reason, "no-session");
  });

  it("分頁隱藏 → 停", () => {
    assert.equal(decidePoll({ ...base, visibilityState: "hidden" }).reason, "hidden");
  });

  it("🔴 閒置 5 分鐘 → 停（J 拍板）", () => {
    const d = decidePoll({ ...base, lastActivityAtMs: NOW - POLL_IDLE_MS - 1 });
    assert.deepEqual([d.poll, d.reason], [false, "idle"]);
  });

  it("🔴 線下 ＋ 線上兩條通路都關 → 停", () => {
    const d = decidePoll({ ...base, storeOpen: false, onlineChannelOpen: false });
    assert.deepEqual([d.poll, d.reason], [false, "all-channels-closed"]);
  });

  it("已收工而且冇 pending 事件 → 停", () => {
    const d = decidePoll({ ...base, shiftOpen: false });
    assert.deepEqual([d.poll, d.reason], [false, "shift-closed"]);
  });
});

describe("decidePoll ── push 優先（核心）", () => {
  it("🔴 Realtime 通 → 兜底間隔係 5 分鐘，唔係 60 秒", () => {
    assert.equal(minIntervalFor(true), POLL_INTERVAL_PUSHED_MS);
    assert.equal(minIntervalFor(false), POLL_INTERVAL_DEGRADED_MS);
    assert.equal(minIntervalFor(null), POLL_INTERVAL_DEGRADED_MS);
  });

  it("🔴 Realtime 通、距上次只隔 90 秒 → 唔打（等推送）", () => {
    const d = decidePoll({ ...base, lastPolledAtMs: NOW - 90_000 });
    assert.deepEqual([d.poll, d.reason], [false, "await-push"]);
    assert.equal(d.minIntervalMs, POLL_INTERVAL_PUSHED_MS);
  });

  it("🔴 Realtime 唔通、距上次只隔 90 秒 → 都唔打（未夠 60 秒下限？已夠 → 打）", () => {
    // 90 秒 > 60 秒 → 降級路徑應該放行
    const d = decidePoll({ ...base, realtimeConnected: false, lastPolledAtMs: NOW - 90_000 });
    assert.equal(d.poll, true);
  });

  it("🔴 Realtime 唔通、距上次只隔 30 秒 → 唔打（未夠降級下限）", () => {
    const d = decidePoll({ ...base, realtimeConnected: false, lastPolledAtMs: NOW - 30_000 });
    assert.deepEqual([d.poll, d.reason], [false, "await-interval"]);
  });

  it("🔴 `realtimeConnected === null`（未知）→ 當唔通，用返現行節奏（fail-open）", () => {
    const d = decidePoll({ ...base, realtimeConnected: null, lastPolledAtMs: NOW - 30_000 });
    assert.equal(d.poll, false, "未知時唔應該用 5 分鐘間隔");
    const ok = decidePoll({ ...base, realtimeConnected: null, lastPolledAtMs: NOW - 61_000 });
    assert.equal(ok.poll, true, "未知時應該回落 60 秒節奏");
  });

  it("🆕 首次（`lastPolledAtMs = 0`）→ 立即放行", () => {
    assert.equal(decidePoll({ ...base, lastPolledAtMs: 0 }).poll, true);
  });
});

describe("decidePoll ── 唔應該停（fail-open，最重要）", () => {
  it("🔴 只關線下（殘留通道：線上仲開）→ 要繼續", () => {
    const d = decidePoll({ ...base, storeOpen: false, onlineChannelOpen: true });
    assert.equal(d.poll, true, "殘留通道狀態下停咗就會漏線上單");
  });

  it("🔴 只關線上 → 要繼續", () => {
    assert.equal(decidePoll({ ...base, storeOpen: true, onlineChannelOpen: false }).poll, true);
  });

  it("🔴 已收工**但本機仲有 pending 事件** → 要繼續", () => {
    const d = decidePoll({ ...base, shiftOpen: false, hasPendingSyncEvents: true });
    assert.equal(d.poll, true, "停咗就會令未上雲嘅單永遠唔上雲");
  });

  it("🔴 未讀到（null）一律照跑（斷網唔可以停同步）", () => {
    for (const patch of [
      { storeOpen: null, onlineChannelOpen: null },
      { storeOpen: null },
      { onlineChannelOpen: null },
      { shiftOpen: null },
    ]) {
      assert.equal(
        decidePoll({ ...base, ...patch }).poll,
        true,
        `null 應該照跑：${JSON.stringify(patch)}`,
      );
    }
  });

  it("剛剛好 5 分鐘（邊界）→ 當作閒置（門檻係「≥」）", () => {
    const d = decidePoll({ ...base, lastActivityAtMs: NOW - POLL_IDLE_MS });
    assert.deepEqual([d.poll, d.reason], [false, "idle"]);
  });

  it("差 1 毫秒就未夠 5 分鐘 → 仍然繼續", () => {
    const d = decidePoll({ ...base, lastActivityAtMs: NOW - POLL_IDLE_MS + 1 });
    assert.equal(d.poll, true);
  });

  it("自訂 idleMs 生效", () => {
    const d = decidePoll({ ...base, lastActivityAtMs: NOW - 61_000, idleMs: 60_000 });
    assert.equal(d.reason, "idle");
  });
});

describe("decidePoll ── 事件驅動 vs 週期（kind）", () => {
  it("🔴 `triggered`：mount backfill / 重連補拉 唔可以被 idle／關店／收工／間隔擋", () => {
    const d = decidePoll({
      ...base,
      kind: "triggered",
      lastActivityAtMs: NOW - 60 * 60_000,
      storeOpen: false,
      onlineChannelOpen: false,
      shiftOpen: false,
      // 刻意連「啱啱打過」都設成未夠間隔 —— triggered 唔應該理
      lastPolledAtMs: NOW - 1_000,
    });
    assert.deepEqual([d.poll, d.reason], [true, "ok"]);
  });

  it("🔴 但 `triggered` 仍然受「冇 session」同「分頁隱藏」限制", () => {
    assert.equal(decidePoll({ ...base, kind: "triggered", sessionAlive: false }).poll, false);
    assert.equal(decidePoll({ ...base, kind: "triggered", visibilityState: "hidden" }).poll, false);
  });

  it("🔴 `periodic`（預設）仍然受全部閘限制 —— 唔可以因為加咗 triggered 而變鬆", () => {
    const d = decidePoll({
      ...base,
      lastActivityAtMs: NOW - 60 * 60_000,
    });
    assert.equal(d.reason, "idle");
  });
});

describe("decidePoll ── 緊急路徑（推單上雲唔可以被擋）", () => {
  it("🔴 閒置時嘅緊急推單 → 照推", () => {
    const d = decidePoll({
      ...base,
      urgent: true,
      lastActivityAtMs: NOW - 60 * 60_000,
      lastPolledAtMs: NOW - 1_000,
    });
    assert.equal(d.poll, true, "閒置唔可以擋住未上雲嘅單");
    assert.equal(d.minIntervalMs, 0);
  });

  it("🔴 關店／收工時嘅緊急推單 → 照推", () => {
    const d = decidePoll({
      ...base,
      urgent: true,
      storeOpen: false,
      onlineChannelOpen: false,
      shiftOpen: false,
    });
    assert.equal(d.poll, true);
  });

  it("🔴 但冇 session／分頁隱藏 → 緊急都唔推（根本冇憑證 / 冇人睇）", () => {
    assert.equal(decidePoll({ ...base, urgent: true, sessionAlive: false }).poll, false);
    assert.equal(decidePoll({ ...base, urgent: true, visibilityState: "hidden" }).poll, false);
  });
});

describe("idleForMs", () => {
  it("正常差值", () => {
    assert.equal(idleForMs({ lastActivityAtMs: NOW - 12_345, nowMs: NOW }), 12_345);
  });

  it("從未互動（0 / NaN）→ 回 0（當剛活躍，唔可以誤判閒置）", () => {
    assert.equal(idleForMs({ lastActivityAtMs: 0, nowMs: NOW }), 0);
    assert.equal(idleForMs({ lastActivityAtMs: NaN, nowMs: NOW }), 0);
  });

  it("時鐘倒退 → 夾做 0（唔可以回負數令判準反轉）", () => {
    assert.equal(idleForMs({ lastActivityAtMs: NOW + 5_000, nowMs: NOW }), 0);
  });
});
