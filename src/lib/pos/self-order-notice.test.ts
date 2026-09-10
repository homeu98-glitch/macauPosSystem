import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addSelfOrderNotice,
  dismissSelfOrderNotice,
  markSelfOrderNoticeSettled,
  toSelfOrderNoticeItems,
  MAX_SELF_ORDER_NOTICES,
  type SelfOrderNotice,
} from "./self-order-notice.ts";

/**
 * 掃碼新單提示嘅規則（2026-09-10 需求 1~6）。
 *
 * 呢幾條規則全部係「靜默錯就出事」：
 *   - 去重失效 → 收銀見到兩個一樣嘅提示（以為兩張單）；
 *   - 上限失效 → 右上角永遠遮住畫面；
 *   - `settled` 判斷錯 → 要麼撳咗跳去一張已埋單嘅枱（莫名其妙），
 *     要麼明明已結帳都仲叫收銀「請查看」。
 */

const T1 = "2026-09-10T10:00:00.000Z";
const T2 = "2026-09-10T10:05:00.000Z";

function order(id: string, tableId = "t-a02", tableName = "A02") {
  return { id, tableId, tableName };
}

describe("addSelfOrderNotice", () => {
  it("新單 → 加入，並記住台號（需求 6 顯示用）", () => {
    const list = addSelfOrderNotice([], order("o1"), T1);
    assert.equal(list.length, 1);
    assert.equal(list[0].orderId, "o1");
    assert.equal(list[0].tableId, "t-a02");
    assert.equal(list[0].tableName, "A02");
    assert.equal(list[0].createdAt, T1);
  });

  it("同一張單再 push（realtime 重送）→ 去重，回傳同一個 reference", () => {
    const first = addSelfOrderNotice([], order("o1"), T1);
    const second = addSelfOrderNotice(first, order("o1"), T2);
    assert.equal(second, first); // reference 相等 = 上層唔會白寫 localStorage
    assert.equal(second.length, 1);
    assert.equal(second[0].createdAt, T1); // 保留首次時間
  });

  it("5 張單 → 5 個獨立項目（需求 4）", () => {
    let list: SelfOrderNotice[] = [];
    for (let i = 1; i <= 5; i += 1) {
      list = addSelfOrderNotice(list, order(`o${i}`, `t-a0${i}`, `A0${i}`), T1);
    }
    assert.equal(list.length, 5);
    assert.deepEqual(
      list.map((n) => n.tableName),
      ["A01", "A02", "A03", "A04", "A05"],
    );
  });

  it("超過上限 → 丟最舊，保留最新（防右上角無限膨脹）", () => {
    let list: SelfOrderNotice[] = [];
    for (let i = 1; i <= MAX_SELF_ORDER_NOTICES + 3; i += 1) {
      list = addSelfOrderNotice(list, order(`o${i}`), T1);
    }
    assert.equal(list.length, MAX_SELF_ORDER_NOTICES);
    assert.equal(list[0].orderId, "o4"); // o1~o3 被丟
    assert.equal(list[list.length - 1].orderId, `o${MAX_SELF_ORDER_NOTICES + 3}`);
  });
});

describe("dismissSelfOrderNotice", () => {
  it("移除指定單，其他保留（向右滑 = 略過）", () => {
    const list = [addSelfOrderNotice([], order("o1"), T1)[0], addSelfOrderNotice([], order("o2"), T1)[0]];
    const next = dismissSelfOrderNotice(list, "o1");
    assert.deepEqual(
      next.map((n) => n.orderId),
      ["o2"],
    );
  });

  it("揾唔到 → 回傳同一個 reference（唔產生多餘寫入）", () => {
    const list = addSelfOrderNotice([], order("o1"), T1);
    assert.equal(dismissSelfOrderNotice(list, "nope"), list);
  });
});

