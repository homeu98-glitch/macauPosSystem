import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OFFLINE_REPORT_CHANNELS,
  OFFLINE_REPORT_MAX_DAYS,
  OFFLINE_REPORT_MAX_DISHES,
  OFFLINE_REPORT_MAX_LABEL_LEN,
  OFFLINE_REPORT_MAX_ORDERS,
  OFFLINE_REPORT_PATH,
  buildOfflineReportResponse,
  clampOfflineReportRange,
  computeOfflineReportSignature,
  dateKeySpanDays,
  isDateKey,
  isStoreId,
  normalizeOfflineReportChannel,
  normalizeStoreId,
  offlineReportCapsHeader,
  shiftDateKey,
  validateOfflineReportRpc,
  verifyOfflineReportSignature,
} from "./offline-report.ts";

/**
 * Ledger「線下營業摘要」契約純邏輯測試（2026-09-25；2026-09-26 加 orders／dishes；
 * 2026-10-07 加 0066 渠道維度）。
 *
 * 每個 describe 對應契約原文嘅一條要求：
 *   · 範圍截斷（§驗證順序 4 ＋ 驗收清單 `2026-01-01→2026-09-24 ⇒ from=2026-06-27`）
 *   · 驗簽（§驗證順序 1–2 ＋ 驗簽參考實作）
 *   · RPC 回值嚴格驗證（§欄位表「型別不符整包丟棄」）
 *   · 回應形狀（§回應 200）
 *   · 2026-09-26 增補：`orders[]`／`dishes[]` ＋ **部署次序安全閥**（0059 未跑要優雅降級）
 *   · 2026-10-07 增補（0066）：`kpiByChannel`／`paymentBreakdown`／
 *     `ordersByChannel[]`／`dishesByChannel[]` ＋ **第二道部署次序安全閥**（0066 未跑要優雅降級）
 *
 * 🔴🔴 0066 最重要嘅一條（J拍板）：**舊欄位一個數字都唔可以變**。
 *    呢個唔淨止要 SQL 守，**lib 呢邊一樣要守**——
 *    `buildOfflineReportResponse()` 係唯一砌出 payload 嘅地方，
 *    如果佢將 `input.kpi` 換咗、或者將 `byPayment` 改成 `paymentBreakdown`，
 *    Ledger 嗰張已對數嘅卡一樣會即刻跳數。⇒ 見下面「0066：舊欄位一個數字都唔可以變」。
 *
 * 🔴🔴🔴 **方案 A（0066 第二版，J 拍板）**：線上數據**全部搬去新 key**。
 *    · 舊 `orders[]`／`dishes[]`：還原 0060 口徑同數值（`online_order_id is null`），
 *      `dishes[]` **只剩三欄**，一旦出現拆欄即 `rpc-dish-split-on-legacy`（503）。
 *    · 新 `ordersByChannel[]`／`dishesByChannel[]`：線上投影單淨係喺呢度出現，
 *      `dishesByChannel[]` 每列七欄（總數 ＋ 四個拆欄）。
 *    · 舊 `orders[]` 每列**仍然帶 `channel`**（additive，唔改任何數字）——
 *      因為外賣平台單冇 `online_order_id`，所以舊 `orders[]` 其實一直包埋平台單，
 *      保留 `channel` 係誠實標示，唔加先係講大話。
 */

const SECRET = "a".repeat(64);
const NOW = Date.parse("2026-09-25T01:00:00.000Z");
const PATH_Q = `${OFFLINE_REPORT_PATH}?storeId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&from=2026-09-01&to=2026-09-24`;

describe("storeId 驗證（契約 §驗證順序 3）", () => {
  it("合法 UUID（大寫都收，一律回小寫）", () => {
    const upper = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
    assert.equal(isStoreId(upper), true);
    assert.equal(normalizeStoreId(upper), upper.toLowerCase());
  });

  it("🔴 假店號／缺前綴／長度錯 ⇒ 拒絕（唔可以放行去查 DB）", () => {
    for (const bad of ["", "  ", "macau-store-a", "8291f843-9def-4956-9d0b", "not-a-uuid", null, 42]) {
      assert.equal(isStoreId(bad as unknown), false, String(bad));
      assert.equal(normalizeStoreId(bad as unknown), "", String(bad));
    }
  });
});

describe("日期鍵驗證（契約：`YYYY-MM-DD` 合法日曆日）", () => {
  it("正常日期通過", () => {
    for (const ok of ["2026-09-25", "2026-01-01", "2024-02-29", "2026-12-31"]) {
      assert.equal(isDateKey(ok), true, ok);
    }
  });

  it("🔴 唔存在嘅日曆日一定要拒（`Date.parse` 會靜靜滾到下個月，唔可以用）", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-1-1", "20260925", "", "2026-02-29"]) {
      assert.equal(isDateKey(bad), false, bad);
    }
  });

  it("日期位移／日數（含首尾）", () => {
    assert.equal(shiftDateKey("2026-09-24", -89), "2026-06-27");
    assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
    assert.equal(dateKeySpanDays("2026-09-01", "2026-09-01"), 1);
    assert.equal(dateKeySpanDays("2026-01-01", "2026-09-24"), 267);
  });
});

describe("範圍截斷 90 日（契約 §驗證順序 4 ＋ 驗收清單）", () => {
  it("🔴 驗收清單原文：2026-01-01 → 2026-09-24 ⇒ clamped=true、from=2026-06-27（to − 89 日）、to 不變", () => {
    const r = clampOfflineReportRange("2026-01-01", "2026-09-24");
    assert.deepEqual(r, { from: "2026-06-27", to: "2026-09-24", clamped: true });
  });

  it("邊界：日差 89（＝90 個日曆日）唔截斷；日差 90 才截斷", () => {
    assert.deepEqual(clampOfflineReportRange("2026-06-27", "2026-09-24"), {
      from: "2026-06-27",
      to: "2026-09-24",
      clamped: false,
    });
    assert.deepEqual(clampOfflineReportRange("2026-06-26", "2026-09-24"), {
      from: "2026-06-27",
      to: "2026-09-24",
      clamped: true,
    });
  });

  it("同日／短區間照原樣", () => {
    assert.deepEqual(clampOfflineReportRange("2026-09-24", "2026-09-24"), {
      from: "2026-09-24",
      to: "2026-09-24",
      clamped: false,
    });
  });

  it("上限常數同契約一致（90 個日曆日）", () => {
    assert.equal(OFFLINE_REPORT_MAX_DAYS, 90);
    assert.equal(dateKeySpanDays(clampOfflineReportRange("2000-01-01", "2026-09-24").from, "2026-09-24"), 90);
  });
});

describe("HMAC 驗簽（契約 §驗證順序 1–2）", () => {
  const ts = String(Math.floor(NOW / 1000));
  const sig = computeOfflineReportSignature(SECRET, ts, PATH_Q);

  function verify(over: Partial<Parameters<typeof verifyOfflineReportSignature>[0]> = {}) {
    return verifyOfflineReportSignature({
      timestampHeader: ts,
      signatureHeader: sig,
      pathWithQuery: PATH_Q,
      secret: SECRET,
      nowMs: NOW,
      ...over,
    });
  }

  it("正確簽名（unix 秒）通過", () => {
    assert.deepEqual(verify(), { ok: true });
  });

  it("毫秒時戳都接受（同一個簽名，容差內）", () => {
    const msTs = String(NOW);
    const msSig = computeOfflineReportSignature(SECRET, msTs, PATH_Q);
    assert.deepEqual(verify({ timestampHeader: msTs, signatureHeader: msSig }), { ok: true });
  });

  it("🔴 錯 secret／改過 path（換 storeId、改區間、重排 query）一律拒", () => {
    assert.equal(verify({ secret: "b".repeat(64) }).ok, false);
    assert.equal(verify({ pathWithQuery: PATH_Q.replace("2026-09-01", "2026-09-02") }).ok, false);
    assert.equal(
      verify({ pathWithQuery: `${OFFLINE_REPORT_PATH}?from=2026-09-01&storeId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&to=2026-09-24` }).ok,
      false,
    );
  });

  it("時戳：過期（+6 分鐘）／未來（−6 分鐘）／非數字 一律拒", () => {
    const stale = String(Math.floor((NOW - 6 * 60_000) / 1000));
    assert.deepEqual(verify({ timestampHeader: stale, signatureHeader: computeOfflineReportSignature(SECRET, stale, PATH_Q) }), {
      ok: false,
      reason: "stale-timestamp",
    });
    const future = String(Math.floor((NOW + 6 * 60_000) / 1000));
    assert.deepEqual(verify({ timestampHeader: future, signatureHeader: computeOfflineReportSignature(SECRET, future, PATH_Q) }), {
      ok: false,
      reason: "stale-timestamp",
    });
    assert.deepEqual(verify({ timestampHeader: "abc" }), { ok: false, reason: "bad-timestamp" });
  });

  it("🔴 壞 hex 要先擋長度（`Buffer.from(hex)` 會靜默截斷尾碼）", () => {
    assert.deepEqual(verify({ signatureHeader: sig.slice(0, 63) }), { ok: false, reason: "bad-signature" });
    assert.deepEqual(verify({ signatureHeader: `${sig.slice(0, 63)}z` }), { ok: false, reason: "bad-signature" });
    assert.deepEqual(verify({ signatureHeader: "" }), { ok: false, reason: "missing-header" });
    assert.deepEqual(verify({ timestampHeader: "" }), { ok: false, reason: "missing-header" });
  });

  it("secret 未設 ⇒ missing-secret（route 據此回 500，唔可以回 401 矇混）", () => {
    assert.deepEqual(verify({ secret: "" }), { ok: false, reason: "missing-secret" });
    assert.deepEqual(verify({ secret: "   " }), { ok: false, reason: "missing-secret" });
  });
});

