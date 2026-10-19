import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getOnlineCustomer, rememberOnlineCustomer } from "./online-customer-cache.ts";

/**
 * 快取測試（2026-10-19）：記低 → 讀返 → 空值清走。
 * 用途：結帳差額「充值返回原支付戶口」要電話先 call `applyPosTopup`
 * （Ledger phone 從未落 pos_orders，見該檔註釋）。
 */
describe("online-customer-cache", () => {
  it("記低 name + phone 之後讀得返", () => {
    rememberOnlineCustomer("led-1", { name: "陳小姐", phone: "63936542" });
    assert.deepEqual(getOnlineCustomer("led-1"), { name: "陳小姐", phone: "63936542" });
  });

  it("冇記錄過 → null", () => {
    assert.equal(getOnlineCustomer("led-never-seen"), null);
  });

  it("空白 key → 唔記亦唔讀", () => {
    rememberOnlineCustomer("   ", { phone: "63936542" });
    assert.equal(getOnlineCustomer(""), null);
    assert.equal(getOnlineCustomer("   "), null);
  });

  it("兩個欄位都空 → 清走舊記錄", () => {
    rememberOnlineCustomer("led-2", { phone: "63936542" });
    rememberOnlineCustomer("led-2", { name: "  ", phone: "" });
    assert.equal(getOnlineCustomer("led-2"), null);
  });

  it("覆寫語意：後一次蓋前一次", () => {
    rememberOnlineCustomer("led-3", { name: "舊名", phone: "63936542" });
    rememberOnlineCustomer("led-3", { name: "新名", phone: "65812233" });
    assert.deepEqual(getOnlineCustomer("led-3"), { name: "新名", phone: "65812233" });
  });
});
