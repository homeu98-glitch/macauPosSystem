"use client";

/**
 * 常駐對賬守護（docs/112 L2，2026-09-10）——**呢個係整套方案嘅核心**。
 *
 * ## 點解要有
 *
 * 舊設計嘅唯一「補救」入口係「同步健康」Modal（`sync-health-modal.tsx`）：
 * 商家要**自己發現**後台狀態唔對、再**自己開 Modal**、再**自己撳補錄**。
 * 結果（2026-09-09 實案）：13 張單喺雲端停留 `sent_to_kitchen`，本地 iPad 顯示
 * 「已完成」——商家根本唔知要撳邊個掣。
 *
 * 呢個 daemon 把「發現 → 補推 → 覆核」變成**背景自動進行**：
 *
 * ```
 * 每 60s（＋每次 flush 後 / 上線 / 回到前景 / 結帳後 20s）
 *   └─ 揀出「本地已終態、但雲端未取得一致確認」嘅單（syncAck 落後）
 *      └─ 一次過 pull 雲端現況（fetchServerOrders）
 *         ├─ 一致        → 寫 syncAck 結案
 *         ├─ 雲端非終態  → **自動補推完整快照**（pushOrderSnapshotForReconcile）
 *         ├─ 雲端都係終態但唔同 → conflict，標 blocked 交人（唔自動揀邊個贏）
 *         └─ 雲端完全冇呢張單且已超過 24h → 標 blocked 交人（唔亂造單）
 * ```
 *
 * ## 成本控制（重要）
 *
 * 冇待確認訂單時**完全唔打網絡**（只讀 localStorage）→ 穩定狀態下零成本。
 * 只有真正出現分叉先會 pull 雲端，而且每輪上限 100 張 + 每單獨立指數退避。
 *
 * ## 開關
 * `localStorage["macau-pos/sync-reconcile-daemon"] = "0"` 即關閉（唔影響 flush）。
 */

import { readNetworkOnline } from "@/lib/use-network-online";
import { loadSyncBlocked, type SyncAckRow } from "@/lib/storage";
import { PosOrder } from "@/lib/types";
import { isTerminalOrderStatus } from "@/lib/pos-order-filters";
import { refreshPosDeviceTokenIfNeeded } from "@/lib/pos/pos-sync-auth";
import { fetchServerOrders, pushOrderSnapshotForReconcile } from "@/lib/pos/sync-reconcile";
import { notifyQueueChanged, resolveStoreId } from "@/lib/pos/sync-flush";
import {
  broadcastSyncHealth,
  clearOrderBlocked,
  listUnackedTerminalOrders,
  markOrderBlocked,
  putSyncAcks,
} from "@/lib/pos/sync-acks";

export const RECONCILE_DAEMON_FLAG_KEY = "macau-pos/sync-reconcile-daemon";

/** 兜底掃描間隔。 */
const SCAN_INTERVAL_MS = 60_000;
/** 收到「訂單有變」（結帳 / 出餐）後延遲少少再查 —— 畀正常 flush 通道先跑。 */
const POST_ORDER_CHANGE_DELAY_MS = 20_000;
/** 收到「隊列有變」（剛 flush 完）之後嘅複查延遲。 */
const POST_FLUSH_DELAY_MS = 8_000;
/** 每輪最多處理幾多張（避開一次過打爆 API）。 */
const MAX_ORDERS_PER_ROUND = 100;
/**
 * 同一張單連續補推幾多次之後就「示警」（標 blocked）。
 * 唔係放棄：blocked 單仍然會以 `BLOCKED_RECHECK_MS` 慢速複查，好返就自動解除。
 */
const BLOCK_AFTER_ATTEMPTS = 3;
/** 每單獨立退避階梯（ms）。 */
const BACKOFF_STEPS_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** 已示警（blocked）嘅單幾耐之後再自動複查一次。 */
const BLOCKED_RECHECK_MS = 30 * 60_000;
/**
 * 雲端完全查唔到呢張單、而本地終態已經超過呢個年齡 → 唔自動補推（交人核對）。
 *
 * 點解要設：24 小時內嘅單「雲端冇」通常係「ORDER_SETTLED 早過 ORDER_CREATED」
 * 呢類可自動修復嘅情況；太久嘅單強行補推有可能係雲端已經清理 / 換店 / 另一部機
 * 處理過，亂造記錄比唔造更危險。
 */
const AUTO_PUSH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function orderTimeMs(order: PosOrder): number {
  return Date.parse(order.updatedAt || order.createdAt || "") || 0;
}

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(RECONCILE_DAEMON_FLAG_KEY) !== "0";
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 執行狀態
// ─────────────────────────────────────────────────────────────

