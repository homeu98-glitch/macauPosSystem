// 手動秤重輸入測試（docs/124 §2.5 W4 兜底路徑）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";

import assert from "node:assert/strict";

import {
  buildScaleLabel,
  computeWeigh,
  DEFAULT_TARE_PRESETS,
  describeRuleMatch,
  formatKg,
  weightFromAmount,
} from "./manual-scale.ts";
import type { WeighedBarcodeRule } from "./types.ts";

// ─────────────────────────────────────────────────────────────
// computeWeigh
// ─────────────────────────────────────────────────────────────

test("computeWeigh：無皮重 — 淨重 = 毛重", () => {
  const r = computeWeigh({ grossKg: 1.235, unitPrice: 28 });
  assert.equal(r.netKg, 1.235);
  assert.equal(r.amount, 34.58); // 1.235 × 28 = 34.58
  assert.equal(r.ok, true);
  assert.equal(r.tareExceedsGross, false);
});

test("computeWeigh：扣皮重後計金額", () => {
  const r = computeWeigh({ grossKg: 1.5, tareKg: 0.012, unitPrice: 20 });
  assert.equal(r.netKg, 1.488);
  assert.equal(r.amount, 29.76);
  assert.equal(r.ok, true);
});

test("computeWeigh：皮重 > 毛重 → 唔可以靜默當 0", () => {
  const r = computeWeigh({ grossKg: 0.005, tareKg: 0.012, unitPrice: 20 });
  assert.equal(r.netKg, 0);
  assert.equal(r.amount, 0);
  assert.equal(r.tareExceedsGross, true);
  assert.equal(r.ok, false);
});

test("computeWeigh：太輕（低於最低計價單位）→ 唔入車", () => {
  // 0.0002 kg 經 round3 後係 0 → 一定 tooLight（唔可以因為四捨五入就當有重量）
  const r = computeWeigh({ grossKg: 0.0002, unitPrice: 20, minWeightKg: 0.001 });
  assert.equal(r.netKg, 0);
  assert.equal(r.tooLight, true);
  assert.equal(r.ok, false);
});

test("computeWeigh：剛好 1 克可以入車（最低計價單位 0.001）", () => {
  const r = computeWeigh({ grossKg: 0.001, unitPrice: 20, minWeightKg: 0.001 });
  assert.equal(r.netKg, 0.001);
  assert.equal(r.tooLight, false);
  assert.equal(r.ok, true);
});

test("computeWeigh：自訂最低計價單位（例如 0.01 kg）", () => {
  const r = computeWeigh({ grossKg: 0.005, unitPrice: 20, minWeightKg: 0.01 });
  assert.equal(r.tooLight, true);
  assert.equal(r.ok, false);
});

test("computeWeigh：負數毛重夾成 0（秤壞 / 打錯）", () => {
  const r = computeWeigh({ grossKg: -5, unitPrice: 20 });
  assert.equal(r.netKg, 0);
  assert.equal(r.ok, false);
  assert.equal(r.tareExceedsGross, false);
});

test("computeWeigh：單價 0 → 金額 0 但重量保留（可能稍後改價）", () => {
  const r = computeWeigh({ grossKg: 2, unitPrice: 0 });
  assert.equal(r.netKg, 2);
  assert.equal(r.amount, 0);
  assert.equal(r.ok, true);
});

test("computeWeigh：NaN 單價唔會令金額變 NaN", () => {
  const r = computeWeigh({ grossKg: 2, unitPrice: Number.NaN });
  assert.equal(r.amount, 0);
  assert.ok(Number.isFinite(r.amount));
});

test("computeWeigh：金額四捨五入到分", () => {
  // 0.333 kg × $9.99 = 3.32667 → 3.33
  const r = computeWeigh({ grossKg: 0.333, unitPrice: 9.99 });
  assert.equal(r.amount, 3.33);
});

// ─────────────────────────────────────────────────────────────
// formatKg
// ─────────────────────────────────────────────────────────────

test("formatKg：去掉尾隨 0", () => {
  assert.equal(formatKg(0.5), "0.5");
  assert.equal(formatKg(0.055), "0.055");
  assert.equal(formatKg(1), "1");
  assert.equal(formatKg(0), "0");
  assert.equal(formatKg(1.2), "1.2");
});

test("formatKg：NaN / 非有限值當 0", () => {
  assert.equal(formatKg(Number.NaN), "0");
  assert.equal(formatKg(Number.POSITIVE_INFINITY), "0");
});

// ─────────────────────────────────────────────────────────────
// DEFAULT_TARE_PRESETS
// ─────────────────────────────────────────────────────────────

