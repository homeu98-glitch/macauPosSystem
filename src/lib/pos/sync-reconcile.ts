"use client";

/**
 * 同步健康檢查 ——「自助補錄 / 事後補救」核心（2026-09-09）。
 *
 * 背景：收銀「已結帳」只代表本機 localStorage 係 settled，事件上唔上到雲係另一回事。
 *   - 失敗事件（status:"failed"）喺 outbox queue 度 → 可以逐筆重試 / 放棄（L1）；
 *   - 更陰濕嘅 case：事件當年已經成功推走（queue 已空），但雲端張單之後俾另一部機嘅
 *     舊 snapshot 回水做返 sent_to_kitchen（今日「13 張未結帳」正正係咁）→ queue 冇嘢可以
 *     重試，唯一自救方法係**用本機仲揸住嘅終態訂單快照，對比雲端狀態，發現分叉就補錄**
 *     （L2）。補錄 = 重新入隊一條 ORDER_UPDATED（完整 snapshot），行返正常 flush 通道上雲。
 *
 * 安全設計：
 *   - 淨係對「本機終態（settled/cancelled/refunded/partially_refunded）」做對賬 ——
 *     進行中 / 返結緊嘅單（draft/sent_to_kitchen/paid/reopened）唔會亂郁；
 *   - 補錄用 ORDER_UPDATED + 完整 snapshot → server 係 upsert（開新單都救得返），
 *     而且行緊 2026-09-09 起嘅 LWW/終態守門，唔會覆寫雲端較新狀態；
 *   - 冪等：同一張單重複撳補錄最多係重推同一份 snapshot，無害；
 *   - 入隊用 coalesceKey → 同 type + 同單嘅 pending 舊事件會原位被取代，唔會囤積。
 *
 * 依賴嘅既有基礎（全部唔使新基建）：
 *   loadOrders / loadQueue / saveQueue（store-scope localStorage）
 *   enqueueEvents（outbox 入隊合併）、withStoreScope（事件 stamp 店）、notifyQueueChanged（即 flush）
 *   /api/pos/state?ordersOnly=1&storeId=…（雲端訂單真源）
 */

import { loadDeletedOrderIds, loadOrders, loadQueue, saveQueue } from "@/lib/storage";
import { PosOrder } from "@/lib/types";
import { isTerminalOrderStatus } from "@/lib/pos-order-filters";
import { enqueueEvents } from "@/lib/pos/queue-outbox";
import { notifyQueueChanged, retryFailedSyncEvents, resolveStoreId, withStoreScope } from "@/lib/pos/sync-flush";

/** 對賬考慮嘅最大單齡（超過就唔再建議補錄 —— 太舊嘅單唔值得冒險推）。 */
export const RECONCILE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** 一行「本地已終態、但雲端唔係」嘅分叉記錄。 */
export interface ReconcileDriftRow {
  orderId: string;
  localOrderNo: string;
  tableName: string;
  total: number;
  localStatus: string;
  /** 雲端狀態；null = server 冇呢張單（或唔喺拉取範圍）。 */
  serverStatus: string | null;
  localUpdatedAt: string;
  /** 雲端 updated_at；null = server 冇。 */
  serverUpdatedAt: string | null;
}

function orderTimeMs(order: PosOrder): number {
  return Date.parse(order.updatedAt ?? "") || Date.parse(order.createdAt ?? "") || 0;
}

/** 由「本機訂單 + 雲端訂單」計出終態分叉行（純函數，方便測試）。 */
export function computeReconcileDrift(localOrders: PosOrder[], serverOrders: PosOrder[]): ReconcileDriftRow[] {
  const deleted = new Set(loadDeletedOrderIds());
  const serverById = new Map(serverOrders.map((o) => [o.id, o]));

  const rows: ReconcileDriftRow[] = [];
  const now = Date.now();
  for (const order of localOrders) {
    if (deleted.has(order.id)) continue;
    if (!isTerminalOrderStatus(order.status)) continue;
    if (now - orderTimeMs(order) > RECONCILE_MAX_AGE_MS) continue;
    const server = serverById.get(order.id);
    const serverStatus = server?.status ?? null;
    // 分叉定義：雲端唔係終態（包括雲端根本冇呢張單）。
    if (server && isTerminalOrderStatus(server.status)) continue;
    rows.push({
      orderId: order.id,
      localOrderNo: order.localOrderNo,
      tableName: order.tableName ?? "",
      total: order.total ?? 0,
      localStatus: order.status,
      serverStatus,
      localUpdatedAt: order.updatedAt,
      serverUpdatedAt: server?.updatedAt ?? null,
    });
  }
  // 最「值得救」嘅排最前：本地終態時間最新嘅喺上面（通常就係啱啱結帳、啱被回水嗰啲）。
  return rows.sort((a, b) => Date.parse(b.localUpdatedAt) - Date.parse(a.localUpdatedAt));
}

