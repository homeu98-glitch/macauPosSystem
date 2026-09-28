import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  actualPayout,
  computeMfoodTotals,
  groupSettlementByOrder,
  normalizeTradeNo,
  settlementForOrder,
  toAmountOrNull,
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
