"use client";

/**
 * 同步隊列 outbox 化（docs/111）—— 根治「交班畫面永遠顯示 N 筆未同步」。
 *
 * ## 點要有呢個模組
 *
 * 舊模型係「狀態流水帳」：事件上咗雲都留喺 queue 做 synced 墓碑，而推唔到嘅事件
 * （外店 / 無 storeId）一世留喺 pending。再加埋 `doFlush` 嘅「同 entityId 淨推最新
 * 一條」去重，輸家永遠選唔中 → 一張單 8 條事件有 7 條永久 pending（假陽性）。
 *
 * 更嚴重嘅係去重**唔理事件類型**：離線時 `ORDER_SETTLED`（server 用 `.update()`，
 * 0 列唔報錯）或 `ORDER_ITEM_VOIDED`（server 根本唔處理）可以贏過 `ORDER_CREATED`
 * → 張單喺 `pos_orders` 直接蒸發。
 *
 * ## 新模型（不變量）
 *   1. queue 入面淨係「未上雲嘅工作」—— 上咗雲就剷走，唔留墓碑；
 *   2. 每條事件都有明確下場：pending（推得到）/ skipped（推唔到但有原因）/ failed；
 *      **唔可以有「無限期 pending 但永遠唔推」嘅狀態**；
 *   3. 唔同 type 嘅事件唔會互相取代（取代淨限同 type + 同目標）；
 *   4. 推送按 createdAt 升序（`ORDER_CREATED` 一定先過 `ORDER_SETTLED`）。
 *
 * ## Feature flag
 * `localStorage["macau-pos/sync-outbox-v2"] === "0"` → 行返舊行為（append + 標 synced +
 * flush 去重）。出事即設 `"0"` 再 reload 就還原。穩定兩星期後可以拆 flag。
 */

import { loadQueue, saveQueue } from "@/lib/storage";
import { QueueEvent } from "@/lib/types";

export const OUTBOX_V2_FLAG_KEY = "macau-pos/sync-outbox-v2";

/** queue 上限：超出先剷 skipped、再剷 failed（由最舊開始）。 */
export const MAX_QUEUE_EVENTS = 2000;

/**
 * outbox v2 開關。默认開（undefined / 任何非 "0" 值都當開）。
 *
 * SSR 一律 false —— 呢個 flag 淨係喺 event handler / effect 用，唔好攞嚟 render，
 * 否則 server 同 client 首 render 會唔一致。
 */
export function isOutboxV2Enabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(OUTBOX_V2_FLAG_KEY) !== "0";
  } catch {
    return false;
  }
}

function ts(event: QueueEvent): number {
  const ms = Date.parse(event.createdAt ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 合併鍵：**只有「同一個目標 + 同一種操作」嘅事件先可以互相取代**。
 *
 * ⚠️ 唔可以淨用 `entityId`（舊 `doFlush` 就係咁）：訂單類事件嘅 entityId 全部係
 * `order.id`，`ORDER_CREATED` / `ORDER_UPDATED` / `ORDER_ITEM_VOIDED` / `ORDER_SETTLED`
 * 會互相取代 → server `.update()` 命中 0 列、張單喺雲端消失。
 *
 * 退菜要再拆到 item 級：同一張單退 3 件嘢係 3 條獨立事件，唔可以淨留最後一件。
 */
export function coalesceKey(event: QueueEvent): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "ORDER_ITEM_VOIDED": {
      const menuItemId = typeof payload.menuItemId === "string" ? payload.menuItemId : "";
      return `void:${event.entityId}:${menuItemId}`;
    }
    // 全機 / 全店設定：淨留最新一條就夠（舊嗰條已經被完全覆蓋）
    case "DEVICE_CONFIG_UPDATED":
    case "TEST_PRINT_REQUESTED":
      return event.type;
    default:
      // ORDER_* 各 type 分開保留；PRINT_JOB_* 嘅 entityId 本身已經唯一
      return `${event.type}:${event.entityId}`;
  }
}