describe("RPC 回值嚴格驗證（契約 §欄位表：型別不符 ⇒ 唔可以回 200）", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  /** KPI 部分（＝ 舊版 0058 嘅完整輸出；冇 0059 嘅四個 key）。 */
  const kpiOnly = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    orderCount: 12,
    revenueAvos: 123450,
    refundedAvos: 0,
    discountAvos: 500,
    covers: 30,
    byPayment: [{ method: "Mpay", amountAvos: 123450 }],
  };
  /** 0059 增補部分。 */
  const detail = {
    ordersTotal: 3,
    orders: [
      { orderNo: "001", totalAvos: 184700, status: "settled" },
      { orderNo: "002", totalAvos: 3800, status: "draft" },
      { orderNo: null, totalAvos: 0, status: "unknown" },
    ],
    dishesTotal: 2,
    dishes: [
      { name: "凍檸茶", qty: 42, revenueAvos: 84000 },
      { name: "豬扒飯", qty: 7, revenueAvos: 49000 },
    ],
  };
  /** 0058 ＋ 0059 之後嘅完整回值。 */
  const good = { ...kpiOnly, ...detail };

  it("正常回值通過，並逐欄抄出", () => {
    const r = validateOfflineReportRpc(good, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.found, true);
    assert.equal(r.hasDetail, true);
    assert.deepEqual(r.kpi, {
      orderCount: 12,
      revenueAvos: 123450,
      refundedAvos: 0,
      discountAvos: 500,
      covers: 30,
    });
    assert.deepEqual(r.byPayment, [{ method: "Mpay", amountAvos: 123450 }]);
  });

  it("🔴 區間／clamped 同 route 自己算嘅唔一致 ⇒ 拒（Ledger 兩邊都會核對）", () => {
    assert.equal(validateOfflineReportRpc({ ...good, from: "2026-06-27" }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...good, clamped: true }, expected).ok, false);
  });

  it("🔴 金額唔係非負安全整數 ⇒ 拒（防浮點／假零）", () => {
    assert.equal(validateOfflineReportRpc({ ...good, revenueAvos: 1234.5 }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...good, revenueAvos: -1 }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...good, revenueAvos: "123450" }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...good, covers: Number.NaN }, expected).ok, false);
  });

  it("🔴 缺 `found` / `clamped` / KPI 任何一欄 ⇒ 拒（RPC 回扁平欄位）", () => {
    const { found: _found, ...noFound } = good;
    void _found;
    assert.equal(validateOfflineReportRpc(noFound, expected).ok, false);
    const { clamped: _clamped, ...noClamped } = good;
    void _clamped;
    assert.equal(validateOfflineReportRpc(noClamped, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...good, covers: undefined }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...good, byPayment: undefined }, expected).ok, false);
    assert.equal(validateOfflineReportRpc(null, expected).ok, false);
  });

  it("🔴 超過 90 日：**SQL 自己截斷**後嘅回傳值要收（from = to − 89、clamped = true）", () => {
    // 2026-09-25 實案：route 曾經先截斷再傳 ⇒ SQL 回 clamped=false ⇒ 驗值 503。
    // 正確流程係「傳原始區間 → SQL 回截斷後嘅值 → 用回傳值核對」。
    const expectedBig = clampOfflineReportRange("2026-01-01", "2026-09-24");
    assert.deepEqual(expectedBig, { from: "2026-06-27", to: "2026-09-24", clamped: true });

    const fromSql = { ...good, from: "2026-06-27", to: "2026-09-24", clamped: true };
    const r = validateOfflineReportRpc(fromSql, expectedBig);
    assert.equal(r.ok, true);
    if (r.ok) {
      // 回應要 echo SQL 實際用嘅區間
      assert.equal(r.from, "2026-06-27");
      assert.equal(r.to, "2026-09-24");
      assert.equal(r.clamped, true);
    }

    // 反例：SQL 回 clamped=false（＝ route 先截斷再傳嘅後果）⇒ 一定要拒，唔可以靜默出錯數
    const wrong = { ...good, from: "2026-06-27", to: "2026-09-24", clamped: false };
    assert.equal(validateOfflineReportRpc(wrong, expectedBig).ok, false);
  });

  it("🔴 回傳值缺 `from`／`to`（或非字串）⇒ 拒", () => {
    const { from: _from, ...noFrom } = good;
    void _from;
    assert.equal(validateOfflineReportRpc(noFrom, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...good, to: 20260924 }, expected).ok, false);
  });

  it("byPayment：method 空／超 32 字／非陣列 ⇒ 拒（契約：> 32 字整包拒收）", () => {
    assert.equal(validateOfflineReportRpc({ ...good, byPayment: [{ method: "", amountAvos: 1 }] }, expected).ok, false);
    assert.equal(
      validateOfflineReportRpc({ ...good, byPayment: [{ method: "x".repeat(33), amountAvos: 1 }] }, expected).ok,
      false,
    );
    assert.equal(validateOfflineReportRpc({ ...good, byPayment: {} }, expected).ok, false);
  });

  it("組合付款方式（實測值 `會員餘額 + Mpay`）可以原樣通過", () => {
    const r = validateOfflineReportRpc({ ...good, byPayment: [{ method: "會員餘額 + Mpay", amountAvos: 6200 }] }, expected);
    assert.equal(r.ok, true);
  });
});

describe("RPC 回值：訂單明細 orders（0059 增補）", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  const detail = {
    ordersTotal: 2,
    orders: [
      { orderNo: "001", totalAvos: 184700, status: "settled" },
      { orderNo: null, totalAvos: 3800, status: "draft" },
    ],
    dishesTotal: 0,
    dishes: [],
  };
  const base = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    orderCount: 1,
    revenueAvos: 184700,
    refundedAvos: 0,
    discountAvos: 0,
    covers: 2,
    byPayment: [{ method: "現金", amountAvos: 184700 }],
    ...detail,
  };

  it("三個欄位照抄出，未截斷時 ordersTruncated = false", () => {
    const r = validateOfflineReportRpc(base, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.orders, [
      { orderNo: "001", totalAvos: 184700, status: "settled" },
      { orderNo: null, totalAvos: 3800, status: "draft" },
    ]);
    assert.equal(r.ordersTotal, 2);
    assert.equal(r.ordersTruncated, false);
  });

  it("🔴 未結帳狀態（draft／sent_to_kitchen／reopened）要收 —— 呢個係增補嘅重點", () => {
    for (const status of ["draft", "sent_to_kitchen", "reopened", "paid", "settled", "refunded", "partially_refunded"]) {
      const r = validateOfflineReportRpc({ ...base, orders: [{ orderNo: "001", totalAvos: 1, status }] , ordersTotal: 1}, expected);
      assert.equal(r.ok, true, status);
    }
  });

  it("🔴 欄位型別唔對 ⇒ 拒（唔可以令 Ledger 收到會整包丟棄嘅 payload）", () => {
    const bad = [
      { orderNo: 123, totalAvos: 1, status: "settled" },          // orderNo 要 string|null
      { orderNo: "x".repeat(65), totalAvos: 1, status: "settled" }, // 超 64 字
      { orderNo: "001", totalAvos: -1, status: "settled" },        // 負金額
      { orderNo: "001", totalAvos: 1.5, status: "settled" },       // 浮點
      { orderNo: "001", totalAvos: 1, status: "" },                // 空狀態
      { orderNo: "001", totalAvos: 1, status: "x".repeat(33) },    // 超 32 字
      { orderNo: "001", totalAvos: 1 },                            // 缺 status
    ];
    for (const row of bad) {
      const r = validateOfflineReportRpc({ ...base, orders: [row], ordersTotal: 1 }, expected);
      assert.equal(r.ok, false, JSON.stringify(row));
    }
    assert.equal(validateOfflineReportRpc({ ...base, orders: "no" }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...base, ordersTotal: -1 }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...base, ordersTotal: undefined }, expected).ok, false);
  });

  it("🔴 回多過 SQL 講嘅總數 ⇒ 拒（SQL where 漏咗嘅訊號）", () => {
    const r = validateOfflineReportRpc({ ...base, ordersTotal: 1 }, expected);
    assert.deepEqual(r, { ok: false, reason: "rpc-orders-exceed-total" });
  });

  it("截斷：ordersTotal > orders.length ⇒ ordersTruncated = true（總數仍以 SQL 為準）", () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({
      orderNo: String(i),
      totalAvos: 100,
      status: "settled",
    }));
    const r = validateOfflineReportRpc({ ...base, orders: rows, ordersTotal: 4321 }, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.orders.length, 3000);
    assert.equal(r.ordersTotal, 4321);
    assert.equal(r.ordersTruncated, true);
  });

  it("🔴 四個 key 只出現一部分 ⇒ 當 SQL 有 bug，拒（唔可以靜靜降級）", () => {
    const { ordersTotal: _ot, ...noTotal } = base;
    void _ot;
    assert.deepEqual(validateOfflineReportRpc(noTotal, expected), { ok: false, reason: "rpc-partial-detail-keys" });
  });
});

