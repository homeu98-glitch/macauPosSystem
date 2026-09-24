import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PLATFORM_VOID_ALLOWED_STATUSES,
  PLATFORM_VOID_BLOCKED_STATUSES,
  PLATFORM_VOID_DEFAULT_REASON,
  PLATFORM_VOID_TARGET_STATUS,
  canVoidPlatformOrder,
  isPlatformOrder,
  isPlatformOrderSource,
  platformVoidDenyReason,
} from "./platform-order.ts";

/**
 * 平台單「作廢（覆寫）」規則（2026-09-24 使用者要求）。
 *
 * 核心：**唔可以由狀態流程推導** —— `paid` / `settled` 都要可以作廢，
 * 因為平台單嘅錢係平台收，平台取消咗我哋就要跟住唔計入報表。
 * 但 `refunded` / `partially_refunded` 要擋（會令報表淨額多計一筆退款）。
 */

describe("isPlatformOrderSource", () => {
  it("只認 aomi / mfood", () => {
    assert.equal(isPlatformOrderSource("aomi"), true);
    assert.equal(isPlatformOrderSource("mfood"), true);
  });

  it("本地來源同未知值一律 false（唔可以誤中）", () => {
    for (const v of ["pos", "kiosk", "scan", "", "AOMI", "aomi ", null, undefined, 0, {}]) {
      assert.equal(isPlatformOrderSource(v), false, `${JSON.stringify(v)} 唔應該當平台單`);
    }
  });
});

describe("canVoidPlatformOrder：任何階段（含已完結）都可以覆寫", () => {
  it("🔴 paid / settled（已收款／已完結）**一定**可以作廢 —— 呢個就係使用者要嘅 override", () => {
    assert.equal(canVoidPlatformOrder({ source: "aomi", status: "paid" }), true);
    assert.equal(canVoidPlatformOrder({ source: "mfood", status: "settled" }), true);
  });

  it("未收款階段一樣可以（draft / sent_to_kitchen / reopened）", () => {
    for (const status of ["draft", "sent_to_kitchen", "reopened"]) {
      assert.equal(canVoidPlatformOrder({ source: "aomi", status }), true, status);
    }
  });

  it("允許清單同封鎖清單互補、冇重疊（改壞即刻紅）", () => {
    const allowed = new Set<string>(PLATFORM_VOID_ALLOWED_STATUSES);
    const blocked = new Set<string>(PLATFORM_VOID_BLOCKED_STATUSES);
    for (const s of allowed) assert.ok(!blocked.has(s), `${s} 同時喺兩邊`);
    assert.ok(allowed.has("paid"), "paid 一定要喺允許清單（否則就變成由狀態流程推導）");
    assert.ok(allowed.has("settled"), "settled 一定要喺允許清單");
    assert.equal(PLATFORM_VOID_TARGET_STATUS, "cancelled");
  });

  it("cancelled → 唔可以再作廢（避免重複寫事件）", () => {
    assert.equal(canVoidPlatformOrder({ source: "aomi", status: "cancelled" }), false);
  });

  it("🔴 refunded / partially_refunded → 擋（否則報表淨額會多計一筆退款）", () => {
    assert.equal(canVoidPlatformOrder({ source: "mfood", status: "refunded" }), false);
    assert.equal(canVoidPlatformOrder({ source: "mfood", status: "partially_refunded" }), false);
  });

  it("本地單（pos / kiosk / scan）一律 false —— 本地單嘅取消口徑完全唔變", () => {
    for (const source of ["pos", "kiosk", "scan"]) {
      for (const status of ["draft", "sent_to_kitchen", "paid", "settled"]) {
        assert.equal(canVoidPlatformOrder({ source, status }), false, `${source}/${status}`);
      }
    }
  });

  it("缺 source / status / null 一律 false（防禦）", () => {
    assert.equal(canVoidPlatformOrder(null), false);
    assert.equal(canVoidPlatformOrder(undefined), false);
    assert.equal(canVoidPlatformOrder({}), false);
    assert.equal(canVoidPlatformOrder({ source: "aomi" }), false);
    assert.equal(canVoidPlatformOrder({ status: "paid" }), false);
    assert.equal(canVoidPlatformOrder({ source: "aomi", status: "" }), false);
    assert.equal(canVoidPlatformOrder({ source: "aomi", status: "   " }), false);
  });

  it("未知新狀態（平台／系統將來加值）→ 保守放行（平台單本身就係 override 語意）", () => {
    assert.equal(canVoidPlatformOrder({ source: "aomi", status: "some_future_status" }), true);
  });
});

describe("platformVoidDenyReason：一句話原因", () => {
  it("可以作廢 → null", () => {
    assert.equal(platformVoidDenyReason({ source: "aomi", status: "settled" }), null);
  });

  it("唔係平台單 → null（呼叫端要用 isPlatformOrder 分辨）", () => {
    assert.equal(platformVoidDenyReason({ source: "pos", status: "draft" }), null);
    assert.equal(platformVoidDenyReason(null), null);
  });

  it("已作廢 / 已退款 → 有原因，而且講明去邊度處理", () => {
    assert.match(String(platformVoidDenyReason({ source: "aomi", status: "cancelled" })), /已經作廢/);
    assert.match(
      String(platformVoidDenyReason({ source: "aomi", status: "refunded" })),
      /退款流程/,
    );
    assert.match(
      String(platformVoidDenyReason({ source: "mfood", status: "partially_refunded" })),
      /退款流程/,
    );
  });
});

describe("isPlatformOrder", () => {
  it("分得出「唔係平台單」同「係平台單但唔准作廢」", () => {
    assert.equal(isPlatformOrder({ source: "pos", status: "settled" }), false);
    assert.equal(isPlatformOrder({ source: "aomi", status: "cancelled" }), true);
    assert.equal(isPlatformOrder({ source: "mfood", status: "refunded" }), true);
  });
});

describe("預設審計文字", () => {
  it("一睇就知係覆寫（唔可以同本地單「收銀取消結帳」撈埋）", () => {
    assert.match(PLATFORM_VOID_DEFAULT_REASON, /覆寫/);
  });
});
