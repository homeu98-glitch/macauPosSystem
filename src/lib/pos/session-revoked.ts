/**
 * 《本機工作階段已被管理員關閉》旗標（2026-09-22）—— client 側模組 store。
 *
 * ## 流程
 *
 * 1. 管理員喺 `/admin/sessions` 撳「強制關閉」⇒ server 寫 `pos_sessions.revoked_at`。
 * 2. 本分頁**下次**請求（輪詢／寫入）嘅回應帶 `x-pos-session-closed: 1`。
 * 3. `pos-app` 收到 → `markPosSessionRevoked()` ⇒ 三件事同時發生：
 *    · 出橫幅（`session-revoked-banner.tsx`，in-flow、**唔自動 reload**）；
 *    · 輪詢閘見到「冇有效 session」⇒ **即刻停輪詢**（省流量，呢個係原本嘅目的）；
 *    · 新生意（建單／加菜）被 server 拒收，收銀員見到提示。
 *
 * ## 為何唔自動 reload、亦唔即刻清 token
 *
 * 同《版本過期橫幅》同一個理由：收銀**結帳中途** reload ＝ 災難。
 * 而且「強制關閉」只係叫呢個分頁停 —— 唔應該令正在結帳嘅客人走唔到
 *（server 端亦刻意放行結帳／退款／刪單，見 `session-record.ts`
 * `blockedEventTypesForRevokedSession()`）。
 *
 * ## 為何零 import
 *
 * `npm test` ＝ `node --test`（唔行 bundler、唔認 `@/` 別名）⇒ 可測模組唔准 import。
 * 呢個 store 唔做任何網絡請求、唔讀 storage，純記憶。
 * 用 `subscribe + getSnapshot` 嘅形狀，React 側可以配 `useState` 或
 * `useSyncExternalStore` 都得。
 */

let revoked = false;
let reason: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * 標記「本機工作階段已被管理員關閉」。
 *
 * 重複呼叫係便宜的（同值唔會通知訂閱者）。
 *
 * @param nextReason 選填：關閉原因（由 server 帶落嚟的話就顯示，冇就唔顯示）。
 */
export function markPosSessionRevoked(nextReason?: string | null): void {
  const normalized = typeof nextReason === "string" && nextReason.trim() ? nextReason.trim() : null;
  if (revoked && reason === normalized) return;
  revoked = true;
  reason = normalized;
  emit();
}

/** 清掉旗標 —— **只喺重新登入成功之後**呼叫（見 `session-key.ts` 嘅 `rotatePosSessionKey`）。 */
export function clearPosSessionRevoked(): void {
  if (!revoked && reason === null) return;
  revoked = false;
  reason = null;
  emit();
}

/** 而家係唔係已被關閉。 */
export function isPosSessionRevoked(): boolean {
  return revoked;
}

/** 關閉原因（冇 → `null`）。 */
export function getPosSessionRevokedReason(): string | null {
  return reason;
}

/** 訂閱變化；回 unsubscribe。 */
export function subscribePosSessionRevoked(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 只供測試。 */
export function resetPosSessionRevokedForTest(): void {
  revoked = false;
  reason = null;
  listeners.clear();
}
