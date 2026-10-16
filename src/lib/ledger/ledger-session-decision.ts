/**
 * 《Ledger 店員 session 分流決策 —— 純決策模組》（2026-10-16，對應 Ledger PR#40）
 *
 * ## 背景：點解要分流
 *
 * `ensureLedgerSession()` 之前**每次呼叫**都 `client.auth.setSession()`，而
 * supabase-js 2.112 喺 token **未過期**時固定打 `GET /auth/v1/user` 驗證
 * （auth-js `GoTrueClient._setSession()` → `_getUser()`，node_modules 實測）。
 * 而 `ensureLedgerSession()` 有十幾處呼叫端（RPC／Realtime 訂閱／輪詢／7 個 mount）
 * ⇒ 晚市一台 iPad 實測 **154 次／時**，全部係唔必要嘅請求。
 *
 * ## 決策表
 *
 * | 情況 | 動作 | 網路 |
 * |---|---|---|
 * | POS storage 冇 token | `unauthorized` | 零 |
 * | client 記憶體未有 session | `bootstrap` | 1 次 `setSession`（每頁僅此一次） |
 * | storage 同 client 票唔同、storage 張**仍然有效** | `bootstrap` | 1 次（另一分頁登入過／刷新過 ⇒ 換身份） |
 * | storage 同 client 票唔同、storage 張已過期／快過期 | 以 client 為準 | 零（client 先醒 refresh 過，舊票已被 rotation） |
 * | client 張 ≤5 分鐘到期｜讀唔到到期時間 | `refresh` | 1 次 `refreshSession` |
 * | 其餘 | `reuse` | 零（`getSession()` 純本地） |
 *
 * ## 🔴 refresh token rotation race（上層責任，唔係呢個模組）
 *
 * Supabase refresh 會**輪換** refresh token。若兩個併發呼叫一個行 `refresh`、
 * 另一個用 storage 舊票行 `bootstrap`，舊 refresh token 已死 ⇒ 失敗彈登入。
 * ⇒ `session.ts` 必須用 single-flight 閘冚住所有呼叫（見該檔註解）。
 *
 * 呢個 module 唔可以 import 任何 runtime／`@/` 別名（要可以 node --test 直接載入）。
 */

/** 距離到期少於呢個時間就主動 refresh（提案口徑：≤5 分鐘）。 */
export const LEDGER_REFRESH_SKEW_MS = 5 * 60 * 1000;

export type LedgerSessionAction =
  /** POS storage 冇 token ⇒ 上層 return null（未登入／已登出）。 */
  | { action: "unauthorized" }
  /** client 未接管過 session（或要換身份）⇒ `setSession()` 一次。 */
  | { action: "bootstrap" }
  /** client 張快過期 ⇒ `refreshSession()`，新票寫返 POS storage。 */
  | { action: "refresh" }
  /** 記憶體有未過期 session ⇒ `getSession()` 本地讀，零網路。 */
  | { action: "reuse" };

export interface LedgerSessionDecisionInput {
  /** POS storage 嘅 access token（`loadAuthSession().ledgerAccessToken`）。 */
  storedAccessToken: string | null;
  /**
   * POS storage 張票嘅到期時間（epoch ms，本地解 JWT `exp` 拿到）；讀唔到傳 null。
   * 只用嚟分辨「storage 張係新身份」vs「client 先醒 refresh 過」。
   */
  storedExpiresAtMs: number | null;
  /** client 記憶體 session 嘅 access token（`getSession()` 攞到；未有就 null）。 */
  clientAccessToken: string | null;
  /** client session 到期時間（epoch ms）；讀唔到傳 null。 */
  clientExpiresAtMs: number | null;
  nowMs: number;
}

/**
 * 唯一決策入口。**唔會 throw**——任何唔肯定嘅情況都落返四個動作之一，
 * 由 `session.ts` 執行（pure ⇒ 可以逐條 node --test）。
 */
export function decideLedgerSessionAction(input: LedgerSessionDecisionInput): LedgerSessionAction {
  if (!input.storedAccessToken) return { action: "unauthorized" };

  // client 未接管過（每次開頁第一次）⇒ 一定要 setSession 一次。
  if (!input.clientAccessToken) return { action: "bootstrap" };

  if (input.clientAccessToken !== input.storedAccessToken) {
    // storage 張仍然有效 ⇒ 係「新身份」（另一分頁登入過／刷新過）⇒ bootstrap 換過去。
    // storage 張已過期／快過期 ⇒ client 先醒 refresh 過（rotation 換咗票）⇒ 以 client
    //   為準，落去個 reuse／refresh 判斷（上層會順手 sync 返 storage）。
    const storedStillFresh =
      input.storedExpiresAtMs !== null &&
      input.storedExpiresAtMs - input.nowMs > LEDGER_REFRESH_SKEW_MS;
    if (storedStillFresh) return { action: "bootstrap" };
  }

  // 到期時間讀唔到 ⇒ 唔好博，寧願 refresh 一次都唔好放過期票出去。
  if (input.clientExpiresAtMs === null) return { action: "refresh" };
  if (input.clientExpiresAtMs - input.nowMs <= LEDGER_REFRESH_SKEW_MS) return { action: "refresh" };

  return { action: "reuse" };
}
