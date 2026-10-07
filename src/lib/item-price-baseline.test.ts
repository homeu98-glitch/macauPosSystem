/**
 * 基準價 / 上漲金額 嘅守衛測試。
 *
 * 🔴 本檔係「零 import 模組」嘅測試，所以用**相對路徑連 .ts 都要寫**
 *    （本專案 `npm test` = `node --test`，唔識解析 `@/` alias）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  pickEarlierBaseline,
  collectBaselines,
  computePriceChange,
  isComparable,
  summarizePriceChanges,
  type BaselineReceiptInput,
  type PriceChange,
} from "./item-price-baseline.ts";

/* ─────────────── 1. 揸「首次」規則 ─────────────── */

test("collectBaselines：揀日期最早嗰筆，唔係最新嗰筆", () => {
  const m = collectBaselines([
    { receipt_date: "2026-03-10", items: [{ name: "豬扒", unit_price: 400 }] },
    { receipt_date: "2026-06-01", items: [{ name: "豬扒", unit_price: 392 }] },
    { receipt_date: "2026-09-20", items: [{ name: "豬扒", unit_price: 408 }] },
  ]);
  assert.equal(m.get("豬扒")?.unitCost, 400, "應該係 3 月首次嘅 400，唔係 6 月嘅 392");
  assert.equal(m.get("豬扒")?.date, "2026-03-10");
});

test("collectBaselines：同日多筆 → 揀單價低者（保守，令漲幅唔會誇大）", () => {
  const m = collectBaselines([
    { receipt_date: "2026-05-01", items: [{ name: "蝦", unit_price: 60 }] },
    { receipt_date: "2026-05-01", items: [{ name: "蝦", unit_price: 55 }] },
  ]);
  assert.equal(m.get("蝦")?.unitCost, 55);
});

test("collectBaselines：單價相同 → 保留先遇到嗰個（穩定可重現）", () => {
  const a = collectBaselines([{ receipt_date: "2026-05-01", items: [{ name: "米", unit_price: 140 }] }]);
  const b = collectBaselines([{ receipt_date: "2026-05-01", items: [{ name: "米", unit_price: 140 }] }]);
  assert.deepEqual(a.get("米"), b.get("米"));
});

test("collectBaselines：品名大小寫 / 空白不同仍然當同一品項", () => {
  const m = collectBaselines([
    { receipt_date: "2026-01-05", items: [{ name: "  Thai Rice ", unit_price: 130 }] },
    { receipt_date: "2026-04-05", items: [{ name: "thai rice", unit_price: 142 }] },
  ]);
  assert.equal(m.size, 1);
  assert.equal(m.get("thai rice")?.unitCost, 130);
});

test("collectBaselines：unit_price <= 0 唔做基準（唔會整出除零）", () => {
  const m = collectBaselines([
    { receipt_date: "2026-01-05", items: [{ name: "贈品", unit_price: 0 }] },
    { receipt_date: "2026-02-05", items: [{ name: "贈品", unit_price: -3 }] },
  ]);
  assert.equal(m.has("贈品"), false, "非正單價唔應該成為基準");
});

test("collectBaselines：收據冇日期時，仍然拎得到基準（唔會整個品項冇基準）", () => {
  const m = collectBaselines([{ receipt_date: null, items: [{ name: "蛋", unit_price: 21 }] }]);
  assert.equal(m.get("蛋")?.unitCost, 21);
  assert.equal(m.get("蛋")?.date, null);
});

test("collectBaselines：空名 / 空 items 唔會整出雜項", () => {
  const m = collectBaselines([
    { receipt_date: "2026-01-05", items: [{ name: "   ", unit_price: 10 }] },
    { receipt_date: "2026-01-05", items: [] },
  ]);
  assert.equal(m.size, 0);
});

