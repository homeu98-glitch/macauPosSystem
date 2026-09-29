import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  actualPayout,
  computeMfoodTotals,
  computeSettlementTotals,
  groupSettlementByOrder,
  normalizePeriodAmounts,
  normalizeTradeNo,
  periodPayout,
  settlementForOrder,
  toAmountOrNull,
  tradeNoCore,
  tradeNoQueryKeys,
  createTradeNoIdIndex,
  type TradeNoIdRow,
} from "./platform-settlement.ts";

/**
 * 外賣平台結算（實收）計算（2026-09-26 使用者需求）。
 *
 * 核心：營業額（客付 62.00）≠ 實收（平台過數 31.91），差額 ＝ 平台抽成。
 * 報表要計「差額率」反映平台費率。
 *
 * ⚠️ 呢支測試要守住兩個「靜默偏少」嘅坑：
 *   ① 同一 tradeNo 多筆 transaction ⇒ 必須加總（唔可以只取一筆）
 *   ② 部分對帳 ⇒ 差額率嘅分子分母要**同一批**（唔可以分子 6 張、分母 10 張）
 */

describe("toAmountOrNull：唔可以將「冇值」當 0", () => {
  it("null / undefined / 空字串 → null", () => {
    assert.equal(toAmountOrNull(null), null);
    assert.equal(toAmountOrNull(undefined), null);
    assert.equal(toAmountOrNull(""), null);
  });

  it("NaN / 非數字字串 → null（唔可以變 0）", () => {
    assert.equal(toAmountOrNull(NaN), null);
    assert.equal(toAmountOrNull("abc"), null);
    assert.equal(toAmountOrNull({}), null);
  });

  it("真嘅 0 → 保持 0（0 同「冇值」係兩件事）", () => {
    assert.equal(toAmountOrNull(0), 0);
    assert.equal(toAmountOrNull("0"), 0);
  });

  it("數字 / 數字字串 → 數值", () => {
    assert.equal(toAmountOrNull(35.11), 35.11);
    assert.equal(toAmountOrNull("35.11"), 35.11);
    assert.equal(toAmountOrNull(-3.2), -3.2);
  });
});

describe("normalizeTradeNo", () => {
  it("去前後空白", () => {
    assert.equal(normalizeTradeNo("  CRD123  "), "CRD123");
  });

  it("空 / 缺 → null", () => {
    assert.equal(normalizeTradeNo(""), null);
    assert.equal(normalizeTradeNo("   "), null);
    assert.equal(normalizeTradeNo(null), null);
    assert.equal(normalizeTradeNo(undefined), null);
  });
});

