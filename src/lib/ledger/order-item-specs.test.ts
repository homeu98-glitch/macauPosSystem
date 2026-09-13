// 回歸測試：Ledger 線上單明細 → 「已選規格」解析。
//
// 對應需求（2026-09-13 商家實紙）：
//   Ledger 自己印嘅單有規格（`*飲料:湯`／`*加購:蒸蛋 +10`），但 POS 廚房單
//   一條規格都冇。根因係 Ledger → POS 投影路徑從來冇建立 `selectedSpecs`。
//   商家口徑：「菜單跟我們是 in sync 的，他們線上的單我們應該都要有。」
//   ⇒ 用本地同步餐牌補返文字。
//
// 用 Node 內建 test runner（`node --test`），零依賴。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  enrichSpecsFromMenu,
  parseOrderItemSpecs,
  toResolvedSpecs,
  type LocalSpecGroup,
} from "./order-item-specs.ts";

const MENU: LocalSpecGroup[] = [
  {
    id: "grp-drink",
    name: "飲料",
    options: [
      { id: "opt-soup", label: "湯", priceDelta: 0 },
      { id: "opt-coke", label: "可樂", priceDelta: 5 },
    ],
  },
  {
    id: "grp-addon",
    name: "加購",
    options: [
      { id: "opt-egg", label: "蒸蛋", priceDelta: 10 },
      { id: "opt-veg", label: "油菜", priceDelta: 1 },
    ],
  },
];

describe("parseOrderItemSpecs：扁平平鋪", () => {
  it("由 options 陣列抽出 group / option / 加價（MOP）", () => {
    const specs = parseOrderItemSpecs({
      product_name: "南乳雞中亦",
      options: [
        { group_name: "飲料", option_name: "湯" },
        { group_name: "加購", option_name: "蒸蛋", price_delta: 10 },
      ],
    });
    assert.deepEqual(specs, [
      { groupId: undefined, groupName: "飲料", optionId: undefined, optionLabel: "湯", priceDelta: undefined },
      { groupId: undefined, groupName: "加購", optionId: undefined, optionLabel: "蒸蛋", priceDelta: 10 },
    ]);
  });

  it("── avos 欄位自動除 100（`price_delta_avos: 500` = +$5）", () => {
    const specs = parseOrderItemSpecs({
      options: [{ group_name: "熱定凍", option_name: "熱", price_delta_avos: 500 }],
    });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].priceDelta, 5);
  });

  it("id / name 三種別名都認", () => {
    const specs = parseOrderItemSpecs({
      selected_options: [{ group_id: "g1", option_id: "o1", label: "凍" }],
    });
    assert.deepEqual(specs, [
      { groupId: "g1", groupName: undefined, optionId: "o1", optionLabel: "凍", priceDelta: undefined },
    ]);
  });
});

describe("parseOrderItemSpecs：group 包選項", () => {
  it("列出全部選項時只取 `selected: true`", () => {
    const specs = parseOrderItemSpecs({
      specs: [
        {
          group_name: "熱定凍",
          options: [
            { id: "o1", name: "熱", selected: false },
            { id: "o2", name: "凍", selected: true },
          ],
        },
      ],
    });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].optionLabel, "凍");
  });

  it("完全冇旗標 → 當列出嘅就係已選", () => {
    const specs = parseOrderItemSpecs({
      options: [{ group_name: "加購", options: [{ name: "蒸蛋" }, { name: "油菜" }] }],
    });
    assert.deepEqual(
      specs.map((spec) => spec.optionLabel),
      ["蒸蛋", "油菜"],
    );
  });

  it("有旗標但全部 false → 唔出任何規格（避免印一堆未揀嘅選項）", () => {
    const specs = parseOrderItemSpecs({
      options: [
        {
          group_name: "飲料",
          options: [
            { name: "湯", selected: false },
            { name: "可樂", selected: false },
          ],
        },
      ],
    });
    assert.deepEqual(specs, []);
  });
});

describe("parseOrderItemSpecs：整條規格文字（Ledger 自家單據格式）", () => {
  it("拆 `*群組:選項` 並抽出尾綴加價", () => {
    const specs = parseOrderItemSpecs({
      spec_text: "*要唔要袋:唔要\n*飲料:湯\n*加購:蒸蛋 +10\n*加購:油菜 +1",
    });
    assert.deepEqual(
      specs.map((spec) => `${spec.groupName}:${spec.optionLabel}`),
      ["要唔要袋:唔要", "飲料:湯", "加購:蒸蛋", "加購:油菜"],
    );
    assert.deepEqual(
      specs.map((spec) => spec.priceDelta),
      [undefined, undefined, 10, 1],
    );
  });

  it("認 `-` 負加價同 `$` 前綴", () => {
    const specs = parseOrderItemSpecs({ options_text: "優惠:套餐 -$5;加購:蒸蛋 $10" });
    assert.deepEqual(
      specs.map((spec) => [spec.optionLabel, spec.priceDelta]),
      [
        ["套餐", -5],
        ["蒸蛋", 10],
      ],
    );
  });

  it("陣列入面直接放字串一樣拆得開", () => {
    const specs = parseOrderItemSpecs({ options: ["飲料:湯", "加購:蒸蛋 +10"] });
    assert.deepEqual(
      specs.map((spec) => spec.optionLabel),
      ["湯", "蒸蛋"],
    );
  });
});

