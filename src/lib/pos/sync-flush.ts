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
 *   2. **Attempts**：每個 event 加 attempts counter（默認 0），超過 MAX_SYNC_ATTEMPTS 標
 *      "failed" 保留喺 queue（唔好丟，數據仲喺 localStorage 嘅 orders 內），等 manual inspect。
 *   3. **Silent**：預設靜默，唔出 toast；manual call 可傳 silent:false（保留舊合約）。
 *
 * Trigger 點（set by 任何 caller）：
 *   - pos-app.tsx pushEvents() 後（每個落單事件 / 結帳事件 / 退菜事件都會 trigger）
 *   - pos-orders.ts confirmSelfOrder / rejectSelfOrder 後
 *   - pos-app.tsx mount 時（ensure boot 後任何 stale pending 都會被 flush）
 *   - online / pos-network-status-changed 事件（reconnect 即推）
 *   - 30s 兜底 interval（兜任何遺漏）
 *
 * ## 2026-09-08 outbox 化（docs/111）—— 去重由 flush 搬到入隊
 *
 * 舊版第 2 點「同 entityId 淨推最新一條」有兩個禍：
 *   a) 輸家永遠選唔中 → 永久 pending → 交班畫面假報「N 筆未同步」；
 *   b) 去重**唔理 type**：離線時 `ORDER_SETTLED`（server `.update()` 命中 0 列唔報錯）
 *      或 `ORDER_ITEM_VOIDED`（server 根本唔處理）可以贏過 `ORDER_CREATED` → 張單喺雲端消失。
 *
 * 家陣改為：**入隊時**按 `coalesceKey()`（同 type + 同目標，退菜再拆到 item 級）取代，
 * flush 唔再做去重 → 所有 pending 都會被推送，推送順序按 createdAt 升序
 * （保證 ORDER_CREATED 先過 ORDER_SETTLED）。
 *
 * 成功之後（v2）由「標 synced」改為**直接剷走**呢啲事件 —— queue 淨留未上雲嘅工作。
 * 推唔到嘅（外店 / 無 storeId）喺 flush 前 classify 做 `skipped` 終態，唔再一世霸住 pending。
 * 全部改動受 `isOutboxV2Enabled()` feature flag 保護（`localStorage` 設 "0" 即還原）。
 */

import { readNetworkOnline } from "@/lib/use-network-online";
import { loadAuthSession, loadOrders, loadQueue, saveQueue, type SyncAckRow } from "@/lib/storage";
import { loadKioskDeviceBinding } from "@/lib/kiosk-order";
import { QueueEvent } from "@/lib/types";
import { classifyQueueEvent, gcSyncQueue, isOutboxV2Enabled } from "@/lib/pos/queue-outbox";
import { posDeviceAuthHeaders, refreshPosDeviceTokenIfNeeded } from "@/lib/pos/pos-sync-auth";
import { broadcastSyncHealth, putSyncAcks, shouldTrackAck } from "@/lib/pos/sync-acks";

export const POS_SYNC_QUEUE_CHANGED_EVENT = "pos-sync-queue-changed";

/**
 * 有 event **永久**同步失敗（attempts 到頂）時廣播畀 UI。
 *
 * ⚠️ 唔可以 reuse `POS_SYNC_QUEUE_CHANGED_EVENT`：嗰個被 `installPosSyncQueueAutoFlush`
 * 當 trigger 用（聽到就 flush），喺 doFlush 入面 dispatch 佢會**無限迴圈**。呢個係淨係
 * 畀 UI 聽嘅單向通知，flush 邏輯唔會聽。
 *
 * 點解要有：永久 failed 嘅 event 之後會俾 doFlush 第 209 行 `continue` 跳過，
 * **永遠唔會再重試**；而全個 app 本來零 UI 顯示佢哋（backoffice 同步頁讀嘅係
 * server 紀錄，傳唔到 server 嘅 event 當然唔會出現喺度）。
 */
export const POS_SYNC_FAILED_EVENT = "pos-sync-failed";

const MAX_SYNC_ATTEMPTS = 5;
/** 對齊 server-side `MAX_EVENTS_PER_REQUEST`（/api/pos/sync 上限 200）。 */
const MAX_EVENTS_PER_FLUSH = 200;
const FLUSH_INTERVAL_MS = 30_000;

