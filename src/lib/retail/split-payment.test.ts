// 零售付款方式 + 拆分付款測試（docs/124 §R4）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MONEY_EPSILON,
  appendSplitEntry,
  buildSplitEntry,
  describeSplitSummary,
  guessPaymentKind,
  isSplitSettled,
  kindRequiresTendered,
  normalizeRetailPaymentMethods,
  removeSplitEntryAt,
  setSplitEntryAmount,
  splitCashReceived,
  splitChangeDue,
  splitOverpaid,
  splitPaidTotal,
  splitRemaining,
  suggestedTopUpAmount,
  validateSplitPayment,
} from "./split-payment.ts";

const cash = { id: "cash", label: "現金" };
const mcard = { id: "mcard", label: "澳門通" };

// ─────────────────────────────────────────────────────────────
// 種類推斷
// ─────────────────────────────────────────────────────────────

test("guessPaymentKind：認得常見中英文付款方式", () => {
  assert.equal(guessPaymentKind("現金"), "cash");
  assert.equal(guessPaymentKind("Cash"), "cash");
  assert.equal(guessPaymentKind("MPay"), "ewallet");
  assert.equal(guessPaymentKind("澳門通"), "ewallet");
  assert.equal(guessPaymentKind("支付寶"), "ewallet");
  assert.equal(guessPaymentKind("微信支付"), "ewallet");
  assert.equal(guessPaymentKind("中銀卡"), "card");
  assert.equal(guessPaymentKind("VISA"), "card");
  assert.equal(guessPaymentKind("會員餘額"), "member_balance");
  assert.equal(guessPaymentKind("積分"), "member_balance");
  assert.equal(guessPaymentKind("現金禮券"), "voucher");
  assert.equal(guessPaymentKind("其他嘢"), "other");
  assert.equal(guessPaymentKind(""), "other");
});

test("kindRequiresTendered：只有現金要收錢找零", () => {
  assert.equal(kindRequiresTendered("cash"), true);
  assert.equal(kindRequiresTendered("ewallet"), false);
  assert.equal(kindRequiresTendered("card"), false);
});

// ─────────────────────────────────────────────────────────────
// 兼容讀取舊設定
// ─────────────────────────────────────────────────────────────

test("🔴 normalizeRetailPaymentMethods：舊自由文字 string[] 要轉得晒（唔可以令現有商戶付款方式消失）", () => {
  const out = normalizeRetailPaymentMethods(["現金", "Mpay", "中銀"]);
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((m) => m.kind),
    ["cash", "ewallet", "card"],
  );
  // id 要穩定（唔可以用時間戳 —— 已存 DB 嘅訂單會引用 methodId）
  assert.equal(out[0].id, "legacy:現金");
  assert.equal(out[0].requiresTendered, true);
  assert.equal(out[0].openDrawer, true);
  assert.equal(out[1].requiresTendered, false);
});

test("normalizeRetailPaymentMethods：id 穩定（兩次呼叫結果一致）", () => {
  const a = normalizeRetailPaymentMethods(["現金", "Mpay"]);
  const b = normalizeRetailPaymentMethods(["現金", "Mpay"]);
  assert.deepEqual(a, b);
});

test("normalizeRetailPaymentMethods：結構化項目原樣保留", () => {
  const out = normalizeRetailPaymentMethods([
    { id: "x", label: "自家支付", kind: "ewallet", integrated: true },
  ]);
  assert.deepEqual(out, [
    { id: "x", label: "自家支付", kind: "ewallet", requiresTendered: false, openDrawer: false, integrated: true },
  ]);
});

test("normalizeRetailPaymentMethods：混合 / 垃圾值 / 重複 id 都要處理到", () => {
  assert.deepEqual(normalizeRetailPaymentMethods(null), []);
  assert.deepEqual(normalizeRetailPaymentMethods(undefined), []);
  assert.deepEqual(normalizeRetailPaymentMethods("現金"), []);
  assert.deepEqual(normalizeRetailPaymentMethods([]), []);

  const out = normalizeRetailPaymentMethods([
    "現金",
    "",
    "   ",
    123,
    null,
    { label: "" },
    "現金", // 重複 → 應該只出一個
    { id: "cash", label: "現金（自訂）" },
  ]);
  assert.equal(out.length, 2); // legacy:現金 + cash
  assert.deepEqual(out.map((m) => m.id), ["legacy:現金", "cash"]);
});

// ─────────────────────────────────────────────────────────────
// 拆分付款
// ─────────────────────────────────────────────────────────────

test("buildSplitEntry：現金帶實收 → 自動算找零", () => {
  const e = buildSplitEntry(cash, 300, 500);
  assert.equal(e.amount, 300);
  assert.equal(e.tendered, 500);
  assert.equal(e.change, 200);
});