describe("parseOrderItemSpecs：唔出亂碼", () => {
  it("空 / 垃圾輸入 → []", () => {
    assert.deepEqual(parseOrderItemSpecs(null), []);
    assert.deepEqual(parseOrderItemSpecs("x"), []);
    assert.deepEqual(parseOrderItemSpecs({ product_name: "飯" }), []);
    assert.deepEqual(parseOrderItemSpecs({ options: [] }), []);
  });

  it("純 id 而欄名唔係 selected*：唔收（怕係「全部可選項」清單）", () => {
    assert.deepEqual(parseOrderItemSpecs({ options: [{ option_id: "o1" }] }), []);
  });

  it("純 id 但欄名寫明 selected*：收，等本地餐牌補文字", () => {
    const specs = parseOrderItemSpecs({ selected_options: [{ option_id: "opt-soup" }] });
    assert.equal(specs.length, 1);
    assert.equal(specs[0].optionId, "opt-soup");
    assert.equal(specs[0].optionLabel, undefined);
  });

  it("同一個 group:option 出現兩次（options + modifiers）只出一次", () => {
    const specs = parseOrderItemSpecs({
      options: [{ group_name: "加購", option_name: "蒸蛋" }],
      modifiers: [{ group_name: "加購", option_name: "蒸蛋" }],
    });
    assert.equal(specs.length, 1);
  });
});

describe("enrichSpecsFromMenu：用本地同步餐牌補文字", () => {
  it("只有 group_name / option_name（冇 id）→ 靠名撞返 id 同加價", () => {
    const out = enrichSpecsFromMenu(
      [{ groupName: "加購", optionLabel: "蒸蛋" }],
      MENU,
    );
    assert.deepEqual(out, [
      { groupId: "grp-addon", groupName: "加購", optionId: "opt-egg", optionLabel: "蒸蛋", priceDelta: 10 },
    ]);
  });

  it("只有 optionId（group 對唔到）→ 全餐牌掃 id", () => {
    const out = enrichSpecsFromMenu([{ optionId: "opt-coke" }], MENU);
    assert.deepEqual(out, [
      { groupId: "grp-drink", groupName: "飲料", optionId: "opt-coke", optionLabel: "可樂", priceDelta: 5 },
    ]);
  });

  it("用 groupId 對到 group、但 optionId 對唔到選項 → 至少補 group 名", () => {
    const out = enrichSpecsFromMenu([{ groupId: "grp-addon", optionId: "opt-unknown" }], MENU);
    assert.equal(out[0].groupName, "加購");
    assert.equal(out[0].optionLabel, undefined);
  });

  it("冇本地餐牌 → 原封不動", () => {
    const input = [{ groupName: "飲料", optionLabel: "湯" }];
    assert.deepEqual(enrichSpecsFromMenu(input, undefined), input);
  });
});

