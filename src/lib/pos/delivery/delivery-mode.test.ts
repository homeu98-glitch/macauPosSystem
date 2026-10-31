// 回歸測試：平台單「配送方式」正規化。
//
// 背景（2026-10-31）：平台單一直冇讀 `raw_json.raw.sendType`（澳覓）/
// `raw.deliveryType`（MFOOD），令 POS 分唔清「平台專送」同「商家自送」。
// 呢條規則決定「派送」掣會唔會出現，估錯 = 兩個車手同時上門。
//
// 實測值（唯讀查生產 raw_json）：
//   aomi  sendType = "專送"
//   mfood deliveryType = "1" / "3"
// 其餘（"2"、未知值、缺失）一律 fail-closed。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDeliveryModeMap,
  isMerchantArrangedMode,
  normalizeDeliveryMode,
  platformSourceOf,
  readPlatformRaw,
} from "./delivery-mode.ts";

describe("platformSourceOf", () => {
  it("只認 aomi / mfood（大小寫不敏感）", () => {
    assert.equal(platformSourceOf("aomi"), "aomi");
    assert.equal(platformSourceOf("MFOOD"), "mfood");
    assert.equal(platformSourceOf("pos"), null);
    assert.equal(platformSourceOf(undefined), null);
  });
});

describe("readPlatformRaw", () => {
  it("優先取 raw 內層（插件包裝）", () => {
    const raw = readPlatformRaw({ externalOrderId: "x", raw: { sendType: "專送" } });
    assert.equal(raw?.sendType, "專送");
  });

  it("冇 raw 內層就用頂層（假單／舊版）", () => {
    const raw = readPlatformRaw({ sendType: "自送" });
    assert.equal(raw?.sendType, "自送");
  });

  it("非物件回 null", () => {
    assert.equal(readPlatformRaw(null), null);
    assert.equal(readPlatformRaw("x"), null);
  });
});

describe("normalizeDeliveryMode · 澳覓", () => {
  const wrap = (sendType: unknown) => ({ raw: { sendType } });

  it("專送 = 平台配送", () => {
    assert.equal(normalizeDeliveryMode("aomi", wrap("專送")), "platform");
  });

  it("自送 = 商家自送", () => {
    assert.equal(normalizeDeliveryMode("aomi", wrap("自送")), "merchant");
  });

  it("自取 = 自取", () => {
    assert.equal(normalizeDeliveryMode("aomi", wrap("自取")), "pickup");
  });

  it("未知值 / 缺失 → unknown（fail-closed）", () => {
    assert.equal(normalizeDeliveryMode("aomi", wrap("神祕配送")), "unknown");
    assert.equal(normalizeDeliveryMode("aomi", wrap(undefined)), "unknown");
    assert.equal(normalizeDeliveryMode("aomi", null), "unknown");
  });
});

describe("normalizeDeliveryMode · MFOOD", () => {
  const wrap = (deliveryType: unknown) => ({ raw: { deliveryType } });

  it("1 = 平台配送", () => {
    assert.equal(normalizeDeliveryMode("mfood", wrap("1")), "platform");
    assert.equal(normalizeDeliveryMode("mfood", wrap(1)), "platform");
  });

  it("2 = 商家自送（未實測，暫定）", () => {
    assert.equal(normalizeDeliveryMode("mfood", wrap("2")), "merchant");
  });

  it("3 = 自取（未 100% 確認，但一定唔係平台派）", () => {
    assert.equal(normalizeDeliveryMode("mfood", wrap("3")), "pickup");
  });

  it("未知值 → unknown", () => {
    assert.equal(normalizeDeliveryMode("mfood", wrap("9")), "unknown");
    assert.equal(normalizeDeliveryMode("mfood", wrap(null)), "unknown");
  });
});

describe("normalizeDeliveryMode · 非平台單", () => {
  it("source 唔係平台 → unknown（唔會誤判）", () => {
    assert.equal(normalizeDeliveryMode("pos", { raw: { sendType: "自送" } }), "unknown");
    assert.equal(normalizeDeliveryMode(undefined, { raw: { sendType: "自送" } }), "unknown");
  });
});

describe("isMerchantArrangedMode", () => {
  it("只有 merchant / pickup 算「商戶自己安排」", () => {
    assert.equal(isMerchantArrangedMode("merchant"), true);
    assert.equal(isMerchantArrangedMode("pickup"), true);
    assert.equal(isMerchantArrangedMode("platform"), false);
    assert.equal(isMerchantArrangedMode("unknown"), false);
  });
});

describe("buildDeliveryModeMap（/api/pos/delivery/modes 回傳用）", () => {
  it("只回 id → mode，唔會漏 raw_json 出街", () => {
    const map = buildDeliveryModeMap([
      { id: "o1", source: "aomi", raw_json: { raw: { sendType: "自送" } } },
      { id: "o2", source: "mfood", raw_json: { raw: { deliveryType: "1" } } },
    ]);
    assert.deepEqual(map, { o1: "merchant", o2: "platform" });
  });

  it("未知值照樣收錄（等 UI 知道係平台單但唔知配送方式）", () => {
    assert.deepEqual(buildDeliveryModeMap([{ id: "o3", source: "aomi", raw_json: {} }]), {
      o3: "unknown",
    });
  });

  it("冇 id 嘅 row 直接跳過", () => {
    assert.deepEqual(buildDeliveryModeMap([{ id: "", source: "aomi" }]), {});
  });

  it("非平台 source → unknown（唔會當成自送）", () => {
    assert.deepEqual(buildDeliveryModeMap([{ id: "o4", source: "pos", raw_json: {} }]), {
      o4: "unknown",
    });
  });
});