test("collectBaselines：字串單價（'1,234.5'）照樣解析", () => {
  const m = collectBaselines([{ receipt_date: "2026-01-05", items: [{ name: "貨", unit_price: "1,234.5" as unknown as number }] }]);
  assert.equal(m.get("貨")?.unitCost, 1234.5);
});

/* ─────────────── 2. pickEarlierBaseline 對稱性 ─────────────── */

test("pickEarlierBaseline：current 為 null → 直接接受候選", () => {
  const r = pickEarlierBaseline(null, { unitCost: 10, date: "2026-01-01" });
  assert.equal(r?.unitCost, 10);
});

test("pickEarlierBaseline：候選日期更早 → 換成候選", () => {
  const r = pickEarlierBaseline({ unitCost: 20, date: "2026-05-01" }, { unitCost: 99, date: "2026-01-01" });
  assert.equal(r?.unitCost, 99, "早到嘅應該贏，就算貴都要用（首次進貨就係首次）");
});

test("pickEarlierBaseline：候選日期更遲 → 保留 current", () => {
  const r = pickEarlierBaseline({ unitCost: 20, date: "2026-01-01" }, { unitCost: 5, date: "2026-05-01" });
  assert.equal(r?.unitCost, 20);
});

test("pickEarlierBaseline：候選單價 <= 0 → 永不贏（唔會污染基準）", () => {
  const cur = { unitCost: 20, date: "2026-05-01" };
  assert.equal(pickEarlierBaseline(cur, { unitCost: 0, date: "2026-01-01" }), cur);
  assert.equal(pickEarlierBaseline(cur, { unitCost: -5, date: "2026-01-01" }), cur);
});

/* ─────────────── 3. 上漲金額 / 漲幅計算 ─────────────── */

test("computePriceChange：上漲金額 =（最新 − 基準）× 現有庫存量", () => {
  const r = computePriceChange({ latestUnitCost: 408, baselineUnitCost: 400, currentQty: 45 });
  assert.equal(r.deltaUnitCost, 8);
  assert.equal(r.changeAmount, 360, "8 × 45 = 360");
  assert.equal(r.direction, "up");
  assert.equal(Math.round(r.changePercent ?? 0), 2, "8/400 = 2%");
});

test("computePriceChange：最新價下跌 → 負數金額、綠色向（down）", () => {
  const r = computePriceChange({ latestUnitCost: 20.5, baselineUnitCost: 21, currentQty: 60 });
  assert.equal(r.deltaUnitCost, -0.5);
  assert.equal(r.changeAmount, -30);
  assert.equal(r.direction, "down");
});

test("computePriceChange：完全無變 → same、金額 0", () => {
  const r = computePriceChange({ latestUnitCost: 100, baselineUnitCost: 100, currentQty: 10 });
  assert.equal(r.direction, "same");
  assert.equal(r.changeAmount, 0);
});

test("computePriceChange：庫存量 0 → 金額 0，但漲幅仍然有（唔會 NaN）", () => {
  const r = computePriceChange({ latestUnitCost: 110, baselineUnitCost: 100, currentQty: 0 });
  assert.equal(r.changeAmount, 0);
  assert.equal(Math.round(r.changePercent ?? 0), 10);
  assert.equal(r.direction, "up");
});

/* ─────────────── 4. 🔴 冇基準嘅處理（J 拍板口徑）─────────────── */

test("computePriceChange：baseline 為 null → 全部欄位 null + direction='new'（唔渲染假零）", () => {
  const r = computePriceChange({ latestUnitCost: 155, baselineUnitCost: null, currentQty: 8 });
  assert.equal(r.baselineUnitCost, null);
  assert.equal(r.deltaUnitCost, null);
  assert.equal(r.changePercent, null);
  assert.equal(r.changeAmount, null, "🔴 唔可以係 0，否則合計會細咗、睇落好似真係零影響");
  assert.equal(r.direction, "new");
});

