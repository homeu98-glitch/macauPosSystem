// 零售變重條碼解析測試（docs/124 §2.5）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WEIGHED_RULE_PRESETS,
  describeWeighedRule,
  ean13CheckDigit,
  isDigits,
  isValidEan13,
  isWeighedBarcode,
  matchWeighedRule,
  minLengthOf,
  normalizeScanInput,
  parseWeighedBarcode,
} from "./weighed-barcode.ts";
import type { WeighedBarcodeRule } from "./types.ts";

/**
 * 已知有效嘅真 EAN-13（業界教科書例子）—— 用嚟獨立驗證校驗位算法，
 * 唔可以只用「實作算出嚟嘅值」自證自。
 */
const KNOWN_VALID_EAN13 = "4006381333931";

/** `21 01234 00350 C`（重量碼，PLU 01234、350g），校驗位算出係 3 */
const WEIGHT_CODE = "2101234003503";
/** `02 00123 01234 C`（金額碼，PLU 00123、$12.34），校驗位算出係 2 */
const PRICE_CODE = "0200123012342";

const rule21 = WEIGHED_RULE_PRESETS.find((r) => r.id === "preset-21-weight")!;
const rule02price = WEIGHED_RULE_PRESETS.find((r) => r.id === "preset-02-price")!;
const rule02weight = WEIGHED_RULE_PRESETS.find((r) => r.id === "preset-02-weight")!;
const rule2price12 = WEIGHED_RULE_PRESETS.find((r) => r.id === "preset-2-price-12")!;

// ─────────────────────────────────────────────────────────────

test("normalizeScanInput：剝走結尾字元、空白同出廠前綴", () => {
  assert.equal(normalizeScanInput("  4891028001232\r\n"), "4891028001232");
  assert.equal(normalizeScanInput("\t4891028001232\t"), "4891028001232");
  assert.equal(normalizeScanInput("~4891028001232"), "4891028001232");
  assert.equal(normalizeScanInput("%#4891028001232"), "4891028001232");
  assert.equal(normalizeScanInput(""), "");
  assert.equal(normalizeScanInput(null), "");
  assert.equal(normalizeScanInput(undefined), "");
});

test("isDigits：空字串唔算數字（唔可以當合法條碼）", () => {
  assert.equal(isDigits("123"), true);
  assert.equal(isDigits(""), false);
  assert.equal(isDigits("12a"), false);
  assert.equal(isDigits("12 3"), false);
});

test("ean13CheckDigit：已知有效值 + 非法輸入回 null（唔可以回 0 造成假通過）", () => {
  assert.equal(ean13CheckDigit("400638133393"), 1);
  assert.equal(ean13CheckDigit("210123400350"), 3);
  assert.equal(ean13CheckDigit("020012301234"), 2);
  // 12 位以外 / 非數字 → null
  assert.equal(ean13CheckDigit("40063813339"), null);
  assert.equal(ean13CheckDigit("4006381333931"), null);
  assert.equal(ean13CheckDigit("abcdefghijkl"), null);
  assert.equal(ean13CheckDigit(""), null);
});

test("isValidEan13：校驗位錯 / 長度錯一律 false", () => {
  assert.equal(isValidEan13(KNOWN_VALID_EAN13), true);
  assert.equal(isValidEan13("4006381333932"), false); // 改咗校驗位
  assert.equal(isValidEan13("400638133393"), false); // 只有 12 位
  assert.equal(isValidEan13("40063813339311"), false); // 14 位
  assert.equal(isValidEan13(""), false);
});

test("matchWeighedRule：長前綴優先（唔可以被短前綴搶先命中）", () => {
  // ⚠️ 刻意將「短前綴規則」放喺陣列前面：如果實作只按陣列次序取第一個就會出錯
  const rules = [rule2price12, rule21];
  const hit = matchWeighedRule(WEIGHT_CODE, rules);
  assert.equal(hit?.id, "preset-21-weight");

  // 只配短前綴時，長碼仍然命中最長可用者（= "2"）
  assert.equal(matchWeighedRule(WEIGHT_CODE, [rule2price12])?.id, "preset-2-price-12");

  // 完全唔匹配
  assert.equal(matchWeighedRule(KNOWN_VALID_EAN13, rules), null);
  assert.equal(matchWeighedRule("", rules), null);
});

test("isWeighedBarcode：只判斷前綴", () => {
  assert.equal(isWeighedBarcode(WEIGHT_CODE, [rule21]), true);
  assert.equal(isWeighedBarcode(KNOWN_VALID_EAN13, [rule21]), false);
});

