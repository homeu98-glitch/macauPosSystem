import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  POLL_INTERVAL_PUSHED_MS,
  POLL_IDLE_MS,
} from "./poll-gate.ts";
import {
  SESSION_KEY_MAX_LEN,
  SESSION_LIVE_WINDOW_MS,
  SESSION_OFFLINE_WINDOW_MS,
  SESSION_RETENTION_DAYS,
  SESSION_STATE_TOUCH_THROTTLE_MS,
  SESSION_TOUCH_THROTTLE_MS,
  blockedEventTypesForRevokedSession,
  canClearPosSession,
  classifyPosSession,
  comparePosSessions,
  describeAgo,
  describeOpenDuration,
  describePosSessionState,
  groupPosSessions,
  isRevokePending,
  isSessionBehind,
  sanitizeBuildId,
  sanitizeSessionKey,
  sessionRowId,
  shouldTouchSession,
  summarizePosSessions,
  type PosSessionRow,
} from "./session-record.ts";

/**
 * 《POS 工作階段》單測（2026-09-22）。
 *
 * 呢個頁面係**管理員用嚟做決定**嘅（邊個工作階段要關）。兩個相反方向嘅事故都要守：
 *   · **太鬆**（健康嘅收銀機標成「已離線」）⇒ 商家見到假警報 ⇒ 以後唔信呢頁 ⇒
 *     真正嘅「開咗一整日冇關」亦唔會有人理（＝功能失效）。
 *   · **太緊**（明明死咗仲顯示「使用中」）⇒ 管理員以為一切正常。
 * 所以每組都同時測兩邊，並特別守「門檻唔可以短過輪詢閘上限」。
 */

const NOW = Date.UTC(2026, 8, 22, 3, 0, 0); // 2026-09-22 11:00（澳門）
const SERVER_BUILD = "f25af2f";

function row(over: Partial<PosSessionRow> = {}): PosSessionRow {
  return {
    id: "st_a:sess-1",
    store_id: "st_a",
    session_key: "sess-1",
    account: "60002381",
    role: "manager",
    build_id: SERVER_BUILD,
    opened_at: new Date(NOW - 60 * 60_000).toISOString(),
    last_seen_at: new Date(NOW - 30_000).toISOString(),
    ip: "60.246.53.111",
    user_agent: "Safari 17.14 · macOS",
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    closed_at: null,
    ...over,
  };
}

const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("門檻 ── 唔可以短過輪詢閘上限（否則全店誤標離線）", () => {
  it("使用中門檻 ≥ 輪詢閘最長間隔 + 1 分鐘餘量", () => {
    assert.ok(
      SESSION_LIVE_WINDOW_MS >= POLL_INTERVAL_PUSHED_MS + 60_000,
      `live=${SESSION_LIVE_WINDOW_MS} 必須 ≥ pollGate=${POLL_INTERVAL_PUSHED_MS} + 60000`,
    );
  });

  it("離線門檻 > 使用中門檻（兩者唔可以撈埋）", () => {
    assert.ok(SESSION_OFFLINE_WINDOW_MS > SESSION_LIVE_WINDOW_MS);
  });

  it("待機恢復（idle）門檻（5 分鐘）唔會短過使用中門檻", () => {
    assert.ok(SESSION_STATE_TOUCH_THROTTLE_MS <= SESSION_LIVE_WINDOW_MS);
  });

  it("POST 續期節流短過 GET 續期節流（寫入較頻繁，寫入時順手續期最抵）", () => {
    assert.ok(SESSION_TOUCH_THROTTLE_MS < SESSION_STATE_TOUCH_THROTTLE_MS);
  });

  it("保留日數合理（> 0 且唔超過一年）", () => {
    assert.ok(SESSION_RETENTION_DAYS > 0 && SESSION_RETENTION_DAYS <= 365);
  });

  it("閒置門檻（5 分鐘）同本模組嘅使用中門檻一致方向", () => {
    assert.ok(POLL_IDLE_MS <= SESSION_LIVE_WINDOW_MS);
  });
});