describe("RPC 回值：菜品排名 dishes（0059 增補）", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  const base = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    orderCount: 1,
    revenueAvos: 84000,
    refundedAvos: 0,
    discountAvos: 0,
    covers: 1,
    byPayment: [{ method: "現金", amountAvos: 84000 }],
    ordersTotal: 0,
    orders: [],
    dishesTotal: 1,
    dishes: [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }],
  };

  it("正常一列照抄出", () => {
    const r = validateOfflineReportRpc(base, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.dishes, [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }]);
    assert.equal(r.dishesTotal, 1);
    assert.equal(r.dishesTruncated, false);
  });

  it("🔴 空名要拒（Ledger 顯示唔到，而且通常代表 SQL 漏了 coalesce）", () => {
    assert.equal(validateOfflineReportRpc({ ...base, dishes: [{ name: "", qty: 1, revenueAvos: 1 }] }, expected).ok, false);
    assert.equal(
      validateOfflineReportRpc({ ...base, dishes: [{ name: "x".repeat(65), qty: 1, revenueAvos: 1 }] }, expected).ok,
      false,
    );
    assert.equal(
      validateOfflineReportRpc({ ...base, dishes: [{ name: 1, qty: 1, revenueAvos: 1 }] }, expected).ok,
      false,
    );
  });

  it("🔴 qty／金額唔係非負安全整數 ⇒ 拒", () => {
    assert.equal(validateOfflineReportRpc({ ...base, dishes: [{ name: "a", qty: -1, revenueAvos: 1 }] }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...base, dishes: [{ name: "a", qty: 1.5, revenueAvos: 1 }] }, expected).ok, false);
    assert.equal(
      validateOfflineReportRpc({ ...base, dishes: [{ name: "a", qty: 1, revenueAvos: "1" }] }, expected).ok,
      false,
    );
  });

  it("截斷：dishesTotal > dishes.length ⇒ dishesTruncated = true", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ name: `菜${i}`, qty: 1, revenueAvos: 100 }));
    const r = validateOfflineReportRpc({ ...base, dishes: rows, dishesTotal: 412 }, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.dishes.length, 300);
    assert.equal(r.dishesTotal, 412);
    assert.equal(r.dishesTruncated, true);
  });

  it("🔴 回多過 dishesTotal ⇒ 拒", () => {
    const r = validateOfflineReportRpc(
      { ...base, dishes: [{ name: "a", qty: 1, revenueAvos: 1 }], dishesTotal: 0 },
      expected,
    );
    assert.deepEqual(r, { ok: false, reason: "rpc-dishes-exceed-total" });
  });
});

describe("部署次序安全閥：0059 未跑（四個 key 全缺）要優雅降級", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  const legacy = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    orderCount: 12,
    revenueAvos: 123450,
    refundedAvos: 0,
    discountAvos: 500,
    covers: 30,
    byPayment: [{ method: "Mpay", amountAvos: 123450 }],
  };

  it("🔴 舊版 0058 回值 ⇒ ok（唔可以 503，否則 Ledger 現有嗰張已對數嘅卡會死）", () => {
    const r = validateOfflineReportRpc(legacy, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hasDetail, false);
    // 空陣列只係內部預設，**唔可以**當成「今日冇單」回出去（buildOfflineReportResponse 會 omit）
    assert.deepEqual(r.orders, []);
    assert.deepEqual(r.dishes, []);
    assert.equal(r.ordersTruncated, false);
    assert.equal(r.dishesTruncated, false);
    // KPI 照樣齊全 —— 呢個就係「降級但唔假零」
    assert.equal(r.kpi.orderCount, 12);
  });
});

describe("回應形狀（契約 §回應 200）", () => {
  const common = {
    storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    range: { from: "2026-09-01", to: "2026-09-24", clamped: true },
    kpi: { orderCount: 1, revenueAvos: 2, refundedAvos: 0, discountAvos: 0, covers: 1 },
    byPayment: [{ method: "現金", amountAvos: 2 }],
    generatedAt: "2026-09-25T01:00:00.000Z",
  };

  it("hasDetail=false（0059 未跑）⇒ 連 key 都唔出 —— 唔可以回空陣列（空陣列 = 假零）", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      hasDetail: false,
      orders: [],
      ordersTotal: 0,
      dishes: [],
      dishesTotal: 0,
    });

    assert.equal(payload.v, 1);
    assert.deepEqual(Object.keys(payload).sort(), [
      "breakdown",
      "flags",
      "from",
      "generatedAt",
      "kpi",
      "storeId",
      "to",
      "v",
    ]);
    assert.deepEqual(payload.breakdown, { byPayment: [{ method: "現金", amountAvos: 2 }] });
    assert.deepEqual(payload.flags, { refundsNetted: false, clamped: true });
    // generatedAt 一定要係 RFC 3339 含時區（純日期或無時區會被 Ledger 拒收）
    assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
    // 唔可以有 `undefined` 漏出去
    assert.equal(JSON.stringify(payload).includes("undefined"), false);
  });

  it("hasDetail=true ⇒ 出 orders／dishes／兩個總數，flags 亦帶兩個 truncated", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      hasDetail: true,
      orders: [{ orderNo: "001", totalAvos: 184700, status: "settled" }],
      ordersTotal: 1,
      dishes: [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }],
      dishesTotal: 1,
    });

    assert.equal(payload.v, 1, "🔴 加欄位唔可以升 v（Ledger 可能 assert v===1）");
    assert.deepEqual(Object.keys(payload).sort(), [
      "breakdown",
      "dishes",
      "dishesTotal",
      "flags",
      "from",
      "generatedAt",
      "kpi",
      "orders",
      "ordersTotal",
      "storeId",
      "to",
      "v",
    ]);
    assert.deepEqual(payload.orders, [{ orderNo: "001", totalAvos: 184700, status: "settled" }]);
    assert.deepEqual(payload.dishes, [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }]);
    assert.deepEqual(payload.flags, {
      refundsNetted: false,
      clamped: true,
      ordersTruncated: false,
      dishesTruncated: false,
    });
    assert.equal(JSON.stringify(payload).includes("undefined"), false);
  });

  it("🔴 flags 嘅 truncated 係由「SQL 總數 vs 實際筆數」推導，route 唔自己截", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      hasDetail: true,
      orders: [{ orderNo: "001", totalAvos: 1, status: "settled" }],
      ordersTotal: 4321,
      dishes: [{ name: "a", qty: 1, revenueAvos: 1 }],
      dishesTotal: 412,
    });
    assert.equal(payload.flags.ordersTruncated, true);
    assert.equal(payload.flags.dishesTruncated, true);
    // 內容唔准被 route 改動（無聲截斷 = 假資料）
    assert.equal(payload.orders?.length, 1);
    assert.equal(payload.dishes?.length, 1);
  });
});

