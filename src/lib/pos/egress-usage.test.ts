// 回歸測試（2026-09-22）：admin「雲端用量」頁嘅匯總邏輯。
//
// 核心契約：
//   ① 澳門日期（+8）唔可以用 UTC —— 跨午夜記錯日 = 報表日日都唔對；
//   ② 「今日 / 本月 / 窗口」三個口徑唔可以互相污染；
//   ③ 缺日一定要補 0（唔可以令走勢圖斷開）；
//   ④ 免費用戶 5 GB 配額嘅警示級別同「仲可容幾間店」要有明確算法。
//
// 跑法：node --test src/lib/pos/egress-usage.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EGRESS_FREE_QUOTA_BYTES,
  formatBytes,
  macauDayString,
  macauMonthPrefix,
  quotaLevel,
  recentMacauDays,
  summarizeEgressUsage,
  type EgressUsageRow,
} from "./egress-usage.ts";

/** 2026-09-22 13:00 澳門 ＝ 05:00 UTC。 */
const NOW = Date.parse("2026-09-22T05:00:00.000Z");

describe("澳門日期口徑", () => {
  it("UTC 16:00 之上仍然係澳門當日；UTC 16:00 之後跳去翌日", () => {
    // 2026-09-22 15:59 UTC ＝ 澳門 23:59 → 仍然係 09-22
    assert.equal(macauDayString(Date.parse("2026-09-22T15:59:00.000Z")), "2026-09-22");
    // 2026-09-22 16:00 UTC ＝ 澳門 09-23 00:00
    assert.equal(macauDayString(Date.parse("2026-09-22T16:00:00.000Z")), "2026-09-23");
  });

  it("月份前綴用澳門時間（唔會喺月尾最後 8 小時入錯月）", () => {
    assert.equal(macauMonthPrefix(Date.parse("2026-09-30T16:30:00.000Z")), "2026-10");
  });

  it("recentMacauDays 回 N 個升序日期，最後一個係今日", () => {
    const days = recentMacauDays(NOW, 5);
    assert.equal(days.length, 5);
    assert.deepEqual(days, ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"]);
  });
});

describe("位元組格式化同警示級別", () => {
  it("formatBytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(900), "900 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1024 * 1024 * 1.5), "1.5 MB");
    assert.equal(formatBytes(EGRESS_FREE_QUOTA_BYTES), "5.0 GB");
    assert.equal(formatBytes(-5), "0 B");
  });

  it("quotaLevel 三級（50% / 80% 門檻）", () => {
    const q = EGRESS_FREE_QUOTA_BYTES;
    assert.equal(quotaLevel(0, q), "ok");
    assert.equal(quotaLevel(q * 0.49, q), "ok");
    assert.equal(quotaLevel(q * 0.5, q), "warn");
    assert.equal(quotaLevel(q * 0.79, q), "warn");
    assert.equal(quotaLevel(q * 0.8, q), "danger");
    assert.equal(quotaLevel(q * 2, q), "danger");
  });
});

