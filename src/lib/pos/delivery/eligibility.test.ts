// 回歸測試：邊張單可以派車手。
//
// 規則（2026-10-31 用戶拍板）：
//   ① 線上單只准外送單（merchant_delivery），其餘一律唔准；
//   ② 店內單（堂食「外賣自送」枱／快餐 counter／自取）任何未取消、已送出都可以；
//   ③ 平台單只限「商家自送／自取」，平台專送同未知一律唔准；
//   ④ 已經有進行中派單 → 唔可以再派。
//
// 呢個 test 係「唔影響現有功能」嘅護欄：UI 只會跟呢個判斷顯示掣，
// 唔會再有第二套條件散落喺 component。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateDispatchEligibility } from "./eligibility.ts";

const aomi = (sendType: string) => ({ raw: { sendType } });
const mfood = (deliveryType: string) => ({ raw: { deliveryType } });

describe("線上單（Ledger）", () => {
  const base = { kind: "online" as const, fulfillmentType: "merchant_delivery" };

  it("外送單 accepted / preparing / ready 可以派", () => {
    for (const status of ["accepted", "preparing", "ready"]) {
      assert.deepEqual(evaluateDispatchEligibility({ ...base, status }), { can: true, reason: "ok" });
    }
  });

  it("未接單（pending）唔准", () => {
    assert.equal(evaluateDispatchEligibility({ ...base, status: "pending" }).reason, "not_accepted");
  });

  it("堂食／外賣自取唔准 —— 要客人取消重落或線下處理", () => {
    for (const fulfillmentType of ["dine_in", "takeaway"]) {
      assert.equal(
        evaluateDispatchEligibility({ kind: "online", fulfillmentType, status: "ready" }).reason,
        "online_not_delivery",
      );
    }
  });

  it("已取消／已完成唔准", () => {
    assert.equal(evaluateDispatchEligibility({ ...base, status: "cancelled" }).reason, "order_closed");
    assert.equal(evaluateDispatchEligibility({ ...base, status: "completed" }).reason, "order_closed");
  });

  it("已經配送中 → 當已派送，唔會重複派", () => {
    assert.equal(evaluateDispatchEligibility({ ...base, status: "delivering" }).reason, "already_dispatched");
  });
});

describe("店內單（POS 本地）", () => {
  it("已送出／已收款／已完成／返結都可以派", () => {
    for (const status of ["sent_to_kitchen", "paid", "settled", "reopened"]) {
      assert.equal(
        evaluateDispatchEligibility({ kind: "local", status }).reason,
        "ok",
        `status=${status}`,
      );
    }
  });

  it("未送出（draft）唔准 —— 廚房都未收到", () => {
    assert.equal(evaluateDispatchEligibility({ kind: "local", status: "draft" }).reason, "not_sent");
  });

  it("已取消／已退款唔准", () => {
    for (const status of ["cancelled", "refunded", "partially_refunded"]) {
      assert.equal(evaluateDispatchEligibility({ kind: "local", status }).reason, "order_closed");
    }
  });
});

describe("平台單（澳覓／MFOOD）", () => {
  const base = { kind: "platform" as const, status: "sent_to_kitchen" };

  it("商家自送 → 可以派", () => {
    assert.deepEqual(evaluateDispatchEligibility({ ...base, source: "aomi", rawJson: aomi("自送") }), {
      can: true,
      reason: "ok",
      mode: "merchant",
    });
    assert.equal(
      evaluateDispatchEligibility({ ...base, source: "mfood", rawJson: mfood("2") }).can,
      true,
    );
  });

  it("自取 → 可以派（客人臨時改送貨）", () => {
    assert.equal(evaluateDispatchEligibility({ ...base, source: "aomi", rawJson: aomi("自取") }).can, true);
    assert.equal(evaluateDispatchEligibility({ ...base, source: "mfood", rawJson: mfood("3") }).can, true);
  });

  it("平台專送 → 唔准（避免重複送餐）", () => {
    assert.deepEqual(evaluateDispatchEligibility({ ...base, source: "aomi", rawJson: aomi("專送") }), {
      can: false,
      reason: "platform_delivery",
      mode: "platform",
    });
    assert.equal(
      evaluateDispatchEligibility({ ...base, source: "mfood", rawJson: mfood("1") }).reason,
      "platform_delivery",
    );
  });

  it("冇配送方式（舊單／插件未送）→ 一律唔准（fail-closed）", () => {
    assert.equal(
      evaluateDispatchEligibility({ ...base, source: "aomi", rawJson: {} }).reason,
      "delivery_mode_unknown",
    );
    assert.equal(
      evaluateDispatchEligibility({ ...base, source: "mfood", rawJson: null }).reason,
      "delivery_mode_unknown",
    );
  });

  it("已取消／已退款唔准", () => {
    assert.equal(
      evaluateDispatchEligibility({
        ...base,
        status: "refunded",
        source: "aomi",
        rawJson: aomi("自送"),
      }).reason,
      "order_closed",
    );
  });
});

describe("前端只傳 mode（冇 raw_json）", () => {
  const base = { kind: "platform" as const, status: "sent_to_kitchen" };

  it("mode=merchant → 可以派", () => {
    assert.deepEqual(evaluateDispatchEligibility({ ...base, mode: "merchant" }), {
      can: true,
      reason: "ok",
      mode: "merchant",
    });
  });

  it("mode=platform → 唔准", () => {
    assert.equal(evaluateDispatchEligibility({ ...base, mode: "platform" }).reason, "platform_delivery");
  });

  it("mode=unknown → 唔准（唔會因為冇 raw_json 而靜靜放行）", () => {
    assert.equal(
      evaluateDispatchEligibility({ ...base, mode: "unknown" }).reason,
      "delivery_mode_unknown",
    );
  });

  it("冇 mode、冇 raw_json → unknown（fail-closed）", () => {
    assert.equal(evaluateDispatchEligibility({ ...base }).reason, "delivery_mode_unknown");
  });
});

describe("已有進行中派單", () => {  it("任何來源都回 already_dispatched（UI 應顯示聊天／進度，而唔係再派）", () => {
    const cases = [
      { kind: "local" as const, status: "sent_to_kitchen" },
      { kind: "online" as const, fulfillmentType: "merchant_delivery", status: "accepted" },
      {
        kind: "platform" as const,
        status: "sent_to_kitchen",
        source: "aomi",
        rawJson: aomi("自送"),
      },
    ];
    for (const input of cases) {
      assert.equal(evaluateDispatchEligibility({ ...input, hasActiveDispatch: true }).reason, "already_dispatched");
    }
  });
});