describe("能力探測標頭（`v` 唔可以升 ⇒ 用 caps 代替）", () => {
  it("hasDetail=true ⇒ 宣告四項；false ⇒ 只宣告 KPI 兩項", () => {
    assert.equal(offlineReportCapsHeader(true), "kpi,byPayment,orders,dishes");
    assert.equal(offlineReportCapsHeader(false), "kpi,byPayment");
  });

  it("🔴 渠道 token 一定要兩個能力位同時有先宣告（0066 方案 A：四個 token）", () => {
    // 四種組合：hasDetail × hasChannel
    assert.equal(
      offlineReportCapsHeader(true, true),
      "kpi,byPayment,orders,dishes,kpiByChannel,paymentBreakdown,ordersByChannel,dishesByChannel",
      "兩個能力位都有 ⇒ 全部宣告（線上單喺 ordersByChannel／菜品拆欄喺 dishesByChannel）",
    );
    assert.equal(
      offlineReportCapsHeader(true, false),
      "kpi,byPayment,orders,dishes",
      "冇明細單有渠道 ⇒ 唔宣告渠道（冇嘢可標示來源）",
    );
    assert.equal(
      offlineReportCapsHeader(false, true),
      "kpi,byPayment",
      "🔴 冇明細就算有渠道都唔宣告（0059 未跑嘅中間狀態）",
    );
    assert.equal(offlineReportCapsHeader(false, false), "kpi,byPayment");
    // 舊式單參數呼叫（0060 時代）唔會宣告渠道 —— 向後兼容
    assert.equal(offlineReportCapsHeader(true), "kpi,byPayment,orders,dishes");
  });

  it("🔴 caps 唔可以宣告舊欄（`orders`／`dishes` 語意冇變，唔會有新 token 指向佢哋）", () => {
    const header = offlineReportCapsHeader(true, true);
    // 線上能力只可以經新 key 讀；舊 key 嘅定義一個字都冇改
    assert.equal(header.includes("onlineIncluded"), false);
    assert.equal(header.split(",").filter((t) => t === "orders").length, 1, "orders 只可以出現一次");
    assert.equal(header.split(",").filter((t) => t === "dishes").length, 1, "dishes 只可以出現一次");
  });

  it("上限常數同 0059 SQL 一致（改咗一邊就要改另一邊）", () => {
    assert.equal(OFFLINE_REPORT_MAX_ORDERS, 3000);
    assert.equal(OFFLINE_REPORT_MAX_DISHES, 300);
    // 🔴 0066 新增：label 長度上限同 SQL 嘅 k_max_label_len 對齊（兩個都係 32）
    assert.equal(OFFLINE_REPORT_MAX_LABEL_LEN, 32);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2026-10-07 增補（0066）：渠道維度
// ═══════════════════════════════════════════════════════════════════════════

describe("0066：渠道白名單（唔可以原樣透傳 SQL 嘅字串）", () => {
  it("三個值逐個對，同 SQL 嘅 CASE 一一對應", () => {
    assert.deepEqual([...OFFLINE_REPORT_CHANNELS], ["offline", "online_projection", "online_platform"]);
  });

  it("合法值（含前後空白）⇒ 正規化", () => {
    for (const ch of OFFLINE_REPORT_CHANNELS) {
      assert.equal(normalizeOfflineReportChannel(ch), ch);
      assert.equal(normalizeOfflineReportChannel(`  ${ch}  `), ch, "應該 trim");
    }
  });

  it("🔴 非法值一律 null（寧願 503 都唔送錯值俾 Ledger）", () => {
    for (const bad of [
      "",
      "Offline", // 大小寫敏感（SQL 出嘅一定係小寫）
      "ONLINE",
      "online", // ← 呢個係 kpiByChannel 嘅 key，唔係 channel 值域！
      "platform",
      "aomi",
      "in_store",
      null,
      undefined,
      0,
      1,
      true,
      {},
      [],
      ["offline"],
    ]) {
      assert.equal(
        normalizeOfflineReportChannel(bad),
        null,
        `💥 ${JSON.stringify(bad)} 唔應該被當成合法渠道值`,
      );
    }
    // ⚠️ 純空白（trim 之後變空字串）⇒ null，唔可以變成合法值
    assert.equal(normalizeOfflineReportChannel("   "), null);
  });

  it("🔴 唔可以將未知值默默降級成 `offline`（會令 Ledger 顯示錯來源）", () => {
    assert.notEqual(normalizeOfflineReportChannel("offlin"), "offline");
    assert.notEqual(normalizeOfflineReportChannel("offline;"), "offline");
  });
});

describe("0066：kpiByChannel（精確拆分；v1 五欄照舊唔郁）", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  const kpiBase = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    // 🔴 v1 口徑（含平台單）—— 呢五個數一個都唔准郁
    orderCount: 12,
    revenueAvos: 123450,
    refundedAvos: 0,
    discountAvos: 500,
    covers: 30,
    byPayment: [{ method: "Mpay", amountAvos: 123450 }],
  };
  const detailBase = {
    ordersTotal: 0,
    orders: [],
    // 🔴 舊 dishes 用 0060 口徑嘅實測基數（42／84000）—— 唔係空，之後會逐欄驗
    dishesTotal: 1,
    dishes: [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }],
  };
  /** 實測 90 日基數（`tools/_probe-offlinereport-v1base-20261007.cjs`）。 */
  const kpiByChannel = {
    offline: { orderCount: 8, revenueAvos: 80000, refundedAvos: 0, discountAvos: 500, covers: 20 },
    online: { orderCount: 3, revenueAvos: 33450, refundedAvos: 0, discountAvos: 0, covers: 8 },
    onlinePlatform: { orderCount: 1, revenueAvos: 10000, refundedAvos: 0, discountAvos: 0, covers: 2 },
  };
  const paymentBreakdown = [
    { method: "Mpay", label: "Mpay", channel: "offline", orderCount: 6, receivableAvos: 80500, paidAvos: 80000, diffAvos: 500 },
    { method: "外賣平台", label: "外賣平台", channel: "online_platform", orderCount: 1, receivableAvos: 10270, paidAvos: 10000, diffAvos: 270 },
  ];
  /**
   * 🔴 方案 A 新增嘅四個 key（線上數據**只**喺呢度出現）。
   * 舊 `orders`／`dishes` 刻意用**舊口徑**（細過新 key）：舊 dishes 42 份／84000，
   * 新 dishesByChannel 54 份／108000 —— 呢個差異本身就係「舊欄一個數字都冇改」嘅證據。
   */
  const channelExtras = {
    ordersByChannelTotal: 4,
    ordersByChannel: [
      { orderNo: "001", totalAvos: 184700, status: "settled", channel: "offline" },
      { orderNo: "002", totalAvos: 3800, status: "draft", channel: "online_projection" },
      { orderNo: null, totalAvos: 69900, status: "settled", channel: "online_platform" },
      { orderNo: "004", totalAvos: 1200, status: "settled", channel: "online_projection" },
    ],
    dishesByChannelTotal: 1,
    dishesByChannel: [
      {
        name: "凍檸茶",
        qty: 54,
        revenueAvos: 108000,
        offlineQty: 42,
        offlineRevenueAvos: 84000,
        onlineQty: 12,
        onlineRevenueAvos: 24000,
      },
    ],
  };
  const full = { ...kpiBase, ...detailBase, kpiByChannel, paymentBreakdown, ...channelExtras };

  it("正常回值通過，三組都抄入 `kpi`（唔係新顶层 key）", () => {
    const r = validateOfflineReportRpc(full, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hasChannel, true);
    // 🔴 v1 五欄原封不動
    assert.equal(r.kpi.orderCount, 12);
    assert.equal(r.kpi.revenueAvos, 123450);
    // 三組拆分掛喺 kpi 入面（唔係改名、唔係搬位）
    assert.equal(r.kpi.offline?.orderCount, 8);
    assert.equal(r.kpi.online?.orderCount, 3);
    assert.equal(r.kpi.onlinePlatform?.orderCount, 1);
    assert.deepEqual(r.paymentBreakdown, paymentBreakdown);
  });

  it("🔴 舊欄一個數字都唔可以因為新 key 而變（方案 A 嘅核心）", () => {
    // 同一份 v1 資料，加唔加 0066 個 key，舊欄結果必須**完全一致**
    const withCh = validateOfflineReportRpc(full, expected);
    const withoutCh = validateOfflineReportRpc({ ...kpiBase, ...detailBase }, expected);
    assert.equal(withCh.ok && withoutCh.ok, true);
    if (!withCh.ok || !withoutCh.ok) return;
    for (const f of ["orderCount", "revenueAvos", "refundedAvos", "discountAvos", "covers"] as const) {
      assert.equal(
        withCh.kpi[f],
        withoutCh.kpi[f],
        `🔴 v1 欄位 ${f} 因為 0066 變咗 —— Ledger 嗰張已對數嘅卡會跳數`,
      );
    }
    // byPayment 一樣唔可以變
    assert.deepEqual(withCh.byPayment, withoutCh.byPayment);
    // 🔴🔴 舊 `ordersTotal`／`dishesTotal` 一樣唔可以變（0066 事故就係呢兩個跳咗）
    assert.equal(withCh.ordersTotal, withoutCh.ordersTotal);
    assert.equal(withCh.dishesTotal, withoutCh.dishesTotal);
    assert.deepEqual(withCh.orders, withoutCh.orders);
    assert.deepEqual(withCh.dishes, withoutCh.dishes);
  });

  it("🔴 舊 dishes[] 淨係三欄（拆欄只喺新 key）", () => {
    const r = validateOfflineReportRpc(full, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // 舊 key：冇拆欄
    assert.deepEqual(Object.keys(r.dishes[0] ?? {}).sort(), ["name", "qty", "revenueAvos"]);
    // 新 key：七欄齊
    assert.deepEqual(Object.keys(r.dishesByChannel[0] ?? {}).sort(), [
      "name",
      "offlineQty",
      "offlineRevenueAvos",
      "onlineQty",
      "onlineRevenueAvos",
      "qty",
      "revenueAvos",
    ]);
    // 線上投影單只喺新 key 出現
    const legacyChannels = new Set(r.orders.map((o) => o.channel));
    assert.equal(legacyChannels.has("online_projection"), false, "🔴 舊 orders[] 唔應該有線上投影單（0060 口徑）");
    const newChannels = new Set(r.ordersByChannel.map((o) => o.channel));
    assert.equal(newChannels.has("online_projection"), true, "線上投影單應該喺 ordersByChannel[]");
  });

  it("🔴 六個 key 要麼全有、要麼全無（部分缺 = SQL 有 bug ⇒ 拒）", () => {
    for (const k of [
      "kpiByChannel",
      "paymentBreakdown",
      "ordersByChannel",
      "ordersByChannelTotal",
      "dishesByChannel",
      "dishesByChannelTotal",
    ] as const) {
      const partial = { ...full } as Record<string, unknown>;
      delete partial[k];
      assert.equal(
        validateOfflineReportRpc(partial, expected).ok,
        false,
        `🔴 缺 ${k}（其餘五個齊）應該拒 —— 半吊子狀態會令 Ledger 以為全部都齊`,
      );
    }
    // 六個全缺 ⇒ 優雅降級（0066 未跑）
    const legacy = { ...kpiBase, ...detailBase };
    const r = validateOfflineReportRpc(legacy, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.hasChannel, false);
  });

  it("🔴 kpiByChannel 三組任何一組缺欄／型別錯 ⇒ 拒（唔可以當 0）", () => {
    for (const ch of ["offline", "online", "onlinePlatform"]) {
      // 缺一組
      const missing = { ...kpiByChannel } as Record<string, unknown>;
      delete missing[ch];
      assert.equal(
        validateOfflineReportRpc({ ...full, kpiByChannel: missing }, expected).ok,
        false,
        `kpiByChannel 缺 ${ch} 應該拒`,
      );
      // 組內缺一欄
      const { revenueAvos: _gone, ...partial } = kpiByChannel[ch as keyof typeof kpiByChannel];
      void _gone;
      assert.equal(
        validateOfflineReportRpc({ ...full, kpiByChannel: { ...kpiByChannel, [ch]: partial } }, expected).ok,
        false,
        `kpiByChannel.${ch} 缺 revenueAvos 應該拒`,
      );
      // 負數（金額唔會係負）
      const neg = { ...kpiByChannel[ch as keyof typeof kpiByChannel], revenueAvos: -1 };
      assert.equal(validateOfflineReportRpc({ ...full, kpiByChannel: { ...kpiByChannel, [ch]: neg } }, expected).ok, false);
    }
    // 本身唔係 object
    assert.equal(validateOfflineReportRpc({ ...full, kpiByChannel: [] }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...full, kpiByChannel: null }, expected).ok, false);
  });

  it("🔴 `hasChannel` 依賴 `hasDetail`（冇明細就唔宣告渠道）", () => {
    // 0059 未跑（零四個 detail key）但 0066 六個 key 出現 ⇒ 當舊版，唔 503、唔宣告
    const r = validateOfflineReportRpc(
      { ...kpiBase, kpiByChannel, paymentBreakdown, ...channelExtras },
      expected,
    );
    assert.equal(r.ok, true, "0059 未跑唔應該因為 0066 個 key 就 503");
    if (!r.ok) return;
    assert.equal(r.hasDetail, false);
    assert.equal(r.hasChannel, false, "🔴 冇明細就唔應該有渠道能力");
    assert.equal(r.kpi.offline, undefined, "降級時唔應該抄入渠道拆分");
    assert.deepEqual(r.paymentBreakdown, []);
    // 🔴 降級時新 key 亦都唔應該有內容（唔會漏出去俾 Ledger 讀到半套）
    assert.deepEqual(r.ordersByChannel, []);
    assert.deepEqual(r.dishesByChannel, []);
    assert.equal(r.ordersByChannelTruncated, false);
    assert.equal(r.dishesByChannelTruncated, false);
  });
});

describe("0066：paymentBreakdown（支付方式分項；J 需求 3）", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  const base = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    orderCount: 12,
    revenueAvos: 123450,
    refundedAvos: 0,
    discountAvos: 500,
    covers: 30,
    byPayment: [{ method: "Mpay", amountAvos: 123450 }],
    ordersTotal: 0,
    orders: [],
    dishesTotal: 0,
    dishes: [],
    kpiByChannel: {
      offline: { orderCount: 8, revenueAvos: 80000, refundedAvos: 0, discountAvos: 500, covers: 20 },
      online: { orderCount: 3, revenueAvos: 33450, refundedAvos: 0, discountAvos: 0, covers: 8 },
      onlinePlatform: { orderCount: 1, revenueAvos: 10000, refundedAvos: 0, discountAvos: 0, covers: 2 },
    },
    // 🔴 方案 A：四個新 key 必須齊（降級閥係「六個要麼全有」）
    ordersByChannelTotal: 0,
    ordersByChannel: [],
    dishesByChannelTotal: 0,
    dishesByChannel: [],
  };
  const row = {
    method: "Mpay",
    label: "Mpay",
    channel: "offline",
    orderCount: 6,
    receivableAvos: 80500,
    paidAvos: 80000,
    diffAvos: 500,
  };
  const withPb = { ...base, paymentBreakdown: [row] };

  it("正常一列七個欄位全抄出", () => {
    const r = validateOfflineReportRpc(withPb, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.paymentBreakdown, [row]);
  });

  it("🔴🔴 `diffAvos` 可以為負（平台抽成）—— 夾非負就等於渲染假零", () => {
    // 實測：mfood 單應收 259 / 實收 232 → −27
    const negative = { ...row, channel: "online_platform", receivableAvos: 25900, paidAvos: 23200, diffAvos: -2700 };
    const r = validateOfflineReportRpc({ ...withPb, paymentBreakdown: [negative] }, expected);
    assert.equal(r.ok, true, "🔴 負 diffAvos 被當成唔合法 ⇒ 平台單令整包 503");
    if (!r.ok) return;
    assert.equal(r.paymentBreakdown[0]?.diffAvos, -2700);
  });

  it("🔴 `diffAvos` 仍然要係整數（小數／字串 ⇒ 拒）", () => {
    for (const bad of [1.5, -1.5, "500", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        validateOfflineReportRpc({ ...withPb, paymentBreakdown: [{ ...row, diffAvos: bad }] }, expected).ok,
        false,
        `diffAvos = ${String(bad)} 應該拒`,
      );
    }
  });

  it("🔴 應收／實收／單數依然要非負（只有 diff 可以負）", () => {
    for (const f of ["orderCount", "receivableAvos", "paidAvos"] as const) {
      assert.equal(
        validateOfflineReportRpc({ ...withPb, paymentBreakdown: [{ ...row, [f]: -1 }] }, expected).ok,
        false,
        `${f} = -1 應該拒（金額／單數唔會係負）`,
      );
    }
  });

  it("🔴 `method` 同 `label` 長度上限都係 32（Ledger 兩邊都食 32）", () => {
    assert.equal(validateOfflineReportRpc({ ...withPb, paymentBreakdown: [{ ...row, method: "" }] }, expected).ok, false);
    assert.equal(
      validateOfflineReportRpc({ ...withPb, paymentBreakdown: [{ ...row, method: "x".repeat(33) }] }, expected).ok,
      false,
    );
    assert.equal(validateOfflineReportRpc({ ...withPb, paymentBreakdown: [{ ...row, label: "" }] }, expected).ok, false);
    assert.equal(
      validateOfflineReportRpc({ ...withPb, paymentBreakdown: [{ ...row, label: "x".repeat(33) }] }, expected).ok,
      false,
    );
    // 剛好 32 收（界線要準）
    const ok32 = validateOfflineReportRpc({ ...withPb, paymentBreakdown: [{ ...row, label: "x".repeat(32) }] }, expected);
    assert.equal(ok32.ok, true);
  });

  it("🔴 `channel` 一定要過白名單（唔可以原樣透傳）", () => {
    for (const bad of ["online", "ONLINE", "platform", "cash", "", null, 1]) {
      assert.equal(
        validateOfflineReportRpc({ ...withPb, paymentBreakdown: [{ ...row, channel: bad }] }, expected).ok,
        false,
        `channel = ${JSON.stringify(bad)} 應該拒`,
      );
    }
  });

  it("🔴 唔係陣列／列唔係 object ⇒ 拒", () => {
    assert.equal(validateOfflineReportRpc({ ...base, paymentBreakdown: {} }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...base, paymentBreakdown: null }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...base, paymentBreakdown: [null] }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...base, paymentBreakdown: ["Mpay"] }, expected).ok, false);
  });

  it("空陣列係合法（該區間真係冇可計銷售單），唔可以當成壞", () => {
    const r = validateOfflineReportRpc({ ...base, paymentBreakdown: [] }, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.paymentBreakdown, []);
  });
});

