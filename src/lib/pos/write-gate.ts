/**
 * 《訂單寫入閘》—— 「店已關／已收工就唔准開新生意」嘅**純決策**（2026-09-21）。
 *
 * ── 為咩需要（取證）─────────────────────────────────────────────────────
 * 兩道 server 閘（`sync/route.ts` 2.55 店內營業、2.56 班次）**只擋匿名**
 * （`if (!authorized && storeClosed)`）⇒ **收銀台（帶 POS 憑證）完全冇「店已關」閘**，
 * 而 client 側 `useStoreStatus().isOpen` **只用於 UI pill**。
 *
 * 後果（J 2026-09-21 回報：「店已關仍可下單，這是錯誤行為」）：
 *   · 老闆撳「暫停營業」之後，收銀台照樣開枱落單；
 *   · **更危險**：一部開咗一整日嘅舊分頁，本機 `shift.openedAt` 仲係「開工」，
 *     另一部機已經交班 —— 舊分頁落單，server 因為 `authorized` 而**照收**，
 *     收銀員以為落咗單、雲端卻係另一回事。
 *
 * ── 判斷口徑（同 `pos-app.tsx` 既有嘅「過閘／唔過閘」清單對齊）──────────
 *
 * | 事件 | 關店／收工時 | 理由 |
 * |---|---|---|
 * | `ORDER_CREATED`（本地新單）| ❌ 拒 | 新生意 |
 * | `ORDER_UPDATED` **帶 `addedItems`**（加菜）| ❌ 拒 | 加菜＝新生意 |
 * | `ORDER_UPDATED` 冇 `addedItems`（純狀態推進）| ✅ 准 | 埋尾；舊 client 冇帶 ⇒ fail-open |
 * | `ORDER_SETTLED`（結帳）| ✅ 准 | **客人走唔到比「收到單」嚴重**（J 拍板）|
 * | `ORDER_ITEM_VOIDED` / `ORDER_DELETED` | ✅ 准 | 更正 |
 * | `PRINT_JOB_*` / `TEST_PRINT_REQUESTED` / 其他 | ✅ 准 | 出紙／基建 |
 *
 * ── 🔴 `ledger-` 線上鏡像一定要放行 ──────────────────────────────────────
 * `ledger-pos-bridge.ts` 嘅 `enqueueOrderEvent()` 會為**線上單**送 `ORDER_CREATED`
 * （首次排位／採納）。線上單係客人**落單在先**，只係 POS 側補記錄 ——
 * 擋咗佢會令「線上單喺 POS 雲端永遠冇完整記錄」（最壞情況結帳時才由
 * `ORDER_SETTLED` 嘅 0 列 upsert 兜底建一條冇 items 嘅最小記錄）。
 *
 * ── 逃生門 ───────────────────────────────────────────────────────────────
 * 關店後真要補單 → **重新開工**（開新班次）—— 令「補單」變成一個有記錄、有意圖嘅動作，
 * 而唔係靜默允許（J 2026-09-21 拍板）。
 *
 * ── 本模組刻意零 import ──────────────────────────────────────────────────
 * 專案 `npm test` ＝ `node --test`（唔行 bundler、唔認 `@/` 別名）⇒ 可測模組唔准 import。
 */

export type WriteGateReason = "ok" | "store-closed" | "shift-closed" | "session-closed";

export type WriteGateInput = {
  eventType: string;
  /** `ORDER_UPDATED` 有冇帶 `addedItems`（收銀台加菜會帶；kiosk／舊 client 唔帶）。 */
  hasAddedItems: boolean;
  /** 訂單 id 以 `ledger-` 開頭 ⇒ **線上鏡像**，一律放行（見頂部說明）。 */
  isOnlineMirror: boolean;
  /** 店內營業閘：`pos_store_status.is_open === false`。 */
  storeClosed: boolean;
  /** 班次閘：`pos_shifts` 冇任何未收工嘅班次。 */
  shiftClosed: boolean;
  /**
   * 工作階段閘（2026-09-22）：**管理員喺 admin 頁強制關閉咗呢個分頁**。
   *
   * 同上兩道閘同一個口徑：**只擋開新生意**（客人走唔到更嚴重）。
   * 情境：商家唔為意開咗幾個分頁，舊分頁靜靜燒流量（實測佔 egress 97%），
   * 管理員要止住佢 —— 但唔可以連正在結帳嘅客人一齊卡死。
   *
   * ⚠️ 舊 client／未跑 migration 0047 → `undefined` → 等同 `false`（fail-open）。
   */
  sessionRevoked?: boolean;
};

/**
 * 呢個事件係唔係「**開新生意**」（＝關店／收工時應該拒）。
 */
export function isNewBusinessEvent(input: Pick<WriteGateInput, "eventType" | "hasAddedItems">): boolean {
  if (input.eventType === "ORDER_CREATED") return true;
  if (input.eventType === "ORDER_UPDATED" && input.hasAddedItems) return true;
  return false;
}

/**
 * 判斷單一事件准唔准寫入。
 *
 * ⚠️ 只有「開新生意」先會受影響 —— 結帳、退菜、刪單、出紙一律照准。
 */
export function decideOrderWrite(input: WriteGateInput): {
  allow: boolean;
  reason: WriteGateReason;
} {
  if (!isNewBusinessEvent(input)) return { allow: true, reason: "ok" };
  // 線上單係客人先落、POS 側補記錄 ⇒ 唔可以因為「店已關」而擋（否則單據永遠唔完整）。
  if (input.isOnlineMirror) return { allow: true, reason: "ok" };
  // 次序：**最明確嘅原因行先** —— 「管理員關閉咗呢個分頁」比「店已關」更具體，
  // 而且店員跟住要做嘅事完全唔同（重新登入 vs 恢復營業）。
  if (input.sessionRevoked) return { allow: false, reason: "session-closed" };
  // 次序同既有兩道閘一致：先講「店已關」，再講「未開工」——
  // 兩者文案唔可以撈埋（客人／店員需要知道分別）。
  if (input.storeClosed) return { allow: false, reason: "store-closed" };
  if (input.shiftClosed) return { allow: false, reason: "shift-closed" };
  return { allow: true, reason: "ok" };
}

/** 收銀員／店員睇得明嘅拒收文案（同 kiosk 嘅 `shop-closed` / `shift-closed` 分開）。 */
export function describeWriteGateRejection(reason: WriteGateReason): string {
  if (reason === "store-closed") return "店內已暫停營業：唔可以開新單或加菜，請先恢復營業。";
  if (reason === "shift-closed") return "本店未開工／已收工：唔可以開新單或加菜，請先開工。";
  // ⚠️ 一定要講「重新登入」：店員見到「被管理員關閉」嘅正確反應係重新登入／開新視窗，
  //    而唔係去撳「恢復營業」（咁樣只會白做）。
  if (reason === "session-closed") {
    return "此工作階段已被管理員關閉：唔可以開新單或加菜，請重新登入或開新視窗。";
  }
  return "";
}
