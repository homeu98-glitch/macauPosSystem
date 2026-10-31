// 回歸測試：UI 顯示層（旗標 + 資格）。
//
// 重點：**旗標關閉時，任何單都唔會顯示派送掣**。
// 呢個係「上線但零影響」嘅保證 —— 日後有人改 component 都唔可以繞過。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveDispatchAction } from "./dispatch-action.ts";

const localReady = { kind: "local" as const, status: "sent_to_kitchen" };

describe("resolveDispatchAction · 功能旗標", () => {
  it("旗標關閉 → 一律唔顯示（即使張單本身合格）", () => {
    assert.deepEqual(resolveDispatchAction(localReady, { enabled: false }), {
      visible: false,
      reason: "flag_off",
    });
  });

  it("旗標開啟 + 合格 → 顯示", () => {
    assert.deepEqual(resolveDispatchAction(localReady, { enabled: true }), {
      visible: true,
      reason: "ok",
    });
  });

  it("旗標開啟但唔合格 → 唔顯示，reason 保留真正原因", () => {
    assert.deepEqual(
      resolveDispatchAction({ kind: "local", status: "cancelled" }, { enabled: true }),
      { visible: false, reason: "order_closed" },
    );
  });
});

describe("resolveDispatchAction · 平台單（前端只有 mode）", () => {
  const base = { kind: "platform" as const, status: "paid" };

  it("自送 → 顯示", () => {
    assert.equal(resolveDispatchAction({ ...base, mode: "merchant" }, { enabled: true }).visible, true);
  });

  it("平台配送 → 唔顯示", () => {
    assert.deepEqual(resolveDispatchAction({ ...base, mode: "platform" }, { enabled: true }), {
      visible: false,
      reason: "platform_delivery",
    });
  });

  it("未載入 mode（undefined）→ 唔顯示（fail-closed）", () => {
    assert.equal(resolveDispatchAction(base, { enabled: true }).visible, false);
  });
});

describe("resolveDispatchAction · 已有派單", () => {
  it("hasActiveDispatch → 唔顯示（UI 應改為顯示聊天／進度）", () => {
    assert.deepEqual(
      resolveDispatchAction({ ...localReady, hasActiveDispatch: true }, { enabled: true }),
      { visible: false, reason: "already_dispatched" },
    );
  });
});

/**
 * 2026-10-31 用戶拍板：**線下／平台先上，Ledger 好之後才開線上**。
 *
 * 所以線上單要獨立一道 `NEXT_PUBLIC_DELIVERY_ONLINE`。呢組測試釘死：
 *   · 未開 → 線上單冇掣，但**店內／平台照舊有**（唔可以一刀切）；
 *   · 有開 → 線上外送單正常顯示。
 */
describe("resolveDispatchAction · 線上單旗標（Ledger A 線）", () => {
  const onlineReady = {
    kind: "online" as const,
    fulfillmentType: "merchant_delivery",
    status: "accepted",
  };

  it("線上旗標關閉 → 線上單冇掣", () => {
    assert.deepEqual(
      resolveDispatchAction(onlineReady, { enabled: true, onlineEnabled: false }),
      { visible: false, reason: "online_disabled" },
    );
  });

  it("線上旗標關閉 ≠ 一刀切：店內單照樣有掣", () => {
    assert.equal(
      resolveDispatchAction(localReady, { enabled: true, onlineEnabled: false }).visible,
      true,
    );
  });

  it("線上旗標開啟 + merchant_delivery → 顯示", () => {
    assert.deepEqual(resolveDispatchAction(onlineReady, { enabled: true, onlineEnabled: true }), {
      visible: true,
      reason: "ok",
    });
  });

  it("線上旗標開啟，但堂食／自取單 → 仍然唔顯示（客人要取消重落）", () => {
    assert.deepEqual(
      resolveDispatchAction(
        { kind: "online", fulfillmentType: "takeaway", status: "accepted" },
        { enabled: true, onlineEnabled: true },
      ),
      { visible: false, reason: "online_not_delivery" },
    );
  });
});

/**
 * 權限 gate（2026-10-31）：店員冇 `dispatchDelivery` → 冇掣。
 * ⚠️ 權限要喺「資格」之前判斷，否則無權限嘅人仍然會見到掣（只係撳唔到）。
 */
describe("resolveDispatchAction · 派送權限", () => {
  it("冇權限 → 唔顯示（即使張單本身合格）", () => {
    assert.deepEqual(resolveDispatchAction(localReady, { enabled: true, canDispatch: false }), {
      visible: false,
      reason: "no_permission",
    });
  });

  it("冇權限 → reason 係 no_permission，唔會漏出業務原因", () => {
    assert.equal(
      resolveDispatchAction({ kind: "local", status: "cancelled" }, { enabled: true, canDispatch: false })
        .reason,
      "no_permission",
    );
  });

  it("有權限（或者未計算）→ 正常按資格判斷", () => {
    assert.equal(resolveDispatchAction(localReady, { enabled: true, canDispatch: true }).visible, true);
    assert.equal(resolveDispatchAction(localReady, { enabled: true }).visible, true);
  });

  it("旗標優先：功能未開時，就算有權限都冇掣", () => {
    assert.equal(
      resolveDispatchAction(localReady, { enabled: false, canDispatch: true }).reason,
      "flag_off",
    );
  });
});
