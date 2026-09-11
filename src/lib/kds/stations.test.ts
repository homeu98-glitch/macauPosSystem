import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FALLBACK_STATION_ID,
  deriveKdsStations,
  isKdsStation,
  isStationAvailable,
  needsStationPicker,
  stationLabel,
} from "./stations.ts";

/**
 * 工位推導規則（docs/116 §4.4）。
 *
 * 呢兩條錯咗會靜默出錯，所以一定要鎖死：
 *   - 冇剔走 `receipt` → 師傅揀到「收銀機」做崗位，屏永遠冇出品；
 *   - 空清單唔 fallback → 「揀崗位」畫面冇嘢揀，部機卡死。
 */

describe("isKdsStation", () => {
  it("receipt / label 唔係工位（大小寫、空白都要擋）", () => {
    assert.equal(isKdsStation("receipt"), false);
    assert.equal(isKdsStation("RECEIPT"), false);
    assert.equal(isKdsStation("  label  "), false);
  });

  it("空值唔係工位", () => {
    assert.equal(isKdsStation(""), false);
    assert.equal(isKdsStation("   "), false);
    assert.equal(isKdsStation(undefined), false);
    assert.equal(isKdsStation(null), false);
  });

  it("正常 printerGroup 係工位", () => {
    assert.equal(isKdsStation("kitchen"), true);
    assert.equal(isKdsStation("drinks"), true);
    assert.equal(isKdsStation("炸爐"), true);
  });
});

describe("deriveKdsStations", () => {
  it("剔走 receipt / label", () => {
    const list = deriveKdsStations({
      printerGroups: ["kitchen", "drinks", "receipt", "label"],
    });
    assert.deepEqual(list.map((s) => s.id), ["kitchen", "drinks"]);
  });

  it("菜單同打印機群取聯集、去重", () => {
    const list = deriveKdsStations({
      printerGroups: ["kitchen", "drinks"],
      menuItemGroups: ["kitchen", "wok"],
    });
    assert.deepEqual(list.map((s) => s.id), ["kitchen", "wok", "drinks"]);
  });

  it("一個工位都冇 → fallback 單一「廚房」（唔可以回空）", () => {
    const list = deriveKdsStations({ printerGroups: ["receipt"], menuItemGroups: [] });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, FALLBACK_STATION_ID);
    assert.equal(list[0].label, "廚房");
  });

  it("顯示名有 fallback，未知工位用返原字串", () => {
    const list = deriveKdsStations({ printerGroups: ["kitchen", "炸爐"] });
    const byId = Object.fromEntries(list.map((s) => [s.id, s.label]));
    assert.equal(byId.kitchen, "廚房");
    assert.equal(byId["炸爐"], "炸爐");
  });

  it("pending 帶入未完成數，缺失當 0，負數夾做 0", () => {
    const list = deriveKdsStations({
      printerGroups: ["kitchen", "drinks"],
      pending: { kitchen: 7, drinks: -3 },
    });
    const byId = Object.fromEntries(list.map((s) => [s.id, s.pending]));
    assert.equal(byId.kitchen, 7);
    assert.equal(byId.drinks, 0);
  });

  it("廚房類排先、水吧其後", () => {
    const list = deriveKdsStations({ printerGroups: ["drinks", "kitchen", "cold"] });
    assert.deepEqual(list.map((s) => s.id), ["kitchen", "cold", "drinks"]);
  });
});

describe("stationLabel", () => {
  it("已知工位譯中文，未知原樣回", () => {
    assert.equal(stationLabel("drinks"), "水吧");
    assert.equal(stationLabel("bar"), "水吧");
    assert.equal(stationLabel("神秘工位"), "神秘工位");
  });
});

describe("needsStationPicker", () => {
  it("只有一個工位 → 唔應該出選擇步驟（多餘一步 = 多一次誤按機會）", () => {
    assert.equal(needsStationPicker([{ id: "kitchen", label: "廚房", pending: 0 }]), false);
  });

  it("兩個工位 → 要出選擇步驟", () => {
    assert.equal(
      needsStationPicker([
        { id: "kitchen", label: "廚房", pending: 0 },
        { id: "drinks", label: "水吧", pending: 0 },
      ]),
      true,
    );
  });
});

describe("isStationAvailable", () => {
  const stations = [
    { id: "kitchen", label: "廚房", pending: 0 },
    { id: "drinks", label: "水吧", pending: 0 },
  ];

  it("綁定嘅工位仲喺清單度 → 有效", () => {
    assert.equal(isStationAvailable(stations, "kitchen"), true);
  });

  it("店家改咗菜單、工位冇咗 → 唔有效（要彈返去重揀，唔可以當「全部」）", () => {
    assert.equal(isStationAvailable(stations, "炸爐"), false);
  });

  it("空值一律唔有效", () => {
    assert.equal(isStationAvailable(stations, ""), false);
    assert.equal(isStationAvailable(stations, undefined), false);
    assert.equal(isStationAvailable(stations, null), false);
  });
});
