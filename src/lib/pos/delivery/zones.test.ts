import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  composeDeliveryAddress,
  isAddressReady,
  MACAU_DELIVERY_ZONES,
  matchZoneFromAddress,
  OTHER_ZONE,
} from "./zones.ts";

/**
 * 分區 + 地址組合回歸測試。
 *
 * 為什麼要釘死：呢條係**車手唯一睇得到嘅送貨資訊**。
 * 組合錯（例如「其他」時仍然加個前綴、或者區份同詳細地址撞埋一齊冇空格）
 * → 車手睇到一坨字，要靠打電話問，變相令「先揀區」嘅好意失效。
 */
describe("composeDeliveryAddress", () => {
  it("區 + 詳細地址：中間一定有空格", () => {
    assert.equal(composeDeliveryAddress("黑沙環", "88 號 5 樓 A"), "黑沙環 88 號 5 樓 A");
  });

  it("詳細地址未填 → 只寫區份（車手靠電話問）", () => {
    assert.equal(composeDeliveryAddress("黑沙環", ""), "黑沙環");
    assert.equal(composeDeliveryAddress("黑沙環", "   "), "黑沙環");
  });

  it("揀「其他」→ 只用詳細地址，唔會出現「其他 xxx」", () => {
    assert.equal(composeDeliveryAddress(OTHER_ZONE, "橫琴口岸 3 號門"), "橫琴口岸 3 號門");
  });

  it("兩邊都空白 → 空字串", () => {
    assert.equal(composeDeliveryAddress("", ""), "");
    assert.equal(composeDeliveryAddress(null, undefined), "");
  });

  it("前後空白會 trim（貼上地址唔會多個空格）", () => {
    assert.equal(composeDeliveryAddress("  氹仔市區 ", "  200 號  "), "氹仔市區 200 號");
  });
});

describe("isAddressReady", () => {
  it("只揀區份就夠（詳細地址可以後補）", () => {
    assert.equal(isAddressReady("黑沙環", ""), true);
  });

  it("乜都冇 → 未夠", () => {
    assert.equal(isAddressReady("", ""), false);
    assert.equal(isAddressReady(null, null), false);
  });

  it("🔴 揀「其他」但冇詳細地址 → 未夠（否則車手完全唔知去邊）", () => {
    assert.equal(isAddressReady(OTHER_ZONE, ""), false);
    assert.equal(isAddressReady(OTHER_ZONE, "橫琴口岸"), true);
  });
});

describe("分區清單本身", () => {
  it("有齊澳門主要區份，而且冇重複", () => {
    assert.ok(MACAU_DELIVERY_ZONES.length >= 10);
    assert.equal(new Set(MACAU_DELIVERY_ZONES).size, MACAU_DELIVERY_ZONES.length);
    for (const zone of ["黑沙環", "氹仔市區", "路環"]) {
      assert.ok((MACAU_DELIVERY_ZONES as readonly string[]).includes(zone), `缺少 ${zone}`);
    }
  });

  it("「其他」唔可以同正式區份撞名", () => {
    assert.equal((MACAU_DELIVERY_ZONES as readonly string[]).includes(OTHER_ZONE), false);
  });
});

describe("matchZoneFromAddress（平台單預填倒推）", () => {
  it("認得開頭嘅區份，並可以切走", () => {
    const address = "黑沙環中街 88 號 5 樓 A";
    const zone = matchZoneFromAddress(address);
    assert.equal(zone, "黑沙環");
    assert.equal(address.slice((zone as string).length).trim(), "中街 88 號 5 樓 A");
  });

  it("🔴 長名優先：氹仔舊城區唔會被氹仔市區食掉", () => {
    assert.equal(matchZoneFromAddress("氹仔舊城區 1 號"), "氹仔舊城區");
  });

  it("認唔到就 null（唔亂猜）", () => {
    assert.equal(matchZoneFromAddress("橫琴口岸 3 號門"), null);
    assert.equal(matchZoneFromAddress(""), null);
    assert.equal(matchZoneFromAddress(null), null);
  });
});
