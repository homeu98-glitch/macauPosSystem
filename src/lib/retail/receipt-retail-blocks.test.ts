// 零售收據區塊內容測試（docs/124 §R5 / §11）
// 用 Node 內建 test runner：node --test
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildExchangeOfLine,
  buildPointsEarnedLine,
  buildRetailReceiptBlocks,
  buildReturnPolicyText,
  buildSplitPaymentLines,
} from "./receipt-retail-blocks.ts";

const fmt = (n: number) => `$${n.toFixed(2)}`;

// ─────────────────────────────────────────────────────────────
// 拆分付款
// ─────────────────────────────────────────────────────────────

test("buildSplitPaymentLines：每筆一行、自我描述（唔另加標題行）", () => {
  const s = buildSplitPaymentLines(
    [
      { label: "現金", amount: 300 },
      { label: "澳門通", amount: 149 },
    ],
    fmt,
  );
  assert.equal(s, "現金: $300.00\n澳門通: $149.00");
});

test("🔴 buildSplitPaymentLines：0 金額嘅筆數要略過（唔可以印 $0.00 一行）", () => {
  const s = buildSplitPaymentLines(
    [
      { label: "現金", amount: 300 },
      { label: "澳門通", amount: 0 },
      { label: "優惠券", amount: 0.001 },
    ],
    fmt,
  );
  assert.equal(s, "現金: $300.00");
});

test("🔴 buildSplitPaymentLines：冇資料 / 全 0 → 空字串（區塊自動略過）", () => {
  assert.equal(buildSplitPaymentLines(undefined, fmt), "");
  assert.equal(buildSplitPaymentLines([], fmt), "");
  assert.equal(buildSplitPaymentLines([{ label: "現金", amount: 0 }], fmt), "");
});

test("buildSplitPaymentLines：標籤空白要有 fallback，唔可以出「: $300.00」", () => {
  assert.equal(buildSplitPaymentLines([{ label: "   ", amount: 300 }], fmt), "付款: $300.00");
  assert.equal(buildSplitPaymentLines([{ label: "", amount: 1 }], fmt), "付款: $1.00");
});

test("buildSplitPaymentLines：NaN / Infinity 唔可以印出嚟", () => {
  assert.equal(buildSplitPaymentLines([{ label: "現金", amount: Number.NaN }], fmt), "");
  assert.equal(
    buildSplitPaymentLines([{ label: "現金", amount: Number.POSITIVE_INFINITY }], fmt),
    "",
  );
});

test("buildSplitPaymentLines：3 筆以上照樣逐行", () => {
  const s = buildSplitPaymentLines(
    [
      { label: "現金", amount: 100 },
      { label: "MPay", amount: 50.5 },
      { label: "會員餘額", amount: 20 },
    ],
    fmt,
  );
  assert.equal(s.split("\n").length, 3);
  assert.equal(s, "現金: $100.00\nMPay: $50.50\n會員餘額: $20.00");
});

// ─────────────────────────────────────────────────────────────
// 會員積分
// ─────────────────────────────────────────────────────────────

test("buildPointsEarnedLine：賺取 + 結餘都有", () => {
  assert.equal(buildPointsEarnedLine(449, 1729), "會員積分: 本單 +449 / 結餘 1729");
});

test("buildPointsEarnedLine：只有賺取 / 只有結餘", () => {
  assert.equal(buildPointsEarnedLine(449, undefined), "會員積分: 本單 +449");
  assert.equal(buildPointsEarnedLine(undefined, 1729), "會員積分: 結餘 1729");
});

test("🔴 buildPointsEarnedLine：賺取 0 分唔算有資料（冇會員 / 未登入唔應該出「本單 +0」）", () => {
  assert.equal(buildPointsEarnedLine(0, undefined), "");
  assert.equal(buildPointsEarnedLine(0, 0), "會員積分: 結餘 0");
  assert.equal(buildPointsEarnedLine(undefined, undefined), "");
});