/** 由終態分叉行反推返「本機嗰張完整訂單」（補錄要推 full snapshot，唔淨推 status）。 */
export function findLocalOrderById(orderId: string, merchantId?: string | null): PosOrder | null {
  return loadOrders(merchantId).find((o) => o.id === orderId) ?? null;
}

/**
 * 補錄一張本機訂單上雲：入隊一條 ORDER_UPDATED（payload.order = 完整快照）+ 即時 flush。
 * @returns {ok, message} 已排入 / 失敗原因。
 */
export function pushOrderSnapshotForReconcile(order: PosOrder): { ok: boolean; message: string } {
  if (typeof window === "undefined") return { ok: false, message: "唔喺瀏覽器環境" };
  const storeId = resolveStoreId();
  if (!storeId) return { ok: false, message: "未登入 / 未綁定店舖，無法補錄" };
  const now = new Date().toISOString();
  const event = {
    id: `evt-${crypto.randomUUID().slice(0, 8)}`,
    type: "ORDER_UPDATED" as const,
    entityId: order.id,
    payload: { order, action: "reconcile_repush" },
    status: "pending" as const,
    createdAt: now,
  };
  const stamped = withStoreScope([event]);
  const next = enqueueEvents(loadQueue(), stamped);
  saveQueue(next);
  notifyQueueChanged();
  return { ok: true, message: `已排入 ${order.localOrderNo} 補錄，等待同步…` };
}

/** 全部失敗事件一次過重試（返回成功重排數）。 */
export function retryAllFailedEvents(): number {
  return retryFailedSyncEvents();
}

/** 讀取目前 failed 事件清單（Modal 顯示用；由 loadQueue 直接讀，唔依賴任何 state）。 */
export function loadFailedEvents() {
  const queue = loadQueue();
  return queue
    .filter((e) => e.status === "failed")
    .sort((a, b) => Date.parse(b.lastFailedAt ?? b.createdAt) - Date.parse(a.lastFailedAt ?? a.createdAt));
}

/**
 * 拉取雲端訂單（ordersOnly 通道，同報表同一個 API）。
 * @param storeId 店 UUID
 * @param startIso 起始（UTC ISO）；null = 唔限（會好大，盡量傳）
 */
export async function fetchServerOrders(
  storeId: string,
  startIso: string | null,
): Promise<{ orders: PosOrder[]; error?: string }> {
  const params = new URLSearchParams({ storeId, ordersOnly: "1", limit: "5000" });
  if (startIso) params.set("start", startIso);
  try {
    const res = await fetch(`/api/pos/state?${params.toString()}`);
    if (!res.ok) return { orders: [], error: `HTTP ${res.status}` };
    const json = (await res.json()) as { ok?: boolean; orders?: PosOrder[]; error?: string };
    if (!json?.ok) return { orders: [], error: json?.error ?? "伺服器回傳失敗" };
    return { orders: Array.isArray(json.orders) ? json.orders : [] };
  } catch (err) {
    return { orders: [], error: err instanceof Error ? err.message : "網絡錯誤" };
  }
}

/** 由本機終態單計出要拉 server 嘅起始時間（最舊嗰張減 12 小時 buffer；冇就 null）。
 * 淨考慮 RECONCILE_MAX_AGE 內嘅單（太舊唔值得拉全歷史）。 */
export function computeServerRangeStart(localOrders: PosOrder[]): string | null {
  const now = Date.now();
  let min = Infinity;
  for (const o of localOrders) {
    if (!isTerminalOrderStatus(o.status)) continue;
    const t = orderTimeMs(o);
    if (!Number.isFinite(t)) continue;
    if (now - t > RECONCILE_MAX_AGE_MS) continue;
    if (t < min) min = t;
  }
  if (!Number.isFinite(min)) return null;
  return new Date(min - 12 * 60 * 60 * 1000).toISOString();
}
