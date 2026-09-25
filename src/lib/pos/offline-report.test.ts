import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OFFLINE_REPORT_MAX_DAYS,
  OFFLINE_REPORT_PATH,
  buildOfflineReportResponse,
  clampOfflineReportRange,
  computeOfflineReportSignature,
  dateKeySpanDays,
  isDateKey,
  isStoreId,
  normalizeStoreId,
  shiftDateKey,
  validateOfflineReportRpc,
  verifyOfflineReportSignature,
} from "./offline-report.ts";

/**
 * Ledger「線下營業摘要」契約純邏輯測試（2026-09-25）。
 *
 * 每個 describe 對應契約原文嘅一條要求：
 *   · 範圍截斷（§驗證順序 4 ＋ 驗收清單 `2026-01-01→2026-09-24 ⇒ from=2026-06-27`）
 *   · 驗簽（§驗證順序 1–2 ＋ 驗簽參考實作）
 *   · RPC 回值嚴格驗證（§欄位表「型別不符整包丟棄」）
 *   · 回應形狀（§回應 200）
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
  const good = {
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

  it("正常回值通過，並逐欄抄出", () => {
    const r = validateOfflineReportRpc(good, expected);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.found, true);
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

describe("回應形狀（契約 §回應 200）", () => {
  it("固定 v=1、flags.refundsNetted=false、breakdown 只有 byPayment（dineIn/quick 刻意缺席）", () => {
    const payload = buildOfflineReportResponse({
      storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      range: { from: "2026-09-01", to: "2026-09-24", clamped: true },
      kpi: { orderCount: 1, revenueAvos: 2, refundedAvos: 0, discountAvos: 0, covers: 1 },
      byPayment: [{ method: "現金", amountAvos: 2 }],
      generatedAt: "2026-09-25T01:00:00.000Z",
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
});
