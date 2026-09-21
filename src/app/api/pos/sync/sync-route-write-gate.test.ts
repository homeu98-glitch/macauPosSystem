import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《授權通道寫入閘》回歸守衛（2026-09-21）。
 *
 * 守護嘅係一個**靜默倒退**：兩道狀態閘（店內營業 2.55 / 班次 2.56）歷史上係
 * `if (!authorized && …)` —— **只擋匿名**。任何人「順手」把條件改返 `!authorized`，
 * 收銀台就會再次無視「店已關／已收工」開新單，而且**唔會有任何測試失敗**。
 *
 * 另一個更危險嘅方向：寫入閘**誤擋 `ledger-` 線上鏡像** ⇒
 * 線上單喺 POS 雲端永遠冇完整記錄（唔會報錯，只會靜靜冇單）。
 */
const SRC = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

describe("/api/pos/sync ── 授權通道寫入閘", () => {
  it("🔴 狀態閘嘅查詢條件要包含「有 ORDER 寫入事件」而唔止「匿名」", () => {
    assert.ok(
      /const hasOrderWriteEvents = events\.some\(/.test(SRC),
      "搵唔到 hasOrderWriteEvents ⇒ 授權通道又變返唔查狀態",
    );
    assert.ok(
      /const needsStoreGate = !authorized \|\| hasOrderWriteEvents;/.test(SRC),
      "needsStoreGate 定義唔見咗或者改錯",
    );
    assert.ok(
      /if \(needsStoreGate\) \{/.test(SRC),
      "店內營業閘冇用 needsStoreGate ⇒ 收銀台又唔受管",
    );
    assert.ok(
      /if \(needsStoreGate && !storeClosed\) \{/.test(SRC),
      "班次閘冇用 needsStoreGate ⇒ 收銀台又唔受管",
    );
  });

  it("🔴 閘一定要用 `decideOrderWrite`（唔可以自己寫一套 inline 判斷）", () => {
    assert.ok(
      /import \{ decideOrderWrite, describeWriteGateRejection \} from "@\/lib\/pos\/write-gate";/.test(
        SRC,
      ),
      "冇由 write-gate 引入決策函式 ⇒ 兩處口徑會漂移",
    );
    assert.ok(/const writeDecision = decideOrderWrite\(\{/.test(SRC), "冇實際呼叫決策");
    assert.ok(/if \(!writeDecision\.allow\) \{/.test(SRC), "冇處理拒收分支");
  });

  it("🔴 授權通道嘅閘只可以喺 `authorized` 分支（匿名通道要保持原本文案）", () => {
    const i = SRC.indexOf("const writeDecision = decideOrderWrite({");
    assert.ok(i > 0);
    // 往上搵最近嘅 `if (authorized) {`
    const before = SRC.slice(0, i);
    const lastGuard = before.lastIndexOf("if (authorized) {");
    assert.ok(lastGuard > 0, "授權通道閘唔喺 `if (authorized)` 之內");
    // 匿名拒收文案要保持原樣（客人端靠 `shop-closed` / `shift-closed` 分流）
    assert.ok(
      /ack\(false, "商家不在營業中", \{ reason: "shop-closed" \}\)/.test(SRC),
      "匿名通道嘅 shop-closed 契約被改動",
    );
    assert.ok(
      /ack\(false, "商家尚未開始營業", \{ reason: "shift-closed" \}\)/.test(SRC),
      "匿名通道嘅 shift-closed 契約被改動",
    );
  });

  it("🔴 線上鏡像（`ledger-`）一定要放行 —— 唔可以因為關店而擋", () => {
    assert.ok(
      /isOnlineMirror: orderId\.startsWith\("ledger-"\)/.test(SRC),
      "冇帶 isOnlineMirror ⇒ 線上單可能永遠上唔到雲（靜默）",
    );
  });

  it("加菜判定要讀 `addedItems`（唔可以靠 status 猜）", () => {
    assert.ok(
      /hasAddedItems: Array\.isArray\(addedItems\) && addedItems\.length > 0/.test(SRC),
      "加菜判定唔係讀 addedItems",
    );
  });
});