describe("groupSettlementByOrder：同一 tradeNo 多筆必須加總", () => {
  it("真實樣本單筆（mfood 使用者提供嘅 payload）", () => {
    const { byOrder, unmatchedCount } = groupSettlementByOrder([
      {
        externalOrderId: "CRD202609161003178839221",
        netAmount: 35.11,
        subsidyNet: 31.91,
        businessAmount: 62.0,
        serviceFee: 14.89,
      },
    ]);
    assert.equal(unmatchedCount, 0);
    const s = byOrder.get("CRD202609161003178839221");
    assert.ok(s);
    assert.equal(s.netAmount, 35.11);
    assert.equal(s.subsidyNet, 31.91);
    assert.equal(s.txnCount, 1);
  });

  it("🔴 同一 tradeNo 兩筆 → 加總（拆單／部分退款場景）", () => {
    const { byOrder } = groupSettlementByOrder([
      { externalOrderId: "CRD1", netAmount: 20.0, subsidyNet: 18.0 },
      { externalOrderId: "CRD1", netAmount: 15.11, subsidyNet: 13.91 },
    ]);
    const s = byOrder.get("CRD1");
    assert.ok(s);
    assert.equal(s.netAmount, 35.11);
    assert.equal(s.subsidyNet, 31.91);
    assert.equal(s.txnCount, 2, "要記住係兩筆，UI 可以顯示「N 筆」");
  });

  it("其中一筆只有 netAmount、另一筆只有 subsidyNet → 兩欄各自獨立加總", () => {
    const { byOrder } = groupSettlementByOrder([
      { externalOrderId: "CRD2", netAmount: 10.0 },
      { externalOrderId: "CRD2", subsidyNet: 8.0 },
    ]);
    const s = byOrder.get("CRD2");
    assert.ok(s);
    assert.equal(s.netAmount, 10.0);
    assert.equal(s.subsidyNet, 8.0);
    assert.equal(s.txnCount, 2);
  });

  it("🔴 冇 tradeNo 嘅 transaction 唔會消失 —— 計入 unmatchedCount", () => {
    const { byOrder, unmatchedCount } = groupSettlementByOrder([
      { externalOrderId: "CRD3", netAmount: 5 },
      { externalOrderId: null, netAmount: 99 },
      { externalOrderId: "  ", netAmount: 88 },
    ]);
    assert.equal(byOrder.size, 1);
    assert.equal(unmatchedCount, 2, "唔可以靜默掉數");
  });

  it("金額 0 會被當成有效值（唔等於「冇值」）", () => {
    const { byOrder } = groupSettlementByOrder([
      { externalOrderId: "CRD4", netAmount: 0, subsidyNet: 0 },
    ]);
    const s = byOrder.get("CRD4");
    assert.ok(s);
    assert.equal(s.netAmount, 0);
    assert.equal(s.txnCount, 1);
  });

  it("浮點加總要四捨五入到 2 位（唔可以出 0.30000000000000004）", () => {
    const { byOrder } = groupSettlementByOrder([
      { externalOrderId: "CRD5", netAmount: 0.1 },
      { externalOrderId: "CRD5", netAmount: 0.2 },
    ]);
    assert.equal(byOrder.get("CRD5")?.netAmount, 0.3);
  });

  it("空陣列 → 空 map", () => {
    const { byOrder, unmatchedCount } = groupSettlementByOrder([]);
    assert.equal(byOrder.size, 0);
    assert.equal(unmatchedCount, 0);
  });
});

describe("settlementForOrder：配對", () => {
  const { byOrder } = groupSettlementByOrder([
    { externalOrderId: "CRD202609161003178839221", netAmount: 35.11, subsidyNet: 31.91 },
  ]);

  it("對得上（正規化後）", () => {
    assert.equal(
      settlementForOrder(byOrder, "CRD202609161003178839221")?.netAmount,
      35.11,
    );
    assert.equal(
      settlementForOrder(byOrder, " CRD202609161003178839221 ")?.netAmount,
      35.11,
    );
  });

  it("對唔上 → null（＝待對帳，唔係 0）", () => {
    assert.equal(settlementForOrder(byOrder, "CRD-NOT-EXIST"), null);
    assert.equal(settlementForOrder(byOrder, null), null);
    assert.equal(settlementForOrder(byOrder, ""), null);
  });
});

describe("actualPayout：實際到帳口徑", () => {
  it("有補貼後金額 → 用佢（補貼後優先）", () => {
    assert.equal(actualPayout({ netAmount: 35.11, subsidyNet: 31.91 }), 31.91);
  });

  it("冇補貼後金額 → 落返 netAmount", () => {
    assert.equal(actualPayout({ netAmount: 35.11, subsidyNet: null }), 35.11);
    assert.equal(actualPayout({ netAmount: 35.11 }), 35.11);
  });

  it("兩者都冇 → null（唔可以當 0）", () => {
    assert.equal(actualPayout({ netAmount: null, subsidyNet: null }), null);
    assert.equal(actualPayout({}), null);
    assert.equal(actualPayout(null), null);
    assert.equal(actualPayout(undefined), null);
  });

  it("補貼後係 0 都算有值（唔可以跳去 fallback）", () => {
    assert.equal(actualPayout({ netAmount: 35.11, subsidyNet: 0 }), 0);
  });
});