/**
 * `attempts` 到頂之後嘅**慢速重試**間隔（docs/112 M2，2026-09-10）。
 *
 * 舊行為：attempts ≥ MAX_SYNC_ATTEMPTS → `failed` → `selectFlippable` 永遠唔揀
 * → **永久放棄**。若撞啱「憑證過期 / server 短暫 5xx / payload 一時寫唔入」，
 * 一次連續 5 次失敗就等於嗰張單永遠上唔到雲，而本地 UI 仲顯示「已完成」。
 *
 * 新行為：`failed` 只係「退避狀態」，過咗呢個間隔就會自動再試一次；
 * 真正需要人介入嘅係對賬守護標出嘅 `blocked`（連續多輪都對唔上）。
 */
const FAILED_RETRY_BACKOFF_MS = 15 * 60 * 1000;

type ExtendedQueueEvent = QueueEvent & { attempts?: number };

let flushChain: Promise<void> = Promise.resolve();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let listenersInstalled = false;
let triggerFn: (() => void) | null = null;
let visibilityHandler: (() => void) | null = null;
/**
 * 是否已跑過「legacy heal」flush。
 *
 * 舊版 pushEvents 寫 status:"synced" 但從未 fire fetch（即係 queue 內 status 完全不可信），
 * 所以呢個 worker 第一次跑要將所有非「永久 failed」嘅 events 都推一次去 server（收到 200 先
 * 標真正 synced）；之後就可以 filter synced 嘅唔再推。
 */
let legacyHealed = false;

/**
 * 排入 flush chain（serialized）：並發 caller 自動排隊，唔會同時開多個 flush。
 * 唔會 throw（內部 try/catch + console.warn）。
 *
 * ⚠️ **Legacy「永遠 synced」嘅 bug 自動修復**：呢個 worker 會將 queue 入面所有
 *  status !== "failed" 嘅 events 都視為可推。即係 status === "synced" 嘅 legacy events
 * （其實從未真正 flush 上 server）都會被當「未推過」處理 → 重新推 → 收到 200 先標 synced。
 * 因為現存 queue 嘅 status 完全不可信（過往寫入從未 fire sync endpoint），
 * 用 status 做 gate 會令 legacy events 永遠留喺 queue。
 * 唯一依賴 attempts counter 嚟保護（MAX_SYNC_ATTEMPTS 超就 failed 留低等人手 inspect）。
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

  // 啟動時一次性 GC + flush：stale pending 唔會留過夜。
  // GC 清走 outbox 化之前積落嚟嘅 synced 墓碑 / 被取代嘅舊事件，
  // 同埋畀外店 / 無主事件一個 skipped 終態（v2 先跑；v1 嘅墓碑係防 server merge 復活嘅唯一機制）。
  gcSyncQueue(resolveStoreId());
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
  legacyHealed = false; // 重裝後要再 heal 一次（罕用，主要 for tests）
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
  const now = new Date().toISOString();
  const next = queue.map((e) =>
    e.id === eventId
      ? {
          ...e,
          status: "failed" as const,
          attempts: (e.attempts ?? 0) + 1,
          lastError: reason ?? e.lastError,
          lastFailedAt: now,
        }
      : e,
  );
  saveQueue(next);
   
  if (reason) console.warn(`[pos-sync-flush] event ${eventId} 標 failed：${reason}`);
}

/**
 * 手動重試「永久失敗」嘅同步 event：attempts 歸零 + status 轉返 pending + 清走失敗紀錄，
 * 等 doFlush 上面第 209 行（`attempts >= MAX_SYNC_ATTEMPTS` 就 continue）唔再 skip 佢哋，
 * 然後觸發一次 flush。
 *
 * 冇咗呢個入口，永久 failed 嘅 event 係死嘅：doFlush 唔會再揀佢，UI 又冇辦法救返，
 * 資料就咁永遠留喺本機、上唔到 DB。
 *
 * @param ids 只重試指定 event id；冇傳 = 全部 failed（保留舊「全部重試」語義）。
 * 呢度 dispatch `POS_SYNC_QUEUE_CHANGED_EVENT` 係**安全**嘅（會即刻 flush 一次）：
 * doFlush 失敗時 dispatch 嘅係另一個 `POS_SYNC_FAILED_EVENT`，唔會自觸發，唔會迴圈。
 *
 * @returns 重新排入嘅 event 數
 */
