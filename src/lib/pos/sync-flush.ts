"use client";

/**
 * 餐飲收銀 / Kiosk 同步隊列自動 flush worker。
 *
 * 2026-09-01 新增：解決「本地推 ORDER_UPDATED / ORDER_SETTLED 後永不上 DB」的「鬼單復活」bug。
 *
 * 過往實作只會 `persistQueue([...pending])`（見 pos-app.tsx pushEvents），event status
 * 寫 "synced" 但**完全唔 trigger fetch("/api/pos/sync")**。結果：
 *   - localStorage 寫咗 cancelled / sent_to_kitchen / settled，DB 仲係 draft；
 *   - 用戶重開瀏覽器或第二部收銀機 → loadRuntimeState() pull server 嘅 draft 蓋返本地 →
 *     「鬼」單又彈返出嚟（用戶截圖：自助單 reject / confirm 完嘅單全部喺訂單頁「點單中」）。
 *
 * 設計（向 salon `flushSalonSyncQueue` 致敬，序列化 + dedupe + 自動 retry）：
 *   1. **Chain lock**：所有 flush 排隊（`flushChain`），避免並發搶同一 queue 造成重複上推 / 寫競態。
 *   2. **Dedup**：用 `Map<entityId, latestEventId>` 去重，同一 entityId 只推最後一條事件。
 *      解決「confirmSelfOrder 連續推兩條 ORDER_UPDATED → 重複 upsert + 浪費 quota」嘅情況。
 *   3. **Attempts**：每個 event 加 attempts counter（默認 0），超過 MAX_SYNC_ATTEMPTS 標
 *      "failed" 保留喺 queue（唔好丟，數據仲喺 localStorage 嘅 orders 內），等 manual inspect。
 *   4. **Silent**：預設靜默，唔出 toast；manual call 可傳 silent:false（保留舊合約）。
 *
 * Trigger 點（set by 任何 caller）：
 *   - pos-app.tsx pushEvents() 後（每個落單事件 / 結帳事件 / 退菜事件都會 trigger）
 *   - pos-orders.ts confirmSelfOrder / rejectSelfOrder 後
 *   - pos-app.tsx mount 時（ensure boot 後任何 stale pending 都會被 flush）
 *   - online / pos-network-status-changed 事件（reconnect 即推）
 *   - 30s 兜底 interval（兜任何遺漏）
 */

import { readNetworkOnline } from "@/lib/use-network-online";
import { loadAuthSession, loadQueue, saveQueue } from "@/lib/storage";
import { loadKioskDeviceBinding } from "@/lib/kiosk-order";
import { QueueEvent } from "@/lib/types";

export const POS_SYNC_QUEUE_CHANGED_EVENT = "pos-sync-queue-changed";

const MAX_SYNC_ATTEMPTS = 5;
const MAX_EVENTS_PER_FLUSH = 100; // 對齊 server-side `MAX_EVENTS_PER_REQUEST`
const FLUSH_INTERVAL_MS = 30_000;

type ExtendedQueueEvent = QueueEvent & { attempts?: number };

let flushChain: Promise<void> = Promise.resolve();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let listenersInstalled = false;
let triggerFn: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;

/**
 * 排入 flush chain（serialized）：並發 caller 自動排隊，唔會同時開多個 flush。
 * 唔會 throw（內部 try/catch + console.warn）。
 */
export function flushPosSyncQueue(options: { silent?: boolean } = {}): Promise<void> {
  flushChain = flushChain.then(() => doFlush(options));
  return flushChain;
}

/**
 * 安裝全局 listener：online 事件 + 30s 兜底 interval + mount 時一次性 flush。
 * 同一 page 重複 call 只 install 一次（idempotent）。
 */
export function installPosSyncQueueAutoFlush(): void {
  if (typeof window === "undefined") return;
  if (listenersInstalled) return;
  listenersInstalled = true;

  const trigger = () => {
    void flushPosSyncQueue({ silent: true });
  };
  triggerFn = trigger;

  window.addEventListener("online", trigger);
  window.addEventListener("offline", trigger);
  // pos-app 嘅 online state 變動事件（見 use-network-online.ts）
  window.addEventListener("pos-network-status-changed", trigger as EventListener);
  // 任何 caller 主動 enqueue 後會 dispatch 呢個 event（見 notifyQueueChanged）
  window.addEventListener(POS_SYNC_QUEUE_CHANGED_EVENT, trigger as EventListener);
  // visibility 變化：tab 重新 active 時試 flush（背景 tab 未必觸發 online 事件）
  visibilityHandler = () => {
    if (document.visibilityState === "visible") trigger();
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  intervalHandle = setInterval(trigger, FLUSH_INTERVAL_MS);

  // 啟動時一次性 flush：stale pending 唔會留過夜
  trigger();
}

/**
 * 解除全局 listener（主要用於測試）。
 */
export function uninstallPosSyncQueueAutoFlush(): void {
  if (typeof window === "undefined") return;
  if (!listenersInstalled) return;
  listenersInstalled = false;
  if (triggerFn) {
    window.removeEventListener("online", triggerFn);
    window.removeEventListener("offline", triggerFn);
    window.removeEventListener("pos-network-status-changed", triggerFn as EventListener);
    window.removeEventListener(POS_SYNC_QUEUE_CHANGED_EVENT, triggerFn as EventListener);
  }
  if (visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler);
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
  }
  intervalHandle = null;
  triggerFn = null;
  visibilityHandler = null;
}

