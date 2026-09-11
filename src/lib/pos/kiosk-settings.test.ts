import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SCAN_MODE, normalizeKioskPrinters, normalizeScanMode } from "./kiosk-settings.ts";

/**
 * 掃碼點餐模式（docs/115）嘅**正常化讀取**規則。
 *
 * 呢條規則係「靜默錯就出事」嘅地方：`scan_mode` 係 0031 migration 新加嘅欄位，
 * 舊 DB row / code 先上 migration 後上嘅窗口期，讀到嘅可能係 `undefined` 或者
 * 第啲未知值。一旦當成 `quick`，鋪頭就會由「逐枱一碼」靜靜變成「全店一碼」
 * —— 桌台碼全部失效，客人掃碼會落一批冇枱嘅單。
 */
describe("normalizeScanMode", () => {
  it("DB 有明確值 → 照用", () => {
    assert.equal(normalizeScanMode("dine_in"), "dine_in");
    assert.equal(normalizeScanMode("quick"), "quick");
  });

  it("undefined / null / 空字串（欄位未存在 / 未設定）→ dine_in（向後兼容）", () => {
    assert.equal(normalizeScanMode(undefined), "dine_in");
    assert.equal(normalizeScanMode(null), "dine_in");
    assert.equal(normalizeScanMode(""), "dine_in");
  });

  it("未知值（打錯字 / 舊版本殘留）→ 一律 dine_in，唔會誤當快餐", () => {
    assert.equal(normalizeScanMode("QUICK"), "dine_in");
    assert.equal(normalizeScanMode("counter"), "dine_in");
    assert.equal(normalizeScanMode(1), "dine_in");
    assert.equal(normalizeScanMode({}), "dine_in");
  });

  it("預設模式係堂食（現存店鋪行為不變）", () => {
    assert.equal(DEFAULT_SCAN_MODE, "dine_in");
  });
});

/**
 * 自助點餐機專屬打印機清單嘅白名單過濾（0032 migration，docs/87 §6.2）。
 *
 * 呢個係「靜默錯就出事」嘅第二個位：垃圾值一旦流入，
 * `resolveJobPrinter()` 會搵唔到目標機 → 跌落 by-role 分支 →
 * **靜靜地印去收銀台嗰部收據機**（商家以為 kiosk 打印機壞咗）。
 */
describe("normalizeKioskPrinters", () => {
  const lanReceipt = {
    id: "printer-kiosk-1",
    name: "小票機 · POS-80",
    role: "receipt",
    connectionType: "lan",
    ipAddress: "192.168.1.110",
    enabled: true,
  };

  it("合法項目照留（連 ipAddress 等欄位一齊保留）", () => {
    const out = normalizeKioskPrinters([lanReceipt]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "printer-kiosk-1");
    assert.equal(out[0].role, "receipt");
    assert.equal(out[0].ipAddress, "192.168.1.110");
  });

  it("唔係陣列 / 空值 → 空陣列（唔會爆）", () => {
    assert.deepEqual(normalizeKioskPrinters(undefined), []);
    assert.deepEqual(normalizeKioskPrinters(null), []);
    assert.deepEqual(normalizeKioskPrinters({}), []);
    assert.deepEqual(normalizeKioskPrinters("[]"), []);
  });

  it("缺 id 或 name → 剔走", () => {
    assert.equal(normalizeKioskPrinters([{ ...lanReceipt, id: "" }]).length, 0);
    assert.equal(normalizeKioskPrinters([{ ...lanReceipt, name: "  " }]).length, 0);
    assert.equal(normalizeKioskPrinters([{ name: "冇 id", role: "receipt", connectionType: "lan" }]).length, 0);
  });

  it("role / connectionType 唔喺白名單 → 剔走（唔會靜靜地當成 receipt）", () => {
    assert.equal(normalizeKioskPrinters([{ ...lanReceipt, role: "printer" }]).length, 0);
    assert.equal(normalizeKioskPrinters([{ ...lanReceipt, role: "RECEIPT" }]).length, 0);
    assert.equal(normalizeKioskPrinters([{ ...lanReceipt, connectionType: "wifi" }]).length, 0);
    assert.equal(normalizeKioskPrinters([{ ...lanReceipt, connectionType: undefined }]).length, 0);
  });

  it("缺 enabled → 當 true；明確 false 就要保留（商家停用要生效）", () => {
    const withoutEnabled: Record<string, unknown> = { ...lanReceipt };
    delete withoutEnabled.enabled;
    assert.equal(normalizeKioskPrinters([withoutEnabled])[0].enabled, true);
    assert.equal(normalizeKioskPrinters([{ ...lanReceipt, enabled: false }])[0].enabled, false);
  });

  it("混合清單 → 只留合法嘅（唔會因為一個壞項目丟晒全部）", () => {
    const out = normalizeKioskPrinters([lanReceipt, null, "garbage", { ...lanReceipt, id: "p2", role: "kitchen" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "printer-kiosk-1");
  });
});
