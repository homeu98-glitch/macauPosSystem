// 零售商品 CSV 批量匯入測試（docs/124 §D4）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  autoMapHeaders,
  buildImportPlan,
  describeImportPlan,
  detectHeaderRow,
  diffFields,
  guessDelimiter,
  parseBool,
  parseCsv,
  parseDate,
  parseMoney,
  parseQty,
  splitBarcodes,
} from "./csv-import.ts";
import type { RetailProduct } from "./types.ts";

// ─────────────────────────────────────────────────────────────
// CSV parser
// ─────────────────────────────────────────────────────────────

test("parseCsv：基本 / 引號內逗號 / 引號內換行 / 轉義雙引號", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,3"), [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
  assert.deepEqual(parseCsv('a,"b,with,commas",c'), [["a", "b,with,commas", "c"]]);
  assert.deepEqual(parseCsv('a,"line1\nline2",c'), [["a", "line1\nline2", "c"]]);
  assert.deepEqual(parseCsv('a,"say ""hi""",c'), [["a", 'say "hi"', "c"]]);
});

test("parseCsv：BOM / CRLF / 舊式 CR / 尾隨空行", () => {
  assert.deepEqual(parseCsv("\uFEFFa,b\n1,2"), [
    ["a", "b"],
    ["1", "2"],
  ]);
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
  assert.deepEqual(parseCsv("a,b\r1,2"), [
    ["a", "b"],
    ["1", "2"],
  ]);
  // Excel 常見嘅尾隨空行要剔走
  assert.deepEqual(parseCsv("a,b\n1,2\n,\n,"), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("parseCsv：引號入面嘅逗號唔會分割；空欄位保留", () => {
  assert.deepEqual(parseCsv("a,,c"), [["a", "", "c"]]);
  assert.deepEqual(parseCsv('"a,b",c'), [["a,b", "c"]]);
});

test("guessDelimiter：逗號 / 分號 / tab", () => {
  assert.equal(guessDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(guessDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(guessDelimiter("a\tb\tc"), "\t");
  assert.equal(guessDelimiter(""), ",");
});

// ─────────────────────────────────────────────────────────────
// 表頭對照
// ─────────────────────────────────────────────────────────────

test("autoMapHeaders：中文表頭自動對照（商家由 Excel 出 CSV 一定係中文）", () => {
  const m = autoMapHeaders(["商品名", "條碼", "售價", "分類", "單位", "追蹤庫存", "庫存", "稱重", "PLU"]);
  assert.deepEqual(m, [
    "name",
    "barcode",
    "price",
    "categoryId",
    "unit",
    "trackStock",
    "stockQty",
    "isWeighed",
    "plu",
  ]);
});

test("autoMapHeaders：英文表頭 + 唔認識嘅欄位 → null", () => {
  const m = autoMapHeaders(["name", "barcode", "Price", "  SKU  ", "亂七八糟"]);
  assert.deepEqual(m, ["name", "barcode", "price", "sku", null]);
});

test("autoMapHeaders：同一個欄位唔會被對照兩次", () => {
  // 「數量」同「庫存」都係 stockQty 嘅別名 → 第一個贏，第二個 null
  const m = autoMapHeaders(["庫存", "數量", "售價"]);
  assert.deepEqual(m, ["stockQty", null, "price"]);
});

test("detectHeaderRow：第一行有認識嘅欄位就當表頭", () => {
  assert.equal(detectHeaderRow(["商品名", "售價"]), true);
  assert.equal(detectHeaderRow(["4891028", "9.5"]), false);
  assert.equal(detectHeaderRow([]), false);
});

// ─────────────────────────────────────────────────────────────
// 值正規化
// ─────────────────────────────────────────────────────────────

test("parseMoney：剝走 $ / 千分位 / MOP；非法回 null", () => {
  assert.equal(parseMoney("9.50"), 9.5);
  assert.equal(parseMoney("$1,234.50"), 1234.5);
  assert.equal(parseMoney("MOP 99"), 99);
  assert.equal(parseMoney(" 12 "), 12);
  assert.equal(parseMoney(""), null);
  assert.equal(parseMoney("abc"), null);
  assert.equal(parseMoney("9.5.5"), null);
  // 負數係「解析得到」，範圍驗證係 caller 嘅責任（buildImportPlan 會擋）
  assert.equal(parseMoney("-$5"), -5);
});

test("parseQty：稱重可以有 3 位小數、剝走 kg", () => {
  assert.equal(parseQty("48"), 48);
  assert.equal(parseQty("12.5"), 12.5);
  assert.equal(parseQty("0.350 kg"), 0.35);
  assert.equal(parseQty(""), null);
  assert.equal(parseQty("abc"), null);
});

test("parseBool：接受中英文常見寫法；空白 = null（唔可以當 false）", () => {
  for (const t of ["是", "Y", "yes", "TRUE", "1", "V", "✓", "有", "要", "開"]) {
    assert.equal(parseBool(t), true, t);
  }
  for (const f of ["否", "N", "no", "FALSE", "0", "X", "✗", "冇", "無", "不", "關"]) {
    assert.equal(parseBool(f), false, f);
  }
  assert.equal(parseBool(""), null);
  assert.equal(parseBool("   "), null);
  assert.equal(parseBool("唔知"), null);
});

test("parseDate：接受 YYYY-MM-DD / 斜線 / 點 / 年月日 / 緊湊格式", () => {
  assert.equal(parseDate("2026-09-12"), "2026-09-12");
  assert.equal(parseDate("2026/9/1"), "2026-09-01");
  assert.equal(parseDate("2026.09.12"), "2026-09-12");
  assert.equal(parseDate("2026年9月12日"), "2026-09-12");
  assert.equal(parseDate("20260912"), "2026-09-12");
  assert.equal(parseDate("2026-13-01"), null);
  assert.equal(parseDate("abc"), null);
  assert.equal(parseDate(""), null);
});

test("splitBarcodes：一條商品多個條碼（| ; 、 , 空白分隔）", () => {
  assert.deepEqual(splitBarcodes("4891028001232|6934177709999"), [
    "4891028001232",
    "6934177709999",
  ]);
  assert.deepEqual(splitBarcodes("a; b、c"), ["a", "b", "c"]);
  assert.deepEqual(splitBarcodes(""), []);
});

// ─────────────────────────────────────────────────────────────
// 匯入計劃
// ─────────────────────────────────────────────────────────────

const HEADER = "商品名,條碼,售價,分類,單位,追蹤庫存,庫存";

function existing(): RetailProduct[] {
  return [
    {
      id: "p1",
      name: "維他檸檬茶 250ml",
      categoryId: "飲品",
      barcode: "4891028001232",
      price: 9.5,
      unit: "件",
      trackStock: true,
      stockQty: 48,
    },
  ];
}

test("buildImportPlan：全新商品 → creates（唔會改任何資料）", () => {
  const csv = `${HEADER}\n維他檸檬茶 250ml,4891028001232,9.50,飲品,件,是,48\n明治雪糕家庭裝,4902720102113,12,零食,件,是,12`;
  const plan = buildImportPlan(csv, []);
  assert.equal(plan.hasHeader, true);
  assert.equal(plan.creates.length, 2);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.unchanged.length, 0);
  assert.equal(plan.creates[0].product.name, "維他檸檬茶 250ml");
  assert.equal(plan.creates[0].product.price, 9.5);
  assert.equal(plan.creates[0].product.trackStock, true);
  assert.equal(plan.creates[0].product.stockQty, 48);
  // 行號同 Excel 一致（表頭係第 1 行）
  assert.equal(plan.creates[0].rowNumber, 2);
  assert.equal(plan.creates[1].rowNumber, 3);
});

test("buildImportPlan：條碼對得中現有商品 → updates + 講明改咩", () => {
  const csv = `${HEADER}\n維他檸檬茶 250ml,4891028001232,10.50,飲品,件,是,48`;
  const plan = buildImportPlan(csv, existing());
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0].changedFields, ["price"]);
  assert.equal(plan.updates[0].existing.id, "p1");
  assert.equal(plan.updates[0].row.product.price, 10.5);
});

test("buildImportPlan：完全一樣 → unchanged（唔應該無謂寫入）", () => {
  const csv = `${HEADER}\n維他檸檬茶 250ml,4891028001232,9.50,飲品,件,是,48`;
  const plan = buildImportPlan(csv, existing());
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.updates.length, 0);
});

test("buildImportPlan：CSV 冇填嘅欄位唔會當成改動", () => {
  const csv = `商品名,條碼,售價\n維他檸檬茶 250ml,4891028001232,9.50`;
  const plan = buildImportPlan(csv, existing());
  assert.equal(plan.unchanged.length, 1);
  assert.deepEqual(plan.updates, []);
});

test("🔴 buildImportPlan：商品名 / 售價 空白 → 錯誤（唔可以靜默當 0）", () => {
  const csv = `${HEADER}\n,4891028111111,9.5,飲品,件,是,1\n冇價錢,4891028222222,,飲品,件,是,1`;
  const plan = buildImportPlan(csv, []);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.errors.length, 2);
  assert.ok(plan.errors.some((e) => e.field === "name" && e.rowNumber === 2));
  assert.ok(plan.errors.some((e) => e.field === "price" && e.rowNumber === 3));
});