/**
 * 任何 caller enqueue 之後可以 call 呢個 trigger flush（同埋廣播畀其他 panel）。
 * 喺 silent 模式下 fire flush，唔會出 toast。
 */
export function notifyQueueChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(POS_SYNC_QUEUE_CHANGED_EVENT));
  void flushPosSyncQueue({ silent: true });
}

/**
 * 取消一個 event（手動放棄 / 用戶決定唔推），由 caller 負責（呢度唔自動）。
 */
export function markQueueEventFailed(eventId: string, reason?: string): void {
  const queue = loadQueue() as ExtendedQueueEvent[];
  const next = queue.map((e) =>
    e.id === eventId
      ? { ...e, status: "failed" as const, attempts: (e.attempts ?? 0) + 1 }
      : e,
  );
  saveQueue(next);
  // eslint-disable-next-line no-console
  if (reason) console.warn(`[pos-sync-flush] event ${eventId} 標 failed：${reason}`);
}

/**
 * 攞當前 sync 應寫嘅 storeId：
 *   1. 收銀台登入咗 → authSession.merchantId
 *   2. 否則 kiosk 綁咗店 → loadKioskDeviceBinding().storeId
 *   3. 兩者都冇 → 唔傳 storeId（server-side 會 fallback DEFAULT_STORE_ID，唔影響 sync）。
 *
 * 注意：跨店污染嘅 source-of-truth 係 server 0016 migration + pos_orders.store_id。
 * 客戶端傳 storeId 只係加速 server-side validation；server 落 row 時會以 payload
 * `source` + 路由 storeId 對齊。如果唔對齊，server 嘅 RLS / unique constraint 會擋。
 */
function resolveStoreId(): string | undefined {
  const auth = loadAuthSession();
  if (auth?.merchantId) return auth.merchantId;
  const binding = loadKioskDeviceBinding();
  if (binding?.storeId) return binding.storeId;
  return undefined;
}

async function doFlush(options: { silent?: boolean }): Promise<void> {
  if (typeof window === "undefined") return;
  if (!readNetworkOnline()) return;

  const allQueue = loadQueue() as ExtendedQueueEvent[];
  if (allQueue.length === 0) return;

  // 只推 pending + failed（synced 留喺度係預期行為：保留審計 + 防 silent data loss）
  const unflushed = allQueue.filter((e) => e.status !== "synced");
  if (unflushed.length === 0) return;

  // Dedup by entityId + 過濾超 attempts：同一 entityId 只推最後一條（最後狀態為準），
  // 超 attempts 嘅自動淘汰（同 entityId 有新未超 attempts 嘅就推嗰條）。
  // 注意 ORDER_UPDATED / ORDER_CREATED 同 entity 會 dedup，PRINT_JOB_CREATED 唔會（唔同 entityId）。
  const candidateByEntity = new Map<string, ExtendedQueueEvent>();
  for (const e of unflushed) {
    if ((e.attempts ?? 0) >= MAX_SYNC_ATTEMPTS) continue;
    const prev = candidateByEntity.get(e.entityId);
    if (!prev || prev.createdAt < e.createdAt) {
      candidateByEntity.set(e.entityId, e);
    }
  }
  const flippable = Array.from(candidateByEntity.values()).slice(0, MAX_EVENTS_PER_FLUSH);
  if (flippable.length === 0) return;

  let result: Response;
  try {
    const storeId = resolveStoreId();
    result = await fetch("/api/pos/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(storeId ? { storeId } : {}),
        events: flippable.map((e) => ({
          id: e.id,
          type: e.type,
          entityId: e.entityId,
          payload: e.payload,
          status: e.status,
          createdAt: e.createdAt,
        })),
      }),
    });
  } catch (err) {
    // 離線 / 網絡錯誤：保留 pending，唔加 attempts（避免純網絡抖動快速 burn 掉 quota）
    // eslint-disable-next-line no-console
    console.warn("[pos-sync-flush] fetch 失敗（保留 pending 等待下次 flush）：", err);
    return;
  }

  if (!result.ok) {
    // Server-side error：加 attempts。連續 MAX 次都失敗就標 failed。
    const next = allQueue.map((e) => {
      if (!flippable.find((f) => f.id === e.id)) return e;
      const attempts = (e.attempts ?? 0) + 1;
      return {
        ...e,
        attempts,
        status: (attempts >= MAX_SYNC_ATTEMPTS ? "failed" : "pending") as "failed" | "pending",
      };
    });
    saveQueue(next);
    if (!options.silent) {
      // eslint-disable-next-line no-console
      console.warn(`[pos-sync-flush] server 拒收 ${flippable.length} 筆同步事件（status ${result.status}）`);
    }
    return;
  }

  // 成功：flippable 全部標 synced（保留佢哋喺 queue，等下次 cleanup / 永遠保留都得）
  const flippedIds = new Set(flippable.map((e) => e.id));
  const nextQueue = allQueue.map((e) =>
    flippedIds.has(e.id) ? { ...e, status: "synced" as const, attempts: 0 } : e,
  );
  saveQueue(nextQueue);

  if (!options.silent) {
    // eslint-disable-next-line no-console
    console.log(`[pos-sync-flush] 已同步 ${flippable.length} 筆事件`);
  }
}