describe("markSelfOrderNoticeSettled", () => {
  it("標記已結帳，但**唔會**移除（需求 5：訊息要留住畀用戶睇）", () => {
    const list = addSelfOrderNotice([], order("o1"), T1);
    const next = markSelfOrderNoticeSettled(list, "o1", T2);
    assert.equal(next.length, 1);
    assert.equal(next[0].settledAt, T2);
  });

  it("重複標記唔會覆寫原本時間", () => {
    const list = markSelfOrderNoticeSettled(addSelfOrderNotice([], order("o1"), T1), "o1", T2);
    const again = markSelfOrderNoticeSettled(list, "o1", "2026-09-10T11:00:00.000Z");
    assert.equal(again[0].settledAt, T2);
  });

  it("只影響目標單", () => {
    const a = addSelfOrderNotice([], order("o1"), T1);
    const list = addSelfOrderNotice(a, order("o2"), T1);
    const next = markSelfOrderNoticeSettled(list, "o2", T2);
    assert.equal(next[0].settledAt, undefined);
    assert.equal(next[1].settledAt, T2);
  });
});

describe("toSelfOrderNoticeItems", () => {
  const isSettled = (o: { status?: string }) => o.status === "settled";

  it("未結單 → settled=false（顯示「A02 已下單 / 請查看」）", () => {
    const notices = addSelfOrderNotice([], order("o1"), T1);
    const items = toSelfOrderNoticeItems(notices, [{ id: "o1", tableId: "t-a02", tableName: "A02", status: "draft" }], isSettled);
    assert.deepEqual(items, [{ orderId: "o1", tableName: "A02", settled: false }]);
  });

  it("訂單已結帳（收銀另一部機埋咗單）→ settled=true，即使提示未標記過", () => {
    const notices = addSelfOrderNotice([], order("o1"), T1);
    const items = toSelfOrderNoticeItems(notices, [{ id: "o1", tableId: "t-a02", tableName: "A02", status: "settled" }], isSettled);
    assert.equal(items[0].settled, true);
  });

  it("訂單已經唔存在（另一部機刪咗 / 本地清咗）→ 一律當已結帳", () => {
    const notices = addSelfOrderNotice([], order("o1"), T1);
    const items = toSelfOrderNoticeItems(notices, [], isSettled);
    assert.equal(items[0].settled, true);
  });

  it("台名優先讀訂單即時值（枱名改過都跟得好），冇單先用提示記住嗰個", () => {
    const notices = addSelfOrderNotice([], order("o1", "t-a02", "A02"), T1);
    const renamed = toSelfOrderNoticeItems(
      notices,
      [{ id: "o1", tableId: "t-a02", tableName: "露台2", status: "sent_to_kitchen" }],
      isSettled,
    );
    assert.equal(renamed[0].tableName, "露台2");
    const orphan = toSelfOrderNoticeItems(notices, [], isSettled);
    assert.equal(orphan[0].tableName, "A02");
  });

  /**
   * docs/115 G4/G5：冇枱嘅自助單（自助點餐機 / 快餐掃碼）**一定要用單號**做標識。
   *
   * 快餐單嘅 `tableName` 全部係「自取」，如果照用台名，幾個提示會一模一樣
   * → 收銀根本分唔清邊張打邊張（甚至以為係重複提示）。
   */
  it("冇枱（counter）→ 顯示**單號**（唔係台名，唔係「自取」）", () => {
    const notices = addSelfOrderNotice([], order("o1", "counter", "自取"), T1);
    const items = toSelfOrderNoticeItems(
      notices,
      [{ id: "o1", tableId: "counter", tableName: "自取", localOrderNo: "自取01", status: "sent_to_kitchen" }],
      isSettled,
    );
    assert.deepEqual(items, [{ orderId: "o1", tableName: "自取01", settled: false }]);
  });

  it("counter 訂單但未讀到單號 → fallback 落提示記住嗰個（唔會顯示 undefined）", () => {
    const notices = addSelfOrderNotice([], order("o1", "counter", "自取"), T1);
    const items = toSelfOrderNoticeItems(
      notices,
      [{ id: "o1", tableId: "counter", tableName: "自取", localOrderNo: "", status: "draft" }],
      isSettled,
    );
    assert.equal(items[0].tableName, "自取");
  });
});