/**
 * 入隊：撞 key 嘅**未推送**事件（status === "pending"）會被新事件原位取代，
 * 保住 queue 嘅時間次序；撞唔到就 append。
 *
 * v2 關咗就係純 append（同舊行為一致）—— call site 可以無條件用呢個函式。
 */
export function enqueueEvents(queue: QueueEvent[], incoming: QueueEvent[]): QueueEvent[] {
  if (incoming.length === 0) return queue;
  if (!isOutboxV2Enabled()) return [...queue, ...incoming];

  const next = queue.slice();
  for (const event of incoming) {
    const key = coalesceKey(event);
    const idx = next.findIndex((e) => e.status === "pending" && coalesceKey(e) === key);
    if (idx >= 0) {
      next[idx] = event; // 原位取代（唔改位置 → 唔打亂時間序）
    } else {
      next.push(event);
    }
  }
  return next;
}

/**
 * 判斷一條 pending 事件係咪「推唔到」。推唔到就畀佢一個終態（`skipped`），
 * 唔好一世留喺 pending 計落「未同步」。
 *
 * @returns 要改寫嘅事件；`null` = 唔使改（推得到，或者未登入仲未判得到）
 */
export function classifyQueueEvent(
  event: QueueEvent,
  currentStoreId?: string | null,
): QueueEvent | null {
  if (event.status !== "pending") return null;
  // 未登入 / Kiosk 未綁店：暫時唔落終態，等有店之後再判（reconcileQueueScope 會補做）
  if (!currentStoreId) return null;
  if (event.storeId === currentStoreId) return null;
  return {
    ...event,
    status: "skipped",
    skipReason: event.storeId ? "foreign-store" : "no-store",
  };
}

/**
 * 切店 / 切帳號後重新對焦 queue 嘅歸屬（配合 `prepareStoreStorage()` 同一時機 call）：
 *   - `skipped/foreign-store` 且 storeId === 新店 → reset 做 pending（返到自己店，重新排隊）
 *   - `pending` 但 storeId !== 新店 → 轉 skipped（唔好霸住「待同步」個數）
 *
 * @returns 有幾多條被重新排隊 / 被標 skipped
 */
export function reconcileQueueScope(currentStoreId?: string | null): {
  requeued: number;
  skipped: number;
} {
  if (typeof window === "undefined" || !currentStoreId) return { requeued: 0, skipped: 0 };
  if (!isOutboxV2Enabled()) return { requeued: 0, skipped: 0 };

  const queue = loadQueue();
  let requeued = 0;
  let skipped = 0;

  const next = queue.map((event) => {
    if (event.status === "skipped" && event.skipReason === "foreign-store" && event.storeId === currentStoreId) {
      requeued += 1;
      const restored: QueueEvent = { ...event, status: "pending" };
      delete restored.skipReason;
      return restored;
    }
    if (event.status === "pending" && event.storeId !== currentStoreId) {
      const classified = classifyQueueEvent(event, currentStoreId);
      if (classified) {
        skipped += 1;
        return classified;
      }
    }
    return event;
  });

  if (requeued > 0 || skipped > 0) {
    saveQueue(next);
    console.log(`[queue-outbox] 切店對焦：${requeued} 條重新排隊、${skipped} 條標 skipped`);
  }
  return { requeued, skipped };
}

/**
 * 一次性 GC（喺 flush worker install 時跑一次），清走 outbox 化之前積落嚟嘅垃圾：
 *   1. 剷 `synced` 墓碑（v2 唔再需要；queue 淨留未上雲嘅工作）
 *   2. 用 `coalesceKey()` 合併：撞 key 淨留最新一條
 *   3. classify pending → skipped（外店 / 無主）
 *   4. 超出 `MAX_QUEUE_EVENTS` 先剷 skipped、再剷 failed（由最舊開始）
 *
 * ⚠️ 只喺 v2 開住時跑：v1 嘅 synced 墓碑係「防止 server merge 復活」嘅唯一機制，剷咗會重推。
 */