describe("toResolvedSpecs：收窄成 OrderItem.selectedSpecs", () => {
  it("冇 optionLabel 一律唔要", () => {
    const out = toResolvedSpecs([
      { groupId: "g", optionId: "o1" },
      { groupName: "飲料", optionLabel: "湯" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].optionLabel, "湯");
  });

  it("groupName 缺失 → 填「規格」，避免印出開頭係冒號嘅行", () => {
    const out = toResolvedSpecs([{ optionLabel: "湯" }]);
    assert.deepEqual(out, [
      { groupId: "", groupName: "規格", optionId: "", optionLabel: "湯", priceDelta: 0 },
    ]);
  });
});

describe("端到端：商家實紙嗰張單", () => {
  it("Ledger 明細 → 規格行字串（同廚房單 `group:option +$X` 口徑一致）", () => {
    const raw = {
      product_name: "南乳雞中亦",
      options: [
        { group_name: "要唔要袋", option_name: "唔要" },
        { group_name: "飲料", option_name: "湯" },
        { group_name: "熱定凍", option_name: "熱", price_delta_avos: 500 },
        { group_name: "加購", option_name: "蒸蛋", price_delta: 10 },
        { group_name: "加購", option_name: "油菜", price_delta: 1 },
        { group_name: "要唔要膠袋?", option_name: "要" },
      ],
    };
    const lines = toResolvedSpecs(parseOrderItemSpecs(raw)).map((spec) => {
      const head = `${spec.groupName}:${spec.optionLabel}`;
      return spec.priceDelta === 0 ? head : `${head} $${Math.abs(spec.priceDelta)}`;
    });
    assert.deepEqual(lines, [
      "要唔要袋:唔要",
      "飲料:湯",
      "熱定凍:熱 $5",
      "加購:蒸蛋 $10",
      "加購:油菜 $1",
      "要唔要膠袋?:要",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 真實 RPC 回應（2026-09-13 商家由 DevTools 抄出嚟；取餐碼 003）。
//
// 呢個 case 係「第一版漏咗 `selected_specs`」嘅回歸測試：
// 舊版候選清單只有 `spec_selections` / `specSelections` / `selected_options` / `specs`
// → 實機一個規格都 parse 唔到，但單元測試（用 `selected_options`）全綠。
// **所以呢個 case 一定要用真欄名 `selected_specs` 嚟鎖住。**
// ─────────────────────────────────────────────────────────────────────────────
const REAL_RPC_ITEMS = [
  {
    id: "673459f6-real-0001",
    qty: 1,
    name: "快閃餐(沙姜炒豬頸肉饭)",
    line_note: null,
    product_id: "abc8e99d-real-0001",
    selected_specs: [
      { group_name: "飲料", option_name: "檸茶", price_delta_avos: 200 },
      { group_name: "熱定凍", option_name: "凍", price_delta_avos: 200 },
      { group_name: "加購", option_name: "蒸蛋", price_delta_avos: 500 },
      { group_name: "要唔要膠袋?", option_name: "不要" },
    ],
    unit_price_avos: 5300,
    promo_applied_qty: null,
    promo_rate_permille: null,
    discounted_unit_price_avos: null,
  },
  {
    id: "fa5a46b7-real-0002",
    qty: 3,
    name: "南乳雞中亦",
    line_note: null,
    product_id: "93045a1f-real-0002",
    selected_specs: [{ group_name: "加購", option_name: "蒸蛋", price_delta_avos: 100 }],
    unit_price_avos: 500,
    promo_applied_qty: null,
    promo_rate_permille: null,
    discounted_unit_price_avos: null,
  },
];

describe("實機 RPC 回應（selected_specs）", () => {
  it("真欄名 `selected_specs` 一定要 parse 到（回歸：舊版漏咗呢個名）", () => {
    const specs = parseOrderItemSpecs(REAL_RPC_ITEMS[0]);
    assert.deepEqual(
      specs.map((spec) => [spec.groupName, spec.optionLabel, spec.priceDelta]),
      [
        ["飲料", "檸茶", 2],
        ["熱定凍", "凍", 2],
        ["加購", "蒸蛋", 5],
        ["要唔要膠袋?", "不要", undefined],
      ],
    );
  });

  it("渲染成廚房單／收據嘅 spec 行（`group:option $X`）", () => {
    const lines = toResolvedSpecs(parseOrderItemSpecs(REAL_RPC_ITEMS[0])).map((spec) => {
      const head = `${spec.groupName}:${spec.optionLabel}`;
      return spec.priceDelta === 0 ? head : `${head} $${Math.abs(spec.priceDelta)}`;
    });
    assert.deepEqual(lines, [
      "飲料:檸茶 $2",
      "熱定凍:凍 $2",
      "加購:蒸蛋 $5",
      "要唔要膠袋?:不要",
    ]);
  });

  it("其餘真欄位（id / product_id / unit_price_avos …）唔會被當成規格", () => {
    const lines = toResolvedSpecs(parseOrderItemSpecs(REAL_RPC_ITEMS[1])).map(
      (spec) => `${spec.groupName}:${spec.optionLabel} $${spec.priceDelta}`,
    );
    assert.deepEqual(lines, ["加購:蒸蛋 $1"]);
  });
});

describe("object map 形式（group → 已選選項）", () => {
  it("欄名寫明 selected* 時，map 形式都收", () => {
    const specs = parseOrderItemSpecs({
      selected_specs: { 飲料: "檸茶", 加購: ["蒸蛋", "油菜"], 要多個膠袋: true },
    });
    assert.deepEqual(
      specs.map((spec) => `${spec.groupName ?? ""}:${spec.optionLabel}`),
      ["飲料:檸茶", "加購:蒸蛋", "加購:油菜", ":要多個膠袋"],
    );
    // `toResolvedSpecs` 會幫冇 group 名嘅補上「規格」，避免印出開頭係冒號嘅行。
    assert.deepEqual(
      toResolvedSpecs(specs).map((spec) => `${spec.groupName}:${spec.optionLabel}`),
      ["飲料:檸茶", "加購:蒸蛋", "加購:油菜", "規格:要多個膠袋"],
    );
  });

  it("欄名唔係 selected*（可能係「全部可選項」清單）→ map 形式唔收", () => {
    assert.deepEqual(parseOrderItemSpecs({ options: { 飲料: "檸茶" } }), []);
  });
});