describe("computeMfoodTotals：報表三格", () => {
  /** 由 map 造 settlementOf（按 order.externalOrderId 查）。 */
  const lookup =
    (m: Map<string, { netAmount: number; subsidyNet: number; txnCount: number }>) =>
    (order: { externalOrderId?: string | null; total?: number | null }) =>
      m.get(String(order.externalOrderId)) ?? null;

  /** 造訂單：`[tradeNo, 營業額]`。 */
  const ord = (externalOrderId: string, total: number) => ({ externalOrderId, total });

  it("🔴 使用者例子：應收 100、實收 50 → 差額率 50%", () => {
    const m = new Map([
      ["A", { netAmount: 50, subsidyNet: 50, txnCount: 1 }],
    ]);
    const orders = [ord("A", 100)];
    const r = computeMfoodTotals(orders, lookup(m));
    assert.equal(r.receivable, 100);
    assert.equal(r.received, 50);
    assert.equal(r.feeRate, 0.5);
    assert.equal(r.settledCount, 1);
    assert.equal(r.pendingCount, 0);
  });

  it("真實樣本：62.00 營業額 / 31.91 到帳 → 差額率 48.5%", () => {
    const m = new Map([
      ["CRD1", { netAmount: 35.11, subsidyNet: 31.91, txnCount: 1 }],
    ]);
    const r = computeMfoodTotals([ord("CRD1", 62)], lookup(m));
    assert.equal(r.receivable, 62);
    assert.equal(r.received, 31.91);
    // 1 - 31.91/62 = 0.48532258…
    assert.ok(r.feeRate !== null && Math.abs(r.feeRate - 0.4853) < 0.001);
  });

  it("🔴 部分對帳：分子分母要同一批（唔可以被未對帳拉低）", () => {
    // 4 張單、每張營業額 100；只有 2 張對到帳、各實收 50。
    const m = new Map([
      ["A", { netAmount: 50, subsidyNet: 50, txnCount: 1 }],
      ["B", { netAmount: 50, subsidyNet: 50, txnCount: 1 }],
    ]);
    const orders = [ord("A", 100), ord("B", 100), ord("C", 100), ord("D", 100)];
    const r = computeMfoodTotals(orders, lookup(m));
    assert.equal(r.receivable, 400, "應收係全部 4 張（POS 即時有）");
    assert.equal(r.received, 100, "實收只計已對帳嘅 2 張");
    assert.equal(r.settledCount, 2);
    assert.equal(r.pendingCount, 2);
    // 🔴 若錯誤地用 100 / 400 → 差額率 0.75（睇落好似平台抽 75%，其實係未對帳）
    assert.equal(r.feeRate, 0.5, "分子分母都只計已對帳嗰批 → 50%");
  });

  it("完全冇對帳 → received = null、feeRate = null（唔可以用 0）", () => {
    const m = new Map<string, { netAmount: number; subsidyNet: number; txnCount: number }>();
    const r = computeMfoodTotals([ord("A", 100), ord("B", 50)], lookup(m));
    assert.equal(r.receivable, 150);
    assert.equal(r.received, null, "唔可以係 0");
    assert.equal(r.feeRate, null, "冇實收就計唔到差額率");
    assert.equal(r.settledCount, 0);
    assert.equal(r.pendingCount, 2);
  });

  it("零訂單 → 全部中性值", () => {
    const r = computeMfoodTotals([], lookup(new Map()));
    assert.equal(r.receivable, 0);
    assert.equal(r.received, null);
    assert.equal(r.feeRate, null);
    assert.equal(r.settledCount, 0);
    assert.equal(r.pendingCount, 0);
  });

  it("應收 0 但有實收 → feeRate 唔可以變負 / NaN", () => {
    const m = new Map([
      ["A", { netAmount: 0, subsidyNet: 0, txnCount: 1 }],
    ]);
    const r = computeMfoodTotals([ord("A", 0)], lookup(m));
    assert.equal(r.receivable, 0);
    assert.equal(r.received, 0);
    assert.equal(r.feeRate, null, "除數 0 → null（唔可以 NaN）");
  });

  it("差額率夾喺 0~1（平台派多過營業額嘅異常情況唔會出負數）", () => {
    const m = new Map([
      ["A", { netAmount: 150, subsidyNet: 150, txnCount: 1 }],
    ]);
    const r = computeMfoodTotals([ord("A", 100)], lookup(m));
    assert.equal(r.feeRate, 0, "1 - 150/100 = -0.5 → 夾成 0");
  });

  it("補貼後優先：同一批要一致用 subsidyNet", () => {
    const m = new Map([
      ["A", { netAmount: 35.11, subsidyNet: 31.91, txnCount: 1 }],
    ]);
    const r = computeMfoodTotals([ord("A", 62)], lookup(m));
    assert.equal(r.received, 31.91, "用補貼後（實際到帳），唔係 35.11");
  });

  it("多張單加總（含補貼差異）", () => {
    const m = new Map([
      ["A", { netAmount: 35.11, subsidyNet: 31.91, txnCount: 1 }],
      ["B", { netAmount: 36.48, subsidyNet: 36.48, txnCount: 1 }],
    ]);
    const orders = [ord("A", 62), ord("B", 48)];
    const r = computeMfoodTotals(orders, lookup(m));
    assert.equal(r.receivable, 110);
    assert.equal(r.received, 68.39);
    assert.equal(r.settledCount, 2);
    assert.equal(r.pendingCount, 0);
  });
});