describe("0066 方案 A：舊 orders[] 還原 0060 口徑（但保留 channel 標示）", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  const base = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    orderCount: 12,
    revenueAvos: 123450,
    refundedAvos: 0,
    discountAvos: 500,
    covers: 30,
    byPayment: [{ method: "Mpay", amountAvos: 123450 }],
    kpiByChannel: {
      offline: { orderCount: 8, revenueAvos: 80000, refundedAvos: 0, discountAvos: 500, covers: 20 },
      online: { orderCount: 3, revenueAvos: 33450, refundedAvos: 0, discountAvos: 0, covers: 8 },
      onlinePlatform: { orderCount: 1, revenueAvos: 10000, refundedAvos: 0, discountAvos: 0, covers: 2 },
    },
    paymentBreakdown: [],
    ordersByChannelTotal: 0,
    ordersByChannel: [],
    dishesByChannelTotal: 0,
    dishesByChannel: [],
  };

  it("🔴 舊 orders[] 逐列抄出，channel 標示照留（additive，唔改任何數字）", () => {
    // 🔴 舊 orders[] 唔會有 online_projection（0060 where 已還原），但**有** platform
    const orders = [
      { orderNo: "001", totalAvos: 184700, status: "settled", channel: "offline" },
      { orderNo: null, totalAvos: 69900, status: "settled", channel: "online_platform" },
    ];
    const r = validateOfflineReportRpc({ ...base, ordersTotal: 2, orders, dishesTotal: 0, dishes: [] }, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.orders.length, 2);
    assert.equal(r.orders[0]?.channel, "offline");
    // 平台單一直冇 online_order_id ⇒ 0060 口徑下佢一直包埋喺舊 orders[]（誠實標示）
    assert.equal(r.orders[1]?.channel, "online_platform");
  });

  it("🔴 舊版（0060，冇 channel 欄）唔會令整包降級或 503", () => {
    // 部署次序安全閥：Vercel push 即自動部署，route 可能比 0066 先上線
    const orders = [{ orderNo: "001", totalAvos: 184700, status: "settled" }];
    const r = validateOfflineReportRpc({ ...base, ordersTotal: 1, orders, dishesTotal: 0, dishes: [] }, expected);
    assert.equal(r.ok, true, "🔴 舊版 orders[] 冇 channel 就 503 ⇒ Ledger 死機");
    if (!r.ok) return;
    assert.equal(r.hasDetail, true);
    // 🔴 唔可以回填 "offline"：舊版根本冇平台單，回填會令語意將來唔一致
    assert.equal(r.orders[0]?.channel, undefined);
    assert.equal("channel" in (r.orders[0] as object), false, "唔應該出現 channel key（連 undefined 都唔好）");
  });

  it("🔴 channel 值非法 ⇒ 拒（寧願 503 都唔送錯來源）", () => {
    for (const bad of ["online", "ONLINE", "offlin", "platform", "", null, 0]) {
      const orders = [{ orderNo: "001", totalAvos: 184700, status: "settled", channel: bad }];
      assert.equal(
        validateOfflineReportRpc({ ...base, ordersTotal: 1, orders, dishesTotal: 0, dishes: [] }, expected).ok,
        false,
        `channel = ${JSON.stringify(bad)} 應該拒`,
      );
    }
  });
});

