"use client";

/**
 * 《輪詢閘》執行層（2026-09-21）。
 *
 * 純決策喺 `./poll-gate.ts`（零 import、有單測）；呢個檔負責**讀真實狀態**
 * 再餵入去，同 `close-gate.ts` / `close-gate-run.ts` 同一分檔法。
 *
 * ## 用法（最小改動）
 *
 * 喺現有嘅 `setInterval` callback **第一行**加一句：
 *
 * ```ts
 * const timer = window.setInterval(() => {
 *   if (!evaluatePollGate({ tag: "pos/shift" }).poll) return;   // ← 加呢句
 *   void syncOnce();
 * }, 180_000);
 * ```
 *
 * 保留 interval 本身唔拆 —— tick 係**本地零成本**，而 request 先係成本。
 * 要「閒置之後即刻恢復」就另外 `subscribeIdleRecovery(() => void syncOnce())`。
 *
 * ## 為何評估即消耗配額
 *
 * `evaluatePollGate()` 回 `poll: true` 時會**順手**更新 `lastPolledAtMs`，
 * 咁每個呼叫端就唔使各自維護一個 timestamp（少一個可以漂移嘅狀態）。
 * `urgent: true`（推本機事件上雲）**唔會**消耗配額 —— 佢唔受最短間隔限制。
 *
 * ## 失敗方向
 *
 * 任何讀取失敗／未讀到（`null`）一律當「未知」→ **照跑**（fail-open）。
 * 詳見 `poll-gate.ts` 頂部。
 */

import { loadAuthSession, loadQueue, loadShiftState } from "@/lib/storage";

import { getLastActivityAtMs, subscribeActivity } from "./activity-tracker.ts";
import { decidePoll, type PollGateDecision } from "./poll-gate.ts";
import { getMerchantOrderConfigSnapshot } from "./use-merchant-order-config";
import { getStoreStatusSnapshot } from "./use-store-status";

/** 上一次真正放行嘅時間（ms）。0 ＝ 從未放行過 → 第一次一定放行。 */
let lastPolledAtMs = 0;
/**
 * Realtime 通唔通。`null` ＝ 未報告（未訂上／未收到 status）——
 * **當唔通**，即用返 60 秒節奏（fail-open，唔會因為未知而少拉）。
 */
let realtimeConnected: boolean | null = null;
/** 上一次評估係唔係「因為閒置」而停 —— 用嚟喺恢復時只觸發一次。 */
let wasIdle = false;
/** 上一次嘅 reason（只喺變化時 log，避免洗版）。 */
let lastLoggedReason: string | null = null;

/** 由 `usePosRealtime` 嘅 `onStatusChange` 報告（`status === "SUBSCRIBED"` → true）。 */
export function reportRealtimeConnected(connected: boolean): void {
  realtimeConnected = connected;
}

/** 只供測試／診斷。 */
export function getRealtimeConnectedForGate(): boolean | null {
  return realtimeConnected;
}

/** 只供測試／診斷。 */
export function getLastPolledAtMs(): number {
  return lastPolledAtMs;
}

/** 手動重設配額（例如切店／換裝置）。 */
export function resetPollGateQuota(): void {
  lastPolledAtMs = 0;
}

/**
 * 評估「而家可唔可以打」。
 *
 * @param opts.kind `"periodic"`（預設，timer 驅動，受全部閘限制）／
 *   `"triggered"`（事件驅動嘅一次性拉取：mount backfill、重連補拉、手勢 ——
 *   只受「冇 session」「分頁隱藏」限制）。見 `poll-gate.ts` 嘅 `kind` 說明。
 * @param opts.urgent `true` ＝ 有本機事件要即刻推上雲；只受「有 session ＋ 可見」限制。
 * @param opts.tag 只供 `console.debug` 診斷（唔影響判斷）。
 */
export function evaluatePollGate(
  opts: { urgent?: boolean; kind?: "periodic" | "triggered"; tag?: string } = {},
): PollGateDecision {
  const nowMs = Date.now();
  const session = loadAuthSession();
  const shift = loadShiftState();

  const decision = decidePoll({
    sessionAlive: Boolean(session),
    visibilityState: typeof document === "undefined" ? "visible" : document.visibilityState,
    lastActivityAtMs: getLastActivityAtMs(),
    nowMs,
    // `pos_store_status`：`null` ＝ 未讀到（唔可以當 false）。
    storeOpen: getStoreStatusSnapshot().isOpen,
    // Ledger `merchant_enabled`：`null` ＝ 未接通。
    onlineChannelOpen: getMerchantOrderConfigSnapshot().merchantEnabled,
    // ⚠️ 本機冇 `openedAt` ＝ **未開工**（同 server 對 `pos_shifts` 嘅口徑一致：
    //    冇 open row ＝ 未開工）。未開工時客人根本落唔到單（server 有班次閘）。
    shiftOpen: Boolean(shift?.openedAt),
    hasPendingSyncEvents: loadQueue().some((event) => event.status === "pending"),
    realtimeConnected,
    lastPolledAtMs,
    urgent: opts.urgent,
    kind: opts.kind,
  });

  // ⚠️ `triggered` / `urgent` 唔應該污染 `wasIdle`（佢哋唔代表「有人用」）。
  if (opts.kind !== "triggered" && !opts.urgent) {
    wasIdle = decision.reason === "idle";
  }

  if (decision.poll) {
    // ⚠️ `urgent`（推本機事件）同 `triggered`（事件驅動一次性）都**唔會**消耗配額 ——
    // 佢哋唔受最短間隔限制，否則會出現「補拉之後 5 分鐘內唔准再拉」嘅怪行為。
    if (!opts.urgent && opts.kind !== "triggered") lastPolledAtMs = nowMs;
    if (lastLoggedReason !== "ok") {
      lastLoggedReason = "ok";
      // 唔用 console.log：呢條係診斷，info 級會混入正常輸出。
      console.debug(
        `[poll-gate] 恢復輪詢${opts.tag ? `（${opts.tag}）` : ""} minInterval=${decision.minIntervalMs}ms`,
      );
    }
  } else if (lastLoggedReason !== decision.reason) {
    lastLoggedReason = decision.reason;
    console.debug(
      `[poll-gate] 暫停輪詢：${decision.reason}${opts.tag ? `（${opts.tag}）` : ""}`,
    );
  }

  return decision;
}

/**
 * 訂閱「由閒置恢復」—— 喺用戶返嚟嗰一刻即刻補一次，唔使等下一次 interval tick。
 *
 * ⚠️ **只會喺「上一次評估係 idle」之後嘅第一次互動**觸發，所以正常操作唔會連環打。
 * @returns unsubscribe
 */
export function subscribeIdleRecovery(onRecover: () => void): () => void {
  return subscribeActivity(() => {
    if (!wasIdle) return;
    wasIdle = false;
    lastPolledAtMs = 0; // 恢復即刻補一次，唔受最短間隔限制
    onRecover();
  });
}