test("computePriceChange：baseline 為 undefined（舊 row 未有欄）→ 當 new", () => {
  const r = computePriceChange({
    latestUnitCost: 100,
    baselineUnitCost: undefined as unknown as number | null,
    currentQty: 5,
  });
  assert.equal(r.direction, "new");
  assert.equal(r.changeAmount, null);
});

test("computePriceChange：baseline = 0 → 當 new，唔會出 Infinity", () => {
  const r = computePriceChange({ latestUnitCost: 100, baselineUnitCost: 0, currentQty: 5 });
  assert.equal(r.changePercent, null);
  assert.equal(r.changeAmount, null);
  assert.equal(r.direction, "new");
  assert.ok(!String(r.changePercent).includes("Infinity"));
});

test("isComparable：'new' 唔計入漲跌統計", () => {
  assert.equal(isComparable("up"), true);
  assert.equal(isComparable("down"), true);
  assert.equal(isComparable("same"), true);
  assert.equal(isComparable("new"), false, "🔴 首次記錄唔可以當成可比品項");
});

/* ─────────────── 5. 合計 ─────────────── */

test("summarizePriceChanges：new 唔入數，漲跌分開加，唔會互相抵消", () => {
  const rows: PriceChange[] = [
    { latestUnitCost: 408, baselineUnitCost: 400, deltaUnitCost: 8, changePercent: 2, changeAmount: 360, direction: "up" },
    { latestUnitCost: 20.5, baselineUnitCost: 21, deltaUnitCost: -0.5, changePercent: -2.4, changeAmount: -30, direction: "down" },
    { latestUnitCost: 100, baselineUnitCost: 100, deltaUnitCost: 0, changePercent: 0, changeAmount: 0, direction: "same" },
    { latestUnitCost: 155, baselineUnitCost: null, deltaUnitCost: null, changePercent: null, changeAmount: null, direction: "new" },
  ];
  const s = summarizePriceChanges(rows);
  assert.equal(s.up, 1);
  assert.equal(s.down, 1);
  assert.equal(s.same, 1);
  assert.equal(s.newItems, 1);
  assert.equal(s.totalUpAmount, 360);
  assert.equal(s.totalDownAmount, -30, "🔴 唔可以淨計涨幅（360 − 30）—— 要分開兩個數");
});

test("summarizePriceChanges：空輸入唔會爆", () => {
  const s = summarizePriceChanges([]);
  assert.deepEqual(s, { up: 0, down: 0, same: 0, newItems: 0, totalUpAmount: 0, totalDownAmount: 0 });
});

/* ─────────────── 6. 端到端：真實收據 → 基準 → 上漲金額 ─────────────── */

test("端到端：新品由單一收據建立，之後漲價仍以「首次」為基準", () => {
  const receipts: BaselineReceiptInput[] = [
    { receipt_date: "2026-03-10", items: [{ name: "豬扒", unit_price: 400 }] },
    { receipt_date: "2026-09-20", items: [{ name: "豬扒", unit_price: 408 }] },
  ];
  const base = collectBaselines(receipts).get("豬扒");
  assert.equal(base?.unitCost, 400, "基準鎖死喺首次 400");
  // avg_unit_cost 已經飄到 408，但基準唔可以跟住飄
  const r = computePriceChange({ latestUnitCost: 408, baselineUnitCost: base?.unitCost ?? null, currentQty: 45 });
  assert.equal(r.changeAmount, 360);
  assert.equal(r.direction, "up");
});

test("端到端：手動新增（零收據）嘅品項 → new，唔會出現 Infinity / NaN", () => {
  const base = collectBaselines([]).get("手動品");
  const r = computePriceChange({ latestUnitCost: 88, baselineUnitCost: base?.unitCost ?? null, currentQty: 3 });
  assert.equal(r.direction, "new");
  assert.equal(r.changeAmount, null);
  assert.equal(Number.isFinite(r.changePercent ?? 0), true);
});