test("buildImportPlan：非法金額 / 數量 / 布林 / 日期都要擋", () => {
  const csv = `商品名,條碼,售價,庫存,追蹤庫存,有效日期\nA,111,abc,xyz,唔知,2026-13-01`;
  const plan = buildImportPlan(csv, []);
  const fields = plan.errors.map((e) => e.field);
  assert.ok(fields.includes("price"));
  assert.ok(fields.includes("stockQty"));
  assert.ok(fields.includes("trackStock"));
  assert.ok(fields.includes("expiryDate"));
  assert.equal(plan.creates.length, 0);
});

test("🔴 buildImportPlan：稱重商品冇 PLU → 錯誤（秤端只認 PLU）", () => {
  const csv = `商品名,條碼,售價,稱重,單位,PLU\n香蕉,2000000000001,28,是,kg,`;
  const plan = buildImportPlan(csv, []);
  assert.equal(plan.errors.length, 1);
  assert.ok(plan.errors[0].message.includes("PLU"));
  assert.equal(plan.creates.length, 0);
});

test("buildImportPlan：稱重商品有 PLU → 通過；單位唔係 kg 只出警告", () => {
  const ok = buildImportPlan(`商品名,售價,稱重,單位,PLU\n香蕉,28,是,kg,01234`, []);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.creates.length, 1);
  assert.equal(ok.creates[0].product.plu, "01234");
  assert.equal(ok.creates[0].product.isWeighed, true);

  const warn = buildImportPlan(`商品名,售價,稱重,單位,PLU\n香蕉,28,是,斤,01234`, []);
  assert.equal(warn.errors.length, 0);
  assert.ok(warn.warnings.some((w) => w.field === "unit"));
});