// ============================================================================
// 帳期級結算（2026-09-28）—— 逐單配對唔上時嘅**保底**來源
// ============================================================================

describe("normalizePeriodAmounts：帳期金額正規化", () => {
  it("冇 period → null（唯一鍵一部分，冇咗會互相覆蓋）", () => {
    assert.equal(normalizePeriodAmounts({ should: 100, receive: 50 }), null);
    assert.equal(normalizePeriodAmounts({ period: "   ", should: 100, receive: 50 }), null);
  });

  it("三個金額全空 → null（唔可以落一筆假帳期）", () => {
    assert.equal(
      normalizePeriodAmounts({ period: "2026-09-16 ~ 2026-09-30", should: null, receive: null, subsidy: null }),
      null,
    );
  });

  it("只有 fee（服務費）都算空 —— 三個口徑金額一個都冇", () => {
    assert.equal(
      normalizePeriodAmounts({ period: "P1", should: null, receive: null, subsidy: null, fee: 12 }),
      null,
    );
  });

  it("正常帳期：原樣保留（元，唔除 100）＋ 去前後空白", () => {
    const n = normalizePeriodAmounts({
      period: " 2026-09-16 ~ 2026-09-30 ",
      should: 1803.34,
      receive: 1353.17,
      subsidy: 1212.37,
      fee: 490.83,
    });
    assert.ok(n);
    assert.equal(n.period, "2026-09-16 ~ 2026-09-30");
    assert.equal(n.should, 1803.34);
    assert.equal(n.receive, 1353.17);
    assert.equal(n.subsidy, 1212.37);
    assert.equal(n.fee, 490.83);
  });

  it("字串 numeric 要轉成 number（PostgREST 會回字串）", () => {
    const n = normalizePeriodAmounts({ period: "P1", should: "1803.34", receive: "1353.17" });
    assert.ok(n);
    assert.equal(n.should, 1803.34);
    assert.equal(n.receive, 1353.17);
  });

  it("非物件 / 陣列 → null", () => {
    assert.equal(normalizePeriodAmounts(null), null);
    assert.equal(normalizePeriodAmounts(undefined), null);
    assert.equal(normalizePeriodAmounts("x"), null);
    assert.equal(normalizePeriodAmounts([{ period: "P1", receive: 1 }]), null);
  });

  it("只有 should（冇實收）都算可用 —— 應收係合法資訊", () => {
    const n = normalizePeriodAmounts({ period: "P1", should: 1803.34 });
    assert.ok(n);
    assert.equal(n.should, 1803.34);
    assert.equal(n.receive, null);
  });
});

describe("periodPayout：帳期「實際到帳」口徑", () => {
  it("補貼後優先（同逐單 actualPayout 一致）", () => {
    assert.equal(periodPayout({ subsidy: 31.91, receive: 35.11 }), 31.91);
  });

  it("冇補貼 → 落返實收", () => {
    assert.equal(periodPayout({ subsidy: null, receive: 35.11 }), 35.11);
  });

  it("補貼係 0 係合法值（唔可以當「冇資料」而退回 receive）", () => {
    assert.equal(periodPayout({ subsidy: 0, receive: 35.11 }), 0);
  });

  it("兩者都冇 → null（待對帳）", () => {
    assert.equal(periodPayout({ subsidy: null, receive: null }), null);
    assert.equal(periodPayout(null), null);
  });
});

