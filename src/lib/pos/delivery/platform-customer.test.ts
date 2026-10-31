import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractPlatformCustomer, isUsablePhone } from "./platform-customer.ts";

/**
 * 平台單客人資料抽取回歸測試。
 *
 * 為什麼要釘死：呢個係**個資路徑**（姓名／電話／地址）。出錯有兩種後果：
 *   ① 抽錯（例如抽到店鋪地址）→ 車手送錯地方；
 *   ② 抽到遮罩電話（澳覓 `853-****9190`）→ 店員以為有電話，車手打唔通。
 */

/** 澳覓：`aomi-bridge.js` normalizeDetail 出嚟嘅形狀（電話係遮罩）。 */
const aomiRaw = {
  source: "aomi",
  externalOrderId: "TK001361260917190710813",
  sendType: "自送",
  customer: {
    phoneMasked: "853-****9190",
    name: "陳小姐",
    address: "黑沙環中街 88 號 金海山花園 5 樓 A",
    remark: "管理處交收",
    tableware: "1",
  },
  raw: {
    orderId: "TK001361260917190710813",
    sendType: "自送",
    userAddress: "黑沙環中街 88 號 金海山花園 5 樓 A",
    userRegistPhone: "853-****9190",
  },
};

/** MFOOD：`mfood-bridge.js` 出嚟嘅形狀（電話完整）。 */
const mfoodRaw = {
  source: "mfood",
  externalOrderId: "202610301857",
  deliveryType: 2,
  customer: {
    phone: "66127888",
    name: "李小姐",
    nickname: "小李",
    address: "氹仔廣東大馬路 200 號 8 樓 B",
    remark: "到達請致電",
  },
  raw: {
    receiverMobile: "66127888",
    receiverName: "李小姐",
    address: "氹仔廣東大馬路 200 號 8 樓 B",
    deliveryType: 2,
  },
};

describe("isUsablePhone", () => {
  it("完整電話（澳門／內地／帶區碼）都算可用", () => {
    assert.equal(isUsablePhone("66127888"), true);
    assert.equal(isUsablePhone("+853 6612 7888"), true);
    assert.equal(isUsablePhone("13800138000"), true);
  });

  it("🔴 遮罩電話唔算可用（車手打唔到）", () => {
    assert.equal(isUsablePhone("853-****9190"), false);
    assert.equal(isUsablePhone("****1234"), false);
  });

  it("太短／空值唔算可用", () => {
    assert.equal(isUsablePhone("123"), false);
    assert.equal(isUsablePhone(""), false);
    assert.equal(isUsablePhone(null), false);
  });
});

describe("extractPlatformCustomer · 澳覓", () => {
  it("抽到姓名、地址、備註", () => {
    const out = extractPlatformCustomer("aomi", aomiRaw);
    assert.equal(out.name, "陳小姐");
    assert.equal(out.address, "黑沙環中街 88 號 金海山花園 5 樓 A");
    assert.equal(out.remark, "管理處交收");
  });

  it("🔴 遮罩電話唔會當成可用電話（回 phoneMasked 而唔係 phone）", () => {
    const out = extractPlatformCustomer("aomi", aomiRaw);
    assert.equal(out.phone, undefined);
    assert.equal(out.phoneMasked, "853-****9190");
  });

  it("正規化層冇地址時 fallback 去原物件 userAddress", () => {
    const out = extractPlatformCustomer("aomi", {
      source: "aomi",
      customer: { name: "陳小姐" },
      raw: { userAddress: "氹仔舊城區 1 號" },
    });
    assert.equal(out.address, "氹仔舊城區 1 號");
  });
});

describe("extractPlatformCustomer · MFOOD", () => {
  it("抽到完整電話、姓名、地址", () => {
    const out = extractPlatformCustomer("mfood", mfoodRaw);
    assert.equal(out.phone, "66127888");
    assert.equal(out.phoneMasked, undefined);
    assert.equal(out.name, "李小姐");
    assert.equal(out.address, "氹仔廣東大馬路 200 號 8 樓 B");
  });

  it("冇 customer 層時 fallback 去原物件", () => {
    const out = extractPlatformCustomer("mfood", {
      source: "mfood",
      raw: { receiverMobile: "66127888", receiverName: "李小姐", address: "氹仔某處" },
    });
    assert.equal(out.phone, "66127888");
    assert.equal(out.name, "李小姐");
    assert.equal(out.address, "氹仔某處");
  });
});

describe("extractPlatformCustomer · 邊界", () => {
  it("非平台單一律回空物件（唔會抽到店內單嘅嘢）", () => {
    assert.deepEqual(extractPlatformCustomer("pos", mfoodRaw), {});
    assert.deepEqual(extractPlatformCustomer(undefined, mfoodRaw), {});
  });

  it("raw_json 亂七八糟唔會 throw", () => {
    assert.deepEqual(extractPlatformCustomer("aomi", null), {});
    assert.deepEqual(extractPlatformCustomer("aomi", "not-an-object"), {});
    assert.deepEqual(extractPlatformCustomer("aomi", { customer: [] }), {});
  });

  it("空白字串當冇值（唔會預填一串空格）", () => {
    const out = extractPlatformCustomer("mfood", {
      customer: { name: "  ", address: "  ", phone: "  " },
    });
    assert.equal(out.name, undefined);
    assert.equal(out.address, undefined);
    assert.equal(out.phone, undefined);
  });
});