test("buildImportPlan：冇任何識別碼 → 警告（唔擋，但要商家知）", () => {
  const csv = `商品名,售價\n散裝糖,5`;
  const plan = buildImportPlan(csv, []);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.creates.length, 1);
  assert.ok(plan.warnings.some((w) => w.message.includes("冇條碼")));
});

test("buildImportPlan：售價 0 → 警告（確認贈品）", () => {
  const plan = buildImportPlan(`商品名,條碼,售價\n贈品,111,0`, []);
  assert.equal(plan.creates.length, 1);
  assert.ok(plan.warnings.some((w) => w.field === "price"));
});

test("🔴 buildImportPlan：檔案內重複條碼 → 錯誤（掃碼會收錯錢）", () => {
  const csv = `${HEADER}\nA,4891028001232,9.5,飲品,件,是,1\nB,4891028001232,12,飲品,件,是,1`;
  const plan = buildImportPlan(csv, []);
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].rowNumber, 3);
  assert.equal(plan.duplicatesInFile.length, 1);
  assert.deepEqual(plan.duplicatesInFile[0].rowNumbers, [2, 3]);
});

test("buildImportPlan：額外條碼用 | 分隔要拆開", () => {
  const csv = `商品名,條碼,額外條碼,售價\nA,111,222|333,9.5`;
  const plan = buildImportPlan(csv, []);
  assert.deepEqual(plan.creates[0].product.extraBarcodes, ["222", "333"]);
});