test("DEFAULT_TARE_PRESETS：第一個係「不扣皮」且磅數為 0", () => {
  assert.equal(DEFAULT_TARE_PRESETS[0].kg, 0);
});

test("DEFAULT_TARE_PRESETS：全部 kg 都係非負、id 唯一", () => {
  assert.ok(DEFAULT_TARE_PRESETS.every((t) => t.kg >= 0));
  assert.equal(new Set(DEFAULT_TARE_PRESETS.map((t) => t.id)).size, DEFAULT_TARE_PRESETS.length);
});

// ─────────────────────────────────────────────────────────────
// buildScaleLabel
// ─────────────────────────────────────────────────────────────

test("buildScaleLabel：有 PLU → 出得到標準變重碼 21+PLU(5)+克(5)", () => {
  const label = buildScaleLabel({
    product: { name: "香蕉（散裝）", plu: "01234", unit: "kg" },
    netKg: 1.235,
    amount: 34.58,
    unitPrice: 28,
  });
  // 21 + 01234 + 01235（1235 克補零到 5 位）= 12 位
  assert.equal(label.barcodePayload, "210123401235");
  assert.equal(label.barcodePayload?.length, 12);
});

test("buildScaleLabel：冇 PLU → 唔出條碼（認唔返商品）", () => {
  const label = buildScaleLabel({
    product: { name: "散裝菜", unit: "kg" },
    netKg: 1,
    amount: 10,
    unitPrice: 10,
  });
  assert.equal(label.barcodePayload, null);
  assert.equal(label.lines.some((l) => l.startsWith("PLU")), false);
});

test("buildScaleLabel：PLU 補零到 5 位", () => {
  const label = buildScaleLabel({
    product: { name: "蘋果", plu: "123", unit: "kg" },
    netKg: 0.5,
    amount: 12.5,
    unitPrice: 25,
  });
  // 21 + 00123 + 00500（500 克）= 12 位
  assert.equal(label.barcodePayload, "210012300500");
});

test("buildScaleLabel：文字行含商品名 / 淨重 / 單價 / 金額", () => {
  const label = buildScaleLabel({
    product: { name: "香蕉（散裝）", plu: "01234", unit: "kg" },
    netKg: 1.235,
    amount: 34.58,
    unitPrice: 28,
  });
  assert.equal(label.lines[0], "香蕉（散裝）");
  assert.match(label.lines[1], /1\.235 kg/);
  assert.match(label.lines[2], /\$28\.00\/kg/);
  assert.match(label.lines[3], /\$34\.58/);
});

test("buildScaleLabel：克數超出 5 位時截取末 5 位（唔會爆長度）", () => {
  const label = buildScaleLabel({
    product: { name: "西瓜", plu: "09999", unit: "kg" },
    netKg: 123.456,
    amount: 100,
    unitPrice: 1,
  });
  // 123456 克 → 取末 5 位 = 23456
  assert.equal(label.barcodePayload, "210999923456");
  assert.equal(label.barcodePayload?.length, 12);
});

// ─────────────────────────────────────────────────────────────
// weightFromAmount
// ─────────────────────────────────────────────────────────────

test("weightFromAmount：金額 ÷ 單價 = 重量", () => {
  assert.equal(weightFromAmount(34.58, 28), 1.235);
});

test("weightFromAmount：單價 0 → null（反推唔到）", () => {
  assert.equal(weightFromAmount(10, 0), null);
});

test("weightFromAmount：負金額夾成 0", () => {
  assert.equal(weightFromAmount(-5, 10), 0);
});

// ─────────────────────────────────────────────────────────────
// describeRuleMatch
// ─────────────────────────────────────────────────────────────

const rule: WeighedBarcodeRule = {
  id: "r1",
  name: "標準 21 重量碼",
  prefixes: ["21"],
  pluStart: 2,
  pluLength: 5,
  payloadStart: 7,
  payloadLength: 5,
  payloadKind: "weight_g",
  divisor: 1000,
  hasCheckDigit: false,
};

test("describeRuleMatch：PLU 正常 → ok", () => {
  assert.deepEqual(describeRuleMatch(rule, { plu: "01234" }), { ok: true });
});

test("describeRuleMatch：冇 PLU → 唔 ok（秤端只認 PLU）", () => {
  const r = describeRuleMatch(rule, { plu: "" });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /PLU/);
});

test("describeRuleMatch：PLU 太長 → 唔 ok", () => {
  const r = describeRuleMatch(rule, { plu: "0123456789" });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /長/);
});

test("describeRuleMatch：規則冇前綴 → 唔 ok", () => {
  const r = describeRuleMatch({ ...rule, prefixes: ["  "] }, { plu: "01234" });
  assert.equal(r.ok, false);
});