export function retryFailedSyncEvents(ids?: string[]): number {
  if (typeof window === "undefined") return 0;
  const queue = loadQueue() as ExtendedQueueEvent[];
  const target = ids && ids.length > 0 ? new Set(ids) : null;
  const failed = queue.filter((e) => e.status === "failed" && (!target || target.has(e.id)));
  if (failed.length === 0) return 0;

  const next = queue.map((e) =>
    e.status === "failed" && (!target || target.has(e.id))
      ? { ...e, status: "pending" as const, attempts: 0, lastError: undefined, lastFailedAt: undefined }
      : e,
  );
  saveQueue(next);
  window.dispatchEvent(new CustomEvent(POS_SYNC_QUEUE_CHANGED_EVENT, { detail: { queue: next } }));
  console.log(`[pos-sync-flush] 手動重試 ${failed.length} 筆永久失敗嘅同步 event`);
  return failed.length;
}

/**
 * 放棄一條永久失敗嘅 event（用戶決定唔再推）：由 failed 轉 skipped 終態 + skipReason
 * "user-discarded"。skipped 唔會被 doFlush 推送，亦唔再計入「未同步」琥珀卡；
 * GC 喺 queue 超上限時會最先清理 skipped（唔會佔位一世）。
 */
export function discardFailedSyncEvent(eventId: string): boolean {
  if (typeof window === "undefined") return false;
  const queue = loadQueue() as ExtendedQueueEvent[];
  const found = queue.some((e) => e.id === eventId && e.status === "failed");
  if (!found) return false;
  const next = queue.map((e) =>
    e.id === eventId && e.status === "failed"
      ? {
          ...e,
          status: "skipped" as const,
          skipReason: "user-discarded" as const,
          lastError: undefined,
          lastFailedAt: undefined,
        }
      : e,
  );
  saveQueue(next);
  console.log(`[pos-sync-flush] 用戶放棄同步 event ${eventId}`);
  return true;
}

/**
 * 🚨 全 codebase 唯一嘅 storeId 真源 —— 所有要寫 store_id 嘅 call site 都必須用呢個。
 *
 * 優先序：
 *   1. 收銀台登入咗 → authSession.merchantId（Ledger login 落嘅真 merchant UUID）
 *   2. 否則 kiosk 綁咗店 → loadKioskDeviceBinding().storeId
 *   3. 兩者都冇 → undefined（server 會返 400，寧願大聲失敗）
 *
 * ## 點解要統一（2026-09-02 修）
 * 以前有 3 套唔同優先序散落喺 5 處，其中 `pos-app.tsx syncNow()` 係**反咗**
 * （`bootstrap?.storeId ?? merchantId`）。而 `bootstrap.storeId` 有可能係 mock 值
 * `macau-store-a`（`applyLedgerMerchantToBootstrap` 喺 session.name 空時唔修正）。
 *
 * 由於 `syncNow()` 係「成條 queue 連埋一齊 push」+ server `upsert({onConflict:"id"})`
 * 包埋 store_id → **last write wins**，一次 syncNow 就可以將啱嘅 merchantId
 * 全體覆寫做 macau-store-a。
 *
 * 對雲端中繼係致命嘅：`pos_print_jobs.store_id` 變成 macau-store-a，但中繼機
 * 用 merchant UUID 註冊 → Realtime filter 唔 match、`pos_claim_print_jobs()` 返 0 列
 * → **UI 顯示「已連線」但一張都印唔出**（最難 debug 嘅 silent failure）。
 *
 * 注意：跨店污染嘅 source-of-truth 係 server 0016 migration + pos_orders.store_id。
 * 客戶端傳 storeId 只係加速 server-side validation；server 落 row 時會以 payload
 * `source` + 路由 storeId 對齊。如果唔對齊，server 嘅 RLS / unique constraint 會擋。
 */
export function resolveStoreId(): string | undefined {
  const auth = loadAuthSession();
  if (auth?.merchantId) return auth.merchantId;
  const binding = loadKioskDeviceBinding();
  if (binding?.storeId) return binding.storeId;
  return undefined;
}

