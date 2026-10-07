/**
 * 「庫存 › 品項分析」純函式守衛測試（`node --test`）。
 *
 * 🔴 本檔只可以 import **零 import** 嘅模組（`item-analysis.ts` / `item-price-baseline.ts`），
 *    因為 `node --test` 唔識解析 `@/` alias。
 *
 * 守住嘅口徑（J 2026-10-07 拍板 + 線框圖 §5）：
 *   1. 基準價 ＝ 首次進貨單價；冇基準 ⇒ direction "new"，**唔當 0% 報**。
 *   2. 漲／跌金額**分開兩行**，唔可以互相抵消。
 *   3. 冇基準嘅品項**完全唔入**漲跌統計。
 *   4. 總庫存值為 0 ⇒ 佔比 `null`，唔可以報 0%。
 *   5. 排序一定要穩定（null 排最後）。
 *   6. `item-analysis.ts` 同 `item-price-baseline.ts` 嘅算術**唔可以漂移**。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAmountRanking,
  buildCategoryBreakdown,
  buildItemAnalysisRows,
  collectAnalysisFilterOptions,
  filterItemAnalysisRows,
  formatAnalysisQty,
  summarizeItemAnalysis,
  type AnalysisProductInput,
} from "./item-analysis.ts";
import { computePriceChange } from "./item-price-baseline.ts";

/** 一個「正常有基準」嘅品項（基準 58 → 最新 62，即 +6.9%，庫存 120）。 */
const SHRIMP: AnalysisProductInput = {
  id: "p-shrimp",
  name: "急凍蝦仁",
  category: "海鮮",
  unit: "kg",
  current_qty: 120,
  avg_unit_cost: 62,
  baseline_unit_cost: 58,
  baseline_at: "2026-01-05",
  last_supplier: "澳門海鮮行",
  is_active: true,
};