test("buildPointsEarnedLine：負分（退貨扣分）要顯示負號，唔可以強加 +", () => {
  assert.equal(buildPointsEarnedLine(-50, 100), "會員積分: 本單 -50 / 結餘 100");
});

test("buildPointsEarnedLine：非有限值當冇", () => {
  assert.equal(buildPointsEarnedLine(Number.NaN, undefined), "");
  assert.equal(buildPointsEarnedLine(Number.POSITIVE_INFINITY, 10), "會員積分: 結餘 10");
});

// ─────────────────────────────────────────────────────────────
// 換貨原單號
// ─────────────────────────────────────────────────────────────

test("buildExchangeOfLine：有值就出「換貨單: 原單 X」", () => {
  assert.equal(buildExchangeOfLine("R-000127"), "換貨單: 原單 R-000127");
});

test("🔴 buildExchangeOfLine：空白 / undefined / null → 空字串（非換貨單唔出）", () => {
  assert.equal(buildExchangeOfLine(undefined), "");
  assert.equal(buildExchangeOfLine(null), "");
  assert.equal(buildExchangeOfLine(""), "");
  assert.equal(buildExchangeOfLine("   "), "");
});

// ─────────────────────────────────────────────────────────────
// 退換貨條款
// ─────────────────────────────────────────────────────────────

test("🔴 buildReturnPolicyText：一定要 trim（打咗空格 = 冇填，唔可以佔一行紙）", () => {
  assert.equal(buildReturnPolicyText("  退換貨請於 7 日內憑此單辦理  "), "退換貨請於 7 日內憑此單辦理");
  assert.equal(buildReturnPolicyText("   "), "");
  assert.equal(buildReturnPolicyText("\n\t "), "");
  assert.equal(buildReturnPolicyText(""), "");
  assert.equal(buildReturnPolicyText(undefined), "");
  assert.equal(buildReturnPolicyText(null), "");
});

test("buildReturnPolicyText：保留內部換行（商家可以寫兩行條款）", () => {
  const t = "退換貨請於 7 日內憑此單及原包裝辦理\n處方藥一經售出恕不退換";
  assert.equal(buildReturnPolicyText(t), t);
});

// ─────────────────────────────────────────────────────────────
// 整合
// ─────────────────────────────────────────────────────────────

test("🔴 buildRetailReceiptBlocks：零售單（拆分付款 + 積分 + 條款）", () => {
  const blocks = buildRetailReceiptBlocks(
    {
      splitPayments: [
        { label: "現金", amount: 300 },
        { label: "澳門通", amount: 149 },
      ],
      pointsEarned: 449,
      pointsBalanceAfter: 1729,
    },
    { formatAmount: fmt, returnPolicyText: "退換貨請於 7 日內憑此單辦理" },
  );
  assert.equal(blocks.split_payment, "現金: $300.00\n澳門通: $149.00");
  assert.equal(blocks.points_earned, "會員積分: 本單 +449 / 結餘 1729");
  assert.equal(blocks.exchange_of, "");
  assert.equal(blocks.return_policy, "退換貨請於 7 日內憑此單辦理");
});

test("🔴 buildRetailReceiptBlocks：餐飲單 → 四個全部空（現有商戶零影響）", () => {
  const blocks = buildRetailReceiptBlocks({}, { formatAmount: fmt });
  assert.deepEqual(blocks, {
    split_payment: "",
    points_earned: "",
    exchange_of: "",
    return_policy: "",
  });
  // 呢個就係「空白內容 → renderer 自動略過」嘅契約：加咗區塊都唔會多出空行
  for (const v of Object.values(blocks)) assert.equal(v, "");
});

test("buildRetailReceiptBlocks：換貨單要出原單號", () => {
  const blocks = buildRetailReceiptBlocks(
    { exchangeOf: "R-000127" },
    { formatAmount: fmt },
  );
  assert.equal(blocks.exchange_of, "換貨單: 原單 R-000127");
});