test("buildSplitEntry：非現金唔填 tendered", () => {
  const e = buildSplitEntry(mcard, 149);
  assert.equal(e.amount, 149);
  assert.equal("tendered" in e, false);
  assert.equal("change" in e, false);
});

test("splitPaidTotal / splitRemaining / splitOverpaid / isSplitSettled", () => {
  const entries = [buildSplitEntry(cash, 300), buildSplitEntry(mcard, 100)];
  assert.equal(splitPaidTotal(entries), 400);
  assert.equal(splitRemaining(449, entries), 49);
  assert.equal(splitOverpaid(449, entries), 0);
  assert.equal(isSplitSettled(449, entries), false);

  const full = [buildSplitEntry(cash, 300), buildSplitEntry(mcard, 149)];
  assert.equal(splitRemaining(449, full), 0);
  assert.equal(isSplitSettled(449, full), true);

  const over = [buildSplitEntry(cash, 500)];
  assert.equal(splitOverpaid(449, over), 51);
  assert.equal(splitRemaining(449, over), 0);
});

test("🔴 銀行浮點：0.1 + 0.2 要當成收夠 0.3（唔可以令收銀撳唔到完成）", () => {
  const entries = [buildSplitEntry(cash, 0.1), buildSplitEntry(mcard, 0.2)];
  assert.equal(splitPaidTotal(entries), 0.3);
  assert.equal(isSplitSettled(0.3, entries), true);
  assert.ok(splitRemaining(0.3, entries) < MONEY_EPSILON);
});

test("appendSplitEntry：同一方法（都冇實收）會合併金額，唔會出兩行", () => {
  let e = appendSplitEntry([], buildSplitEntry(cash, 100));
  e = appendSplitEntry(e, buildSplitEntry(cash, 50));
  assert.equal(e.length, 1);
  assert.equal(e[0].amount, 150);
});

test("appendSplitEntry：帶實收嘅現金唔合併（每筆找零獨立）", () => {
  let e = appendSplitEntry([], buildSplitEntry(cash, 100, 200));
  e = appendSplitEntry(e, buildSplitEntry(cash, 50, 50));
  assert.equal(e.length, 2);
});

test("removeSplitEntryAt / setSplitEntryAmount", () => {
  let e = [buildSplitEntry(cash, 300, 400), buildSplitEntry(mcard, 100)];
  e = removeSplitEntryAt(e, 1);
  assert.equal(e.length, 1);
  // 越界唔會拋錯
  assert.equal(removeSplitEntryAt(e, 99).length, 1);
  assert.equal(removeSplitEntryAt(e, -1).length, 1);

  e = setSplitEntryAmount(e, 0, 200);
  assert.equal(e[0].amount, 200);
  assert.equal(e[0].change, 200); // 實收 400 − 200
});

test("splitCashReceived / splitChangeDue：交班對帳用", () => {
  const entries = [buildSplitEntry(cash, 300, 500), buildSplitEntry(mcard, 149)];
  assert.equal(splitCashReceived(entries), 500);
  assert.equal(splitChangeDue(entries), 200);
});

test("suggestedTopUpAmount：「一鍵補齊」= 尚欠", () => {
  assert.equal(suggestedTopUpAmount(449, [buildSplitEntry(cash, 300)]), 149);
  assert.equal(suggestedTopUpAmount(449, []), 449);
});

// ─────────────────────────────────────────────────────────────
// 完成前驗證
// ─────────────────────────────────────────────────────────────

test("🔴 validateSplitPayment：尚欠要講清楚（唔可以靜默 disable 個掣）", () => {
  const r = validateSplitPayment(449, [buildSplitEntry(cash, 300), buildSplitEntry(mcard, 100)]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("49.00")));
});

test("validateSplitPayment：收夠 → ok", () => {
  const r = validateSplitPayment(449, [buildSplitEntry(cash, 300), buildSplitEntry(mcard, 149)]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateSplitPayment：未加入任何收款", () => {
  const r = validateSplitPayment(449, []);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("未加入")));
});

test("validateSplitPayment：0 金額 / 現金實收不足要逐項報", () => {
  const zero = validateSplitPayment(449, [buildSplitEntry(cash, 0)]);
  assert.ok(zero.errors.some((e) => e.includes("金額係 0")));

  const short = validateSplitPayment(449, [buildSplitEntry(cash, 300, 100)]);
  assert.ok(short.errors.some((e) => e.includes("唔夠找零")));
});

test("validateSplitPayment：非現金多收要報錯（唔可以當找零）", () => {
  const r = validateSplitPayment(449, [buildSplitEntry(mcard, 500)]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("多收")));
});

test("describeSplitSummary：畀收據 / 對帳睇", () => {
  assert.equal(describeSplitSummary([]), "未收款");
  assert.equal(
    describeSplitSummary([buildSplitEntry(cash, 300), buildSplitEntry(mcard, 149)]),
    "現金 $300.00 + 澳門通 $149.00",
  );
});
