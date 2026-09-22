import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildLabel,
  describeBuildMismatch,
  describeReloadRisk,
  envLabel,
  formatMacauStamp,
  getObservedServerBuildId,
  isSameBuild,
  readClientBuildInfo,
  resetObservedServerBuildForTest,
  setObservedServerBuildId,
  subscribeObservedServerBuild,
  type BuildInfo,
} from "./build-info.ts";

/**
 * 《建置版本資訊》單測（2026-09-22）。
 *
 * 呢個顯示有兩個相反方向嘅事故：
 *   · **顯示錯**（講「最新」但其實跑舊版）⇒ 完全失去「確認商家用邊個版本」嘅作用。
 *   · **亂提示**（本機 dev / 標頭讀唔到都出「你過期喇」）⇒ 用戶學識無視個警示。
 * 所以每組都測兩個方向。
 */

const CLIENT: BuildInfo = { id: "1a2b3c4", builtAt: "2026-09-21T15:54:00.000Z", env: "production" };

describe("formatMacauStamp", () => {
  it("🔴 ISO（UTC）→ 澳門 +8，格式 YYYY-MM-DD HH:mm", () => {
    // 2026-09-21T15:54Z = 澳門 23:54
    assert.equal(formatMacauStamp("2026-09-21T15:54:00.000Z"), "2026-09-21 23:54");
    // 跨日邊界：16:30Z = 翌日 00:30
    assert.equal(formatMacauStamp("2026-09-21T16:30:00.000Z"), "2026-09-22 00:30");
  });

  it("非法 / null / 空字串 → 空字串（唔可以出 Invalid Date）", () => {
    assert.equal(formatMacauStamp(null), "");
    assert.equal(formatMacauStamp(""), "");
    assert.equal(formatMacauStamp("not-a-date"), "");
  });
});

describe("envLabel", () => {
  it("三個已知環境有中文標籤（唔露出枚舉值）", () => {
    assert.equal(envLabel("production"), "正式");
    assert.equal(envLabel("preview"), "預覽");
    assert.equal(envLabel("development"), "本機");
  });

  it("未知值原樣回（唔可以當成「正式」）", () => {
    assert.equal(envLabel("staging"), "staging");
    assert.equal(envLabel(""), "");
  });
});

describe("buildLabel", () => {
  it("齊料 → `id（時間 · 環境）`", () => {
    assert.equal(buildLabel(CLIENT), "1a2b3c4（2026-09-21 23:54 · 正式）");
  });

  it("冇時間 / 冇環境 → 只顯示 id（唔可以出空括號）", () => {
    assert.equal(buildLabel({ id: "1a2b3c4", builtAt: null, env: "" }), "1a2b3c4");
  });

  it("冇 id → 講清楚「未知」，唔可以靜靜咁當冇事", () => {
    assert.equal(buildLabel({ id: "", builtAt: null, env: "" }), "未知（未注入）");
    assert.equal(
      buildLabel({ id: "", builtAt: "2026-09-21T15:54:00.000Z", env: "" }),
      "未知（2026-09-21 23:54）",
    );
  });
});

describe("isSameBuild", () => {
  it("兩邊都有值而且一樣 → true", () => {
    assert.equal(isSameBuild("1a2b3c4", "1a2b3c4"), true);
  });

  it("🔴 任一未知 → false（唔可以當「一致」）", () => {
    assert.equal(isSameBuild("", "1a2b3c4"), false);
    assert.equal(isSameBuild("1a2b3c4", null), false);
    assert.equal(isSameBuild("", null), false);
  });

  it("唔同 → false", () => {
    assert.equal(isSameBuild("1a2b3c4", "9f8e7d6"), false);
  });
});

describe("describeBuildMismatch", () => {
  it("🔴 兩邊一樣 → 唔提示", () => {
    assert.equal(describeBuildMismatch(CLIENT, "1a2b3c4"), null);
  });

  it("🔴 唔同 → 提示「請完全閂掉再開」（唔可以寫「重新載入」就算）", () => {
    const hint = describeBuildMismatch(CLIENT, "9f8e7d6");
    assert.ok(hint, "應該有提示");
    assert.ok(/舊版本/.test(hint.text));
    assert.ok(/閂掉/.test(hint.text), "要講清楚係「閂掉」而唔係只 reload");
  });

  it("🔴 本機 dev → 唔提示（唔可以喺開發環境嘈）", () => {
    assert.equal(describeBuildMismatch({ ...CLIENT, id: "dev" }, "9f8e7d6"), null);
    assert.equal(describeBuildMismatch(CLIENT, "dev"), null);
  });

  it("🔴 任一未知（未注入 / 標頭讀唔到）→ 唔提示", () => {
    assert.equal(describeBuildMismatch({ ...CLIENT, id: "" }, "9f8e7d6"), null);
    assert.equal(describeBuildMismatch(CLIENT, null), null);
  });
});

