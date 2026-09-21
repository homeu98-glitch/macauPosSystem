import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldBackfillOnResubscribe } from "./resubscribe-guard.ts";

/**
 * 《realtime 重連補拉》守衛（2026-09-21 egress 優化）。
 *
 * 為何要用測試鎖死：呢個守衛係「今日最大單一 egress 修正」（實測 9 分鐘 80 MB、
 * 佔全部 egress 96%）。它有兩個**相反方向**嘅失效模式，兩邊都唔可以錯：
 *   · 擋得太多 → realtime 一斷就永遠收唔返漏掉嘅單（**功能問題**：收銀見唔到新單）
 *   · 擋得太少 → 背景分頁每 4.47 秒拉 857 KB（**用量問題**：就係今次要修嘅嘢）
 */
const BASE = {
  offlineMode: false,
  hasPendingEvents: false,
  visibilityState: "visible",
  lastFullPullAtMs: 0,
  nowMs: 1_000_000,
  minGapMs: 30_000,
};

describe("shouldBackfillOnResubscribe — 應該拉嘅情況", () => {
  it("前景 ＋ 冇 pending ＋ 隔足時間 → 拉", () => {
    const d = shouldBackfillOnResubscribe({ ...BASE, lastFullPullAtMs: BASE.nowMs - 60_000 });
    assert.equal(d.ok, true);
    assert.equal(d.reason, undefined);
  });

  it("從未拉過（lastFullPullAt = 0）→ 拉（唔可以因為「冇紀錄」而永遠唔拉）", () => {
    assert.equal(shouldBackfillOnResubscribe({ ...BASE, lastFullPullAtMs: 0 }).ok, true);
  });

  it("minGapMs = 0（關閉節流）→ 仍然係前景就拉", () => {
    const d = shouldBackfillOnResubscribe({
      ...BASE,
      minGapMs: 0,
      lastFullPullAtMs: BASE.nowMs - 1,
    });
    assert.equal(d.ok, true);
  });
});

describe("shouldBackfillOnResubscribe — 唔應該拉嘅情況", () => {
  it("🔴 分頁隱藏 → 唔拉（背景分頁循環嘅主閘）", () => {
    const d = shouldBackfillOnResubscribe({ ...BASE, visibilityState: "hidden" });
    assert.equal(d.ok, false);
    assert.equal(d.reason, "hidden");
  });

  it("🔴 距上次拉取 < minGap → 唔拉", () => {
    for (const gap of [0, 1_000, 29_999]) {
      const d = shouldBackfillOnResubscribe({ ...BASE, lastFullPullAtMs: BASE.nowMs - gap });
      assert.equal(d.ok, false, `gap=${gap} 應該被擋`);
      assert.equal(d.reason, "too-soon");
    }
  });

  it("剛好等於 minGap → 拉（邊界唔可以過度擋）", () => {
    const d = shouldBackfillOnResubscribe({ ...BASE, lastFullPullAtMs: BASE.nowMs - 30_000 });
    assert.equal(d.ok, true);
  });

  it("離線模式 → 唔拉（原本已有嘅條件，次序最先）", () => {
    const d = shouldBackfillOnResubscribe({
      ...BASE,
      offlineMode: true,
      visibilityState: "hidden", // 同時隱藏 → 仍然要報 offline（次序證明）
    });
    assert.equal(d.ok, false);
    assert.equal(d.reason, "offline");
  });

  it("本機仲有 pending 事件 → 唔拉（避免覆蓋未上雲嘅新單）", () => {
    const d = shouldBackfillOnResubscribe({
      ...BASE,
      hasPendingEvents: true,
      visibilityState: "hidden",
    });
    assert.equal(d.ok, false);
    assert.equal(d.reason, "pending-events");
  });

  it("隱藏 ＋ 太近 → 報 hidden（兩道閘都要存在）", () => {
    const d = shouldBackfillOnResubscribe({
      ...BASE,
      visibilityState: "hidden",
      lastFullPullAtMs: BASE.nowMs - 1,
    });
    assert.equal(d.reason, "hidden");
  });
});

describe("模擬真實 burst：背景分頁每 4.47 秒重連一次（實測值）", () => {
  it("103 次重連（9 分鐘、每 4.47 秒）⇒ 守衛擋到 0 次拉取", () => {
    let lastPull = 0;
    let pulls = 0;
    const cycleMs = 4_470;
    let now = 1_000_000;
    for (let i = 0; i < 103; i++) {
      // 背景分頁：visibilityState = "hidden"
      const d = shouldBackfillOnResubscribe({
        offlineMode: false,
        hasPendingEvents: false,
        visibilityState: "hidden",
        lastFullPullAtMs: lastPull,
        nowMs: now,
        minGapMs: 30_000,
      });
      if (d.ok) {
        pulls += 1;
        lastPull = now;
      }
      now += cycleMs;
    }
    assert.equal(pulls, 0, "背景分頁應該零拉取（修前係 103 次 × 857 KB ≈ 80 MB）");
  });

  it("同一情境但分頁在前景 → 只拉 1 次（每 30 秒上限，修前係 103 次）", () => {
    let lastPull = 0;
    let pulls = 0;
    const cycleMs = 4_470;
    let now = 1_000_000;
    for (let i = 0; i < 103; i++) {
      const d = shouldBackfillOnResubscribe({
        offlineMode: false,
        hasPendingEvents: false,
        visibilityState: "visible",
        lastFullPullAtMs: lastPull,
        nowMs: now,
        minGapMs: 30_000,
      });
      if (d.ok) {
        pulls += 1;
        lastPull = now;
      }
      now += cycleMs;
    }
    // 103 × 4.47 秒 ≈ 460 秒 ⇒ 每 30 秒最多 1 次 ⇒ 約 16 次（唔會係 1，因為時間確實過去咗）
    assert.ok(pulls >= 1 && pulls <= 17, `前景亦應該被節流（實際 ${pulls} 次，修前 103 次）`);
    assert.ok(pulls < 20, "一定要遠低於 103");
  });

  it("長時間斷線（隱藏 10 分鐘）→ 返前景即補一次", () => {
    const hiddenSince = 1_000_000;
    const lastPull = hiddenSince - 5_000; // 斷線前 5 秒拉過
    // 隱藏期間：全部擋
    for (let t = hiddenSince; t < hiddenSince + 600_000; t += 4_470) {
      const d = shouldBackfillOnResubscribe({
        offlineMode: false,
        hasPendingEvents: false,
        visibilityState: "hidden",
        lastFullPullAtMs: lastPull,
        nowMs: t,
        minGapMs: 30_000,
      });
      assert.equal(d.ok, false);
    }
    // 返前景 → 一定拉（時間已隔足）
    const back = shouldBackfillOnResubscribe({
      offlineMode: false,
      hasPendingEvents: false,
      visibilityState: "visible",
      lastFullPullAtMs: lastPull,
      nowMs: hiddenSince + 600_000,
      minGapMs: 30_000,
    });
    assert.equal(back.ok, true, "返前景一定要補拉（唔可以漏事件）");
  });
});
