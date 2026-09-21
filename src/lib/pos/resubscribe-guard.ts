/**
 * 《realtime 重連補拉》守衛（2026-09-21 egress 優化）。
 *
 * ## 為何要有（實測，唔係估算）
 *
 * Vercel log 實測：**連續 9 分鐘、每 4.47 秒一次**嘅全量 state 拉取，
 * 每次 **857 KB**（orders 200 ＋ queue 300 ＋ printJobs 200 ＋ 設定）
 * ⇒ 單單嗰 9 分鐘就 **80 MB**，佔該窗口全部 egress **96%**。
 * 秒級間隔全部落喺 3–4.5 秒、103 次之中**冇任何兩次喺同一秒** ⇒ **定時循環**（唔係人手點）。
 * 對得上 `use-pos-realtime.ts` 嘅 `RESUBSCRIBE_DEBOUNCE_MS = 3000`：
 * channel 反覆「訂上 → 即斷」時，每輪都 `onResubscribed()` → `loadRuntimeState()`，
 * 而每次成功訂上都 reset `reconnectAttempt` ⇒ 重連永遠 3 秒（Safari 背景分頁會殺 WebSocket）。
 *
 * ## 兩個致命嘅「唔可以拆」
 *
 *  ① **唔可以連 `loadRuntimeState()` 本身加節流** —— mount／手動更新／
 *     `backToTables()`（`setRuntimeRefreshTick`）都係**刻意即時刷新**嘅入口，擋咗會變功能問題。
 *     所以守衛只可以放喺 `onResubscribed` 呢個「重連補拉」路徑。
 *  ② **唔可以只靠最少間隔、唔加「隱藏唔拉」** —— 背景分頁循環每 4.47 秒一輪，
 *     單靠 30 秒間隔仍然會每 30 秒拉一次 857 KB（＝每 9 分鐘 17 次 ×857 KB）。
 *     加咗「隱藏唔拉」之後背景係 **0 次**。
 *
 * ## 正確性論證（唔會漏事件）
 *
 * 分頁一返前景 → `visibilitychange` → `subscribe()` → `SUBSCRIBED` → 呢個 callback
 * 再跑一次（此時 `visibilityState === "visible"`、而且通常已隔足時間）⇒ **一定補到**。
 * 即係「睡醒之後一定睇到最新狀態」嘅保證完全保留。
 */

export interface ResubscribeBackfillInput {
  /** 離線模式（`offlineMode`）→ 一律唔拉（原本已有嘅條件）。 */
  offlineMode: boolean;
  /** 本機 outbox 仲有未推事件（`pending`）→ 唔拉，避免覆蓋未上雲嘅新單（原本已有嘅條件）。 */
  hasPendingEvents: boolean;
  /** `document.visibilityState`（用 string 而唔用 DOM 型別，令呢個模組保持零依賴）。 */
  visibilityState: string;
  /** 上一次全量拉取嘅時間（`loadRuntimeState()` 開跑時記）。0 = 從未拉過。 */
  lastFullPullAtMs: number;
  /** 現在時間。 */
  nowMs: number;
  /** 最少間隔（ms）。傳 0 = 唔節流（仍保留「隱藏唔拉」）。 */
  minGapMs: number;
}

export interface ResubscribeBackfillDecision {
  ok: boolean;
  /** 唔拉嘅原因（診斷用；`ok:true` 時係 undefined）。 */
  reason?: "offline" | "pending-events" | "hidden" | "too-soon";
}

/**
 * 判斷「重連補拉」應唔應該真係拉一次。
 *
 * 次序刻意同原本嘅 early-return 一致（行為等價），只係多咗 `hidden` / `too-soon` 兩道閘。
 */
export function shouldBackfillOnResubscribe(input: ResubscribeBackfillInput): ResubscribeBackfillDecision {
  if (input.offlineMode) return { ok: false, reason: "offline" };
  if (input.hasPendingEvents) return { ok: false, reason: "pending-events" };
  if (input.visibilityState !== "visible") return { ok: false, reason: "hidden" };
  if (input.minGapMs > 0 && input.lastFullPullAtMs > 0) {
    if (input.nowMs - input.lastFullPullAtMs < input.minGapMs) {
      return { ok: false, reason: "too-soon" };
    }
  }
  return { ok: true };
}