describe("summarizeEgressUsage", () => {
  const rows: EgressUsageRow[] = [
    // 今日（09-22）
    { storeId: "A", day: "2026-09-22", route: "pos/state", calls: 10, bytes: 1_000_000 },
    { storeId: "A", day: "2026-09-22", route: "pos/print-jobs/status", calls: 5, bytes: 200_000 },
    // 本月但唔係今日（09-20）
    { storeId: "A", day: "2026-09-20", route: "pos/state", calls: 20, bytes: 2_000_000 },
    // 上月（唔應該計入本月）
    { storeId: "A", day: "2026-08-31", route: "pos/state", calls: 99, bytes: 9_000_000 },
    // 另一間店，只有上月資料 → 本月 0
    { storeId: "B", day: "2026-08-15", route: "pos/state", calls: 3, bytes: 300_000 },
  ];

  it("今日 / 本月 / 窗口三個口徑唔會互相污染", () => {
    const s = summarizeEgressUsage(rows, NOW, 14);
    const a = s.stores.find((x) => x.storeId === "A");
    assert.ok(a);
    assert.equal(a.todayBytes, 1_200_000);
    assert.equal(a.todayCalls, 15);
    // 本月 = 09-22 兩條 + 09-20 一條（唔含 08-31）
    assert.equal(a.monthBytes, 3_200_000);
    assert.equal(a.monthCalls, 35);
    // 窗口 14 日（09-09 ~ 09-22）同樣唔含 08-31
    assert.equal(a.windowBytes, 3_200_000);
  });

  it("按月用量降序排（用量大嘅店喺前面）", () => {
    const s = summarizeEgressUsage(rows, NOW, 14);
    assert.deepEqual(s.stores.map((x) => x.storeId), ["A", "B"]);
  });

  it("走勢：14 日、升序、缺日補 0", () => {
    const s = summarizeEgressUsage(rows, NOW, 14);
    const a = s.stores.find((x) => x.storeId === "A");
    assert.ok(a);
    assert.equal(a.daily.length, 14);
    assert.equal(a.daily[0].day, "2026-09-09");
    assert.equal(a.daily[a.daily.length - 1].day, "2026-09-22");
    // 09-19 冇資料 → 0（唔可以斷開）
    const sep19 = a.daily.find((d) => d.day === "2026-09-19");
    assert.equal(sep19?.bytes, 0);
    assert.equal(a.daily.find((d) => d.day === "2026-09-20")?.bytes, 2_000_000);
  });

  it("頭幾條路徑：降序，最多 6 條", () => {
    const many: EgressUsageRow[] = Array.from({ length: 9 }, (_, i) => ({
      storeId: "C",
      day: "2026-09-22",
      route: `r${i}`,
      calls: 1,
      bytes: (i + 1) * 1000,
    }));
    const s = summarizeEgressUsage(many, NOW, 14);
    const c = s.stores.find((x) => x.storeId === "C");
    assert.ok(c);
    assert.equal(c.topRoutes.length, 6);
    assert.equal(c.topRoutes[0].route, "r8");
    assert.equal(c.topRoutes[0].bytes, 9000);
  });

  it("配額比例同全月推算（月中就要知會唔會爆）", () => {
    const s = summarizeEgressUsage(rows, NOW, 14);
    const a = s.stores.find((x) => x.storeId === "A");
    assert.ok(a);
    assert.ok(Math.abs(a.quotaRatio - 3_200_000 / EGRESS_FREE_QUOTA_BYTES) < 1e-9);
    // 09-22 係 22 號：3.2 MB / 22 × 31
    assert.equal(a.projectedMonthBytes, Math.round((3_200_000 / 22) * 31));
  });

  it("總計：店數、今日、本月、可容店數", () => {
    const s = summarizeEgressUsage(rows, NOW, 14);
    assert.equal(s.totals.storeCount, 2);
    assert.equal(s.totals.todayBytes, 1_200_000);
    assert.equal(s.totals.monthBytes, 3_200_000);
    assert.ok(s.totals.affordableStores > 1000); // 用量極細 → 可以容好多間
  });

  it("🔴 骯髒資料唔可以污染結果（壞日期 / 負數 / 缺欄）", () => {
    const dirty = [
      { storeId: "D", day: "not-a-date", route: "x", calls: 1, bytes: 999 },
      { storeId: "", day: "2026-09-22", route: "x", calls: 1, bytes: 999 },
      { storeId: "D", day: "2026-09-22", route: "x", calls: -5, bytes: -1000 },
      { storeId: "D", day: "2026-09-22", route: "y", calls: 2, bytes: 100 },
    ] as EgressUsageRow[];
    const s = summarizeEgressUsage(dirty, NOW, 14);
    assert.equal(s.stores.length, 1);
    assert.equal(s.stores[0].storeId, "D");
    assert.equal(s.stores[0].todayBytes, 100); // 負數當 0
    assert.equal(s.stores[0].todayCalls, 2);
  });

  it("空表唔會爆（未跑 migration 時 admin 頁要照開得成）", () => {
    const s = summarizeEgressUsage([], NOW, 14);
    assert.equal(s.stores.length, 0);
    assert.equal(s.totals.monthBytes, 0);
    assert.equal(s.totals.affordableStores, 0);
    assert.equal(s.windowDays.length, 14);
  });

  it("單店用量全部為 0 → 唔可以推斷「可容幾間店」（回 0 唔係 Infinity）", () => {
    const zero: EgressUsageRow[] = [
      { storeId: "Z", day: "2026-09-22", route: "pos/state", calls: 0, bytes: 0 },
    ];
    const s = summarizeEgressUsage(zero, NOW, 14);
    assert.equal(s.totals.affordableStores, 0);
  });
});