describe("品項分析：組列（buildItemAnalysisRows）", () => {
  it("正常品項：算出漲幅／上漲金額，direction = up", () => {
    const [row] = buildItemAnalysisRows([SHRIMP]);
    assert.equal(row.name, "急凍蝦仁");
    assert.equal(row.latestUnitCost, 62);
    assert.equal(row.baselineUnitCost, 58);
    assert.equal(row.deltaUnitCost, 4);
    assert.equal(row.changeAmount, 480); // 4 × 120
    assert.ok(Math.abs((row.changePercent ?? 0) - 6.8965) < 0.01);
    assert.equal(row.direction, "up");
    assert.equal(row.stockValue, 7440); // 120 × 62
    assert.equal(row.valueSharePercent, 100); // 唯一品項 ⇒ 100%
  });

  it("🔴 冇基準（baseline null）⇒ direction new，金額／漲幅一律 null（唔可以係 0）", () => {
    const [row] = buildItemAnalysisRows([
      { name: "椰菜", current_qty: 32, avg_unit_cost: 305, baseline_unit_cost: null, is_active: true },
    ]);
    assert.equal(row.direction, "new");
    assert.equal(row.baselineUnitCost, null);
    assert.equal(row.changeAmount, null, "首次記錄唔可以回 0（會渲染成假零）");
    assert.equal(row.changePercent, null);
    assert.equal(row.deltaUnitCost, null);
    assert.equal(row.latestUnitCost, 305); // 最新單價照出
  });

  it("🔴 基準 = 0 ⇒ 當「未有基準」（避免除零出 Infinity / NaN）", () => {
    const [row] = buildItemAnalysisRows([
      { name: "怪單價", current_qty: 10, avg_unit_cost: 5, baseline_unit_cost: 0, is_active: true },
    ]);
    assert.equal(row.direction, "new");
    assert.equal(row.changePercent, null);
    assert.equal(row.baselineUnitCost, 0); // 照實報（唔會偷偷變 null）
    assert.ok(!Number.isNaN(row.changePercent ?? 0));
  });

  it("跌價 ⇒ direction down，數額為負", () => {
    const [row] = buildItemAnalysisRows([
      { name: "蛋", current_qty: 60, avg_unit_cost: 20.5, baseline_unit_cost: 21, is_active: true },
    ]);
    assert.equal(row.direction, "down");
    assert.equal(row.deltaUnitCost, -0.5);
    assert.equal(row.changeAmount, -30); // -0.5 × 60
    assert.ok((row.changePercent ?? 0) < 0);
  });

  it("持平 ⇒ direction same（係真數據，唔等於 new）", () => {
    const [row] = buildItemAnalysisRows([
      { name: "豆漿粉", current_qty: 25, avg_unit_cost: 35.6, baseline_unit_cost: 35.6, is_active: true },
    ]);
    assert.equal(row.direction, "same");
    assert.equal(row.deltaUnitCost, 0);
    assert.equal(row.changeAmount, 0);
  });

  it("🔴 is_active === false 嘅品項要完全排除（連分母都唔計）", () => {
    const rows = buildItemAnalysisRows([
      SHRIMP,
      { name: "已停用", current_qty: 999, avg_unit_cost: 999, baseline_unit_cost: 1, is_active: false },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "急凍蝦仁");
    assert.equal(rows[0].valueSharePercent, 100, "停用品項唔可以攤薄佔比");
  });

  it("分類／供應商係空字串或全空白 ⇒ null（唔會當成一個真分類）", () => {
    const [row] = buildItemAnalysisRows([
      { name: "無分類貨", category: "   ", last_supplier: "", current_qty: 1, avg_unit_cost: 10, is_active: true },
    ]);
    assert.equal(row.category, null);
    assert.equal(row.supplier, null);
  });

  it("🔴 總庫存值為 0 ⇒ 佔比 null（唔可以報 0%）", () => {
    const rows = buildItemAnalysisRows([
      { name: "零庫存", current_qty: 0, avg_unit_cost: 0, is_active: true },
    ]);
    assert.equal(summarizeItemAnalysis(rows).stockTotal, 0);
    assert.equal(rows[0].valueSharePercent, null);
  });

  it("單位缺席 ⇒ 'unit'（formatAnalysisQty 會收埋唔顯示）", () => {
    const [row] = buildItemAnalysisRows([{ name: "冇單位", current_qty: 1, avg_unit_cost: 1 }]);
    assert.equal(row.unit, "unit");
  });
});

describe("品項分析：摘要（summarizeItemAnalysis）", () => {
  const rows = buildItemAnalysisRows([
    SHRIMP, // up    +480
    { name: "豬扒", category: "肉類", current_qty: 45, avg_unit_cost: 408, baseline_unit_cost: 392, last_supplier: "新苗肉食" }, // up +720
    { name: "蛋", category: "肉類", current_qty: 60, avg_unit_cost: 20.5, baseline_unit_cost: 21, last_supplier: "新苗肉食" }, // down -30
    { name: "椰菜", category: "蔬菜", current_qty: 32, avg_unit_cost: 305, baseline_unit_cost: null, last_supplier: "澳門海鮮行" }, // new
  ]);

  it("🔴 漲／跌金額分開累加，唔可以互相抵消", () => {
    const s = summarizeItemAnalysis(rows);
    assert.equal(s.totalUpAmount, 1200, "+480 +720");
    assert.equal(s.totalDownAmount, -30);
    assert.equal(s.upCount, 2);
    assert.equal(s.downCount, 1);
    assert.equal(s.sameCount, 0);
    assert.equal(s.newCount, 1);
  });

  it("🔴 new（首次記錄）完全唔入漲跌統計", () => {
    const s = summarizeItemAnalysis(rows);
    // 4 個品項，但可比嘅只有 3 個（up2 + down1）
    assert.equal(s.upCount + s.downCount + s.sameCount + s.newCount, 4);
    assert.equal(s.upCount + s.downCount + s.sameCount, 3);
    // 椰菜（new）嘅 9760 唔可以偷偷入到 up/down 金額
    assert.equal(s.totalUpAmount + s.totalDownAmount, 1170);
  });

  it("平均漲幅只計可比品項", () => {
    const s = summarizeItemAnalysis(rows);
    assert.ok(s.avgChangePercent !== null);
    const expected =
      (6.896551724137931 + (16 / 392) * 100 + (-0.5 / 21) * 100) / 3;
    assert.ok(Math.abs((s.avgChangePercent ?? 0) - expected) < 0.001);
  });

  it("完全冇可比品項 ⇒ avgChangePercent = null（唔可以報 0）", () => {
    const s = summarizeItemAnalysis(
      buildItemAnalysisRows([{ name: "只有新品", current_qty: 1, avg_unit_cost: 10, baseline_unit_cost: null }]),
    );
    assert.equal(s.avgChangePercent, null);
    assert.equal(s.totalUpAmount, 0);
    assert.equal(s.totalDownAmount, 0);
    assert.equal(s.newCount, 1);
  });

  it("分類／供應商數用 distinct（null 唔計）", () => {
    const s = summarizeItemAnalysis(rows);
    assert.equal(s.categoryCount, 3); // 海鮮 / 肉類 / 蔬菜
    assert.equal(s.supplierCount, 2); // 澳門海鮮行 / 新苗肉食
  });

  it("upSharePercent 用全部 active 品項做分母", () => {
    const s = summarizeItemAnalysis(rows);
    assert.equal(s.upSharePercent, 50); // 2 / 4
  });

  it("空陣列 ⇒ 全 0，唔會 NaN", () => {
    const s = summarizeItemAnalysis([]);
    assert.equal(s.stockTotal, 0);
    assert.equal(s.itemCount, 0);
    assert.equal(s.upSharePercent, 0);
    assert.equal(s.avgChangePercent, null);
  });
});

describe("品項分析：篩選 / 排序（filterItemAnalysisRows）", () => {
  const rows = buildItemAnalysisRows([
    SHRIMP, // up +6.9%, 7440
    { name: "豬扒", category: "肉類", current_qty: 45, avg_unit_cost: 408, baseline_unit_cost: 392, last_supplier: "新苗肉食" }, // up +4.1%, 18360
    { name: "蛋", category: "肉類", current_qty: 60, avg_unit_cost: 20.5, baseline_unit_cost: 21, last_supplier: "新苗肉食" }, // down
    { name: "椰菜", category: "蔬菜", current_qty: 32, avg_unit_cost: 305, baseline_unit_cost: null, last_supplier: "澳門海鮮行" }, // new
  ]);

  it("onlyUp 只留 direction === up", () => {
    const out = filterItemAnalysisRows(rows, { onlyUp: true });
    assert.deepEqual(out.map((r) => r.name), ["急凍蝦仁", "豬扒"]);
  });

  it("分類篩選用精確比對（自由文字，唔可以模糊）", () => {
    assert.deepEqual(
      filterItemAnalysisRows(rows, { category: "肉類" }).map((r) => r.name).sort(),
      ["蛋", "豬扒"],
    );
  });

  it("搜尋：大小寫與首尾空白唔敏感", () => {
    assert.deepEqual(filterItemAnalysisRows(rows, { query: "  蝦  " }).map((r) => r.name), ["急凍蝦仁"]);
    assert.deepEqual(filterItemAnalysisRows(rows, { query: "豬扒" }).map((r) => r.name), ["豬扒"]);
  });

  it("🔴 change_desc：null（首次記錄）排最後，唔會散落中間", () => {
    const out = filterItemAnalysisRows(rows, {}, "change_desc");
    assert.deepEqual(out.map((r) => r.name), ["急凍蝦仁", "豬扒", "蛋", "椰菜"]);
    assert.equal(out[out.length - 1].direction, "new");
  });

  it("change_asc：跌最前，null 仍然最後", () => {
    const out = filterItemAnalysisRows(rows, {}, "change_asc");
    assert.deepEqual(out.map((r) => r.name), ["蛋", "豬扒", "急凍蝦仁", "椰菜"]);
  });

  it("value_desc 按庫存金額落序（null 佔比唔影響）", () => {
    const out = filterItemAnalysisRows(rows, {}, "value_desc");
    assert.equal(out[0].name, "豬扒");
    assert.equal(out[out.length - 1].name, "蛋");
  });

  it("🔴 排序唔可以改動傳入陣列（回新陣列）", () => {
    const before = rows.map((r) => r.name);
    filterItemAnalysisRows(rows, {}, "value_desc");
    assert.deepEqual(rows.map((r) => r.name), before);
  });

  it("篩選同排序併用", () => {
    const out = filterItemAnalysisRows(rows, { category: "肉類" }, "value_desc");
    assert.deepEqual(out.map((r) => r.name), ["豬扒", "蛋"]);
  });
});

describe("品項分析：圖表與選項", () => {
  const rows = buildItemAnalysisRows([
    SHRIMP, // 海鮮 7440
    { name: "豬扒", category: "肉類", current_qty: 45, avg_unit_cost: 408, baseline_unit_cost: 392 }, // 18360
    { name: "椰菜", category: "蔬菜", current_qty: 32, avg_unit_cost: 305, baseline_unit_cost: null }, // 9760
    { name: "無分類貨", category: null, current_qty: 2, avg_unit_cost: 500, baseline_unit_cost: null }, // 1000
  ]);

  it("金額排名落序並截 Top N", () => {
    const top = buildAmountRanking(rows, 2);
    assert.deepEqual(top.map((p) => p.name), ["豬扒", "椰菜"]);
    assert.equal(top[0].value, 18360);
  });

  it("排名佔比對得住總值", () => {
    const top = buildAmountRanking(rows, 1);
    assert.ok(Math.abs((top[0].sharePercent ?? 0) - (18360 / 36560) * 100) < 0.001);
  });

  it("分類佔比：null 分類歸一組（label 保持 null，唔會填假值）", () => {
    const cats = buildCategoryBreakdown(rows);
    assert.equal(cats[0].label, "肉類");
    assert.equal(cats[0].value, 18360);
    const unclassified = cats.find((c) => c.label === null);
    assert.ok(unclassified, "未分類一定要有一組");
    assert.equal(unclassified?.value, 1000);
  });

  it("總值為 0 ⇒ 分類佔比 sharePercent 全部 null", () => {
    const zero = buildItemAnalysisRows([{ name: "零", current_qty: 0, avg_unit_cost: 0, category: "X" }]);
    assert.equal(buildCategoryBreakdown(zero)[0].sharePercent, null);
  });

  it("篩選選項由實際資料 distinct 得出，並跟優先次序", () => {
    const opts = collectAnalysisFilterOptions(rows, {
      categories: ["蔬菜"], // 商家拖過：蔬菜排最前
      suppliers: [],
    });
    assert.equal(opts.categories[0], "蔬菜");
    // ⚠️ 唔可以斷言排序結果：`localeCompare(zh-Hant)` 係筆劃序（海 → 肉 → 蔬），
    //    同 JS 預設 UTF-16 碼位序唔同，寫死任何次序都會變成脆弱測試。
    //    呢度只斷言「三個真分類齊、蔬菜排最前、冇 null 混入」。
    assert.equal(opts.categories.length, 3, "null 分類唔應該入選項");
    assert.deepEqual([...new Set(opts.categories)].sort(), ["海鮮", "肉類", "蔬菜"].sort());
    assert.equal(opts.categories.includes("蔬菜"), true);
    assert.equal(opts.categories.includes("海鮮"), true);
    assert.equal(opts.categories.includes("肉類"), true);
  });
});

describe("品項分析：格式", () => {
  it("數量 3 位小數 + 單位", () => {
    assert.equal(formatAnalysisQty(120, "kg"), "120.000 kg");
    assert.equal(formatAnalysisQty(0.5, "包"), "0.500 包");
  });

  it("單位為空或 'unit' 時唔顯示單位", () => {
    assert.equal(formatAnalysisQty(12, "unit"), "12.000");
    assert.equal(formatAnalysisQty(12, ""), "12.000");
  });
});

describe("品項分析：同 item-price-baseline 算術對齊（防口徑漂移）", () => {
  /*
   * 🔴 為何要有呢組測試：`item-analysis.ts` 刻意自己寫咗一份 `computeChange()`，
   *    唔 import `item-price-baseline.ts`（後者 import 咗 `@/` ⇒ node --test 會爆）。
   *    兩份算術一旦漂移，就會出現「同一件貨，交班頁睇到 +480、品項分析睇到 +490」，
   *    而兩個畫面都自稱跟 J 拍板口徑。呢組測試係唯一嘅防線。
   */
  const CASES: Array<{ latest: number; base: number; qty: number }> = [
    { latest: 62, base: 58, qty: 120 },
    { latest: 20.5, base: 21, qty: 60 },
    { latest: 35.6, base: 35.6, qty: 25 },
    { latest: 142, base: 138, qty: 200 },
    { latest: 0, base: 10, qty: 5 },
    { latest: 99.995, base: 33.331, qty: 3 },
  ];

  for (const c of CASES) {
    it(`最新 ${c.latest} / 基準 ${c.base} / 數量 ${c.qty}：兩支算術完全一致`, () => {
      const [row] = buildItemAnalysisRows([
        { name: "對照品", current_qty: c.qty, avg_unit_cost: c.latest, baseline_unit_cost: c.base },
      ]);
      const ref = computePriceChange({
        latestUnitCost: c.latest,
        baselineUnitCost: c.base,
        currentQty: c.qty,
      });
      assert.equal(row.latestUnitCost, ref.latestUnitCost, "最新單價");
      assert.equal(row.baselineUnitCost, ref.baselineUnitCost, "基準價");
      assert.equal(row.deltaUnitCost, ref.deltaUnitCost, "單價漲跌額");
      assert.equal(row.changeAmount, ref.changeAmount, "受影響金額");
      assert.equal(row.direction, ref.direction, "方向");
      if (ref.changePercent === null) {
        assert.equal(row.changePercent, null);
      } else {
        assert.ok(
          Math.abs((row.changePercent ?? 0) - ref.changePercent) < 1e-9,
          `漲幅 ${row.changePercent} vs ${ref.changePercent}`,
        );
      }
    });
  }

  it("摘要加總同 summarizePriceChanges 口徑一致", () => {
    const products: AnalysisProductInput[] = [
      { name: "A", current_qty: 10, avg_unit_cost: 12, baseline_unit_cost: 10 },
      { name: "B", current_qty: 10, avg_unit_cost: 8, baseline_unit_cost: 10 },
      { name: "C", current_qty: 10, avg_unit_cost: 5, baseline_unit_cost: null },
    ];
    const rows = buildItemAnalysisRows(products);
    const s = summarizeItemAnalysis(rows);
    assert.equal(s.totalUpAmount, 20); // 2 × 10
    assert.equal(s.totalDownAmount, -20); // -2 × 10
    assert.equal(s.newCount, 1);
    /*
     * 🔴 「唔可以互相抵消」既正確檢查：淨額雖然係 0（+20 + -20），
     *    但兩個**分項**必須各自保留 —— 若有人寫成「先加埋再取絕對值」或者
     *    「up 同 down 用同一個 accumulator」，兩個分項就會爆。
     */
    assert.equal(s.totalUpAmount + s.totalDownAmount, 0, "淨額係 0 係事實，唔係 bug");
    assert.equal(s.totalUpAmount, 20, "漲價金額唔可以被跌價抹走");
    assert.equal(s.totalDownAmount, -20, "跌價金額唔可以被漲價抹走");
  });
});