test("minLengthOf：PLU 尾 / 數值尾 / 校驗位取最大", () => {
  assert.equal(minLengthOf(rule21), 13); // payloadStart 7 + 5 + 校驗 1
  assert.equal(minLengthOf(rule2price12), 10); // 6 + 4，冇校驗位
});

test("parseWeighedBarcode：重量碼 → PLU + kg", () => {
  const hit = parseWeighedBarcode(WEIGHT_CODE, [rule21]);
  assert.ok(hit);
  assert.equal(hit.plu, "01234");
  assert.equal(hit.weightKg, 0.35);
  assert.equal(hit.price, undefined);
  assert.equal(hit.ruleId, "preset-21-weight");
});

test("parseWeighedBarcode：金額碼 → PLU + 元（唔會再乘重量）", () => {
  const hit = parseWeighedBarcode(PRICE_CODE, [rule02price]);
  assert.ok(hit);
  assert.equal(hit.plu, "00123");
  assert.equal(hit.price, 12.34);
  assert.equal(hit.weightKg, undefined);
});

test("parseWeighedBarcode：同一個 02 前綴、payloadKind 唔同 → 結果唔同（呢個係最常見嘅設定錯）", () => {
  const asPrice = parseWeighedBarcode(PRICE_CODE, [rule02price]);
  const asWeight = parseWeighedBarcode(PRICE_CODE, [rule02weight]);
  assert.equal(asPrice?.price, 12.34);
  assert.equal(asPrice?.weightKg, undefined);
  // 同一串數字當重量克 → 1.234 kg
  assert.equal(asWeight?.weightKg, 1.234);
  assert.equal(asWeight?.price, undefined);
});

test("parseWeighedBarcode：校驗位錯 → null（唔可以靜默接受）", () => {
  assert.equal(parseWeighedBarcode("2101234003504", [rule21]), null);
});

test("parseWeighedBarcode：長度不足 / 非數字 / 冇命中規則 → null", () => {
  assert.equal(parseWeighedBarcode("210123", [rule21]), null);
  assert.equal(parseWeighedBarcode("21012340035AB", [rule21]), null);
  assert.equal(parseWeighedBarcode(WEIGHT_CODE, []), null);
  assert.equal(parseWeighedBarcode(WEIGHT_CODE, [rule02price]), null);
  assert.equal(parseWeighedBarcode("", [rule21]), null);
});

test("parseWeighedBarcode：重量千克 / 金額元（冇分）嘅規則", () => {
  // divisor 控制刻度：weight_kg + divisor 10 = 條碼欄位係「0.1 kg」為單位
  const kgRule: WeighedBarcodeRule = {
    id: "custom-kg",
    name: "自家公斤秤（一位小數）",
    prefixes: ["23"],
    pluStart: 2,
    pluLength: 5,
    payloadStart: 7,
    payloadLength: 5,
    payloadKind: "weight_kg",
    divisor: 10,
    hasCheckDigit: false,
  };
  const hit = parseWeighedBarcode("2309876000359", [kgRule]);
  assert.equal(hit?.plu, "09876");
  assert.equal(hit?.weightKg, 3.5);

  // weight_kg + divisor 1 = 條碼欄位本身就係**整數公斤**（唔會自動加小數）
  const kgIntRule: WeighedBarcodeRule = { ...kgRule, id: "custom-kg-int", divisor: 1 };
  assert.equal(parseWeighedBarcode("2309876001234", [kgIntRule])?.weightKg, 123);

  const yuanRule: WeighedBarcodeRule = {
    id: "custom-yuan",
    name: "自家元碼",
    prefixes: ["24"],
    pluStart: 2,
    pluLength: 5,
    payloadStart: 7,
    payloadLength: 5,
    payloadKind: "price",
    divisor: 1,
    hasCheckDigit: false,
  };
  assert.equal(parseWeighedBarcode("2409876001299", [yuanRule])?.price, 129);
});

test("parseWeighedBarcode：前置空白 / 結尾字元都要處理到（掃碼槍實況）", () => {
  const hit = parseWeighedBarcode("  2101234003503\r\n", [rule21]);
  assert.equal(hit?.weightKg, 0.35);
});

test("內建預設規則：id 唯一、都有名同描述", () => {
  const ids = WEIGHED_RULE_PRESETS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of WEIGHED_RULE_PRESETS) {
    assert.ok(r.name.length > 0);
    assert.ok(r.prefixes.length > 0);
    assert.ok(describeWeighedRule(r).length > 0);
    assert.ok(r.divisor > 0);
  }
});

test("describeWeighedRule：講清楚位數同單位（設定頁顯示用）", () => {
  const s = describeWeighedRule(rule21);
  assert.ok(s.includes("21"));
  assert.ok(s.includes("克"));
  assert.ok(s.includes("校驗"));
});
