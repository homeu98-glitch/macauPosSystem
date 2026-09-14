// 回歸測試：排位爬梯嘅**判定口徑**（梯級順序、「已過此級」、已完成）。
//
// 病症（2026-09-14 J）：排位後 Ledger 應該直接到「已完成」；若爬梯中途真失敗
// （例如訂單已取消、登入過期），收銀必須見到提示，唔可以靜默當成功。
//
// ⚠️ 呢個檔只測純判定 —— 爬梯本體要真打 Ledger RPC，屬於整合測試範圍。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DINEIN_FINAL_STATUS,
  DINEIN_LADDER,
  isInvalidTransition,
  isLedgerStatusComplete,
} from "./online-dinein-ladder.ts";

describe("排位爬梯：梯級順序（Ledger 只接受逐級）", () => {
  it("梯級必須係 accepted → preparing → ready → completed", () => {
    assert.deepEqual([...DINEIN_LADDER], ["accepted", "preparing", "ready", "completed"]);
  });

  it("梯頂一定係 completed，同 DINEIN_FINAL_STATUS 一致", () => {
    assert.equal(DINEIN_LADDER[DINEIN_LADDER.length - 1], DINEIN_FINAL_STATUS);
  });
});

describe("排位爬梯：邊啲錯誤算「已過此級」→ 可以繼續", () => {
  it("Ledger 原始英文 invalid transition → 繼續", () => {
    assert.equal(isInvalidTransition("invalid transition: ready -> completed"), true);
    assert.equal(isInvalidTransition("Invalid Transition"), true);
  });

  it("🔴 經 mapRpcErrorMessage 翻譯後嘅中文 → 一樣要認得（現行主力判定）", () => {
    assert.equal(isInvalidTransition("目前狀態不可執行此操作。"), true);
  });

  it("already（例如 order already completed）→ 繼續", () => {
    assert.equal(isInvalidTransition("order already completed"), true);
    assert.equal(isInvalidTransition("Order ALREADY closed"), true);
  });

  it("🔴 真失敗（登入／設定／網絡）→ 唔算，要即刻停手", () => {
    assert.equal(isInvalidTransition("Ledger 登入已過期，請重新登入。"), false);
    assert.equal(isInvalidTransition("Ledger Supabase 尚未設定。"), false);
    assert.equal(isInvalidTransition("Failed to fetch"), false);
    assert.equal(isInvalidTransition(""), false);
  });
});

describe("排位爬梯：完成判定", () => {
  it("completed（含大小寫／空白）→ 已完成", () => {
    assert.equal(isLedgerStatusComplete("completed"), true);
    assert.equal(isLedgerStatusComplete("COMPLETED"), true);
    assert.equal(isLedgerStatusComplete(" completed "), true);
  });

  it("🔴 未到梯頂 / 已取消 / 讀唔到 → 唔算完成（要當失敗提示收銀）", () => {
    assert.equal(isLedgerStatusComplete("ready"), false);
    assert.equal(isLedgerStatusComplete("preparing"), false);
    assert.equal(isLedgerStatusComplete("accepted"), false);
    assert.equal(isLedgerStatusComplete("cancelled"), false);
    assert.equal(isLedgerStatusComplete(null), false);
    assert.equal(isLedgerStatusComplete(undefined), false);
    assert.equal(isLedgerStatusComplete(""), false);
  });
});