describe("classifyPosSession ── 四態邊界", () => {
  it("30 秒前上報 → 使用中", () => {
    assert.equal(classifyPosSession(row({ last_seen_at: ago(30_000) }), NOW), "live");
  });

  it("啱啱好 6 分鐘 → 仍然當使用中（邊界包含）", () => {
    assert.equal(classifyPosSession(row({ last_seen_at: ago(SESSION_LIVE_WINDOW_MS) }), NOW), "live");
  });

  it("6 分鐘零 1 毫秒 → 閒置", () => {
    assert.equal(classifyPosSession(row({ last_seen_at: ago(SESSION_LIVE_WINDOW_MS + 1) }), NOW), "idle");
  });

  it("啱啱好 30 分鐘 → 仍然當閒置", () => {
    assert.equal(classifyPosSession(row({ last_seen_at: ago(SESSION_OFFLINE_WINDOW_MS) }), NOW), "idle");
  });

  it("30 分鐘零 1 毫秒 → 已離線", () => {
    assert.equal(classifyPosSession(row({ last_seen_at: ago(SESSION_OFFLINE_WINDOW_MS + 1) }), NOW), "off");
  });

  it("已強制關閉**蓋過**使用中（即係啱啱仲有上報都算已關閉）", () => {
    const r = row({ last_seen_at: ago(5_000), revoked_at: ago(120_000) });
    assert.equal(classifyPosSession(r, NOW), "rev");
  });

  it("last_seen_at 讀唔到 → 當已離線（唯一安全方向）", () => {
    assert.equal(classifyPosSession(row({ last_seen_at: "唔係時間" }), NOW), "off");
  });

  it("狀態講人話", () => {
    assert.equal(describePosSessionState("live"), "使用中");
    assert.equal(describePosSessionState("idle"), "閒置");
    assert.equal(describePosSessionState("off"), "已離線");
    assert.equal(describePosSessionState("rev"), "已強制關閉");
  });
});

describe("清洗 header 值", () => {
  it("正常 key 通過", () => {
    assert.equal(sanitizeSessionKey(" 8f2a-1b3c "), "8f2a-1b3c");
  });

  it("空白／太長／怪字元一律拒（防止塞大字串入 DB primary key）", () => {
    assert.equal(sanitizeSessionKey(""), null);
    assert.equal(sanitizeSessionKey(null), null);
    assert.equal(sanitizeSessionKey("x".repeat(SESSION_KEY_MAX_LEN + 1)), null);
    assert.equal(sanitizeSessionKey("a b"), null);
    assert.equal(sanitizeSessionKey("a:b"), null);
    assert.equal(sanitizeSessionKey("a/b"), null);
  });

  it("build id：正常通過；含中文／太長 → null", () => {
    assert.equal(sanitizeBuildId(" f25af2f "), "f25af2f");
    assert.equal(sanitizeBuildId("dev"), "dev");
    assert.equal(sanitizeBuildId(""), null);
    assert.equal(sanitizeBuildId("版本"), null);
    assert.equal(sanitizeBuildId("x".repeat(25)), null);
  });

  it("合成 id", () => {
    assert.equal(sessionRowId("st_a", "sess-1"), "st_a:sess-1");
  });
});

describe("isSessionBehind ── 任一未知 → 唔可以當落後", () => {
  it("同版本 → false", () => {
    assert.equal(isSessionBehind(row(), SERVER_BUILD), false);
  });

  it("唔同版本 → true", () => {
    assert.equal(isSessionBehind(row({ build_id: "c5db7a0" }), SERVER_BUILD), true);
  });

  it("舊 client 冇傳 build id → false（唔可以一晚之間全部標紅）", () => {
    assert.equal(isSessionBehind(row({ build_id: null }), SERVER_BUILD), false);
  });

  it("server 未知版本 → false", () => {
    assert.equal(isSessionBehind(row({ build_id: "c5db7a0" }), null), false);
  });

  it("本機開發（dev）→ false（唔應該嘈）", () => {
    assert.equal(isSessionBehind(row({ build_id: "dev" }), "f25af2f"), false);
    assert.equal(isSessionBehind(row({ build_id: "f25af2f" }), "dev"), false);
  });
});