describe("readClientBuildInfo", () => {
  it("讀到內聯值（逐一字面寫 env 先會被 DefinePlugin 替換）", () => {
    const prev = {
      id: process.env.NEXT_PUBLIC_BUILD_ID,
      time: process.env.NEXT_PUBLIC_BUILD_TIME,
      env: process.env.NEXT_PUBLIC_BUILD_ENV,
    };
    process.env.NEXT_PUBLIC_BUILD_ID = "abc1234";
    process.env.NEXT_PUBLIC_BUILD_TIME = "2026-09-21T15:54:00.000Z";
    process.env.NEXT_PUBLIC_BUILD_ENV = "production";
    try {
      assert.deepEqual(readClientBuildInfo(), {
        id: "abc1234",
        builtAt: "2026-09-21T15:54:00.000Z",
        env: "production",
      });
    } finally {
      // 還原，唔好影響其他測試
      for (const [k, v] of [
        ["NEXT_PUBLIC_BUILD_ID", prev.id],
        ["NEXT_PUBLIC_BUILD_TIME", prev.time],
        ["NEXT_PUBLIC_BUILD_ENV", prev.env],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("🔴 未注入 → 回空值（唔可以 throw、唔可以回 'undefined' 字串）", () => {
    const prev = process.env.NEXT_PUBLIC_BUILD_ID;
    delete process.env.NEXT_PUBLIC_BUILD_ID;
    try {
      const info = readClientBuildInfo();
      assert.equal(info.id, "");
      assert.notEqual(info.id, "undefined");
    } finally {
      if (prev !== undefined) process.env.NEXT_PUBLIC_BUILD_ID = prev;
    }
  });
});

describe("describeReloadRisk ── 一鍵重新載入嘅保護", () => {
  it("🔴 冇未完成工作 → 唔使確認（一按即好）", () => {
    const r = describeReloadRisk({ cartItemCount: 0, settlementOpen: false, pendingSyncCount: 0 });
    assert.equal(r.needsConfirm, false);
  });

  it("🔴 有購物車 → 一定要確認，而且要講出「幾多項」", () => {
    const r = describeReloadRisk({ cartItemCount: 3, settlementOpen: false, pendingSyncCount: 0 });
    assert.equal(r.needsConfirm, true);
    assert.ok(/3 項/.test(r.message), `要講清楚數量：${r.message}`);
  });

  it("🔴 結帳畫面開住 → 一定要確認", () => {
    const r = describeReloadRisk({ cartItemCount: 0, settlementOpen: true, pendingSyncCount: 0 });
    assert.equal(r.needsConfirm, true);
    assert.ok(/結帳/.test(r.message));
  });

  it("🔴 要同時講「邊樣唔會冇」（未上雲紀錄喺 localStorage 會保留）", () => {
    const r = describeReloadRisk({ cartItemCount: 2, settlementOpen: true, pendingSyncCount: 5 });
    assert.ok(/保留/.test(r.message), `唔可以只講失去：${r.message}`);
    assert.ok(/5 筆/.test(r.message));
  });

  it("🔴 語氣：講「清空」唔可以講「失去資料」（後者係錯，會嚇到收銀）", () => {
    const r = describeReloadRisk({ cartItemCount: 1, settlementOpen: false, pendingSyncCount: 0 });
    assert.ok(!/失去資料/.test(r.message), "唔可以講「失去資料」");
    assert.ok(/清空/.test(r.message));
  });

  it("冇未完成工作但仲有未上雲紀錄 → 都要講明佢哋安全", () => {
    const r = describeReloadRisk({ cartItemCount: 0, settlementOpen: false, pendingSyncCount: 4 });
    assert.equal(r.needsConfirm, false);
    assert.ok(/保留/.test(r.message));
  });
});

describe("觀測到嘅伺服器版本 store", () => {
  it("set / get / subscribe", () => {
    resetObservedServerBuildForTest();
    let notified = 0;
    const unsubscribe = subscribeObservedServerBuild(() => {
      notified += 1;
    });

    assert.equal(getObservedServerBuildId(), null);
    setObservedServerBuildId("9f8e7d6");
    assert.equal(getObservedServerBuildId(), "9f8e7d6");
    assert.equal(notified, 1);

    // 同值再設 → 唔應該再通知（避免無謂 re-render）
    setObservedServerBuildId("9f8e7d6");
    assert.equal(notified, 1);

    setObservedServerBuildId(null);
    assert.equal(getObservedServerBuildId(), null);
    assert.equal(notified, 2);

    unsubscribe();
    setObservedServerBuildId("abc");
    assert.equal(notified, 2, "unsubscribe 之後唔應該再收到");
    resetObservedServerBuildForTest();
  });

  it("空白 / 空字串當「未知」（唔可以存 `\"\"` 落去）", () => {
    resetObservedServerBuildForTest();
    setObservedServerBuildId("   ");
    assert.equal(getObservedServerBuildId(), null);
    setObservedServerBuildId("");
    assert.equal(getObservedServerBuildId(), null);
    resetObservedServerBuildForTest();
  });
});
