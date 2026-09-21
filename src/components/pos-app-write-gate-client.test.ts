import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * 《G2／G3 客戶端自我修正》回歸守衛（2026-09-21）。
 *
 * 兩個方向都會靜默出事：
 *   · **G2 漏咗** ⇒ 店已暫停營業但收銀台照樣開枱落單（J 回報嘅錯行為）。
 *   · **G2 加上結帳** ⇒ 關店後客人走唔到（J 明確拍板：**結帳要准**）。
 *   · **G3 漏咗** ⇒ 舊分頁一路白試到 `failed`，收銀員完全唔知係被規則拒收。
 *
 * ⚠️ 掃 `.tsx` 前一定要**剝註釋行**，否則自己嘅解釋性註釋（刻意引用函式名）會誤報。
 */
function stripCommentLines(src: string): string {
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const POS_APP = stripCommentLines(
  readFileSync(new URL("./pos-app.tsx", import.meta.url), "utf8"),
);
const SYNC_FLUSH = stripCommentLines(
  readFileSync(new URL("../lib/pos/sync-flush.ts", import.meta.url), "utf8"),
);

describe("G2 ── 店已關唔准「開新生意」", () => {
  it("有 `ensureStoreOpenForNewBusiness()`，而且係 fail-open（只有 === false 才擋）", () => {
    const i = POS_APP.indexOf("function ensureStoreOpenForNewBusiness()");
    assert.ok(i > 0, "搵唔到 G2 閘");
    const body = POS_APP.slice(i, i + 260);
    assert.ok(
      /getStoreStatusSnapshot\(\)\.isOpen !== false\) return true;/.test(body),
      "判準唔係「只有明確 false 才擋」⇒ 未讀到（null）會被當已關（斷網全店開唔到單）",
    );
  });

  it("🔴 四個「開新生意」入口都要掛 G2（開枱 ×2、加菜、落單）", () => {
    const hits = POS_APP.match(/ensureStoreOpenForNewBusiness\(\) \|\| !ensureShiftOpened\(\)/g) ?? [];
    assert.equal(
      hits.length,
      4,
      `應該有 4 處（selectTable 空閒枱 / confirmOpenTable / addMenuItem / sendToKitchen），實際 ${hits.length}`,
    );
    // 落單（sendToKitchen）嗰處係 `return null`
    assert.ok(
      /ensureStoreOpenForNewBusiness\(\) \|\| !ensureShiftOpened\(\)\) return null;/.test(POS_APP),
      "落單入口冇掛 G2",
    );
  });

  it("🔴 結帳入口**唔可以**掛 G2（J 拍板：關店後結帳要准，客人走唔到更嚴重）", () => {
    for (const fn of ["async function confirmPayment", "async function openSettlementModal"]) {
      const i = POS_APP.indexOf(fn);
      assert.ok(i > 0, `搵唔到 ${fn}`);
      const body = POS_APP.slice(i, i + 1_200);
      assert.ok(
        !/ensureStoreOpenForNewBusiness/.test(body),
        `${fn} 掛咗 G2 ⇒ 關店後客人走唔到（應該只受 ensureShiftOpened 限制）`,
      );
    }
  });
});

describe("G3 ── 被 server 拒收之後要自我修正", () => {
  it("`sync-flush` 有定義 `POS_SYNC_BLOCKED_EVENT`（同「嘗試到頂」分開）", () => {
    assert.ok(
      /export const POS_SYNC_BLOCKED_EVENT = "pos-sync-blocked";/.test(SYNC_FLUSH),
      "冇事件常數",
    );
  });

  it("🔴 兩條回執路徑（HTTP 非 200 / HTTP 200）都要通知", () => {
    const hits = SYNC_FLUSH.match(/notifyBlockedByGate\(/g) ?? [];
    // 1 個定義 + 2 個呼叫點
    assert.equal(hits.length, 3, `應該 1 定義 + 2 呼叫，實際 ${hits.length}`);
  });

  it("🔴 只認 `store-closed` / `shift-closed`（唔可以撈埋其他 reason）", () => {
    const i = SYNC_FLUSH.indexOf("function notifyBlockedByGate");
    assert.ok(i > 0);
    const body = SYNC_FLUSH.slice(i, i + 700);
    assert.ok(/r\.reason === "store-closed" \|\| r\.reason === "shift-closed"/.test(body), "判準唔對");
    assert.ok(/dispatchEvent\(/.test(body), "冇廣播");
  });

  it("🔴 pos-app 收到之後要有 listener、要出提示、要即刻對齊班次", () => {
    assert.ok(
      /window\.addEventListener\(POS_SYNC_BLOCKED_EVENT, onSyncBlocked as EventListener\)/.test(
        POS_APP,
      ),
      "冇訂閱 ⇒ 收銀員唔會知被拒收",
    );
    assert.ok(
      /window\.removeEventListener\(POS_SYNC_BLOCKED_EVENT, onSyncBlocked as EventListener\)/.test(
        POS_APP,
      ),
      "冇解除訂閱（會洩漏 listener）",
    );
    const i = POS_APP.indexOf("function onSyncBlocked(");
    assert.ok(i > 0);
    const body = POS_APP.slice(i, i + 900);
    assert.ok(/setToast\(/.test(body), "冇提示收銀員");
    assert.ok(/void syncOnce\(\);/.test(body), "冇由雲端重新對齊班次（會一路白試到 failed）");
  });
});