describe("shouldTouchSession ── 續期節流", () => {
  it("未夠節流時間 → 唔續（省 DB 寫入）", () => {
    assert.equal(shouldTouchSession(ago(30_000), NOW, SESSION_TOUCH_THROTTLE_MS), false);
  });

  it("夠節流時間 → 續", () => {
    assert.equal(shouldTouchSession(ago(61_000), NOW, SESSION_TOUCH_THROTTLE_MS), true);
  });

  it("row 唔存在（null）→ **唔**喺度建立（GET 唔創造狀態）", () => {
    assert.equal(shouldTouchSession(null, NOW, SESSION_TOUCH_THROTTLE_MS), false);
    assert.equal(shouldTouchSession("垃圾", NOW, SESSION_TOUCH_THROTTLE_MS), false);
  });
});

describe("相對時間 / 時長（確定性輸出，唔用 toLocaleString）", () => {
  it("describeAgo", () => {
    assert.equal(describeAgo(ago(10_000), NOW), "剛剛");
    assert.equal(describeAgo(ago(2 * 60_000), NOW), "2 分鐘前");
    assert.equal(describeAgo(ago(3 * 60 * 60_000), NOW), "3 小時前");
    assert.equal(describeAgo(ago(50 * 60 * 60_000), NOW), "2 日前");
    assert.equal(describeAgo(null, NOW), "—");
  });

  it("describeOpenDuration（超過 24 小時照用「小時」，唔換成「日」）", () => {
    assert.equal(describeOpenDuration(ago(19 * 60_000), NOW), "19 分鐘");
    assert.equal(describeOpenDuration(ago(2 * 60 * 60_000 + 38 * 60_000), NOW), "2 小時 38 分");
    assert.equal(describeOpenDuration(ago(3 * 60 * 60_000), NOW), "3 小時");
    assert.equal(describeOpenDuration(ago(26 * 60 * 60_000 + 38 * 60_000), NOW), "26 小時 38 分");
    assert.equal(describeOpenDuration("", NOW), "—");
  });
});

describe("comparePosSessions ── 最需要處理嘅排最前", () => {
  it("狀態先行：使用中 → 閒置 → 已離線 → 已強制關閉", () => {
    const live = row({ id: "live", last_seen_at: ago(1_000) });
    const idle = row({ id: "idle", last_seen_at: ago(10 * 60_000) });
    const off = row({ id: "off", last_seen_at: ago(60 * 60_000) });
    const rev = row({ id: "rev", revoked_at: ago(60_000) });
    const sorted = [rev, off, idle, live].sort((a, b) => comparePosSessions(a, b, NOW));
    assert.deepEqual(
      sorted.map((r) => r.id),
      ["live", "idle", "off", "rev"],
    );
  });

  it("同狀態 → 開啟較久優先", () => {
    const older = row({ id: "older", opened_at: ago(10 * 60 * 60_000) });
    const newer = row({ id: "newer", opened_at: ago(10 * 60_000) });
    const sorted = [newer, older].sort((a, b) => comparePosSessions(a, b, NOW));
    assert.deepEqual(
      sorted.map((r) => r.id),
      ["older", "newer"],
    );
  });
});