describe("0066 方案 A：ordersByChannel[] 線上單淨係喺呢度（J 需求 2）", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  const base = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    orderCount: 12,
    revenueAvos: 123450,
    refundedAvos: 0,
    discountAvos: 500,
    covers: 30,
    byPayment: [{ method: "Mpay", amountAvos: 123450 }],
    ordersTotal: 2,
    orders: [
      { orderNo: "001", totalAvos: 184700, status: "settled", channel: "offline" },
      { orderNo: null, totalAvos: 69900, status: "settled", channel: "online_platform" },
    ],
    dishesTotal: 0,
    dishes: [],
    kpiByChannel: {
      offline: { orderCount: 8, revenueAvos: 80000, refundedAvos: 0, discountAvos: 500, covers: 20 },
      online: { orderCount: 3, revenueAvos: 33450, refundedAvos: 0, discountAvos: 0, covers: 8 },
      onlinePlatform: { orderCount: 1, revenueAvos: 10000, refundedAvos: 0, discountAvos: 0, covers: 2 },
    },
    paymentBreakdown: [],
    dishesByChannelTotal: 0,
    dishesByChannel: [],
  };
  const onlineOrders = [
    { orderNo: "002", totalAvos: 3800, status: "draft", channel: "online_projection" },
    { orderNo: "004", totalAvos: 1200, status: "settled", channel: "online_projection" },
  ];
  const withCh = { ...base, ordersByChannelTotal: 4, ordersByChannel: [...base.orders, ...onlineOrders] };

  it("🔴 線上投影單只喺新 key 出現，舊 key 完全冇", () => {
    const r = validateOfflineReportRpc(withCh, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ordersByChannel.length, 4);
    assert.equal(r.ordersByChannelTotal, 4);
    // 舊 orders[] 一個數字都冇郁（2 筆，冇 online_projection）
    assert.equal(r.orders.length, 2);
    assert.equal(r.ordersTotal, 2);
    assert.equal(r.orders.some((o) => o.channel === "online_projection"), false);
  });

  it("🔴 `channel` 喺呢個 key 係必填（冇 = SQL 寫錯，成個 key 就係為咗標渠道而存在）", () => {
    for (const bad of [undefined, null, "online", "ONLINE", "", 0, {}]) {
      const row: Record<string, unknown> = { orderNo: "002", totalAvos: 3800, status: "draft" };
      if (bad !== undefined) row.channel = bad;
      assert.equal(
        validateOfflineReportRpc({ ...withCh, ordersByChannel: [row] }, expected).ok,
        false,
        `ordersByChannel.channel = ${JSON.stringify(bad)} 應該拒`,
      );
    }
  });

  it("🔴 其他欄位驗證同舊 key 一致（單號／金額／狀態）", () => {
    for (const row of [
      { orderNo: 1, totalAvos: 3800, status: "draft", channel: "online_projection" },
      { orderNo: "x".repeat(65), totalAvos: 3800, status: "draft", channel: "online_projection" },
      { orderNo: "002", totalAvos: -1, status: "draft", channel: "online_projection" },
      { orderNo: "002", totalAvos: 3800, status: "", channel: "online_projection" },
      { orderNo: "002", totalAvos: 3800, status: "x".repeat(33), channel: "online_projection" },
      "002",
      null,
    ]) {
      assert.equal(
        validateOfflineReportRpc({ ...withCh, ordersByChannel: [row] }, expected).ok,
        false,
        `ordersByChannel 列 ${JSON.stringify(row)} 應該拒`,
      );
    }
    // orderNo = null 合法（平台單冇本地單號）
    const okNull = validateOfflineReportRpc(
      { ...withCh, ordersByChannel: [{ orderNo: null, totalAvos: 3800, status: "settled", channel: "online_platform" }] },
      expected,
    );
    assert.equal(okNull.ok, true);
  });

  it("🔴 唔係陣列 ⇒ 拒；回多過 total ⇒ 拒", () => {
    assert.equal(validateOfflineReportRpc({ ...withCh, ordersByChannel: {} }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...withCh, ordersByChannel: null }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...withCh, ordersByChannelTotal: -1 }, expected).ok, false);
    const r = validateOfflineReportRpc({ ...withCh, ordersByChannelTotal: 1 }, expected);
    assert.deepEqual(r, { ok: false, reason: "rpc-ordersch-exceed-total" });
  });

  it("🔴 截斷旗標由 SQL 總數推導（唔准 route 自己截）", () => {
    const r = validateOfflineReportRpc({ ...withCh, ordersByChannelTotal: 4000 }, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ordersByChannelTruncated, true);
    assert.equal(r.ordersByChannel.length, 4, "內容唔可以被驗證層改動");
    // 舊 key 嘅 truncated 旗標唔應該被新 key 牽動
    assert.equal(r.ordersTruncated, false);
  });
});

describe("0066 方案 A：舊 dishes[] 只准三欄（J 需求 1 · 還原 0060）", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  const base = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    orderCount: 12,
    revenueAvos: 123450,
    refundedAvos: 0,
    discountAvos: 500,
    covers: 30,
    byPayment: [{ method: "Mpay", amountAvos: 123450 }],
    ordersTotal: 0,
    orders: [],
    kpiByChannel: {
      offline: { orderCount: 8, revenueAvos: 80000, refundedAvos: 0, discountAvos: 500, covers: 20 },
      online: { orderCount: 3, revenueAvos: 33450, refundedAvos: 0, discountAvos: 0, covers: 8 },
      onlinePlatform: { orderCount: 1, revenueAvos: 10000, refundedAvos: 0, discountAvos: 0, covers: 2 },
    },
    paymentBreakdown: [],
    ordersByChannelTotal: 0,
    ordersByChannel: [],
    dishesByChannelTotal: 0,
    dishesByChannel: [],
  };
  /** 0060 口徑：三欄，金額 84000（實測 90 日基數）。 */
  const legacyDish = { name: "凍檸茶", qty: 42, revenueAvos: 84000 };
  const withDishes = { ...base, dishesTotal: 1, dishes: [legacyDish] };

  it("🔴 三欄照抄，冇任何拆欄 key 漏出去", () => {
    const r = validateOfflineReportRpc(withDishes, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.dishes, [legacyDish]);
    assert.deepEqual(Object.keys(r.dishes[0] ?? {}).sort(), ["name", "qty", "revenueAvos"]);
  });

  it("🔴🔴🔴 舊 dishes[] 出現拆欄 ⇒ 503（`rpc-dish-split-on-legacy`）", () => {
    // 呢個就係 2026-10-07 事故嘅**服務器端防線**：
    // 0066 第一版加咗拆欄而 `qty` 同時變成全渠道總數（42→54）⇒ 舊 Ledger 照 render 一個被改咗嘅舊數字。
    // 而家驗證層見到拆欄就拒收整包 —— 寧願 503 顯示「暫時無法取得」，都好過靜靜畀錯數。
    for (const k of ["offlineQty", "offlineRevenueAvos", "onlineQty", "onlineRevenueAvos"] as const) {
      const polluted = { ...legacyDish, qty: 54, revenueAvos: 108000, [k]: 12 };
      const r = validateOfflineReportRpc({ ...withDishes, dishes: [polluted] }, expected);
      assert.deepEqual(
        r,
        { ok: false, reason: "rpc-dish-split-on-legacy" },
        `🔴 舊 dishes[] 出現 ${k} 一定要 503 —— 0066 第一版就係咁炸咗 Ledger 張卡`,
      );
    }
  });

  it("🔴 舊 dishes[] 型別驗證維持不變（空名／負數／小數照拒）", () => {
    for (const row of [
      { name: "", qty: 1, revenueAvos: 1 },
      { name: "x".repeat(65), qty: 1, revenueAvos: 1 },
      { name: 1, qty: 1, revenueAvos: 1 },
      { name: "a", qty: -1, revenueAvos: 1 },
      { name: "a", qty: 1.5, revenueAvos: 1 },
      { name: "a", qty: 1, revenueAvos: "1" },
      "凍檸茶",
      null,
    ]) {
      assert.equal(
        validateOfflineReportRpc({ ...withDishes, dishes: [row] }, expected).ok,
        false,
        `舊 dishes 列 ${JSON.stringify(row)} 應該拒`,
      );
    }
  });

  it("🔴 舊 dishesTotal 唔可以被新 key 牽動（截斷旗標各自獨立）", () => {
    const r = validateOfflineReportRpc({ ...withDishes, dishesByChannelTotal: 4000 }, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.dishesTruncated, false);
    assert.equal(r.dishesByChannelTruncated, true, "新 key 截斷唔應該影響舊 key 嘅旗標");
  });
});

