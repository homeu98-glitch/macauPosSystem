"use client";

import { loadOrders, loadPrintJobs, loadStateSyncMeta, saveStateSyncMeta } from "@/lib/storage";
import { resolveSince, watermarkAfterPull } from "@/lib/pos/state-sync-watermark";

/**
 * 《增量拉取水位 —— 客戶端執行層》（2026-09-22 P1／P3）。
 *
 * ## 為咩要抽一個共用模組
 *
 * `/api/pos/state` 有**兩個**會拉訂單嘅 client 入口：
 *
 * | 入口 | 用途 | 改動前每次 | 改動後 |
 * |---|---|---|---|
 * | `pos-app.tsx` `loadRuntimeState()` | 收銀工作台全量 backfill | **412 KB** | **~30 KB** |
 * | `local-orders-panel.tsx` `pullServerOrders()` | 訂單頁 backfill | **~296 KB**（200 張 × 1.5 KB） | **~3 KB** |
 *
 * 兩者都需要「幾時可以信 `since`」嘅同一套判斷（純邏輯收喺
 * `@/lib/pos/state-sync-watermark`，12 條單測）。如果各自寫一份，
 * 兩邊口徑一漂移就會出現「一邊以為有水位、另一邊以為冇」⇒ 其中一邊靜默唔更新。
 *
 * ## 為何兩個入口可以共用同一個水位（安全論證）
 *
 * 水位係 **store-scope localStorage** ⇒ **同一部機／同一個瀏覽器共用**。
 * 假設 pos-app 先拉（水位由 T0 → T1），訂單頁之後用 T1 拉 ⇒ 會錯過 (T0, T1) 嘅變更。
 * 但：
 *   · pos-app 嗰次拉取**已經 merge 落 localStorage**，而訂單頁嘅清單本身就係讀 localStorage
 *     （`loadOrders()`），訂單頁亦會收到 `pos-orders-changed` 事件 ⇒ **唔會漏**；
 *   · 兩者係同一個 JS realm（同一個 window）→ 狀態共享，唔存在「兩個獨立終端」嘅情境；
 *   · **第二部 iPad 有自己嘅 localStorage ⇒ 自己嘅水位**，天然獨立。
 *
 * ## 使用方式（三個入口都要跟同一個次序）
 *
 * ```ts
 * const since = beginStateSince();            // 1. 開請求之前
 * const res = await fetch(`${url}${since.param}`);
 * const payload = await res.json();
 * commitStateSince(since, Boolean(payload.truncated));  // 2. 成功之後
 * ```
 *
 * ⚠️ `truncated`（增量撞 `limit` / 查詢失敗）→ **清水位**，
 * 令下一次一定走全量（唔可以靜默截斷，見 route 嘅說明）。
 */

export interface StateSinceTicket {
  /** 直接接落 URL 尾嘅 query 片段（`&since=...` 或空字串）。 */
  param: string;
  /** 請求開始時間 —— 成功之後用佢做新水位（唔用回應時間，避免漏請求期間嘅寫入）。 */
  requestStartedAtMs: number;
  /** 今次係咪增量（false ＝ 全量）。 */
  incremental: boolean;
  /** 診斷用：`resolveSince()` 嘅判斷原因。 */
  reason: string;
}

/** 開請求之前：讀水位 + 本機狀態，砌出 `since` query 片段。 */
export function beginStateSince(opts?: { forceFull?: boolean }): StateSinceTicket {
  const requestStartedAtMs = Date.now();
  const decision = resolveSince({
    lastSyncedAt: loadStateSyncMeta()?.syncedAt ?? null,
    hasLocalData: loadOrders().length > 0 || loadPrintJobs().length > 0,
    nowMs: requestStartedAtMs,
    forceFull: Boolean(opts?.forceFull),
  });
  return {
    param: decision.since ? `&since=${encodeURIComponent(decision.since)}` : "",
    requestStartedAtMs,
    incremental: !decision.fullPull,
    reason: decision.reason,
  };
}

/** 成功之後：更新水位（`truncated` ⇒ 清水位，下次走全量）。 */
export function commitStateSince(ticket: StateSinceTicket, truncated?: boolean): void {
  if (truncated) {
    saveStateSyncMeta({ syncedAt: null });
    return;
  }
  saveStateSyncMeta({ syncedAt: watermarkAfterPull(ticket.requestStartedAtMs) });
}