describe("groupPosSessions ── 多開店家優先", () => {
  const sessions = [
    row({ id: "a1", store_id: "st_a", opened_at: ago(3 * 60 * 60_000) }),
    row({ id: "a2", store_id: "st_a", opened_at: ago(20 * 60_000), build_id: "c5db7a0" }),
    row({ id: "a3", store_id: "st_a", opened_at: ago(26 * 60 * 60_000), last_seen_at: ago(40 * 60_000) }),
    row({ id: "b1", store_id: "st_b", opened_at: ago(30 * 60_000) }),
    row({ id: "b2", store_id: "st_b", opened_at: ago(25 * 60 * 60_000), last_seen_at: ago(60 * 60_000) }),
    row({ id: "c1", store_id: "st_c", opened_at: ago(10 * 60_000) }),
  ];

  it("多開店家排前；同為多開則最舊開啟時間排前", () => {
    const groups = groupPosSessions(sessions, NOW, SERVER_BUILD);
    assert.deepEqual(
      groups.map((g) => g.storeId),
      ["st_a", "st_b", "st_c"],
      "st_a（最舊 26 小時）同 st_b（25 小時）都係多開 ⇒ 最舊嗰間先；單開嘅 st_c 最後",
    );
  });

  it("多開旗標同落後數量", () => {
    const groups = groupPosSessions(sessions, NOW, SERVER_BUILD);
    const a = groups.find((g) => g.storeId === "st_a")!;
    assert.equal(a.multiOpen, true);
    assert.equal(a.behind, 1);
    assert.equal(a.sessions.length, 3);
    const c = groups.find((g) => g.storeId === "st_c")!;
    assert.equal(c.multiOpen, false);
    assert.equal(c.behind, 0);
  });

  it("組內排序：使用中（較舊開啟先）→ 已離線", () => {
    const a = groupPosSessions(sessions, NOW, SERVER_BUILD).find((g) => g.storeId === "st_a")!;
    assert.deepEqual(
      a.sessions.map((s) => s.id),
      ["a1", "a2", "a3"],
      "a1 同 a2 都係使用中 ⇒ 3 小時前開嘅 a1 先（開得越久越需要處理）；a3 已離線排最後",
    );
  });
});

describe("summarizePosSessions ── admin KPI", () => {
  it("數齊 5 格", () => {
    const rows = [
      row({ id: "a1", store_id: "st_a", opened_at: ago(26 * 60 * 60_000) }),
      row({ id: "a2", store_id: "st_a", build_id: "c5db7a0" }),
      row({ id: "b1", store_id: "st_b" }),
      /**
       * 🔴 2026-09-22 **契約更新**：`revokedPending` 由「有 revoked_at 就算」
       * 收緊為「已下達**但未確認生效**」（`isRevokePending()`），否則 KPI 一升就永遠唔跌。
       *   · r1：下達之後**仲有上報**（last_seen 較新）⇒ 已收到軟踢 ⇒ 唔算；
       *   · r2：下達之後冇再上報、但**仍在離線門檻內** ⇒ 算 pending。
       */
      row({ id: "r1", store_id: "st_c", revoked_at: ago(60_000) }),
      row({ id: "r2", store_id: "st_d", revoked_at: ago(60_000), last_seen_at: ago(10 * 60_000) }),
    ];
    const s = summarizePosSessions(rows, NOW, SERVER_BUILD);
    assert.equal(s.total, 5);
    assert.equal(s.stores, 4);
    assert.equal(s.multiOpenStores, 1);
    assert.equal(s.behind, 1);
    assert.equal(s.revokedPending, 1);
    assert.equal(s.openOver24h, 1);
    assert.equal(s.oldestOpenedAt, ago(26 * 60 * 60_000));
  });

  it("空清單唔會爆，回 0 / null", () => {
    const s = summarizePosSessions([], NOW, SERVER_BUILD);
    assert.equal(s.total, 0);
    assert.equal(s.stores, 0);
    assert.equal(s.oldestOpenedAt, null);
  });
});

describe("canClearPosSession ── 唔准清仲活躍嘅", () => {
  it("使用中 → 唔准清", () => {
    assert.equal(canClearPosSession(row({ last_seen_at: ago(1_000) }), NOW), false);
  });

  it("閒置（6~30 分鐘）→ 唔准清", () => {
    assert.equal(canClearPosSession(row({ last_seen_at: ago(10 * 60_000) }), NOW), false);
  });

  it("已離線 → 准清", () => {
    assert.equal(canClearPosSession(row({ last_seen_at: ago(60 * 60_000) }), NOW), true);
  });

  it("已強制關閉 → 准清", () => {
    assert.equal(canClearPosSession(row({ revoked_at: ago(60_000) }), NOW), true);
  });
});

