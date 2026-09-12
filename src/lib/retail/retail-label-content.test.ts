// 零售價籤內容測試（docs/124 §12）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRetailLabelContent,
  charWidth,
  describeLabel,
  displayWidth,
  unitLabel,
  wrapToWidth,
} from "./retail-label-content.ts";
import type { RetailProduct } from "./types.ts";

const fmt = (n: number) => `$${n.toFixed(2)}`;

function product(over: Partial<RetailProduct> = {}): RetailProduct {
  return {
    id: "p1",
    name: "維他檸檬茶 250ml",
    categoryId: "飲品",
    barcode: "4891028001232",
    price: 9.5,
    unit: "件",
    trackStock: true,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────
// 闊度計算
// ─────────────────────────────────────────────────────────────

test("charWidth：全角算 2、半角算 1", () => {
  assert.equal(charWidth("A"), 1);
  assert.equal(charWidth("1"), 1);
  assert.equal(charWidth("維"), 2);
  assert.equal(charWidth("，"), 2); // 全角標點
  assert.equal(charWidth("$"), 1);
});

test("🔴 displayWidth：中文名一定要用顯示闊度（唔可以當 length）", () => {
  assert.equal(displayWidth("維他檸檬茶"), 10); // 5 個中文字
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("維a"), 3);
  assert.equal(displayWidth(""), 0);
});

// ─────────────────────────────────────────────────────────────
// 摺行
// ─────────────────────────────────────────────────────────────

test("🔴 wrapToWidth：按顯示闊度摺行（按 length 摺會令中文一行塞爆）", () => {
  // 「維他檸檬茶 250ml」= 10 + 1 + 5 = 16 位；欄寬 10 → 兩行
  const wrapped = wrapToWidth("維他檸檬茶 250ml", 10, 3);
  const lines = wrapped.split("\n");
  assert.equal(lines.length >= 2, true);
  for (const l of lines) assert.ok(displayWidth(l) <= 10, `「${l}」闊度 ${displayWidth(l)} > 10`);
});

test("wrapToWidth：短字串唔摺", () => {
  assert.equal(wrapToWidth("可樂", 10), "可樂");
  assert.equal(wrapToWidth("", 10), "");
  assert.equal(wrapToWidth("   ", 10), "");
});

test("🔴 wrapToWidth：超出 maxLines → 最後一行加 `…`（唔可以靜默截斷）", () => {
  const long = "超級無敵大特價有機冷壓初榨橄欖油第一道冷壓五百毫升裝";
  const wrapped = wrapToWidth(long, 10, 2);
  const lines = wrapped.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith("…"), `最後一行冇省略號：${lines[1]}`);
  assert.ok(displayWidth(lines[1]) <= 10);
});

test("wrapToWidth：欄寬太細要有下限（唔可以無限 0 或負數）", () => {
  const wrapped = wrapToWidth("可樂", 0);
  assert.equal(wrapped, "可樂"); // 4 位下限，唔會炸
  assert.equal(wrapToWidth("可樂", -5), "可樂");
});

// ─────────────────────────────────────────────────────────────
// 單位
// ─────────────────────────────────────────────────────────────

test("unitLabel：稱重商品要講清「每 kg」", () => {
  assert.equal(unitLabel({ unit: "kg", isWeighed: true }), "每 kg");
  assert.equal(unitLabel({ unit: "件" }), "每 件");
  // 冇設單位 → 按形態 fallback
  assert.equal(unitLabel({ unit: "", isWeighed: true }), "每 kg");
  assert.equal(unitLabel({ unit: "" }), "每件");
});

// ─────────────────────────────────────────────────────────────
// 價籤內容
// ─────────────────────────────────────────────────────────────

