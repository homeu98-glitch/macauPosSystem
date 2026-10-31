import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDeliveryJobDraft, canOverwriteJob, mopToAvos, normalizePhone } from "./job-input.ts";

const base = {
  orderSource: "pos",
  orderRef: "8f1f0d7e-0000-4000-8000-000000000001",
  orderNoSnapshot: "外賣 003",
  deliveryMode: "merchant",
  customer: { name: "陳小姐", phone: "6612 3456", address: "黑沙環中街 88 號 5 樓 A" },
  feeAmountMop: 30,
  feePaidBy: "shop",
  codAmountMop: 0,
};

describe("mopToAvos", () => {
  it("整數同小數都轉得準", () => {
    assert.equal(mopToAvos(30, 1000), 3000);
    assert.equal(mopToAvos("30.5", 1000), 3050);
    assert.equal(mopToAvos(0.07, 1000), 7);
  });

  it("空值當 0（代收默認唔收）", () => {
    assert.equal(mopToAvos(null, 1000), 0);
    assert.equal(mopToAvos("", 1000), 0);
  });

  it("負數／超上限／亂碼回 null（唔可以靜靜變 0）", () => {
    assert.equal(mopToAvos(-1, 1000), null);
    assert.equal(mopToAvos(1001, 1000), null);
    assert.equal(mopToAvos("abc", 1000), null);
  });
});

describe("normalizePhone", () => {
  it("澳門 8 位、內地 11 位、帶 +853 都收", () => {
    assert.equal(normalizePhone("66123456"), "66123456");
    assert.equal(normalizePhone("6612 3456"), "6612 3456");
    assert.equal(normalizePhone("+853 6612 3456"), "+853 6612 3456");
    assert.equal(normalizePhone("13800138000"), "13800138000");
  });

  it("太短、太長、有字母一律拒", () => {
    assert.equal(normalizePhone("123"), null);
    assert.equal(normalizePhone("1234567890123456"), null);
    assert.equal(normalizePhone("6612abc"), null);
    assert.equal(normalizePhone(""), null);
  });
});

describe("buildDeliveryJobDraft · 成功路徑", () => {
  it("店內單：只寫 draft，配送方式固定 merchant", () => {
    const result = buildDeliveryJobDraft(base);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.row.status, "draft");
    assert.equal(result.row.order_source, "pos");
    assert.equal(result.row.delivery_mode, "merchant");
    assert.equal(result.row.customer_phone, "6612 3456");
    assert.equal(result.row.fee_amount_avos, 3000);
    assert.equal(result.row.fee_paid_by, "shop");
    assert.equal(result.row.cod_amount_avos, 0);
    assert.equal(result.row.platform, null);
  });

  it("線上外送單：order_source = ledger", () => {
    const result = buildDeliveryJobDraft({ ...base, orderSource: "ledger" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.row.order_source, "ledger");
  });

  it("平台自送單：platform 保留，mode 可以係 pickup", () => {
    const result = buildDeliveryJobDraft({
      ...base,
      platform: "mfood",
      deliveryMode: "pickup",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.row.platform, "mfood");
    assert.equal(result.row.delivery_mode, "pickup");
  });

  it("冇傳 deliveryMode 時當 merchant（店內／線上本身就係自送）", () => {
    const result = buildDeliveryJobDraft({ ...base, deliveryMode: undefined });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.row.delivery_mode, "merchant");
  });

  it("代收貨款同座標都收", () => {
    const result = buildDeliveryJobDraft({
      ...base,
      codAmountMop: 128,
      customer: { ...base.customer, lat: 22.2001, lng: 113.5483 },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.row.cod_amount_avos, 12800);
    assert.equal(result.row.customer_lat, 22.2001);
    assert.equal(result.row.customer_lng, 113.5483);
  });
});

describe("buildDeliveryJobDraft · 拒絕路徑", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["來源亂填", { orderSource: "aomi" }, "bad_source"],
    ["冇單號", { orderRef: "" }, "bad_ref"],
    ["平台專送", { deliveryMode: "platform" }, "platform_delivery"],
    ["配送方式未知", { deliveryMode: "unknown" }, "bad_mode"],
    ["冇電話", { customer: { address: "x" } }, "missing_phone"],
    ["電話亂碼", { customer: { phone: "abc", address: "x" } }, "bad_phone"],
    ["冇地址", { customer: { phone: "66123456", address: "  " } }, "missing_address"],
    ["座標超範圍", { customer: { ...base.customer, lat: 999 } }, "bad_coords"],
    ["車手費負數", { feeAmountMop: -5 }, "bad_fee"],
    ["代收太大", { codAmountMop: 200000 }, "bad_cod"],
  ];

  for (const [name, patch, expected] of cases) {
    it(name, () => {
      const result = buildDeliveryJobDraft({ ...base, ...patch });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error, expected);
    });
  }

  it("🔴 平台專送唔可以靠前端繞過：直接 POST 一樣拒", () => {
    // 呢個 case 係安全網 —— POS 前端本來已經唔顯示掣，
    // 但直接打 API 都要擋，否則兩個車手會同時上門。
    const result = buildDeliveryJobDraft({ ...base, platform: "aomi", deliveryMode: "platform" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "platform_delivery");
  });
});

describe("canOverwriteJob", () => {
  it("只有 draft / canceled / failed 准蓋", () => {
    assert.equal(canOverwriteJob("draft"), true);
    assert.equal(canOverwriteJob("canceled"), true);
    assert.equal(canOverwriteJob("failed"), true);
  });

  it("進行中（new / accepted / picked_up）同已送達都唔准蓋", () => {
    assert.equal(canOverwriteJob("new"), false);
    assert.equal(canOverwriteJob("accepted"), false);
    assert.equal(canOverwriteJob("picked_up"), false);
    assert.equal(canOverwriteJob("delivered"), false);
    assert.equal(canOverwriteJob(undefined), false);
  });
});