describe("isRevokePending ── 「待生效」KPI 要識得自然歸零（2026-09-22 實案）", () => {
  /**
   * 舊寫法 `Boolean(revoked_at) && classify() === "rev"` —— 因為 `classifyPosSession()`
   * 只要 `revoked_at` 有值就永遠回 "rev"，所以 KPI **一升就永遠唔跌**
   * （商家：「我強制關掉後，一直都是卡在那邊」）。
   */
  it("下達之後仲有上報過 ⇒ 唔算待生效（該分頁已經連過線、收到軟踢）", () => {
    const r = row({
      revoked_at: new Date(NOW - 5 * 60_000).toISOString(),
      last_seen_at: new Date(NOW - 60_000).toISOString(),
    });
    assert.equal(isRevokePending(r, NOW), false);
  });

  it("下達之後未上報、但仍喺離線門檻內 ⇒ 算待生效（可能只係未到輪詢週期）", () => {
    const r = row({
      revoked_at: new Date(NOW - 2 * 60_000).toISOString(),
      last_seen_at: new Date(NOW - 20 * 60_000).toISOString(),
    });
    assert.equal(isRevokePending(r, NOW), true);
  });

  it("下達之後一直冇上報、已過離線門檻 ⇒ 唔算（部機根本唔喺度，屬「可清除」）", () => {
    const r = row({
      revoked_at: new Date(NOW - 3 * 60 * 60_000).toISOString(),
      last_seen_at: new Date(NOW - 4 * 60 * 60_000).toISOString(),
    });
    assert.equal(isRevokePending(r, NOW), false);
  });

  it("冇 revoked_at ／ 讀唔到時間 ⇒ 一律 false（唔可以無中生有）", () => {
    assert.equal(isRevokePending(row(), NOW), false);
    assert.equal(isRevokePending(row({ revoked_at: "garbage" }), NOW), false);
    assert.equal(
      isRevokePending(row({ revoked_at: new Date(NOW - 60_000).toISOString(), last_seen_at: "garbage" }), NOW),
      false,
    );
  });

  it("summarize：3 小時前下達 ⇒ revokedPending 回 0（唔會長期卡住）", () => {
    const rows = [
      row({
        revoked_at: new Date(NOW - 3 * 60 * 60_000).toISOString(),
        last_seen_at: new Date(NOW - 4 * 60 * 60_000).toISOString(),
      }),
    ];
    assert.equal(summarizePosSessions(rows, NOW, SERVER_BUILD).revokedPending, 0);
  });
});

describe("admin 頁 ── 已強制關閉嘅 row 一定要有清除入口（2026-09-22）", () => {
  const page = readFileSync(new URL("../../app/admin/sessions/page.tsx", import.meta.url), "utf8");

  it("列表行嘅 rev 分支一定要有 onClear（唔可以只出「已下達」badge）", () => {
    const at = page.indexOf('{state === "rev" ? (');
    const end = page.indexOf(") : canClear ?", at);
    assert.ok(at > 0 && end > at, "搵唔到列表行嘅 rev 分支");
    const branch = page.slice(at, end);
    assert.ok(/onClear/.test(branch), "rev 行冇清除入口 ⇒ 被軟踢嘅工作階段會永遠卡喺列表");
  });

  it("詳情 drawer 嘅 rev 狀態要有「清除紀錄」掣", () => {
    assert.ok(/清除紀錄/.test(page), "detail drawer 冇「清除紀錄」掣");
  });
});

describe("blockedEventTypesForRevokedSession ── 只擋新生意", () => {
  it("建單／加菜被擋", () => {
    assert.deepEqual(blockedEventTypesForRevokedSession(["ORDER_CREATED"]), ["ORDER_CREATED"]);
    assert.deepEqual(blockedEventTypesForRevokedSession(["ORDER_UPDATED"]), ["ORDER_UPDATED"]);
  });

  it("🔴 結帳／退款／刪單／打印一律放行（客人走唔到更嚴重）", () => {
    const blocked = blockedEventTypesForRevokedSession([
      "ORDER_SETTLED",
      "ORDER_REFUNDED",
      "ORDER_DELETED",
      "PRINT_JOB_CREATED",
      "SHIFT_CLOSED",
    ]);
    assert.deepEqual(blocked, []);
  });

  it("混合同一批：只回被擋嘅種類，而且去重", () => {
    const blocked = blockedEventTypesForRevokedSession([
      "ORDER_CREATED",
      "ORDER_SETTLED",
      "ORDER_CREATED",
      "ORDER_UPDATED",
    ]);
    assert.deepEqual(blocked.sort(), ["ORDER_CREATED", "ORDER_UPDATED"]);
  });
});
