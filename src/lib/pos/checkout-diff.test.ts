import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildDiffNote, computeCheckoutDiff, maskPhoneForReceipt } from "./checkout-diff.ts";

/** 收據金額格式（fake：只係想睇註腳串法，唔引入 format 模組）。 */
const fmt = (n: number) => `MOP ${n.toFixed(2)}`;

/**
 * 守衛測試（mockup v3 畫面 ⑩ 護欄表：「誤彈差額模態」）：
 * 差額模態**只準**喺「線上已付 > 新價」彈；加菜／未付款／本地單維持現有行為。
 */
describe("computeCheckoutDiff（結帳差額判準）", () => {
  it("線上單改價：已付 100 > 新價 90 → 差額 10", () => {
    assert.equal(
      computeCheckoutDiff({ onlineOrderId: "led-1", prepaidAmount: 100, baseTotal: 100, discountAmount: 10 }),
      10,
    );
  });

  it("線上單改價（冇折扣）：已付 100 > 新價 90 → 差額 10", () => {
    assert.equal(
      computeCheckoutDiff({ onlineOrderId: "led-1", prepaidAmount: 100, baseTotal: 90, discountAmount: 0 }),
      10,
    );
  });

  it("加菜情况：新價 120 > 已付 100 → 唔使處理（0）", () => {
    assert.equal(
      computeCheckoutDiff({ onlineOrderId: "led-1", prepaidAmount: 100, baseTotal: 120, discountAmount: 0 }),
      0,
    );
  });

  it("加菜＋折扣後仍然高過已付 → 0", () => {
    assert.equal(
      computeCheckoutDiff({ onlineOrderId: "led-1", prepaidAmount: 100, baseTotal: 130, discountAmount: 10 }),
      0,
    );
  });

  it("一文差唔多：已付 == 新價 → 0（邊界）", () => {
    assert.equal(
      computeCheckoutDiff({ onlineOrderId: "led-1", prepaidAmount: 90, baseTotal: 100, discountAmount: 10 }),
      0,
    );
  });

  it("未付款線上單：prepaidAmount = 0 → 0", () => {
    assert.equal(
      computeCheckoutDiff({ onlineOrderId: "led-1", prepaidAmount: 0, baseTotal: 90, discountAmount: 0 }),
      0,
    );
  });

  it("純本地單（冇 onlineOrderId）：就算有 prepaid 都恒 0", () => {
    assert.equal(
      computeCheckoutDiff({ onlineOrderId: undefined, prepaidAmount: 100, baseTotal: 90, discountAmount: 0 }),
      0,
    );
  });

  it("浮點尾數要對：100 − 89.99 → 10.01（兩位小數）", () => {
    assert.equal(
      computeCheckoutDiff({ onlineOrderId: "led-1", prepaidAmount: 100, baseTotal: 89.99, discountAmount: 0 }),
      10.01,
    );
  });

  it("折扣大過原價（全免）：settleTotal 坐底 0 → 差額 = 已付", () => {
    assert.equal(
      computeCheckoutDiff({ onlineOrderId: "led-1", prepaidAmount: 100, baseTotal: 50, discountAmount: 80 }),
      100,
    );
  });
});

/**
 * 電話遮罩（個資紅線）：DB／收據只準存遮罩版。
 */
describe("maskPhoneForReceipt", () => {
  it("8 位電話 → 前 4 位 + ****", () => {
    assert.equal(maskPhoneForReceipt("63936542"), "6393****");
  });

  it("有分隔符（空格 / 橫線）都照遮", () => {
    assert.equal(maskPhoneForReceipt("6393 6542"), "6393****");
  });

  it("4 位或以下 → 原樣（爛資料唔好變成假 mask）", () => {
    assert.equal(maskPhoneForReceipt("6393"), "6393");
    assert.equal(maskPhoneForReceipt(""), "");
  });

  it("null / undefined → 空字串（唔好炸）", () => {
    assert.equal(maskPhoneForReceipt(null), "");
    assert.equal(maskPhoneForReceipt(undefined), "");
  });
});

/**
 * 小票差額註腳（mockup v3 畫面 ⑥）：
 * 冇處理過差額 → 空字串 → renderer 自動略過（舊單零影響）。
 */
describe("buildDiffNote（收據 diff_note 內容）", () => {
  it("未處理過差額（diffHandling 空）→ 空字串", () => {
    assert.equal(buildDiffNote({ handling: undefined, amount: 10, formatAmount: fmt }), "");
  });

  it("金額 0 / 缺值 → 空字串（防呆）", () => {
    assert.equal(buildDiffNote({ handling: "topup", amount: 0, formatAmount: fmt }), "");
    assert.equal(buildDiffNote({ handling: "cash", amount: undefined, formatAmount: fmt }), "");
  });

  it("topup：差額 + 遮罩電話 + 憑證（mockup 原句）", () => {
    assert.equal(
      buildDiffNote({
        handling: "topup",
        amount: 10,
        txnId: "TXN-8F3K2",
        phoneMask: "6234****",
        formatAmount: fmt,
      }),
      "差額 MOP 10.00 已充值返回原支付戶口（6234****）· 憑證 TXN-8F3K2",
    );
  });

  it("topup 冇遮罩電話（快取失效 + 人手輸入過期）→ 省略括號", () => {
    assert.equal(
      buildDiffNote({ handling: "topup", amount: 10, formatAmount: fmt }),
      "差額 MOP 10.00 已充值返回原支付戶口",
    );
  });

  it("topup 冇 txn id → 省略憑證段", () => {
    assert.equal(
      buildDiffNote({ handling: "topup", amount: 10, phoneMask: "6234****", formatAmount: fmt }),
      "差額 MOP 10.00 已充值返回原支付戶口（6234****）",
    );
  });

  it("cash：現金退款一句", () => {
    assert.equal(buildDiffNote({ handling: "cash", amount: 10, formatAmount: fmt }), "差額 MOP 10.00 已現金退款");
  });

  it("none：店方保留 + 必填原因", () => {
    assert.equal(
      buildDiffNote({ handling: "none", amount: 10, reason: "堂食優惠差額，店方承擔", formatAmount: fmt }),
      "差額 MOP 10.00 店方保留（堂食優惠差額，店方承擔）",
    );
  });

  it("none 冇原因（理論上唔發生，原因必填）→ 唔印空括號", () => {
    assert.equal(buildDiffNote({ handling: "none", amount: 10, formatAmount: fmt }), "差額 MOP 10.00 店方保留");
  });

  it("空白 reason（純空格）→ 當冇原因", () => {
    assert.equal(buildDiffNote({ handling: "none", amount: 10, reason: "   ", formatAmount: fmt }), "差額 MOP 10.00 店方保留");
  });
});
