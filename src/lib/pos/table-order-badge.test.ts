import { test } from "node:test";
import assert from "node:assert/strict";

import { tableOrderBadge } from "./table-order-badge.ts";

// ── 商家需求（2026-09-22）：桌台格子右上角「訂單號」角標 ────────────────────────
//   「當桌台已有下單時，在其格子右上角顯示對應的訂單號，例如訂單號為『訂單1』
//     就在右上角顯示『訂單1』；尚未下單的桌台則不顯示任何角標。」

test("已下單（sent_to_kitchen）→ 出角標，文字 = 訂單號原樣", () => {
  assert.deepEqual(tableOrderBadge({ status: "sent_to_kitchen", localOrderNo: "訂單1" }), {
    show: true,
    text: "訂單1",
  });
});

test("空閒枱（idle）→ 唔出角標（就算殘留舊單號都唔出）", () => {
  // 實案：枱結帳後 `tableOrderMap` 可能短暫仍指住舊單，
  // 若照出角標，白卡會出現「空閒 ＋ 訂單1」嘅自相矛盾。
  assert.deepEqual(tableOrderBadge({ status: "idle", localOrderNo: "訂單1" }), { show: false, text: "" });
  assert.deepEqual(tableOrderBadge({ status: "idle" }), { show: false, text: "" });
});

test("狀態缺失（null / undefined / 空物件）→ 當空閒，唔出角標", () => {
  assert.deepEqual(tableOrderBadge(null), { show: false, text: "" });
  assert.deepEqual(tableOrderBadge(undefined), { show: false, text: "" });
  assert.deepEqual(tableOrderBadge({}), { show: false, text: "" });
  assert.deepEqual(tableOrderBadge({ localOrderNo: "訂單1" }), { show: false, text: "" }, "冇 status = idle");
});

test("其餘三種「有單」狀態一樣出角標（唔可以只認 sent_to_kitchen）", () => {
  // draft = **客人自助落單、等店員確認**（kiosk-order.ts 係唯一會寫 draft 嘅路徑；
  //          店員落單一律 sent_to_kitchen）→ 單號已經存在，照出。
  // paid    = 線上／店內已收款待收尾（綠卡）。
  // reopened= 返結中（琥珀卡）。
  // 三者枱卡都係實底彩色，一樣需要靠角標認單。
  for (const status of ["draft", "paid", "reopened"]) {
    assert.deepEqual(
      tableOrderBadge({ status, localOrderNo: "訂單22" }),
      { show: true, text: "訂單22" },
      `${status} 應該出角標`,
    );
  }
});

test("開咗枱但未落單 = idle，唔出角標（confirmOpenTable 唔會建單）", () => {
  // 商家口徑「尚未下單嘅枱唔顯示任何角標」→ 對應 idle。
  // `confirmOpenTable()` 只寫入座人數 ＋ 開工作台，訂單要撳「下單」先出現，
  // 所以呢一刻枱仍然係 idle（白卡），正確行為係冇角標。
  assert.deepEqual(tableOrderBadge({ status: "idle" }), { show: false, text: "" });
});

test("單號係空字串／全空白／缺失 → 唔出角標（防「空白白色藥丸」爛 UI）", () => {
  for (const bad of ["", "   ", "\t", undefined, null]) {
    assert.deepEqual(
      tableOrderBadge({ status: "sent_to_kitchen", localOrderNo: bad as string | null | undefined }),
      { show: false, text: "" },
      `localOrderNo=${JSON.stringify(bad)} 唔應該出角標`,
    );
  }
});

test("單號前後空白會 trim（來源可能係 DB `order_no` text 欄）", () => {
  assert.deepEqual(tableOrderBadge({ status: "paid", localOrderNo: "  訂單8  " }), {
    show: true,
    text: "訂單8",
  });
});

test("四種單號前綴（堂食／快餐／掃碼／自取）都照出", () => {
  // 建單程式唔同 → localOrderNo 形狀唔同（見 kiosk-order.ts）：
  // 掃碼堂食單直接寫枱名（A01）。照顯示，唔做任何格式改寫。
  for (const no of ["訂單1", "快餐01", "堂食09", "A01"]) {
    assert.equal(tableOrderBadge({ status: "sent_to_kitchen", localOrderNo: no }).text, no);
  }
});