describe("computeSettlementTotals：一律逐單（2026-09-29 改口徑）", () => {
  const ord = (id: string, total: number) => ({ externalOrderId: id, total });
  const settled = (net: number, sub: number) => () => ({ netAmount: net, subsidyNet: sub });

  it("🔴 逐單完全對齊 → 用逐單（應收＝POS 逐單，唔用平台帳期）", () => {
    const t = computeSettlementTotals([ord("A", 62)], settled(35.11, 31.91));
    assert.equal(t.basis, "per-order");
    assert.equal(t.receivable, 62);
    assert.equal(t.received, 31.91);
    assert.equal(t.periodLabel, null);
    assert.equal(t.usedPeriodFallback, false);
  });

  it("🔴🔴 逐單一張都配唔上（有單但未對帳）→ 仍用逐單，唔落帳期", () => {
    const t = computeSettlementTotals([ord("A", 62), ord("B", 48)], () => null);
    assert.equal(t.basis, "per-order", "永遠逐單，唔會變 period");
    assert.equal(
      t.receivable,
      110,
      "應收＝POS 同步單營業額總和（62+48），唔係平台帳期 1803.34",
    );
    assert.equal(t.received, null, "完全冇對到帳 → 待對帳");
    assert.equal(t.pendingCount, 2, "仲有 2 張未對帳（要報出嚟）");
    assert.equal(t.usedPeriodFallback, false);
  });

  it("🔴 逐單部分對齊 → 用逐單已對帳嗰批，唔用帳期補數", () => {
    const t = computeSettlementTotals(
      [ord("A", 62), ord("B", 48)],
      (o) => (o.externalOrderId === "A" ? { netAmount: 35.11, subsidyNet: 31.91 } : null),
    );
    assert.equal(t.basis, "per-order");
    assert.equal(t.usedPeriodFallback, false, "唔可以標示換咗口徑");
    assert.equal(t.settledCount, 1);
    assert.equal(t.pendingCount, 1);
    // 🔴 唔可以係 31.91（逐單 OK）＋ 帳期補數；亦唔可以變 1212.37（帳期）
    assert.equal(t.received, 31.91, "實收只計已對帳嗰張 A");
    assert.equal(t.receivable, 110, "應收計晒兩張");
  });

  it("🔴 有平台單但未對帳 → 實收 null、顯示待對帳", () => {
    const none = computeSettlementTotals([ord("A", 62)], () => null);
    assert.equal(none.basis, "per-order");
    assert.equal(none.receivable, 62);
    assert.equal(none.received, null, "冇對帳 → null（唔可以 0）");
    assert.equal(none.feeRate, null);
  });

  it("🔴 冇任何平台單 → basis none（區塊唔 render）", () => {
    const t = computeSettlementTotals([], () => null);
    assert.equal(t.receivable, 0);
    assert.equal(t.received, null);
    assert.equal(t.feeRate, null);
    assert.equal(t.basis, "none");
  });
});

// ============================================================================
// 平台單號「前綴無關」配對（2026-09-29 確診真案）
// ============================================================================

/**
 * 🔴🔴 mfood 單號有兩個口徑：
 *   - 接單列表 `id`         = `202609250937046870290`（純數字，寫入 DB）
 *   - 財務頁   `tradeNo`    = `CRD202609250937046870290`（多一個 `CRD` 前綴）
 *
 * 舊 code 直接拎 `tradeNo` 去 `.in("external_order_id")` 查 DB
 * ⇒ 一條都唔中 ⇒ 全部 notFound ⇒ 實收價格永遠補唔返（2026-09-29 使用者實案）。
 *
 * 呢組測試要鎖死：核心配對可以跨前綴，但**完全相同要優先**（零行為改變）。
 */