/**
 * 入隊前為**新建**事件 stamp 所屬店（= 事件產生嗰刻嘅 `resolveStoreId()`）。
 *
 * 🛡️ 跨店隔離（0022 migration）L1：事件一出世就帶住自己嘅 store，之後 flush /
 * state / sync 全部以佢為準，唔可以再用「flush 當刻邊個登入」決定一張單屬於邊間店。
 *
 * ⚠️ 兩條鐵律：
 *   1. **只可以餵新建事件**（啱啱 create 嗰啲）。舊 queue 事件（可能係 server merge
 *      落嚟嘅外店事件）已經有 storeId 嘅唔會被覆寫；但 undefined 嘅 legacy 事件若
 *      行過呢度會被 stamp 做當前店 —— 即係「改姓」，正正係要修嘅 bug。所以呼叫端
 *      一定要 `[...withStoreScope(newEvents), ...oldQueue]`，唔好成條 queue 過。
 *   2. resolveStoreId() 為 undefined（未登入又冇 kiosk 綁定）時原樣返回 —— 呢啲
 *      事件冇店可歸，flush 閘口（filterEventsForCurrentStore）自然唔會推佢哋。
 */
export function withStoreScope<T extends QueueEvent>(events: T[]): T[] {
  const store = resolveStoreId();
  if (!store) return events;
  return events.map((e) => (e.storeId ? e : { ...e, storeId: store }));
}

/**
 * 🛡️ 跨店隔離 L4：任何直接 POST `/api/pos/sync` 嘅路徑（doFlush / syncNow /
 * shift-page forceSyncBeforeClose / closeShift）推送前**必須**用呢個 filter。
 *
 * 只放行 `storeId === 當前店` 嘅事件：
 *   - 外店事件（曾經由 server state merge 混入）留喺 queue，等其所屬店登入時先推；
 *   - undefined storeId 嘅 legacy 事件一律唔推 —— 無法證明佢屬於當前店，
 *     推咗就會被 server 用請求級 storeId 蓋章寫入 `pos_orders`（跨店污染）。
 */
export function filterEventsForCurrentStore<T extends QueueEvent>(events: T[]): T[] {
  const store = resolveStoreId();
  if (!store) return [];
  return events.filter((e) => e.storeId === store);
}

