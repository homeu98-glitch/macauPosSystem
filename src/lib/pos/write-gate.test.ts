import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decideOrderWrite,
  describeWriteGateRejection,
  isNewBusinessEvent,
  type WriteGateInput,
} from "./write-gate.ts";

/**
 * 《訂單寫入閘》單測（2026-09-21）。
 *
 * J 嘅要求：「店已關仍可下單，這是錯誤行為，應立即阻止」＋「結帳准、加菜不准」。
 * 兩個相反方向都要守：
 *   · **太鬆** ⇒ 關店後照開新生意（今次要修嘅事）。
 *   · **太緊** ⇒ ① 客人走唔到（結帳被擋）② 線上單永遠上唔到雲（擋咗 `ledger-` 鏡像）。
 *  ② 係最危險嘅一種 —— 佢唔會報錯，只會靜靜令雲端冇單。
 */

const base: WriteGateInput = {
  eventType: "ORDER_CREATED",
  hasAddedItems: false,
  isOnlineMirror: false,
  storeClosed: false,
  shiftClosed: false,
};

describe("isNewBusinessEvent", () => {
  it("ORDER_CREATED 一律係新生意", () => {
    assert.equal(isNewBusinessEvent({ eventType: "ORDER_CREATED", hasAddedItems: false }), true);
  });

  it("🔴 ORDER_UPDATED **帶 addedItems** ＝ 加菜 ＝ 新生意", () => {
    assert.equal(isNewBusinessEvent({ eventType: "ORDER_UPDATED", hasAddedItems: true }), true);
  });

  it("🔴 ORDER_UPDATED **冇 addedItems**（純狀態推進）唔算新生意（fail-open）", () => {
    assert.equal(isNewBusinessEvent({ eventType: "ORDER_UPDATED", hasAddedItems: false }), false);
  });

  it("其他事件一律唔算新生意", () => {
    for (const type of [
      "ORDER_SETTLED",
      "ORDER_ITEM_VOIDED",
      "ORDER_DELETED",
      "PRINT_JOB_CREATED",
      "PRINT_JOB_DELETED",
      "TEST_PRINT_REQUESTED",
      "DEVICE_CONFIG_UPDATED",
    ]) {
      assert.equal(isNewBusinessEvent({ eventType: type, hasAddedItems: false }), false, type);
    }
  });
});

describe("decideOrderWrite ── 應該拒", () => {
  it("店已關 + 本地新單 → 拒（store-closed）", () => {
    assert.deepEqual(decideOrderWrite({ ...base, storeClosed: true }), {
      allow: false,
      reason: "store-closed",
    });
  });

  it("🔴 店已關 + 加菜（ORDER_UPDATED 帶 addedItems）→ 拒", () => {
    const d = decideOrderWrite({
      ...base,
      eventType: "ORDER_UPDATED",
      hasAddedItems: true,
      storeClosed: true,
    });
    assert.deepEqual([d.allow, d.reason], [false, "store-closed"]);
  });

  it("已收工 + 本地新單 → 拒（shift-closed）", () => {
    assert.deepEqual(decideOrderWrite({ ...base, shiftClosed: true }), {
      allow: false,
      reason: "shift-closed",
    });
  });

  it("店已關 ＋ 已收工 → 講「店已關」先（兩者文案唔可以撈埋）", () => {
    const d = decideOrderWrite({ ...base, storeClosed: true, shiftClosed: true });
    assert.equal(d.reason, "store-closed");
  });
});

describe("decideOrderWrite ── 唔應該拒（最重要）", () => {
  it("🔴 結帳（ORDER_SETTLED）即使店已關 ＋ 已收工都**准**（客人走唔到更嚴重）", () => {
    const d = decideOrderWrite({
      ...base,
      eventType: "ORDER_SETTLED",
      storeClosed: true,
      shiftClosed: true,
    });
    assert.equal(d.allow, true);
  });

  it("🔴 線上鏡像（`ledger-`）嘅 ORDER_CREATED 即使店已關都**准**", () => {
    const d = decideOrderWrite({ ...base, isOnlineMirror: true, storeClosed: true, shiftClosed: true });
    assert.equal(d.allow, true, "擋咗會令線上單喺 POS 雲端永遠冇完整記錄");
  });

  it("🔴 純狀態推進（ORDER_UPDATED 冇 addedItems）即使關店都**准**", () => {
    const d = decideOrderWrite({
      ...base,
      eventType: "ORDER_UPDATED",
      hasAddedItems: false,
      storeClosed: true,
      shiftClosed: true,
    });
    assert.equal(d.allow, true);
  });

  it("退菜 / 刪單 / 出紙一律准", () => {
    for (const type of ["ORDER_ITEM_VOIDED", "ORDER_DELETED", "PRINT_JOB_CREATED"]) {
      const d = decideOrderWrite({ ...base, eventType: type, storeClosed: true, shiftClosed: true });
      assert.equal(d.allow, true, type);
    }
  });

  it("正常營業中 → 一切准", () => {
    assert.equal(decideOrderWrite(base).allow, true);
    assert.equal(
      decideOrderWrite({ ...base, eventType: "ORDER_UPDATED", hasAddedItems: true }).allow,
      true,
    );
  });
});

describe("describeWriteGateRejection", () => {
  it("兩種原因有唔同文案（唔可以撈埋）", () => {
    const a = describeWriteGateRejection("store-closed");
    const b = describeWriteGateRejection("shift-closed");
    assert.ok(a.length > 0 && b.length > 0);
    assert.notEqual(a, b);
    assert.ok(/暫停營業/.test(a));
    assert.ok(/開工/.test(b));
  });

  it("`ok` 冇文案", () => {
    assert.equal(describeWriteGateRejection("ok"), "");
  });
});