test("buildRetailLabelContent：基本價籤（店名 / 名 / 售價 / 單位 / 條碼）", () => {
  const b = buildRetailLabelContent(product(), {
    storeName: "澳門示範便利商店",
    formatAmount: fmt,
    columns: 34,
  });
  assert.equal(b.store_name, "澳門示範便利商店");
  assert.equal(b.product_name, "維他檸檬茶 250ml");
  assert.equal(b.price, "$9.50");
  assert.equal(b.unit, "每 件");
  assert.equal(b.barcode, "4891028001232");
  assert.equal(b.plu, "");
  assert.equal(b.date, "");
  assert.equal(b.footer, "");
});

test("🔴 buildRetailLabelContent：冇原價 / 原價唔高過售價 → 唔印（唔可以出「售價 $10 / 原價 $10」）", () => {
  assert.equal(
    buildRetailLabelContent(product({ price: 10 }), { storeName: "S", formatAmount: fmt }).original_price,
    "",
  );
  assert.equal(
    buildRetailLabelContent(product({ price: 10, originalPrice: 10 }), {
      storeName: "S",
      formatAmount: fmt,
    }).original_price,
    "",
  );
  assert.equal(
    buildRetailLabelContent(product({ price: 10, originalPrice: 8 }), {
      storeName: "S",
      formatAmount: fmt,
    }).original_price,
    "",
  );
  // 真係有得比才印
  assert.equal(
    buildRetailLabelContent(product({ price: 8, originalPrice: 12 }), {
      storeName: "S",
      formatAmount: fmt,
    }).original_price,
    "原價 $12.00",
  );
});

test("buildRetailLabelContent：稱重商品要印 PLU（店員對秤用）", () => {
  const b = buildRetailLabelContent(product({ plu: "01234", unit: "kg", isWeighed: true, barcode: undefined }), {
    storeName: "S",
    formatAmount: fmt,
  });
  assert.equal(b.plu, "PLU 01234");
  assert.equal(b.unit, "每 kg");
  assert.equal(b.barcode, "");
});

test("🔴 buildRetailLabelContent：冇條碼 / 冇 PLU / 冇頁尾 → 空字串（唔可以出空行）", () => {
  const b = buildRetailLabelContent(product({ barcode: undefined }), { storeName: "S", formatAmount: fmt });
  assert.equal(b.barcode, "");
  for (const v of Object.values(b)) {
    assert.equal(v.includes("undefined"), false, `唔應該出 undefined：${v}`);
    assert.equal(v.includes("null"), false);
  }
});

test("buildRetailLabelContent：售價 0 / 壞值 → 唔印（唔可以出 $0.00）", () => {
  assert.equal(buildRetailLabelContent(product({ price: 0 }), { storeName: "S", formatAmount: fmt }).price, "");
  assert.equal(
    buildRetailLabelContent(product({ price: Number.NaN }), { storeName: "S", formatAmount: fmt }).price,
    "",
  );
});

test("buildRetailLabelContent：日期 / 頁尾要 trim（打咗空格 = 冇填）", () => {
  const b = buildRetailLabelContent(product(), {
    storeName: "S",
    formatAmount: fmt,
    printedDate: "  2026-09-13  ",
    footerText: "   ",
  });
  assert.equal(b.date, "2026-09-13");
  assert.equal(b.footer, "");
});

test("buildRetailLabelContent：長商品名要預先摺行（唔好靠打印機自動摺）", () => {
  const b = buildRetailLabelContent(
    product({ name: "超級無敵大特價有機冷壓初榨橄欖油第一道冷壓五百毫升裝" }),
    { storeName: "S", formatAmount: fmt, columns: 12, maxNameLines: 2 },
  );
  const lines = b.product_name.split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(displayWidth(l) <= 12);
  assert.equal(b.store_name, "S");
});

test("describeLabel：UI 摘要", () => {
  assert.equal(describeLabel(product(), fmt), "維他檸檬茶 250ml · $9.50");
  assert.equal(describeLabel(product({ name: "  " }), fmt), "(未命名) · $9.50");
});
