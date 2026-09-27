import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OFFLINE_REPORT_MAX_DAYS,
  OFFLINE_REPORT_MAX_DISHES,
  OFFLINE_REPORT_MAX_ORDERS,
  OFFLINE_REPORT_PATH,
  buildOfflineReportResponse,
  clampOfflineReportRange,
  computeOfflineReportSignature,
  dateKeySpanDays,
  isDateKey,
  isStoreId,
  normalizeStoreId,
  offlineReportCapsHeader,
  shiftDateKey,
  validateOfflineReportRpc,
  verifyOfflineReportSignature,
} from "./offline-report.ts";

/**
 * Ledger「線下營業摘要」契約純邏輯測試（2026-09-25；2026-09-26 加 orders／dishes）。
 *
 * 每個 describe 對應契約原文嘅一條要求：
 *   · 範圍截斷（§驗證順序 4 ＋ 驗收清單 `2026-01-01→2026-09-24 ⇒ from=2026-06-27`）
 *   · 驗簽（§驗證順序 1–2 ＋ 驗簽參考實作）
 *   · RPC 回值嚴格驗證（§欄位表「型別不符整包丟棄」）
 *   · 回應形狀（§回應 200）
 *   · 2026-09-26 增補：`orders[]`／`dishes[]` ＋ **部署次序安全閥**（0059 未跑要優雅降級）
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

  it("上限常數同 0059 SQL 一致（改咗一邊就要改另一邊）", () => {
    assert.equal(OFFLINE_REPORT_MAX_ORDERS, 3000);
    assert.equal(OFFLINE_REPORT_MAX_DISHES, 300);
  });
});