describe("tradeNoCore：剝走開頭英文字母前綴", () => {
  it("🔴 真案：CRD202609250937046870290 → 202609250937046870290", () => {
    assert.equal(tradeNoCore("CRD202609250937046870290"), "202609250937046870290");
  });

  it("本身冇前綴 → 原樣返回（唔可以改數字）", () => {
    assert.equal(tradeNoCore("202609250937046870290"), "202609250937046870290");
  });

  it("🔴 平台改版換前綴（CRD → MFD）都對得上（刻意唔只剝 CRD）", () => {
    assert.equal(tradeNoCore("MFD202609250937046870290"), "202609250937046870290");
    assert.equal(tradeNoCore("crd202609250937046870290"), "202609250937046870290");
  });

  it("null / undefined / 空字串 / 純空白 → null", () => {
    assert.equal(tradeNoCore(null), null);
    assert.equal(tradeNoCore(undefined), null);
    assert.equal(tradeNoCore(""), null);
    assert.equal(tradeNoCore("   "), null);
  });

  it("全係字母（剝完變空）→ null（唔可以回空字串當 key）", () => {
    assert.equal(tradeNoCore("CRD"), null);
  });
});

describe("tradeNoQueryKeys：查 DB 用嘅候選鍵（原值＋核心）", () => {
  it("🔴 有 CRD 前綴 → 出兩個候選（原值 + 核心）", () => {
    assert.deepEqual(tradeNoQueryKeys(["CRD202609250937046870290"]), [
      "CRD202609250937046870290",
      "202609250937046870290",
    ]);
  });

  it("🔴 去重：原值同核心一樣嘅時候唔可以重複出現在 IN 清單", () => {
    assert.deepEqual(tradeNoQueryKeys(["202609250937046870290"]), ["202609250937046870290"]);
    assert.deepEqual(
      tradeNoQueryKeys(["202609250937046870290", "CRD202609250937046870290"]),
      ["202609250937046870290", "CRD202609250937046870290"],
    );
  });

  it("無效值（null / 空）全部掉棄", () => {
    assert.deepEqual(tradeNoQueryKeys([null, "", "  ", undefined]), []);
  });

  it("空陣列 / null → 空陣列（唔可以崩）", () => {
    assert.deepEqual(tradeNoQueryKeys([]), []);
    assert.deepEqual(tradeNoQueryKeys(null as unknown as readonly unknown[]), []);
  });
});

describe("createTradeNoIdIndex：DB 列 → 單號索引（exact 優先、核心兜底）", () => {
  const DB_ROW = { id: "uuid-1", external_order_id: "202609250937046870290" };

  it("🔴 真案：財務頁 tradeNo（CRD…）要配到 DB 嗰張（無 CRD）", () => {
    const idx = createTradeNoIdIndex();
    idx.add([DB_ROW]);
    assert.equal(idx.get("CRD202609250937046870290"), "uuid-1");
  });

  it("完全相同 → 直接命中（舊行為零改變）", () => {
    const idx = createTradeNoIdIndex();
    idx.add([DB_ROW]);
    assert.equal(idx.get("202609250937046870290"), "uuid-1");
  });

  it("🔴 exact 優先：兩張單（一張帶前綴、一張純數字）唔可以配錯", () => {
    const idx = createTradeNoIdIndex();
    idx.add([
      { id: "uuid-core", external_order_id: "202609250937046870290" },
      { id: "uuid-exact", external_order_id: "CRD202609250937046870290" },
    ]);
    assert.equal(idx.get("CRD202609250937046870290"), "uuid-exact");
    assert.equal(idx.get("202609250937046870290"), "uuid-core");
  });

  it("搵唔到 → null（唔可以亂配）", () => {
    const idx = createTradeNoIdIndex();
    idx.add([DB_ROW]);
    assert.equal(idx.get("CRD999999999999999999999"), null);
    assert.equal(idx.get(null), null);
    assert.equal(idx.get(""), null);
  });

  it("空索引 → null（唔可以崩）", () => {
    const idx = createTradeNoIdIndex();
    assert.equal(idx.get("CRD202609250937046870290"), null);
  });

  it("冇效列（冇 id / 非物件 / 冇單號）要安全掉棄", () => {
    const idx = createTradeNoIdIndex();
    // 故意塞入唔合型別嘅列（DB 回傳有可能唔乾淨）——索引要安全掉棄，唔可以崩
    idx.add([
      { id: "", external_order_id: "202609250937046870290" },
      { id: "uuid-2", external_order_id: null },
      null,
      "not-an-object",
    ] as unknown as TradeNoIdRow[]);
    assert.equal(idx.get("CRD202609250937046870290"), null);
    idx.add([{ id: "uuid-3", external_order_id: "CRD202609250937046870290" }]);
    assert.equal(idx.get("202609250937046870290"), "uuid-3");
  });

  it("分批 add（chunk 200 查詢）結果要累積，唔可以互相覆蓋", () => {
    const idx = createTradeNoIdIndex();
    idx.add([{ id: "uuid-a", external_order_id: "202609250937046870290" }]);
    idx.add([{ id: "uuid-b", external_order_id: "202609251303412269108" }]);
    assert.equal(idx.get("CRD202609250937046870290"), "uuid-a");
    assert.equal(idx.get("CRD202609251303412269108"), "uuid-b");
  });

  it("add(null) / add(undefined) 唔可以崩", () => {
    const idx = createTradeNoIdIndex();
    idx.add(null);
    idx.add(undefined);
    assert.equal(idx.get("CRD202609250937046870290"), null);
  });
});