test("buildImportPlan：唔變嘅欄位保留（extraBarcodes 要逐個比）", () => {
  const ex: RetailProduct[] = [
    {
      id: "p9",
      name: "A",
      categoryId: "c",
      barcode: "111",
      extraBarcodes: ["222", "333"],
      price: 9.5,
      unit: "件",
      trackStock: false,
    },
  ];
  const same = buildImportPlan(`商品名,條碼,額外條碼,售價\nA,111,222|333,9.5`, ex);
  assert.equal(same.unchanged.length, 1);

  const diff = buildImportPlan(`商品名,條碼,額外條碼,售價\nA,111,222|444,9.5`, ex);
  assert.deepEqual(diff.updates[0].changedFields, ["extraBarcodes"]);
});

test("buildImportPlan：冇表頭（第一行就係資料）都要處理到", () => {
  const csv = `維他檸檬茶,4891028001232,9.5\n明治雪糕,4902720102113,12`;
  const plan = buildImportPlan(csv, [], { hasHeader: false, mapping: ["name", "barcode", "price"] });
  assert.equal(plan.hasHeader, false);
  assert.equal(plan.creates.length, 2);
  assert.equal(plan.creates[0].rowNumber, 1);
});

test("buildImportPlan：空 CSV / 只有表頭 → 空計劃，唔會拋錯", () => {
  for (const t of ["", "   ", "\n\n", HEADER]) {
    const plan = buildImportPlan(t, []);
    assert.equal(plan.creates.length, 0);
    assert.equal(plan.errors.length, 0);
    assert.ok(Number.isFinite(plan.creates.length));
  }
});

test("buildImportPlan：分號分隔嘅 CSV（歐洲 Excel）", () => {
  const csv = `商品名;條碼;售價\nA;111;9,5`;
  const plan = buildImportPlan(csv, []);
  assert.equal(plan.delimiter, ";");
  assert.equal(plan.creates.length, 1);
});

test("buildImportPlan：unmappedHeaders 要報返（商家知邊啲欄位冇匯入）", () => {
  const csv = `商品名,售價,亂七八糟欄\nA,9.5,x`;
  const plan = buildImportPlan(csv, []);
  assert.deepEqual(plan.unmappedHeaders, ["亂七八糟欄"]);
});

test("diffFields：CSV 冇提供嘅欄位唔算改動", () => {
  const ex: RetailProduct = {
    id: "p1",
    name: "A",
    categoryId: "c",
    price: 9.5,
    unit: "件",
    trackStock: true,
    stockQty: 1,
  };
  assert.deepEqual(diffFields(ex, { name: "A" }), []);
  assert.deepEqual(diffFields(ex, { price: 10 }), ["price"]);
  // 明確傳 false / 0 都要當改動
  assert.deepEqual(diffFields(ex, { trackStock: false, stockQty: 0 }), ["trackStock", "stockQty"]);
});

test("describeImportPlan：一行睇晒", () => {
  const plan = buildImportPlan(`${HEADER}\nA,111,9.5,飲品,件,是,1`, []);
  const s = describeImportPlan(plan);
  assert.ok(s.includes("新增 1"));
  assert.ok(s.includes("更新 0"));
  assert.ok(s.includes("唔變 0"));
});