export function gcSyncQueue(currentStoreId?: string | null): {
  droppedSynced: number;
  deduped: number;
  skipped: number;
  trimmed: number;
} {
  if (typeof window === "undefined" || !isOutboxV2Enabled()) {
    return { droppedSynced: 0, deduped: 0, skipped: 0, trimmed: 0 };
  }

  const queue = loadQueue();
  if (queue.length === 0) return { droppedSynced: 0, deduped: 0, skipped: 0, trimmed: 0 };

  // 1) 剷 synced 墓碑
  const withoutSynced = queue.filter((e) => e.status !== "synced");
  const droppedSynced = queue.length - withoutSynced.length;

  // 2) 合併：撞 key 淨留最新一條（時間相同就留後面嗰條）
  const keepIndex = new Set<number>();
  const latestByKey = new Map<string, number>();
  withoutSynced.forEach((event, index) => {
    const key = coalesceKey(event);
    const prevIndex = latestByKey.get(key);
    if (prevIndex === undefined || ts(event) >= ts(withoutSynced[prevIndex])) {
      if (prevIndex !== undefined) keepIndex.delete(prevIndex);
      latestByKey.set(key, index);
      keepIndex.add(index);
    }
  });
  let result = withoutSynced.filter((_, index) => keepIndex.has(index));
  const deduped = withoutSynced.length - result.length;

  // 3) classify
  let skipped = 0;
  result = result.map((event) => {
    const classified = classifyQueueEvent(event, currentStoreId);
    if (classified) {
      skipped += 1;
      return classified;
    }
    return event;
  });

  // 4) 上限：先剷 skipped，再剷 failed（都由最舊開始）；pending 一條都唔會剷
  let trimmed = 0;
  if (result.length > MAX_QUEUE_EVENTS) {
    const excess = result.length - MAX_QUEUE_EVENTS;
    const rank = (status: QueueEvent["status"]) => (status === "skipped" ? 0 : 1);
    const removeIndex = new Set(
      result
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.status === "skipped" || event.status === "failed")
        .sort((a, b) => {
          const byRank = rank(a.event.status) - rank(b.event.status);
          return byRank !== 0 ? byRank : ts(a.event) - ts(b.event);
        })
        .slice(0, excess)
        .map(({ index }) => index),
    );
    result = result.filter((_, index) => !removeIndex.has(index));
    trimmed = removeIndex.size;
  }

  if (droppedSynced > 0 || deduped > 0 || skipped > 0 || trimmed > 0) {
    saveQueue(result);
    console.log(
      `[queue-outbox] GC：剷 ${droppedSynced} 條墓碑、合併 ${deduped} 條、標 ${skipped} 條 skipped` +
        (trimmed > 0 ? `、超出上限剷 ${trimmed} 條` : "") +
        `（${queue.length} → ${result.length}）`,
    );
  }
  return { droppedSynced, deduped, skipped, trimmed };
}

/**
 * 交班畫面用嘅隊列摘要。
 *
 * `pendingEvents` = **真正會被推送**嘅數量：
 *   - 剔走外店 / 無 storeId（永遠唔推）
 *   - 剔走「去重輸家」：同 entityId 有更新事件喺度嘅舊事件（v1 模式下永遠選唔中）
 *
 * v2 模式正常情況下面兩個數都係 0，呢個 filter 只係 GC 行之前的保險。
 */
export function summarizeQueueEvents(
  queue: QueueEvent[],
  currentStoreId?: string | null,
): { pendingEvents: number; skippedEvents: number; failedEvents: number } {
  const pushable = queue.filter(
    (event) => event.status === "pending" && (!currentStoreId || event.storeId === currentStoreId),
  );

  // 去重輸家（v1）：同 entityId 淨推最新一條 → 舊嗰啲永遠選唔中
  const latestByEntity = new Map<string, QueueEvent>();
  for (const event of pushable) {
    const prev = latestByEntity.get(event.entityId);
    if (!prev || ts(prev) < ts(event)) latestByEntity.set(event.entityId, event);
  }
  const pendingEvents = pushable.filter((event) => latestByEntity.get(event.entityId)?.id === event.id).length;

  return {
    pendingEvents,
    skippedEvents: queue.filter((event) => event.status === "skipped").length,
    failedEvents: queue.filter((event) => event.status === "failed").length,
  };
}
