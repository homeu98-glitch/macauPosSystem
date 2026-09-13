// 回歸測試：線上堂食單「排位 → 自動推到已完成」嘅**範圍隔離**。
//
// 對應需求（2026-09-13 商家）：
//   ① 排位完成即代表訂單已開始製作 → 一次過推 Ledger 到 completed。
//   ② 🔴 只限線上堂食單，其他訂單類型流程不受影響。
//
// ⚠️ 呢個檔只測**純判定**（`isOnlineDineInOrder`）——爬梯函式要真打 Ledger RPC，
// 屬於整合測試範圍，唔喺呢度 mock。
//
// ⚠️ 呢個檔用 node:test 直接載入 .ts，所以**唔可以** import 帶 runtime 依賴嘅模組
// （`online-dinein-fulfillment.ts` 有 `"use client"` ＋ `@/lib/ledger/order-actions` →
// node 解析唔到 `@/` alias，會 ERR_MODULE_NOT_FOUND）。判定邏輯收喺零依賴嘅
// `online-dinein-labels.ts`，兩邊共用同一份口徑。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isOnlineDineInOrder } from "./online-dinein-labels.ts";

function order(patch: { onlineOrderId?: string | null; tableId?: string | null }) {
  return { onlineOrderId: "L1", tableId: "table-a01", ...patch };
}

describe("線上堂食單判定（排位自動完成嘅適用範圍）", () => {
  it("🔴 帶 Ledger 單 id ＋ 真枱號 → 適用（排位會自動推 completed）", () => {
    assert.equal(isOnlineDineInOrder(order({})), true);
  });

  it("🔴 本地單（冇 onlineOrderId）→ 唔適用（本地堂食流程完全不變）", () => {
    assert.equal(isOnlineDineInOrder(order({ onlineOrderId: null })), false);
    assert.equal(isOnlineDineInOrder(order({ onlineOrderId: undefined })), false);
    assert.equal(isOnlineDineInOrder(order({ onlineOrderId: "" })), false);
  });

  it("🔴 快餐 counter 單 → 唔適用（保留收銀自行撳「可取餐 / 完成」）", () => {
    assert.equal(isOnlineDineInOrder(order({ tableId: "counter" })), false);
  });

  it("🔴 自取 / 外賣單（tableId 為 null）→ 唔適用", () => {
    assert.equal(isOnlineDineInOrder(order({ tableId: null })), false);
    assert.equal(isOnlineDineInOrder(order({ tableId: undefined })), false);
  });
});