describe("0066 方案 A：dishesByChannel[] 七欄拆欄（J 需求 1 · 線上數據新 key）", () => {
  const expected = { from: "2026-09-01", to: "2026-09-24", clamped: false };
  const base = {
    found: true,
    from: "2026-09-01",
    to: "2026-09-24",
    clamped: false,
    orderCount: 12,
    revenueAvos: 123450,
    refundedAvos: 0,
    discountAvos: 500,
    covers: 30,
    byPayment: [{ method: "Mpay", amountAvos: 123450 }],
    ordersTotal: 1,
    orders: [{ orderNo: "001", totalAvos: 184700, status: "settled" }],
    dishesTotal: 1,
    // 🔴 舊 dishes 係 0060 口徑（42／84000），新 dishesByChannel 係全渠道（54／108000）
    dishes: [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }],
    kpiByChannel: {
      offline: { orderCount: 8, revenueAvos: 80000, refundedAvos: 0, discountAvos: 500, covers: 20 },
      online: { orderCount: 3, revenueAvos: 33450, refundedAvos: 0, discountAvos: 0, covers: 8 },
      onlinePlatform: { orderCount: 1, revenueAvos: 10000, refundedAvos: 0, discountAvos: 0, covers: 2 },
    },
    paymentBreakdown: [],
    ordersByChannelTotal: 0,
    ordersByChannel: [],
  };
  const dishCh = {
    name: "凍檸茶",
    qty: 54,
    revenueAvos: 108000,
    offlineQty: 42,
    offlineRevenueAvos: 84000,
    onlineQty: 12,
    onlineRevenueAvos: 24000,
  };
  const withCh = { ...base, dishesByChannelTotal: 1, dishesByChannel: [dishCh] };

  it("🔴 七個欄位全抄出", () => {
    const r = validateOfflineReportRpc(withCh, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.dishesByChannel, [dishCh]);
    // 🔴 舊 dishes 完全唔受影響（42／84000，唔會變成 54／108000）
    assert.deepEqual(r.dishes, [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }]);
  });

  it("🔴🔴 拆欄加埋必須等於總數（唔等 = SQL merge 壞咗）", () => {
    const r = validateOfflineReportRpc({ ...withCh, dishesByChannel: [{ ...dishCh, onlineQty: 11 }] }, expected);
    assert.deepEqual(r, { ok: false, reason: "rpc-dishch-split-qty-mismatch" });
  });

  it("🔴🔴 金額拆欄一樣要守恆（淨守數量會漏咗金額欄 merge 壞咗）", () => {
    // 數量仍然守恆（offlineQty + onlineQty === qty），只有金額唔守恆
    const r = validateOfflineReportRpc(
      { ...withCh, dishesByChannel: [{ ...dishCh, onlineRevenueAvos: 24001 }] },
      expected,
    );
    assert.deepEqual(r, { ok: false, reason: "rpc-dishch-split-rev-mismatch" });
    // 兩邊都大過總數（溢價）同兩邊都細過總數（漏數）都要捉
    for (const bad of [108001, 107999]) {
      const r2 = validateOfflineReportRpc(
        { ...withCh, dishesByChannel: [{ ...dishCh, onlineRevenueAvos: bad - 84000 }] },
        expected,
      );
      assert.deepEqual(r2, { ok: false, reason: "rpc-dishch-split-rev-mismatch" }, `在線金額 ${bad - 84000} 應該拒`);
    }
  });

  it("🔴🔴 金額守恆唔可以錯寫成 offline* 對齊舊 dishes[]（舊 dishes[] 包埋平台單）", () => {
    // 生產實測：舊 dishes[] 嘅條件係 online_order_id is null，包埋 online_platform；
    // offline* 只涵蓋 channel = 'offline'。所以「offline* === 舊同名行」係**假命題**，
    // 驗證層一旦咁守就會喺正常生產資料上誤報 503。
    // 呢度鎖住正確關係：只守住 offline* 對**自己嗰行嘅** revenueAvos/qty 守恆。
    const r = validateOfflineReportRpc(withCh, expected);
    assert.equal(r.ok, true, "拆欄對自己總數守恆就必須收，唔應該因為舊 dishes 唔同欄而拒");
    if (!r.ok) return;
    const row = r.dishesByChannel[0]!;
    assert.equal(row.offlineRevenueAvos + row.onlineRevenueAvos, row.revenueAvos);
    assert.equal(row.offlineQty + row.onlineQty, row.qty);
  });

  it("🔴 四個拆欄要麼全有、要麼全無（部分有 = SQL 寫漏 = 假零）", () => {
    for (const f of ["offlineQty", "offlineRevenueAvos", "onlineQty", "onlineRevenueAvos"] as const) {
      const partial = { ...dishCh } as Record<string, unknown>;
      delete partial[f];
      const r = validateOfflineReportRpc({ ...withCh, dishesByChannel: [partial] }, expected);
      assert.deepEqual(r, { ok: false, reason: "rpc-partial-dishch-split" }, `dishesByChannel 缺 ${f} 應該拒`);
    }
  });

  it("🔴 拆欄都要非負整數（拆欄喺新 key 係必填）", () => {
    for (const f of ["offlineQty", "offlineRevenueAvos", "onlineQty", "onlineRevenueAvos"] as const) {
      for (const bad of [-1, 1.5, "3", null, Number.NaN]) {
        const r = validateOfflineReportRpc(
          { ...withCh, dishesByChannel: [{ ...dishCh, [f]: bad }] },
          expected,
        );
        assert.equal(r.ok, false, `dishesByChannel.${f} = ${String(bad)} 應該拒`);
      }
    }
  });

  it("🔴 總數欄（qty／revenueAvos）都要非負整數", () => {
    for (const f of ["qty", "revenueAvos"] as const) {
      assert.equal(validateOfflineReportRpc({ ...withCh, dishesByChannel: [{ ...dishCh, [f]: -1 }] }, expected).ok, false);
    }
  });

  it("🔴 線上拆欄為 0 係合法（該款菜淨係喺線下賣過）", () => {
    const offlineOnly = {
      ...dishCh,
      qty: dishCh.offlineQty,
      revenueAvos: dishCh.offlineRevenueAvos,
      onlineQty: 0,
      onlineRevenueAvos: 0,
    };
    const r = validateOfflineReportRpc({ ...withCh, dishesByChannel: [offlineOnly] }, expected);
    assert.equal(r.ok, true, "淨係線下賣過唔應該被拒");
  });

  it("🔴 唔係陣列／列唔係 object ⇒ 拒；回多過 total ⇒ 拒", () => {
    assert.equal(validateOfflineReportRpc({ ...withCh, dishesByChannel: {} }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...withCh, dishesByChannel: null }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...withCh, dishesByChannel: [null] }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...withCh, dishesByChannel: ["凍檸茶"] }, expected).ok, false);
    assert.equal(validateOfflineReportRpc({ ...withCh, dishesByChannelTotal: -1 }, expected).ok, false);
    const r = validateOfflineReportRpc({ ...withCh, dishesByChannelTotal: 0 }, expected);
    assert.deepEqual(r, { ok: false, reason: "rpc-dishch-exceed-total" });
  });

  it("🔴 空陣列係合法（該區間真係冇菜）", () => {
    const r = validateOfflineReportRpc({ ...withCh, dishesByChannelTotal: 0, dishesByChannel: [] }, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.dishesByChannel, []);
    assert.equal(r.dishesByChannelTruncated, false);
    // 🔴 舊 dishes 唔受影響（呢個 key 出唔出都一樣）
    assert.deepEqual(r.dishes, [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }]);
  });
});

