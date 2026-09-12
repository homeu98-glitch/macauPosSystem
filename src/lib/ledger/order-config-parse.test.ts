import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeOrderConfigBlockers,
  hasAnyOnlinePayment,
  isRpcMissingError,
  parseMerchantOrderConfig,
} from "./order-config-parse.ts";

/**
 * Ledger 商家接單設定嘅防禦性解析（開關店）。
 *
 * 呢度每條規則都係「靜默錯就出事」：`merchant_enabled` 判錯，收銀就會
 * 喺暫停接單期間以為自己開咗店（或者反過來）。
 */
describe("parseMerchantOrderConfig", () => {
  it("標準 snake_case 回傳 → 全部照讀", () => {
    const config = parseMerchantOrderConfig({
      merchant_enabled: true,
      auto_accept: true,
      admin_enabled: true,
      open_now: true,
      hours_enabled: false,
      allow_balance_deduct: true,
      allow_pay_in_store: false,
      status: "active",
    });

    assert.equal(config.merchantEnabled, true);
    assert.equal(config.autoAccept, true);
    assert.equal(config.adminEnabled, true);
    assert.equal(config.openNow, true);
    assert.equal(config.hoursEnabled, false);
    assert.equal(config.allowBalanceDeduct, true);
    assert.equal(config.allowPayInStore, false);
    assert.equal(config.status, "active");
  });

  it("camelCase 回傳一樣讀得到", () => {
    const config = parseMerchantOrderConfig({ merchantEnabled: false, autoAccept: true, adminEnabled: false });
    assert.equal(config.merchantEnabled, false);
    assert.equal(config.autoAccept, true);
    assert.equal(config.adminEnabled, false);
  });

  it("🔴 缺 merchant_enabled 欄 → null（唔可以當 true／false）", () => {
    const config = parseMerchantOrderConfig({ auto_accept: true, status: "active" });
    assert.equal(config.merchantEnabled, null);
  });

  it("🔴 空物件 / null / 純字串 → merchantEnabled 一律 null", () => {
    for (const payload of [{}, null, undefined, "ok", 42, []]) {
      assert.equal(parseMerchantOrderConfig(payload).merchantEnabled, null, `payload=${String(payload)}`);
    }
  });

  it('字串 "false" 唔可以當 truthy（會反轉成「開」）', () => {
    const config = parseMerchantOrderConfig({ merchant_enabled: "false", auto_accept: "true" });
    assert.equal(config.merchantEnabled, false);
    assert.equal(config.autoAccept, true);
  });

  it("0 / 1 數字寫法一樣支援", () => {
    const config = parseMerchantOrderConfig({ merchant_enabled: 1, auto_accept: 0 });
    assert.equal(config.merchantEnabled, true);
    assert.equal(config.autoAccept, false);
  });

  it("陣列包住一行 → 取第一行", () => {
    const config = parseMerchantOrderConfig([{ merchant_enabled: false }]);
    assert.equal(config.merchantEnabled, false);
  });

  it("包一層 { config: {...} } → 拆開", () => {
    const config = parseMerchantOrderConfig({ config: { merchant_enabled: true, auto_accept: true } });
    assert.equal(config.merchantEnabled, true);
    assert.equal(config.autoAccept, true);
  });

  it("auto_accept 缺欄 → false（同 POS 本地 default 一致）", () => {
    assert.equal(parseMerchantOrderConfig({ merchant_enabled: true }).autoAccept, false);
  });
});

describe("isRpcMissingError", () => {
  it("PostgREST 揾唔到函式 → true", () => {
    assert.equal(
      isRpcMissingError("Could not find the function public.merchant_set_order_enabled(p_merchant_enabled, p_merchant_id) in the schema cache"),
      true,
    );
    assert.equal(isRpcMissingError('PGRST202: function not found'), true);
  });

  it("普通業務錯誤 → false", () => {
    assert.equal(isRpcMissingError("at least one payment method required"), false);
    assert.equal(isRpcMissingError("not authorized"), false);
    assert.equal(isRpcMissingError(null), false);
  });
});

describe("describeOrderConfigBlockers", () => {
  it("正常營業中 → 冇 blocker", () => {
    const config = parseMerchantOrderConfig({
      merchant_enabled: true,
      admin_enabled: true,
      open_now: true,
      status: "active",
    });
    assert.deepEqual(describeOrderConfigBlockers(config), []);
  });

  it("admin_enabled=false → 平台未核可（店員解唔到）", () => {
    const config = parseMerchantOrderConfig({ merchant_enabled: true, admin_enabled: false });
    const blockers = describeOrderConfigBlockers(config);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].fixableByStaff, false);
  });

  it("merchant_enabled=false → 已暫停接單（店員自己開得返）", () => {
    const config = parseMerchantOrderConfig({ merchant_enabled: false, admin_enabled: true });
    const blockers = describeOrderConfigBlockers(config);
    assert.deepEqual(blockers, [{ label: "已暫停接單", fixableByStaff: true }]);
  });

  it("suspended → 列出帳號狀態", () => {
    const config = parseMerchantOrderConfig({ merchant_enabled: true, admin_enabled: true, status: "suspended" });
    const blockers = describeOrderConfigBlockers(config);
    assert.equal(blockers.length, 1);
    assert.match(blockers[0].label, /suspended/);
  });

  it("時段外（hours_enabled=true 且 open_now=false）→ 休息中", () => {
    const config = parseMerchantOrderConfig({
      merchant_enabled: true,
      admin_enabled: true,
      hours_enabled: true,
      open_now: false,
    });
    const blockers = describeOrderConfigBlockers(config);
    assert.deepEqual(blockers, [{ label: "非接單時段（休息中）", fixableByStaff: false }]);
  });

  it("全天接單（hours_enabled=false）就算 open_now 缺欄都唔會亂報休息", () => {
    const config = parseMerchantOrderConfig({ merchant_enabled: true, admin_enabled: true, hours_enabled: false });
    assert.deepEqual(describeOrderConfigBlockers(config), []);
  });

  it("全缺欄 → 唔亂嚇人，唔列 blocker", () => {
    assert.deepEqual(describeOrderConfigBlockers(parseMerchantOrderConfig({})), []);
  });
});

describe("hasAnyOnlinePayment", () => {
  it("兩種都關 → false（開店會畀 RPC 拒）", () => {
    const config = parseMerchantOrderConfig({ allow_balance_deduct: false, allow_pay_in_store: false });
    assert.equal(hasAnyOnlinePayment(config), false);
  });

  it("有一邊開 → true", () => {
    assert.equal(
      hasAnyOnlinePayment(parseMerchantOrderConfig({ allow_balance_deduct: true, allow_pay_in_store: false })),
      true,
    );
    assert.equal(
      hasAnyOnlinePayment(parseMerchantOrderConfig({ allow_balance_deduct: false, allow_pay_in_store: true })),
      true,
    );
  });

  it("兩邊都缺欄 → null（無從判斷）", () => {
    assert.equal(hasAnyOnlinePayment(parseMerchantOrderConfig({})), null);
  });
});
