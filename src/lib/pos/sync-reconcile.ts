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

import {
  addDeletedOrderIds,
  loadDeletedOrderIds,
  loadOrders,
  loadQuarantinedOrders,
  loadQueue,
  QuarantinedOrderRow,
  saveOrders,
  saveQueue,
  saveQuarantinedOrders,
} from "@/lib/storage";
import { PosOrder, QueueEvent } from "@/lib/types";
import { isTerminalOrderStatus } from "@/lib/pos-order-filters";
import { enqueueEvents } from "@/lib/pos/queue-outbox";
import { notifyQueueChanged, retryFailedSyncEvents, resolveStoreId, withStoreScope } from "@/lib/pos/sync-flush";
import { posDeviceAuthHeaders } from "@/lib/pos/pos-sync-auth";

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
    const res = await fetch(`/api/pos/state?${params.toString()}`, {
      // 2026-09-10 P0-4：需要 POS 終端憑證
      headers: { ...posDeviceAuthHeaders() },
    });
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

/**
 * 一行「雲端有、本機缺」嘅終態單（2026-09-09 補）。
 *
 * 場景：另一部機喺呢部機 mount 之後結咗帳，事件上咗雲端，但呢部機從未見過呢個 id
 * （POS client 只喺 mount + realtime delta 拉雲端 order 落 react state，**冇寫入
 * localStorage**，所以本機 orders 永遠缺對方結嘅單）。L2 對賬本來只揾「本機有、雲端錯」
 * 嗰個方向，呢度加返反方向：雲端有、本機冇、雲端係終態 → 列為「待補入本機」。
 *
 * 重要：呢類單**唔係** sync 失敗，事件早已成功推上雲；亦唔會用補錄 ORDER_UPDATED
 * （補錄只解決本機有 vs 雲端錯嘅 case）。要解決就係**下載雲端 row 寫入本機 localStorage**，
 * 之後 UI render 自動見到。安全條件：
 *   - 只處理雲端行 status 屬終態（settled / cancelled / refunded / partially_refunded）
 *     ——open 單雲端 row 唔可以任意「下載」，否則覆蓋本地正在進行嘅單；
 *   - 跳過本機 deletedIds（用戶手動刪過嘅唔好復活）；
 *   - 太舊（>RECONCILE_MAX_AGE）唔做。
 */
export interface MissingLocalRow {
  orderId: string;
  localOrderNo: string;
  tableName: string;
  total: number;
  serverStatus: string;
  serverUpdatedAt: string;
}

export function computeMissingLocalOrders(localOrders: PosOrder[], serverOrders: PosOrder[]): MissingLocalRow[] {
  const deleted = new Set(loadDeletedOrderIds());
  const localIds = new Set(localOrders.map((o) => o.id));
  const now = Date.now();
  const rows: MissingLocalRow[] = [];
  for (const o of serverOrders) {
    if (localIds.has(o.id)) continue;
    if (deleted.has(o.id)) continue;
    if (!isTerminalOrderStatus(o.status)) continue; // 雲端係 open 單 → 唔准下載覆寫進行中
    const t = orderTimeMs(o);
    if (now - t > RECONCILE_MAX_AGE_MS) continue;
    rows.push({
      orderId: o.id,
      localOrderNo: o.localOrderNo ?? "",
      tableName: o.tableName ?? "",
      total: o.total ?? 0,
      serverStatus: o.status,
      serverUpdatedAt: o.updatedAt,
    });
  }
  // 最新排前面（同 L2 分叉一致排序）
  return rows.sort((a, b) => Date.parse(b.serverUpdatedAt) - Date.parse(a.serverUpdatedAt));
}

/**
 * 將一批雲端訂單「下載」入本機 localStorage：append（不覆寫本機已有 id）+ 廣播 pos-orders-changed。
 *
 * 用法：L2 Modal 顯示「雲端有、本機缺」清單 → 用戶一撳「全部下載」就將雲端 row 寫入本機。
 * 寫入後 pos-app 嘅 pos-orders-changed listener 自動 reload、桌台總覽、店內線下訂量都會即時更新。
 *
 * @returns 成功寫入嘅 row 數（會跳過本機已有 id / deletedId）
 */
export function downloadMissingOrdersToLocal(serverOrders: PosOrder[], merchantId?: string | null): number {
  if (typeof window === "undefined") return 0;
  const local = loadOrders(merchantId);
  const deleted = new Set(loadDeletedOrderIds());
  const localIds = new Set(local.map((o) => o.id));
  let appended = 0;
  for (const o of serverOrders) {
    if (localIds.has(o.id)) continue;
    if (deleted.has(o.id)) continue;
    if (!isTerminalOrderStatus(o.status)) continue; // 二次保險：UI 唔應該見到 open 單
    local.push(o);
    localIds.add(o.id);
    appended += 1;
  }
  if (appended > 0) saveOrders(local);
  return appended;
}

// ═══════════════════════════════════════════════════════════════
// L3：孤兒單對賬 + 隔離區（2026-09-09 方案 A，docs/桌台回退根治方案）
//
// 根因：merge 係「合併」唔係「取代」——雲端冇嘅本機單會永遠保留，冇任何機制清走。
// 實例：iPad B 手動更新不斷拉返 6 張「未結帳」枱，但 server pos_orders 對嗰啲
// table_id 係零筆記錄（SQL 已證實）→ 嗰啲係本機孤兒單，時間源改動都救唔到。
//
// 孤兒定義（三個條件同時成立）：
//   1. 本機非終態（draft / sent_to_kitchen / paid / reopened）——終態單由 L2 對賬管；
//   2. 雲端全量 pull 冇呢個 id；
//   3. outbox 冇任何 pending / failed 嘅 ORDER_* 事件支持佢（有 = 仲未放棄上雲，
//     唔好郁佢；ORDER_DELETED 唔算支持——佢係刪除意圖）。
//
// 安全閥：
//   - 單齡 < ORPHAN_MIN_AGE_MS 唔隔離（避開「事件啱啱 flush 完、pull response
//     用舊 snapshot」嘅競態窗口）；
//   - 隔離 = 移入 quarantine store（唔刪除），同步健康 Modal 可還原 / 永久刪除；
//   - filterResurrectedOrders 會剔走隔離 id，merge / realtime 唔會令佢復活。
// ═══════════════════════════════════════════════════════════════