describe("🔴 端到端真案：mfood 財務頁（CRD）→ pos_orders（無 CRD）", () => {
  /**
   * 呢條係 2026-09-29 使用者實案嘅**整條鏈**重演：
   *   插件原始列 → readTxns 改名 → groupSettlementByOrder → tradeNoQueryKeys
   *   → （DB `.in(external_order_id)`）→ createTradeNoIdIndex → update
   * 任何一環改壞，呢條就會紅。
   */
  const RAW_ROW = {
    // `_get-order-summary-list` 嘅 result[] 原始列：兩個號同時存在
    id: "202609250937046870290",
    tradeNo: "CRD202609250937046870290",
    storeBusinessAmtn: 62,
    storeReceiveAmtn: 35.11,
    subsidyStoreReceiveAmtn: 31.91,
  };

  it("🔴 tradeNo 帶 CRD 都要配到 DB 嗰張單（舊寫法會全部 notFound）", () => {
    // ① route.readTxns() 嘅改名（`tradeNo` 優先）
    const txn = {
      externalOrderId: normalizeTradeNo(RAW_ROW.tradeNo) ?? normalizeTradeNo(RAW_ROW.id),
      netAmount: toAmountOrNull(RAW_ROW.storeReceiveAmtn),
      subsidyNet: toAmountOrNull(RAW_ROW.subsidyStoreReceiveAmtn),
      businessAmount: toAmountOrNull(RAW_ROW.storeBusinessAmtn),
      serviceFee: null,
    };
    assert.equal(txn.externalOrderId, "CRD202609250937046870290");

    // ② 分組
    const { byOrder, unmatchedCount } = groupSettlementByOrder([txn]);
    assert.equal(unmatchedCount, 0);
    assert.equal(byOrder.size, 1);

    // ③ 查 DB 嘅候選鍵一定要包埋「無 CRD」嗰個
    const queryKeys = tradeNoQueryKeys([...byOrder.keys()]);
    assert.ok(queryKeys.includes("202609250937046870290"), "IN 清單一定要有核心鍵");
    assert.ok(queryKeys.includes("CRD202609250937046870290"), "IN 清單要有原值鍵");

    // ④ DB 回傳（`external_order_id` 由接單列表 `id` 寫入 ⇒ 無 CRD）
    const idx = createTradeNoIdIndex();
    idx.add([{ id: "order-uuid-1", external_order_id: RAW_ROW.id }]);

    // ⑤ 配對：拎財務頁 tradeNo 去查 → 要中
    const orderId = idx.get("CRD202609250937046870290");
    assert.equal(orderId, "order-uuid-1", "🔴 呢條就係當年配唔上嘅地方");

    // ⑥ 實收金額（報表三格用）
    const s = byOrder.get("CRD202609250937046870290");
    assert.ok(s);
    assert.equal(s.txnCount, 1);
    assert.equal(s.netAmount, 35.11, "平台過數（補貼前）");
    assert.equal(s.subsidyNet, 31.91, "補貼後");
    assert.equal(actualPayout(s), 31.91, "🔴 實收價＝補貼後（31.91），唔係 35.11");
  });
});
