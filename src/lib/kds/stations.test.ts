import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveKdsStations,
  isLegacyNonStation,
  isStationAvailable,
  needsStationPicker,
} from "./stations.ts";

/**
 * 分區（工位）推導規則（docs/116 §4.4 · 2026-09-11 修正）。
 *
 * 🔴 最重要嘅一條：**分區清單 = 商家自己設定嘅 `printZones`**，
 * 唔可以寫死、唔可以合併、唔可以改名。
 * 反例（舊版嘅錯）：店有「後廚1/2/3、水吧1/2/3」六個分區，
 * 被硬編碼嘅 `STATION_LABELS` 譯成「廚房／水吧」兩個 → 師傅揀唔到自己嘅崗位。
 */

const ZONES = [
  { id: "後廚1", name: "後廚1" },
  { id: "後廚2", name: "後廚2" },
  { id: "後廚3", name: "後廚3" },
  { id: "水吧1", name: "水吧1" },
  { id: "水吧2", name: "水吧2" },
  { id: "水吧3", name: "水吧3" },
];

describe("deriveKdsStations · 主來源 = 商家 printZones", () => {
  it("🔴 六個分區各自獨立呈現，一個都唔合併、一個都唔改名", () => {
    const list = deriveKdsStations({ printZones: ZONES });
    assert.deepEqual(list.map((s) => s.name), ["後廚1", "後廚2", "後廚3", "水吧1", "水吧2", "水吧3"]);
  });

  it("🔴 唔會將自訂分區譯成「廚房 / 水吧」（舊版嘅核心 bug）", () => {
    const list = deriveKdsStations({ printZones: ZONES });
    assert.equal(list.some((s) => s.name === "廚房" || s.name === "水吧"), false);
  });

  it("顯示名用商家打嘅名，唔係 id", () => {
    const list = deriveKdsStations({
      printZones: [{ id: "zone-a-1757380123456", name: "前廳甜品" }],
    });
    assert.equal(list[0].name, "前廳甜品");
    assert.equal(list[0].id, "zone-a-1757380123456");
  });

  it("商家改名 → 屏上即刻跟住變（因為名係由 printZones 提供）", () => {
    const list = deriveKdsStations({ printZones: [{ id: "kitchen", name: "一廚" }] });
    assert.equal(list[0].name, "一廚");
  });

  it("名係空白 → 退返 id（唔會顯示空白卡）", () => {
    const list = deriveKdsStations({ printZones: [{ id: "kitchen", name: "   " }] });
    assert.equal(list[0].name, "kitchen");
  });

  it("冇任何菜、冇任何單嘅分區都要出現（後廚3 今晚未開都要揀得到）", () => {
    const list = deriveKdsStations({ printZones: ZONES, pending: { 後廚1: 3 } });
    assert.equal(list.length, 6);
    assert.equal(list[0].pending, 3);
    assert.equal(list[5].pending, 0);
  });

  it("保持商家設定嘅次序（唔會自己排序）", () => {
    const list = deriveKdsStations({
      printZones: [
        { id: "b", name: "水吧" },
        { id: "a", name: "廚房" },
      ],
    });
    assert.deepEqual(list.map((s) => s.id), ["b", "a"]);
  });

  it("重複 id 會去重", () => {
    const list = deriveKdsStations({
      printZones: [
        { id: "a", name: "廚房" },
        { id: "a", name: "重複" },
      ],
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "廚房");
  });

  it("壞資料（null / 空 id）一律跳過，唔會 crash", () => {
    const list = deriveKdsStations({
      printZones: [null as never, { id: "  ", name: "x" }, { id: "ok", name: "好" }],
    });
    assert.deepEqual(list.map((s) => s.id), ["ok"]);
  });
});

describe("deriveKdsStations · 舊資料補救", () => {
  it("訂單出現過、但唔喺 printZones 嘅 id → 仍然要出現（唔可以令嗰啲單上唔到屏）", () => {
    const list = deriveKdsStations({
      printZones: [{ id: "後廚1", name: "後廚1" }],
      observedStationIds: ["kitchen"],
    });
    assert.deepEqual(list.map((s) => s.id), ["後廚1", "kitchen"]);
    // 冇名可以提供 → 用 id 做名（誠實過亂譯）
    assert.equal(list[1].name, "kitchen");
  });

  it("舊 printer_groups 只做最後兜底，而且唔會蓋過 printZones", () => {
    const list = deriveKdsStations({
      printZones: [{ id: "後廚1", name: "後廚1" }],
      printerGroups: ["kitchen", "drinks"],
    });
    assert.deepEqual(list.map((s) => s.id), ["後廚1", "kitchen", "drinks"]);
  });

  it("receipt / label 係打印機 role 唔係分區 → 唔會出現喺崗位清單", () => {
    const list = deriveKdsStations({ printerGroups: ["kitchen", "receipt", "label"] });
    assert.deepEqual(list.map((s) => s.id), ["kitchen"]);
  });

  it("但商家真係開咗一個叫 receipt 嘅分區 → 照樣尊重（唔會剔走）", () => {
    const list = deriveKdsStations({ printZones: [{ id: "receipt", name: "收銀" }] });
    assert.deepEqual(list.map((s) => s.name), ["收銀"]);
  });
});

describe("isLegacyNonStation", () => {
  it("receipt / label（大小寫、空白）都算舊資料排除項", () => {
    assert.equal(isLegacyNonStation("receipt"), true);
    assert.equal(isLegacyNonStation("RECEIPT"), true);
    assert.equal(isLegacyNonStation("  label  "), true);
  });

  it("正常分區名唔算", () => {
    assert.equal(isLegacyNonStation("kitchen"), false);
    assert.equal(isLegacyNonStation("後廚1"), false);
    assert.equal(isLegacyNonStation(""), false);
    assert.equal(isLegacyNonStation(undefined), false);
  });
});

describe("needsStationPicker", () => {
  it("只有一個分區 → 唔應該出選擇步驟（多餘一步 = 多一次誤按機會）", () => {
    assert.equal(needsStationPicker(deriveKdsStations({ printZones: ZONES.slice(0, 1) })), false);
  });

  it("多過一個分區 → 要出選擇步驟", () => {
    assert.equal(needsStationPicker(deriveKdsStations({ printZones: ZONES })), true);
  });

  it("一個分區都冇 → 唔會自動鎖定（要顯示「未設定分區」）", () => {
    assert.equal(needsStationPicker(deriveKdsStations({})), false);
  });
});

describe("isStationAvailable", () => {
  const stations = deriveKdsStations({ printZones: ZONES });

  it("綁定嘅分區仲喺清單度 → 有效", () => {
    assert.equal(isStationAvailable(stations, "後廚2"), true);
  });

  it("店家刪咗個分區 → 唔有效（設定卡要出提示；但**唔會**自動彈返揀崗位）", () => {
    assert.equal(isStationAvailable(stations, "甜品部"), false);
  });

  it("空值一律唔有效", () => {
    assert.equal(isStationAvailable(stations, ""), false);
    assert.equal(isStationAvailable(stations, undefined), false);
    assert.equal(isStationAvailable(stations, null), false);
  });
});