let installed = false;
let running = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let scheduledHandle: ReturnType<typeof setTimeout> | null = null;
let visibilityHandler: (() => void) | null = null;
let onlineHandler: (() => void) | null = null;
let queueChangedHandler: (() => void) | null = null;
let ordersChangedHandler: (() => void) | null = null;

/** orderId → 冷卻（每個 session 內存；跨 session 由 blocked 記錄接管）。 */
const cooldown = new Map<string, { attempts: number; nextAt: number }>();

function stepBackoffMs(attempts: number): number {
  return BACKOFF_STEPS_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_STEPS_MS.length - 1)];
}

function blockedLastTriedMs(orderId: string): number | null {
  const row = loadSyncBlocked().find((r) => r.orderId === orderId);
  if (!row) return null;
  const t = Date.parse(row.lastTriedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 呢張單而家可唔可以處理（冷卻 / blocked 慢速複查都要等）。
 * @returns 0 = 即刻可以；>0 = 仲要等幾多毫秒
 */
function waitBefore(orderId: string): number {
  const now = Date.now();
  const c = cooldown.get(orderId);
  if (c) return Math.max(0, c.nextAt - now);
  const lastTried = blockedLastTriedMs(orderId);
  if (lastTried !== null) return Math.max(0, lastTried + BLOCKED_RECHECK_MS - now);
  return 0;
}

/** 補推過之後設定冷卻；到頂就標 blocked（示警，但唔停止慢速複查）。 */
function notePushAttempt(order: PosOrder, reason: string, serverStatus: string | null = null): void {
  const prev = cooldown.get(order.id)?.attempts ?? 0;
  const attempts = prev + 1;
  cooldown.set(order.id, { attempts, nextAt: Date.now() + stepBackoffMs(attempts) });
  if (attempts < BLOCK_AFTER_ATTEMPTS) return;
  const existing = loadSyncBlocked().find((r) => r.orderId === order.id);
  const nowIso = new Date().toISOString();
  markOrderBlocked({
    orderId: order.id,
    localOrderNo: order.localOrderNo ?? "",
    localStatus: order.status,
    serverStatus: serverStatus ?? existing?.serverStatus ?? null,
    attempts,
    lastError: reason,
    blockedAt: existing?.blockedAt ?? nowIso,
    lastTriedAt: nowIso,
  });
}

function clearCooldown(orderId: string): void {
  cooldown.delete(orderId);
}

// ─────────────────────────────────────────────────────────────
// 一輪對賬
// ─────────────────────────────────────────────────────────────

/**
 * 跑一輪對賬（可重入保護）。
 * @param reason 診斷用標籤（log 用）
 * @returns 今輪實際處理咗幾多張單
 */
export async function runReconcileRound(reason = "manual"): Promise<number> {
  if (typeof window === "undefined") return 0;
  if (!isEnabled()) return 0;
  if (running) return 0;
  if (!readNetworkOnline()) return 0;

  const storeId = resolveStoreId();
  if (!storeId) return 0;

  // ① 本地先篩（純 localStorage，零網絡）—— 穩定狀態下喺呢度就結束。
  const all = listUnackedTerminalOrders();
  if (all.length === 0) return 0;
  const batch = all.filter((o) => waitBefore(o.id) === 0).slice(0, MAX_ORDERS_PER_ROUND);
  if (batch.length === 0) return 0;

  running = true;
  try {
    // ② 憑證先確保有效（結帳 / 補推都要 POS 終端憑證）
    await refreshPosDeviceTokenIfNeeded();

    // ③ 一次過 pull 雲端現況（同「同步健康」用同一條 ordersOnly 通道）
    const { orders: serverOrders, error } = await fetchServerOrders(storeId, null);
    if (error) {
      console.warn(`[sync-daemon] 拉雲端訂單失敗（${reason}）：${error}`);
      return 0;
    }
    const serverById = new Map(serverOrders.map((o) => [o.id, o]));

    const ackedAt = new Date().toISOString();
    const acks: SyncAckRow[] = [];
    let pushed = 0;
    let conflicts = 0;
    let missing = 0;

    for (const order of batch) {
      const server = serverById.get(order.id);
      const serverStatus = server?.status ?? null;

      // ── 一致：寫回執結案 ──
      if (server && server.status === order.status) {
        acks.push({
          orderId: order.id,
          orderUpdatedAt: order.updatedAt,
          status: order.status,
          ackedAt,
          via: "verify",
        });
        clearCooldown(order.id);
        clearOrderBlocked(order.id);
        continue;
      }

      // ── 兩邊都係終態但唔同：唔自動揀邊個贏，交人 ──
      if (server && isTerminalOrderStatus(server.status)) {
        conflicts += 1;
        notePushAttempt(
          order,
          `雲端同本地都係終態但唔一致（本地 ${order.status} / 雲端 ${server.status}），需人手核對`,
          server.status,
        );
        continue;
      }

      // ── 雲端冇呢張單，而且已太舊：唔亂造記錄 ──
      if (!server && Date.now() - orderTimeMs(order) > AUTO_PUSH_MAX_AGE_MS) {
        missing += 1;
        notePushAttempt(order, "雲端查唔到呢張單且已超過 24 小時，需人手核對", serverStatus);
        continue;
      }

      // ── 需要補推：用本機完整快照重推（雲端非終態 / 雲端冇單） ──
      const result = pushOrderSnapshotForReconcile(order);
      if (!result.ok) {
        notePushAttempt(order, result.message, serverStatus);
        continue;
      }
      pushed += 1;
      notePushAttempt(
        order,
        `已自動補推第 ${(cooldown.get(order.id)?.attempts ?? 1)} 次，等雲端確認`,
        serverStatus,
      );
    }

    putSyncAcks(acks);
    if (pushed > 0) {
      // 立即 flush，唔想等 30s 嘅兜底 interval。
      notifyQueueChanged();
      console.log(`[sync-daemon] ${reason}：自動補推 ${pushed} 張（${batch.length} 張待對賬）`);
    }
    if (conflicts > 0 || missing > 0) {
      console.warn(
        `[sync-daemon] ${reason}：${conflicts} 張狀態衝突、${missing} 張雲端缺記錄 —— 已示警待人核對`,
      );
    }
    broadcastSyncHealth();
    return batch.length;
  } catch (err) {
    // 守護永遠唔應該令畫面爆。
    console.warn("[sync-daemon] 對賬異常（已忽略）：", err);
    return 0;
  } finally {
    running = false;
  }
}

/** 合併短時間內多次觸發（後到嘅唔會搶先）。 */
function scheduleRound(delayMs: number): void {
  if (typeof window === "undefined") return;
  if (scheduledHandle) return;
  scheduledHandle = setTimeout(() => {
    scheduledHandle = null;
    void runReconcileRound("scheduled");
  }, delayMs);
}

/**
 * 安裝常駐守護（idempotent）。
 *
 * 觸發點：mount ／ 每 60s ／ 上線 ／ 回到前景 ／ 每次 flush 完成 ／ 訂單有變（結帳 / 出餐）。
 */
export function installSyncReconcileDaemon(): void {
  if (typeof window === "undefined") return;
  if (installed) return;
  installed = true;

  onlineHandler = () => scheduleRound(0);
  window.addEventListener("online", onlineHandler);
  window.addEventListener("pos-network-status-changed", onlineHandler as EventListener);

  queueChangedHandler = () => scheduleRound(POST_FLUSH_DELAY_MS);
  window.addEventListener("pos-sync-queue-changed", queueChangedHandler as EventListener);

  ordersChangedHandler = () => scheduleRound(POST_ORDER_CHANGE_DELAY_MS);
  window.addEventListener("pos-orders-changed", ordersChangedHandler as EventListener);

  visibilityHandler = () => {
    if (document.visibilityState === "visible") scheduleRound(0);
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  intervalHandle = setInterval(() => void runReconcileRound("interval"), SCAN_INTERVAL_MS);

  // 啟動時跑一輪：把上一 session 積落嘅分叉一次過補返。
  scheduleRound(3_000);
}

export function uninstallSyncReconcileDaemon(): void {
  if (typeof window === "undefined") return;
  if (!installed) return;
  installed = false;
  if (onlineHandler) {
    window.removeEventListener("online", onlineHandler);
    window.removeEventListener("pos-network-status-changed", onlineHandler as EventListener);
  }
  if (queueChangedHandler) {
    window.removeEventListener("pos-sync-queue-changed", queueChangedHandler as EventListener);
  }
  if (ordersChangedHandler) {
    window.removeEventListener("pos-orders-changed", ordersChangedHandler as EventListener);
  }
  if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
  if (intervalHandle) clearInterval(intervalHandle);
  if (scheduledHandle) clearTimeout(scheduledHandle);
  intervalHandle = null;
  scheduledHandle = null;
  onlineHandler = null;
  queueChangedHandler = null;
  ordersChangedHandler = null;
  visibilityHandler = null;
  cooldown.clear();
}

/** UI「立即重試」：清走冷卻同 blocked 標記，然後即刻跑一輪。 */
export async function retryReconcileNow(): Promise<number> {
  cooldown.clear();
  for (const row of loadSyncBlocked()) clearOrderBlocked(row.orderId);
  return runReconcileRound("manual-retry");
}
