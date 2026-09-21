"use client";

/**
 * 《真人互動追蹤》（2026-09-21）—— 畀輪詢閘判斷「有冇人喺度用」。
 *
 * ── 為咩需要 ─────────────────────────────────────────────────────────────
 * 實測：關店時段仍然 15.2 次/分鐘，而**全系統冇任何 idle 偵測**。
 * 大量商家長期掛住個網頁 ＝ 資源被慢慢燒乾。呢個模組提供唯一真相：
 * **最後一次真人互動嘅時間**。
 *
 * ── 設計紀律 ─────────────────────────────────────────────────────────────
 * 1. **module singleton ＋ 單一 listener**：多個呼叫端共用同一組 DOM listener
 *    （同 `use-store-status.ts` / `pending-count-store.ts` 同一個反 thundering-herd 紀律；
 *    唔可以每個 hook 各自 addEventListener）。
 * 2. **refCount 安裝**：`ensureActivityTracking()` 回傳 uninstall；最後一個用完就拆。
 * 3. **只記時間，唔做任何請求**：呢個模組**零網絡**，所以成本係零。
 * 4. **唔用 `performance.now()`**：要同 `Date.now()` 同一個鐘域（輪詢閘用 `Date.now()`）。
 *
 * ⚠️ 只計「**真人**互動」：`pointerdown` / `keydown` / `wheel` / `touchstart`。
 * **唔可以**計 `mousemove`（POS 有滑鼠嘅機會有，但更重要係 mousemove 會被
 * 系統提示 / 動畫觸發，唔代表有人用）。亦**唔可以**計程式化事件（例如
 * `dispatchEvent`），否則自己嘅程式碼就會令閘門永遠唔會 idle。
 *
 * ⚠️ `visibilitychange` 返前景**亦算一次互動**（用戶主動切返嚟睇）。
 */

let lastActivityAtMs = 0;
let installCount = 0;

const activityListeners = new Set<() => void>();
/** 一次性安裝嘅 DOM handler（要拆得返，所以留住參考）。 */
let domHandler: (() => void) | null = null;

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** 記一次互動。公開係為咗「程式化但確實代表有人在用」嘅情境（例如落單成功）。 */
export function markActivity(nowMs: number = Date.now()): void {
  lastActivityAtMs = nowMs;
  for (const listener of activityListeners) listener();
}

/** 最後一次互動時間（ms）。`0` ＝ 從未互動過（輪詢閘會當「剛活躍」，fail-open）。 */
export function getLastActivityAtMs(): number {
  return lastActivityAtMs;
}

/** 距離最後一次互動幾久（ms）。 */
export function idleSinceMs(nowMs: number = Date.now()): number {
  if (!Number.isFinite(lastActivityAtMs) || lastActivityAtMs <= 0) return 0;
  return Math.max(0, nowMs - lastActivityAtMs);
}

/**
 * 訂閱「有互動」。用嚟喺**閒置之後**即刻恢復（唔使等下一次 interval tick）。
 * @returns unsubscribe
 */
export function subscribeActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

/**
 * 安裝 DOM 監聽（refCount）。
 * @returns uninstall（最後一個呼叫者拆走時真正移除 listeners）
 */
export function ensureActivityTracking(): () => void {
  installCount += 1;
  if (!domHandler && typeof window !== "undefined") {
    const handler = () => markActivity();
    domHandler = handler;
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, handler, { passive: true, capture: true });
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    installCount = Math.max(0, installCount - 1);
    if (installCount > 0 || !domHandler) return;
    for (const name of ACTIVITY_EVENTS) {
      window.removeEventListener(name, domHandler, { capture: true });
    }
    domHandler = null;
  };
}

/** 只供測試／診斷：目前安裝數。 */
export function getActivityTrackingInstallCount(): number {
  return installCount;
}
