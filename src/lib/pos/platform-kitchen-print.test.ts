import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PLATFORM_KITCHEN_BACKFILL_MAX_AGE_MS,
  PLATFORM_ZONE_FOLLOW_KITCHEN,
  decidePlatformKitchenBackfill,
  kitchenPrinterTakesItem,
  normalizePlatformPrinterZone,
  platformZoneFollowsKitchen,
  platformZonePrinterCount,
  resolvePlatformItemZone,
} from "./platform-kitchen-print.ts";

/**
 * 平台單（澳覓 / MFOOD）廚房單出紙規則（2026-09-24 · 方案 A：分區式）。
 *
 * 最重要嘅不變式：**「未設定」唔可以變成一個真分區 id** —— 一變成真 id 就會
 * 對唔到任何打印機 ⇒ 零 job、零出紙、零錯誤（本專案反覆中招嘅靜默病）。
 */

describe("normalizePlatformPrinterZone：未設定一律回空字串", () => {
  it("非字串（undefined / null / 數字 / 物件）＝未設定", () => {
    for (const v of [undefined, null, 0, 1, {}, [], true]) {
      assert.equal(normalizePlatformPrinterZone(v), "", `${JSON.stringify(v)} 應該當未設定`);
    }
  });

  it("空白字串／全空白／有前後空白 → 正規化", () => {
    assert.equal(normalizePlatformPrinterZone(""), "");
    assert.equal(normalizePlatformPrinterZone("   "), "");
    assert.equal(normalizePlatformPrinterZone("\t\n"), "");
    assert.equal(PLATFORM_ZONE_FOLLOW_KITCHEN, "");
    assert.equal(normalizePlatformPrinterZone("  外賣平台  "), "外賣平台");
  });

  it("platformZoneFollowsKitchen 同 normalize 一致", () => {
    assert.equal(platformZoneFollowsKitchen(undefined), true);
    assert.equal(platformZoneFollowsKitchen(""), true);
    assert.equal(platformZoneFollowsKitchen("   "), true);
    assert.equal(platformZoneFollowsKitchen("kitchen"), false);
    assert.equal(platformZoneFollowsKitchen("外賣平台"), false);
  });
});

describe("resolvePlatformItemZone：有設定就全部品項都用該分區", () => {
  it("🔴 未設定 → 保留品項原本嘅 printerGroup（平台單目前一律 kitchen）", () => {
    assert.equal(resolvePlatformItemZone("kitchen", ""), "kitchen");
    assert.equal(resolvePlatformItemZone("kitchen", undefined), "kitchen");
    assert.equal(resolvePlatformItemZone("kitchen", null), "kitchen");
    assert.equal(resolvePlatformItemZone("kitchen", "   "), "kitchen");
    // 品項本身冇 printerGroup（舊資料 / 平台菜）→ 空字串（＝冇 zoneId 嘅 catch-all 機收）
    assert.equal(resolvePlatformItemZone(undefined, ""), "");
    assert.equal(resolvePlatformItemZone(null, undefined), "");
  });

  it("有設定 → 覆寫所有品項，唔理佢原本係 kitchen 定 drinks", () => {
    assert.equal(resolvePlatformItemZone("kitchen", "外賣平台"), "外賣平台");
    assert.equal(resolvePlatformItemZone("drinks", "外賣平台"), "外賣平台");
    assert.equal(resolvePlatformItemZone(undefined, "外賣平台"), "外賣平台");
  });

  it("設定值有前後空白 → 用正規化之後嘅值（避免對唔到分區 id）", () => {
    assert.equal(resolvePlatformItemZone("kitchen", "  外賣平台 "), "外賣平台");
  });
});

/**
 * 🔴 派發規則（`kitchenPrinterTakesItem`）—— 「平台單會唔會出紙、出喺邊台」嘅唯一判準。
 *
 * 呢條規則原本係 `print-jobs.ts` 一行 `.filter()`，嗰個檔載唔到入 `node --test`
 * ⇒ 一直零覆蓋。以下用一間「兩台機」嘅實店場景鎖死佢。
 */