describe("0066：回應形狀（🔴 舊欄位一個數字都唔可以變）", () => {
  const common = {
    storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    range: { from: "2026-09-01", to: "2026-09-24", clamped: true },
    kpi: { orderCount: 12, revenueAvos: 123450, refundedAvos: 0, discountAvos: 500, covers: 30 },
    byPayment: [{ method: "Mpay", amountAvos: 123450 }],
    generatedAt: "2026-10-07T14:00:00.000Z",
  };
  const kpiWithChannels = {
    ...common.kpi,
    offline: { orderCount: 8, revenueAvos: 80000, refundedAvos: 0, discountAvos: 500, covers: 20 },
    online: { orderCount: 3, revenueAvos: 33450, refundedAvos: 0, discountAvos: 0, covers: 8 },
    onlinePlatform: { orderCount: 1, revenueAvos: 10000, refundedAvos: 0, discountAvos: 0, covers: 2 },
  };
  const pb = [
    { method: "Mpay", label: "Mpay", channel: "offline" as const, orderCount: 6, receivableAvos: 80500, paidAvos: 80000, diffAvos: 500 },
  ];

  it("🔴 `kpi` 原樣輸出（三個新 key 掛喺 kpi 入面，唔會改名／搬位）", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      kpi: kpiWithChannels,
      hasDetail: true,
      hasChannel: true,
      orders: [],
      ordersTotal: 0,
      dishes: [],
      dishesTotal: 0,
      paymentBreakdown: pb,
    });
    assert.equal(payload.v, 1, "🔴 加咗三個 key 都唔可以升 v");
    // 五欄一個都唔可以郁
    assert.equal(payload.kpi.orderCount, 12);
    assert.equal(payload.kpi.revenueAvos, 123450);
    assert.equal(payload.kpi.refundedAvos, 0);
    assert.equal(payload.kpi.discountAvos, 500);
    assert.equal(payload.kpi.covers, 30);
    // 三個新 key 喺 kpi 入面
    assert.equal(payload.kpi.offline?.revenueAvos, 80000);
    assert.equal(payload.kpi.online?.revenueAvos, 33450);
    assert.equal(payload.kpi.onlinePlatform?.revenueAvos, 10000);
  });

  it("🔴 `byPayment` 永遠照 v1 輸出（唔會被 paymentBreakdown 取代）", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      kpi: kpiWithChannels,
      hasDetail: true,
      hasChannel: true,
      orders: [],
      ordersTotal: 0,
      dishes: [],
      dishesTotal: 0,
      paymentBreakdown: pb,
    });
    // 🔴 Ledger 嗰條 bar 靠 byPayment；換咗佢個「外賣平台」條會突然消失
    assert.deepEqual(payload.breakdown.byPayment, [{ method: "Mpay", amountAvos: 123450 }]);
    assert.equal(payload.breakdown.paymentBreakdown?.length, 1);
  });

  it("hasChannel=true ⇒ paymentBreakdown 出、兩個 flag 出", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      kpi: kpiWithChannels,
      hasDetail: true,
      hasChannel: true,
      orders: [],
      ordersTotal: 0,
      dishes: [],
      dishesTotal: 0,
      paymentBreakdown: pb,
    });
    assert.equal(payload.flags.channelBreakdownAvailable, true);
    assert.equal(payload.flags.ledgerOwnsOnlineRevenue, true);
    assert.equal(JSON.stringify(payload).includes("undefined"), false);
  });

  it("🔴 hasChannel=false ⇒ paymentBreakdown 連 key 都唔出（空陣列 = 假零）", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      hasDetail: true,
      hasChannel: false,
      orders: [],
      ordersTotal: 0,
      dishes: [],
      dishesTotal: 0,
      paymentBreakdown: pb, // 就算有傳都要唔出
      ordersByChannel: [],
      ordersByChannelTotal: 0,
      dishesByChannel: [],
      dishesByChannelTotal: 0,
    });
    assert.equal("paymentBreakdown" in payload.breakdown, false);
    assert.equal("channelBreakdownAvailable" in payload.flags, false, "唔可以聲稱一件冇發生嘅事");
    assert.equal("ledgerOwnsOnlineRevenue" in payload.flags, false);
    // 🔴 四個新 key 一個都唔可以漏（唔會出現「有總數冇明細」嘅半套）
    assert.equal("ordersByChannel" in payload, false);
    assert.equal("ordersByChannelTotal" in payload, false);
    assert.equal("dishesByChannel" in payload, false);
    assert.equal("dishesByChannelTotal" in payload, false);
  });

  it("🔴 `hasChannel` 喺 build 都要再綁一次 hasDetail（防禦雙重保險）", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      kpi: kpiWithChannels,
      hasDetail: false,
      hasChannel: true, // 矛盾組合
      orders: [],
      ordersTotal: 0,
      dishes: [],
      dishesTotal: 0,
      paymentBreakdown: pb,
      ordersByChannel: [{ orderNo: "002", totalAvos: 3800, status: "draft", channel: "online_projection" }],
      ordersByChannelTotal: 1,
      dishesByChannel: [],
      dishesByChannelTotal: 0,
    });
    assert.equal("paymentBreakdown" in payload.breakdown, false, "🔴 冇明細就唔應該宣告渠道");
    assert.equal("orders" in payload, false);
    assert.equal("ordersByChannel" in payload, false, "🔴 冇明細就唔應該有線上單（否則會同舊 orders[] 對唔上）");
    assert.equal("channelBreakdownAvailable" in payload.flags, false);
  });

  it("🔴 0059＋0066 都未跑 ⇒ 降級到最細形狀，舊 Ledger 完全無感", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      hasDetail: false,
      hasChannel: false,
      orders: [],
      ordersTotal: 0,
      dishes: [],
      dishesTotal: 0,
    });
    assert.deepEqual(Object.keys(payload).sort(), [
      "breakdown",
      "flags",
      "from",
      "generatedAt",
      "kpi",
      "storeId",
      "to",
      "v",
    ]);
    assert.deepEqual(payload.breakdown, { byPayment: common.byPayment });
    assert.deepEqual(payload.flags, { refundsNetted: false, clamped: true });
    assert.equal(payload.v, 1);
  });

  it("🔴🔴 舊 orders[]／dishes[] 原樣透傳（build 唔好加工，唔好偷偷搬去新 key）", () => {
    const orders = [
      { orderNo: "001", totalAvos: 184700, status: "settled", channel: "online_platform" as const },
      { orderNo: "002", totalAvos: 3800, status: "draft" },
    ];
    // 🔴 舊 dishes 只會有三欄：build 收到乜就出乜
    const dishes = [
      { name: "凍檸茶", qty: 42, revenueAvos: 84000 },
      { name: "豬扒飯", qty: 7, revenueAvos: 49000 },
    ];
    const payload = buildOfflineReportResponse({
      ...common,
      kpi: kpiWithChannels,
      hasDetail: true,
      hasChannel: true,
      orders,
      ordersTotal: 2,
      dishes,
      dishesTotal: 2,
      paymentBreakdown: pb,
    });
    assert.deepEqual(payload.orders, orders);
    assert.deepEqual(payload.dishes, dishes);
    // 舊 dishes 唔可以被 build 加欄位（TS 型別已經收窄到三欄，呢個係 runtime 雙保險）
    for (const row of payload.dishes ?? []) {
      assert.deepEqual(Object.keys(row).sort(), ["name", "qty", "revenueAvos"]);
    }
  });

  it("🔴 hasChannel=true ⇒ 四個新 key ＋ 兩個 truncated flag 出", () => {
    const ordersByChannel = [
      { orderNo: "001", totalAvos: 184700, status: "settled", channel: "offline" as const },
      { orderNo: "002", totalAvos: 3800, status: "draft", channel: "online_projection" as const },
    ];
    const dishesByChannel = [
      {
        name: "凍檸茶",
        qty: 54,
        revenueAvos: 108000,
        offlineQty: 42,
        offlineRevenueAvos: 84000,
        onlineQty: 12,
        onlineRevenueAvos: 24000,
      },
    ];
    const payload = buildOfflineReportResponse({
      ...common,
      kpi: kpiWithChannels,
      hasDetail: true,
      hasChannel: true,
      orders: [{ orderNo: "001", totalAvos: 184700, status: "settled" }],
      ordersTotal: 1,
      dishes: [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }],
      dishesTotal: 1,
      paymentBreakdown: pb,
      ordersByChannel,
      ordersByChannelTotal: 2,
      dishesByChannel,
      dishesByChannelTotal: 4000, // 故意唔等 ⇒ 應該 truncated
    });
    // 🔴 舊欄照 0060 數字出，線上數字淨係喺新 key
    assert.deepEqual(payload.orders, [{ orderNo: "001", totalAvos: 184700, status: "settled" }]);
    assert.equal(payload.ordersTotal, 1);
    assert.deepEqual(payload.dishes, [{ name: "凍檸茶", qty: 42, revenueAvos: 84000 }]);
    assert.equal(payload.dishesTotal, 1);
    // 新 key
    assert.deepEqual(payload.ordersByChannel, ordersByChannel);
    assert.equal(payload.ordersByChannelTotal, 2);
    assert.deepEqual(payload.dishesByChannel, dishesByChannel);
    assert.equal(payload.dishesByChannelTotal, 4000);
    // flags
    assert.equal(payload.flags.ordersByChannelTruncated, false);
    assert.equal(payload.flags.dishesByChannelTruncated, true);
    assert.equal(payload.flags.ordersTruncated, false, "舊 key 旗標唔可以被新 key 牽動");
    assert.equal(payload.flags.dishesTruncated, false);
    assert.equal(JSON.stringify(payload).includes("undefined"), false);
  });

  it("🔴 hasChannel=true 但冇傳新 key 內容 ⇒ 出空陣列而唔係 undefined（唔會有 undefined 漏出去）", () => {
    const payload = buildOfflineReportResponse({
      ...common,
      kpi: kpiWithChannels,
      hasDetail: true,
      hasChannel: true,
      orders: [],
      ordersTotal: 0,
      dishes: [],
      dishesTotal: 0,
      paymentBreakdown: pb,
    });
    assert.deepEqual(payload.ordersByChannel, []);
    assert.equal(payload.ordersByChannelTotal, 0);
    assert.deepEqual(payload.dishesByChannel, []);
    assert.equal(payload.dishesByChannelTotal, 0);
    assert.equal(JSON.stringify(payload).includes("undefined"), false);
  });
});