/** 孤兒判定嘅最小單齡：避開 flush / pull 競態（見上）。 */
export const ORPHAN_MIN_AGE_MS = 10 * 60 * 1000;

/** 一行「本機非終態、雲端冇、無事件支持」嘅孤兒記錄。 */
export interface OrphanLocalRow {
  orderId: string;
  localOrderNo: string;
  tableName: string;
  total: number;
  status: string;
  updatedAt: string;
}

/**
 * 由「本機訂單 + 雲端全量訂單 + outbox 隊列」計出孤兒單（純函數，方便測試）。
 *
 * @param localOrders 本機 orders（已 merge 嘅完整清單）
 * @param serverOrders 雲端**全量**訂單（fetchServerOrders(storeId, null)，唔可以帶 range）
 * @param queue outbox 隊列（loadQueue()）
 */
export function computeOrphanLocalOrders(
  localOrders: PosOrder[],
  serverOrders: PosOrder[],
  queue: QueueEvent[],
): OrphanLocalRow[] {
  const quarantined = new Set(loadQuarantinedOrders().map((r) => r.order.id));
  const serverIds = new Set(serverOrders.map((o) => o.id));
  // 有 pending / failed ORDER_* 事件（唔計 ORDER_DELETED）嘅單 = 仲有上雲希望，唔算孤兒
  const supported = new Set<string>();
  for (const e of queue) {
    if (e.status !== "pending" && e.status !== "failed") continue;
    if (!e.type.startsWith("ORDER_") || e.type === "ORDER_DELETED") continue;
    supported.add(e.entityId);
  }
  const now = Date.now();
  const rows: OrphanLocalRow[] = [];
  for (const o of localOrders) {
    if (quarantined.has(o.id)) continue; // 已隔離嘅唔會再出現（但 react state 可能殘留）
    if (isTerminalOrderStatus(o.status)) continue;
    if (serverIds.has(o.id)) continue;
    if (supported.has(o.id)) continue;
    const t = orderTimeMs(o);
    if (t > 0 && now - t < ORPHAN_MIN_AGE_MS) continue; // 競態保護：太新唔好郁
    rows.push({
      orderId: o.id,
      localOrderNo: o.localOrderNo ?? "",
      tableName: o.tableName ?? "",
      total: o.total ?? 0,
      status: o.status,
      updatedAt: o.updatedAt,
    });
  }
  // 最舊排先（孤兒越舊越可疑）
  return rows.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
}

/**
 * 將指定訂單隔離：由 orders localStorage 移出、寫入隔離區（含快照，可還原）。
 *
 * @returns 實際隔離咗幾多張（已隔離 / 已終態嘅會跳過）
 */
export function quarantineOrders(orderIds: string[], reason: string): number {
  if (typeof window === "undefined" || orderIds.length === 0) return 0;
  const idSet = new Set(orderIds);
  const local = loadOrders();
  const victims = local.filter((o) => idSet.has(o.id) && !isTerminalOrderStatus(o.status));
  if (victims.length === 0) return 0;
  const remaining = local.filter((o) => !idSet.has(o.id));
  const now = new Date().toISOString();
  const rows: QuarantinedOrderRow[] = [
    ...loadQuarantinedOrders(),
    ...victims.map((order) => ({ order, quarantinedAt: now, reason })),
  ];
  saveQuarantinedOrders(rows);
  saveOrders(remaining); // 觸發 pos-orders-changed → UI 即時甩走隔離單
   
  console.log(
    `[sync-reconcile] 孤兒單隔離：${victims.length} 張（${victims
      .map((o) => o.localOrderNo ?? o.id.slice(-8))
      .join("、")}），原因=${reason}`,
  );
  return victims.length;
}

/** 由隔離區還原一張單返 orders localStorage（放返最尾，merge 語義唔變）。 */
export function restoreQuarantinedOrder(orderId: string): boolean {
  if (typeof window === "undefined") return false;
  const rows = loadQuarantinedOrders();
  const idx = rows.findIndex((r) => r.order.id === orderId);
  if (idx < 0) return false;
  const [row] = rows.splice(idx, 1);
  saveQuarantinedOrders(rows);
  const deleted = new Set(loadDeletedOrderIds());
  if (deleted.has(orderId)) return true; // 已 tombstone，唔還原訂單本身，淨剷隔離記錄
  const local = loadOrders();
  if (!local.some((o) => o.id === orderId)) {
    local.push(row.order);
    saveOrders(local);
  }
  return true;
}

/** 永久刪除隔離區一張單（加 tombstone 防 realtime / backfill 復活）。 */
export function discardQuarantinedOrder(orderId: string): boolean {
  if (typeof window === "undefined") return false;
  const rows = loadQuarantinedOrders();
  const next = rows.filter((r) => r.order.id !== orderId);
  if (next.length === rows.length) return false;
  saveQuarantinedOrders(next);
  addDeletedOrderIds([orderId]);
  // 同步斬草除根：orders localStorage 若仲有殘留（理論上隔離時已移走）都一併剷
  const local = loadOrders();
  const filtered = local.filter((o) => o.id !== orderId);
  if (filtered.length !== local.length) saveOrders(filtered);
  return true;
}