describe("kitchenPrinterTakesItem：平台單派發去邊台機", () => {
  // 實店場景：printer = 廚房機（分區 kitchen）、printer2 = 外賣專用機（分區 外賣平台）
  const KITCHEN_PRINTER = { name: "printer（廚房機）", zoneId: "kitchen" };
  const PLATFORM_PRINTER = { name: "printer2（外賣專用機）", zoneId: "外賣平台" };

  const takes = (printer: { zoneId?: string }, override?: string) =>
    kitchenPrinterTakesItem({
      printerZoneId: printer.zoneId,
      // 平台單目前一律 printerGroup = kitchen（入站 route 寫死 defaultPrinterGroup）
      itemPrinterGroup: "kitchen",
      zoneOverride: override,
    });

  it("未設定（跟隨廚房）→ 只有廚房機收紙，外賣專用機唔收", () => {
    assert.equal(takes(KITCHEN_PRINTER), true);
    assert.equal(takes(PLATFORM_PRINTER), false);
    assert.equal(takes(KITCHEN_PRINTER, ""), true);
    assert.equal(takes(PLATFORM_PRINTER, ""), false);
  });

  it("🔴 設定成「外賣平台」→ 紙改去外賣專用機，廚房機變成唔收（就係呢個設定嘅全部作用）", () => {
    assert.equal(takes(KITCHEN_PRINTER, "外賣平台"), false);
    assert.equal(takes(PLATFORM_PRINTER, "外賣平台"), true);
  });

  it("方案 A 多台機：兩台機都綁「外賣平台」→ 兩台都收（唔使做多選打印機）", () => {
    const second = { zoneId: "外賣平台" };
    assert.equal(takes(PLATFORM_PRINTER, "外賣平台"), true);
    assert.equal(takes(second, "外賣平台"), true);
    assert.equal(platformZonePrinterCount("外賣平台", [
      { enabled: true, role: "zone", zoneId: "外賣平台" },
      { enabled: true, role: "zone", zoneId: "外賣平台" },
    ]), 2);
  });

  it("catch-all（冇填分區嘅機）永遠接晒所有品項 —— 有冇覆寫都一樣", () => {
    assert.equal(takes({ zoneId: "" }), true);
    assert.equal(takes({ zoneId: undefined }, "外賣平台"), true);
    assert.equal(takes({ zoneId: "" }, "外賣平台"), true);
  });

  it("對唔到嘅分區 id（例如分區被改名／刪除）→ 冇任何機收（所以設定頁／刪分區要 remap）", () => {
    assert.equal(takes(KITCHEN_PRINTER, "唔存在嘅分區"), false);
    assert.equal(takes(PLATFORM_PRINTER, "唔存在嘅分區"), false);
  });

  it("覆寫有前後空白 → 一樣對得上（唔可以因為空白變成靜默零出紙）", () => {
    assert.equal(takes(PLATFORM_PRINTER, "  外賣平台 "), true);
  });
});

describe("platformZonePrinterCount：設定頁警示用（揀咗冇機嘅分區 = 靜默零出紙）", () => {
  const printers = [
    { enabled: true, role: "zone", zoneId: "kitchen" },
    { enabled: true, role: "zone", zoneId: "外賣平台" },
    { enabled: true, role: "zone", zoneId: "外賣平台" },
    { enabled: false, role: "zone", zoneId: "外賣平台" },
    { enabled: true, role: "receipt", zoneId: "外賣平台" },
    { enabled: true, role: "zone", zoneId: "" },
  ];

  it("只計「啟用 且 role=zone 且 zoneId 相同」嘅機", () => {
    assert.equal(platformZonePrinterCount("外賣平台", printers), 2);
    assert.equal(platformZonePrinterCount("kitchen", printers), 1);
  });

  it("停用機／收據機／無分區機一律唔計", () => {
    assert.equal(platformZonePrinterCount("收據", printers), 0);
    assert.equal(platformZonePrinterCount("", printers), 0);
  });

  it("未設定／空清單 → 0（呼叫端據此出橙字，唔可以當「有機」）", () => {
    assert.equal(platformZonePrinterCount(undefined, printers), 0);
    assert.equal(platformZonePrinterCount(null, printers), 0);
    assert.equal(platformZonePrinterCount("外賣平台", []), 0);
    assert.equal(platformZonePrinterCount("外賣平台", null), 0);
  });
});

describe("decidePlatformKitchenBackfill：開機補印窗口", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();

  it("最近 1 小時內 → 補印", () => {
    assert.equal(decidePlatformKitchenBackfill({ createdAt: at(0), nowMs: now }), "print");
    assert.equal(decidePlatformKitchenBackfill({ createdAt: at(59), nowMs: now }), "print");
  });

  it("🔴 過咗 1 小時 → 唔補（唔可以把一開機見到嘅歷史單一次過出紙）", () => {
    assert.equal(decidePlatformKitchenBackfill({ createdAt: at(61), nowMs: now }), "stale");
    assert.equal(decidePlatformKitchenBackfill({ createdAt: at(60 * 24 * 3), nowMs: now }), "stale");
  });

  it("時間缺失／唔合法 → 保守唔補（唔可以當 0，否則永遠都「未過期」）", () => {
    for (const v of [undefined, null, "", "   ", "not-a-date", "2026-13-45T99:99:99Z"]) {
      assert.equal(
        decidePlatformKitchenBackfill({ createdAt: v, nowMs: now }),
        "unknown-time",
        `${JSON.stringify(v)} 應該保守唔補`,
      );
    }
  });

  it("容忍期可覆寫（測試／其他場景用）", () => {
    assert.equal(
      decidePlatformKitchenBackfill({ createdAt: at(30), nowMs: now, maxAgeMs: 10 * 60_000 }),
      "stale",
    );
    assert.equal(PLATFORM_KITCHEN_BACKFILL_MAX_AGE_MS, 60 * 60 * 1000);
  });
});