/** 事件時間戳（用嚟排序推送次序）。非法時間當 0，排最前。 */
function eventTime(event: QueueEvent): number {
  const ms = Date.parse(event.createdAt ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 一條事件而家係咪值得推。
 *
 * - `attempts < MAX_SYNC_ATTEMPTS`：正常重試。
 * - `attempts >= MAX_SYNC_ATTEMPTS`（status:failed）：**唔係永久放棄**，而係
 *   要等 `FAILED_RETRY_BACKOFF_MS` 過去之後慢速重試一次（docs/112 M2）。
 *   `lastFailedAt` 缺失（legacy）就當即刻可以試。
 */
function isRetryableEvent(event: ExtendedQueueEvent): boolean {
  const attempts = event.attempts ?? 0;
  if (attempts < MAX_SYNC_ATTEMPTS) return true;
  const last = Date.parse(event.lastFailedAt ?? event.createdAt ?? "");
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= FAILED_RETRY_BACKOFF_MS;
}

/**
 * 由「已通過跨店過濾」嘅事件度揀出今次要推嘅批次。
 *
 * - **v2（outbox）**：唔做去重（入隊時已經按 `coalesceKey()` 合併），
 *   **全部 pending 都推**，而且按 `createdAt` 升序 —— 保證 `ORDER_CREATED`
 *   先過 `ORDER_SETTLED`（server settle 用 `.update()`，順序錯咗會 0 列寫唔到）。
 * - **v1（舊行為）**：同 entityId 淨推最新一條（保留舊語義，但會留低「去重輸家」）。
 */
function selectFlippable(scoped: ExtendedQueueEvent[]): ExtendedQueueEvent[] {
  const retryable = scoped.filter(isRetryableEvent);
  if (retryable.length === 0) return [];

  if (isOutboxV2Enabled()) {
    return retryable.sort((a, b) => eventTime(a) - eventTime(b)).slice(0, MAX_EVENTS_PER_FLUSH);
  }

  const candidateByEntity = new Map<string, ExtendedQueueEvent>();
  for (const e of retryable) {
    const prev = candidateByEntity.get(e.entityId);
    if (!prev || prev.createdAt < e.createdAt) {
      candidateByEntity.set(e.entityId, e);
    }
  }
  return Array.from(candidateByEntity.values()).slice(0, MAX_EVENTS_PER_FLUSH);
}

/** server 按事件回執（方案 C 擴充，docs/112 L1）。 */
interface EventAckResult {
  id: string;
  ok: boolean;
  /** 係咪**真係**寫入咗 `pos_orders`。舊 server 冇呢個欄 → undefined 當 true。 */
  applied?: boolean;
  /** 為何冇 applied：`stale` / `downgrade` / `unauthorized` / `not-found` / `db-error`。 */
  reason?: string;
  error?: string;
}

/** 由事件推算出「今次推送嘅訂單狀態」（用嚟寫上傳回執）。null = 唔關訂單事。 */
function pushedOrderStatus(event: QueueEvent): string | null {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === "ORDER_SETTLED") {
    return typeof payload.status === "string" && payload.status ? payload.status : "settled";
  }
  if (event.type === "ORDER_CREATED" || event.type === "ORDER_UPDATED") {
    const order = (event.type === "ORDER_UPDATED" ? payload.order : payload) as
      | Record<string, unknown>
      | undefined;
    return order && typeof order.status === "string" && order.status ? order.status : null;
  }
  return null;
}

/**
 * 為「確認已上雲」嘅訂單事件寫上傳回執（docs/112 L3）。
 *
 * 只記「本地現況同今次推送內容一致」嘅單：若推送期間本地又改過（status 對唔上），
 * 寧願唔記 —— 稍後嘅 flush / 對賬守護會再處理，唔好留低假回執。
 */
function recordPushAcks(events: ExtendedQueueEvent[]): void {
  if (events.length === 0) return;
  const byId = new Map(loadOrders().map((o) => [o.id, o]));
  const now = new Date().toISOString();
  const rows: SyncAckRow[] = [];
  for (const event of events) {
    if (!event.type.startsWith("ORDER_") || event.type === "ORDER_DELETED") continue;
    const status = pushedOrderStatus(event);
    if (!status) continue;
    const order = byId.get(event.entityId);
    if (!order || order.status !== status) continue;
    if (!shouldTrackAck(order)) continue;
    rows.push({
      orderId: order.id,
      orderUpdatedAt: order.updatedAt,
      status: order.status,
      ackedAt: now,
      via: "push",
    });
  }
  putSyncAcks(rows);
}

/**
 * 依 server 按事件回執更新 queue（方案 C + docs/112 L1 語義收緊）。
 *
 * ⚠️ **核心改變**：只有 `ok && applied !== false` 先當「真係上咗雲」。
 * server 對「incoming 較舊（stale）」同「終態降級」兩種情況會回
 * `ok:true, applied:false`（保留 `ok:true` 係為咗向後兼容舊 client）——
 * 新 client **唔可以照剷**，因為咁樣就係「假成功」：雲端停留舊狀態，
 * 而本地連副本都冇咗（2026-09-09 診斷：13 張單就係咁樣上唔到雲）。
 * 呢啲事件一律落 `skipped / server-newer` —— 重推同一條冇意義，
 * 補救由對賬守護用「本機終態完整快照」重新入隊一條新事件。
 */
function applyEventResults(params: {
  allQueue: ExtendedQueueEvent[];
  flippable: ExtendedQueueEvent[];
  perEvent: EventAckResult[] | null;
  failedAt: string;
  fallbackError: string;
}): { next: ExtendedQueueEvent[]; acked: ExtendedQueueEvent[]; justFailed: number; superseded: number } {
  const { allQueue, flippable, perEvent, failedAt, fallbackError } = params;
  const outboxV2 = isOutboxV2Enabled();
  const flippedIds = new Set(flippable.map((e) => e.id));
  const resultById = perEvent ? new Map(perEvent.map((r) => [r.id, r])) : null;

  const acked: ExtendedQueueEvent[] = [];
  let justFailed = 0;
  let superseded = 0;

  const next = allQueue.flatMap((event): ExtendedQueueEvent[] => {
    if (!flippedIds.has(event.id)) return [event];
    const r = resultById ? resultById.get(event.id) : null;

    // 冇回執資訊（舊 server / 空 body）→ 維持舊行為：當成功。
    const ok = resultById ? Boolean(r?.ok) : true;
    const applied = resultById ? r?.applied !== false : true;

    if (ok && applied) {
      acked.push(event);
      return outboxV2 ? [] : [{ ...event, status: "synced" as const, attempts: 0 }];
    }

    if (ok && !applied) {
      superseded += 1;
      return [
        {
          ...event,
          status: "skipped" as const,
          skipReason: "server-newer" as const,
          lastError: `雲端已有較新版本（${r?.reason ?? "stale"}），改由對賬守護補推`,
        },
      ];
    }

    const attempts = (event.attempts ?? 0) + 1;
    const goesFailed = attempts >= MAX_SYNC_ATTEMPTS;
    // 只喺「第一次跌落 failed」時通知 UI：之後仲會慢速重試，唔應該每次彈一次。
    if (goesFailed && event.status !== "failed") justFailed += 1;
    return [
      {
        ...event,
        attempts,
        lastError: r?.error ?? fallbackError,
        lastFailedAt: failedAt,
        status: (goesFailed ? "failed" : "pending") as "failed" | "pending",
      },
    ];
  });

  return { next, acked, justFailed, superseded };
}

async function doFlush(options: { silent?: boolean }): Promise<void> {
  if (typeof window === "undefined") return;
  if (!readNetworkOnline()) return;

  const storeId = resolveStoreId();
  let allQueue = loadQueue() as ExtendedQueueEvent[];
  if (allQueue.length === 0) return;

  // 2026-09-10 P0-3：收銀端事件（結帳 / 刪單 / 打印任務）需要 POS 終端憑證，
  // 而憑證 TTL 12h —— flush 前先確保仍然有效，否則全日開住嘅機會突然推唔到單。
  await refreshPosDeviceTokenIfNeeded();

  // ── 0) v2：畀「推唔到」嘅 pending 一個 skipped 終態（外店 / 無 storeId）──
  // 冇呢一步，呢啲事件會一世霸住 pending，交班畫面永遠假報「N 筆未同步」。
  if (isOutboxV2Enabled() && storeId) {
    let classifiedCount = 0;
    const classified = allQueue.map((e) => {
      const next = classifyQueueEvent(e, storeId);
      if (next) {
        classifiedCount += 1;
        return next as ExtendedQueueEvent;
      }
      return e;
    });
    if (classifiedCount > 0) {
      saveQueue(classified);
      allQueue = classified;
    }
  }

  // **Legacy heal（首次 flush）**：唔再 filter synced events（過往「寫 status:synced 但從未 fetch sync」
  // 嘅 legacy queue 會永遠卡住，要靠呢次重新推）。
  // 只 filter status:"failed" 且已超 attempts 嘅（嗰啲真係永久卡死，留低等人手 inspect）。
  // v2：queue 入面唔應該再有 synced 墓碑（GC 已經剷晒），呢個 filter 係空轉。
  const unflushed = legacyHealed
    ? allQueue.filter((e) => e.status !== "synced" && e.status !== "skipped")
    : allQueue.filter((e) => !(e.status === "failed" && (e.attempts ?? 0) >= MAX_SYNC_ATTEMPTS));
  legacyHealed = true;
  if (unflushed.length === 0) return;

  // 🛡️ 跨店隔離 L4（2026-09-06 修）：只推「storeId === 當前店」嘅事件。
  // 外店事件留喺 queue（等其所屬店登入時先推）；undefined storeId 嘅 legacy 事件
  // 一律唔推 —— 以前 legacy-heal 連 synced 事件都全量重推，配合 server 用請求級
  // storeId 覆寫 pos_orders，就係「切帳號後外店單被搬過嚟」嘅 root cause。
  const scoped = filterEventsForCurrentStore(unflushed);
  if (scoped.length === 0) return;

  const flippable = selectFlippable(scoped);
  if (flippable.length === 0) return;

  let result: Response;
  try {
    result = await fetch("/api/pos/sync", {
      method: "POST",
      // 2026-09-10 P0-3：帶 POS 終端憑證（/api/ledger/login 簽發）。
      // 冇憑證 → server 只接受匿名通道（ORDER_CREATED / ORDER_UPDATED），
      // 收銀端嘅結帳 / 刪單 / 打印任務會被拒。
      headers: { "Content-Type": "application/json", ...posDeviceAuthHeaders() },
      body: JSON.stringify({
        ...(storeId ? { storeId } : {}),
        events: flippable.map((e) => ({
          id: e.id,
          type: e.type,
          entityId: e.entityId,
          payload: e.payload,
          status: e.status,
          createdAt: e.createdAt,
          // 🛡️ 跨店隔離：事件自身嘅 store 一定要帶（上面 filter 已保證 === 當前店），
          // server 會驗證佢同請求級 storeId 一致，唔一致即拒。
          storeId: e.storeId,
        })),
      }),
    });
  } catch (err) {
    // 離線 / 網絡錯誤：保留 pending，唔加 attempts（避免純網絡抖動快速 burn 掉 quota）
     
    console.warn("[pos-sync-flush] fetch 失敗（保留 pending 等待下次 flush）：", err);
    return;
  }

  const failedAt = new Date().toISOString();

  if (!result.ok) {
    // Server-side error。方案 C（2026-09-09）+ docs/112 L1：server 會喺 body 帶按事件
    // `results` —— 真正寫入嘅照樣剷走（v2）/ 標 synced（v1），寫唔入嘅先 attempts+1。
    // 舊 server 冇 results → 成批保留 pending。
    let lastError = `HTTP ${result.status}`;
    let perEvent: EventAckResult[] | null = null;
    try {
      const body = await result.text();
      if (body) {
        lastError = `${body.slice(0, 160)} (HTTP ${result.status})`;
        const parsed = JSON.parse(body) as { results?: EventAckResult[] };
        if (Array.isArray(parsed?.results)) perEvent = parsed.results;
      }
    } catch {
      // 讀 body / JSON 失敗唔影響主流程（lastError 已至少帶 HTTP status）
    }

    // docs/112 M1：憑證出事（reason:unauthorized）→ **強制續期一次**，
    // 令下一次 flush 帶住新憑證；否則結帳事件會被反覆拒收（舊版更會一路燒到 failed）。
    if (perEvent?.some((r) => r.reason === "unauthorized")) {
      console.warn("[pos-sync-flush] 收到 unauthorized，強制續期 POS 終端憑證…");
      void refreshPosDeviceTokenIfNeeded(true);
    }

    const { next, acked, justFailed, superseded } = applyEventResults({
      allQueue,
      flippable,
      perEvent,
      failedAt,
      fallbackError: lastError,
    });
    saveQueue(next);
    recordPushAcks(acked);

    if (justFailed > 0) {
      window.dispatchEvent(
        new CustomEvent(POS_SYNC_FAILED_EVENT, {
          detail: { count: justFailed, status: result.status },
        }),
      );
    }
    if (superseded > 0) {
      console.warn(
        `[pos-sync-flush] ${superseded} 筆事件雲端已有較新版本（已交對賬守護補推，唔會重複推送）`,
      );
    }
    broadcastSyncHealth();

    if (!options.silent) {
      console.warn(
        `[pos-sync-flush] 部分同步失敗（HTTP ${result.status}）：成功 ${acked.length}/${flippable.length} 筆`,
      );
    }
    return;
  }

  // ── 成功（HTTP 200）──
  // ⚠️ 一定要讀 body 嘅 `results`：server 對「incoming 較舊（stale）」同「終態降級」
  // 會回 `ok:true, applied:false`，呢啲事件**唔算上雲**（見 applyEventResults 註解）。
  // 舊 server 冇 results（空 body / 非 JSON）→ 當全部成功，維持舊行為。
  let okPerEvent: EventAckResult[] | null = null;
  try {
    const body = await result.text();
    if (body) {
      const parsed = JSON.parse(body) as { results?: EventAckResult[] };
      if (Array.isArray(parsed?.results)) okPerEvent = parsed.results;
    }
  } catch {
    // 空 body / 非 JSON（舊 server）→ 保持 null
  }

  const appliedRes = applyEventResults({
    allQueue,
    flippable,
    perEvent: okPerEvent,
    failedAt,
    fallbackError: "HTTP 200 但未確認套用",
  });
  saveQueue(appliedRes.next);
  recordPushAcks(appliedRes.acked);
  if (appliedRes.superseded > 0) {
    console.warn(
      `[pos-sync-flush] ${appliedRes.superseded} 筆事件雲端已有較新版本（已交對賬守護補推）`,
    );
  }
  broadcastSyncHealth();

  if (!options.silent) {
    console.log(`[pos-sync-flush] 已同步 ${appliedRes.acked.length} 筆事件`);
  }
}