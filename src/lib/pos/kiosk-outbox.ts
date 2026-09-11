"use client";

import { KioskOrderRejectedError, submitKioskOrder } from "@/lib/kiosk-order";
import { OrderItem, PosOrder } from "@/lib/types";

/**
 * Kiosk / 掃碼落單嘅「待同步」本地隊列（2026-09-10 掃碼點餐審查 P1-4）。
 *
 * 【問題】`submitKioskOrder()` 舊版係單次 `fetch`，失敗直接 throw。餐飲現場
 * Wi-Fi 不穩好常見，一旦抖動，客人就眼白白睇住落單失敗（而且舊版仲要係靜默）。
 *
 * 【方案】落單失敗（網絡 / 5xx）時唔再即時判死，改為：
 *   1. 寫入呢個 **store-scoped** 本地隊列（唔靠 authSession，掃碼客人一樣寫得入）；
 *   2. UI 照樣顯示成功頁，但標明「已收到，同步中…」；
 *   3. 下次入 `/menu` `/order`（或網絡恢復）時 `flushPendingKioskOrders()` 自動補推。
 *
 * ⚠️ 刻意**唔重用** `pos/queue-outbox`：嗰條路徑嘅 flush 靠 `resolveStoreId()`
 * （= 當前登入帳號 / kiosk 綁定），而掃碼客人兩者都冇 → 事件會被分類成
 * 「無主」而永遠推唔出去。呢邊直接用落單時嘅 `storeId` 為真源。
 */

const KEY_PREFIX = "macau-pos/kiosk-pending-orders/";
/**
 * 隊列上限：呢個係「救生艇」唔係檔案庫，滿咗就唔再收（避免打爆 localStorage quota）。
 *
 * ⚠️ 2026-09-11 由 20 提高到 50：餐飲現場 Wi-Fi 斷一段時間可以積落十幾張單，
 * 20 太快滿。但**真正嘅修正係「滿咗唔再靜靜丟單」**（見 `enqueuePendingKioskOrder`）。
 */
export const MAX_PENDING_KIOSK_ORDERS = 50;
export const KIOSK_PENDING_CHANGED_EVENT = "pos-kiosk-pending-changed";

export type PendingKioskOrder = {
  order: PosOrder;
  eventType: "ORDER_CREATED" | "ORDER_UPDATED";
  storeId: string;
  queuedAt: string;
  attempts: number;
  /**
   * 今次事件嘅「新增菜品」（只有 ORDER_UPDATED 加單先有意義）。
   * 一定要一齊存：補推時要原樣上送，否則 server 端「只驗新增菜品售罄」同收銀端
   * 補印廚房單都會失去判斷依據。舊記錄冇呢個欄 → undefined（視為未知）。
   */
  addedItems?: OrderItem[];
};

function storageKey(storeId: string): string {
  return `${KEY_PREFIX}${storeId}`;
}

export function loadPendingKioskOrders(storeId: string): PendingKioskOrder[] {
  if (typeof window === "undefined" || !storeId) return [];
  try {
    const raw = window.localStorage.getItem(storageKey(storeId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingKioskOrder[]) : [];
  } catch {
    return [];
  }
}

function savePendingKioskOrders(storeId: string, rows: PendingKioskOrder[]): void {
  if (typeof window === "undefined" || !storeId) return;
  try {
    window.localStorage.setItem(storageKey(storeId), JSON.stringify(rows));
  } catch (e) {
    console.error("[kiosk-outbox] 寫入待同步隊列失敗", e instanceof Error ? e.message : e);
  }
  window.dispatchEvent(new CustomEvent(KIOSK_PENDING_CHANGED_EVENT, { detail: { storeId } }));
}

export function pendingKioskOrderCount(storeId: string): number {
  return loadPendingKioskOrders(storeId).length;
}

/**
 * 入隊結果。
 *
 * ⚠️ 為何要 `enqueued`（2026-09-11 修）：舊版隊列滿會 `rows.shift()` **丟最舊一張**
 * 然後照樣 return 長度，caller 一律當「已收到，同步中」→ 客人見到成功頁，
 * 但嗰張單**永遠上唔到雲**（廚房由頭到尾收唔到），而客人仲企喺度等。
 * 呢個係「假成功」，比直接報錯更差。所以滿咗**唔入隊、唔丟單**，
 * 由 caller 明確告知客人（`enqueued: false`）。
 */
export interface EnqueueKioskOrderResult {
  /** 入隊後嘅隊列長度。 */
  count: number;
  /** `false` = 隊列已滿，**冇**入隊（訂單未暫存，UI 必須提示客人）。 */
  enqueued: boolean;
}

/**
 * 入隊（同一個 order.id 只保留一條，重試唔會疊單）。
 *
 * 隊列滿 → **唔入隊、唔丟任何現有單**，回 `enqueued: false`（見上面註解）。
 */
export function enqueuePendingKioskOrder(
  storeId: string,
  order: PosOrder,
  eventType: "ORDER_CREATED" | "ORDER_UPDATED",
  addedItems?: OrderItem[],
): EnqueueKioskOrderResult {
  const rows = loadPendingKioskOrders(storeId).filter((row) => row.order?.id !== order.id);
  if (rows.length >= MAX_PENDING_KIOSK_ORDERS) {
    // 滿咗：唔入隊、亦唔丟走任何現有單。由 caller 提示客人（見 EnqueueKioskOrderResult）。
    return { count: rows.length, enqueued: false };
  }
  rows.push({ order, eventType, storeId, queuedAt: new Date().toISOString(), attempts: 0, addedItems });
  savePendingKioskOrders(storeId, rows);
  return { count: rows.length, enqueued: true };
}

export function clearPendingKioskOrder(storeId: string, orderId: string): number {
  const rows = loadPendingKioskOrders(storeId).filter((row) => row.order?.id !== orderId);
  savePendingKioskOrders(storeId, rows);
  return rows.length;
}

/**
 * 補推隊列。逐條 `submitKioskOrder()`：
 *   - 成功 → 由隊列移除；
 *   - 失敗 → attempts+1，保留等下次（attempts 上限 10，之後丟棄避免永久卡住）。
 *
 * @returns 仍未同步嘅條數
 */
export async function flushPendingKioskOrders(storeId: string): Promise<number> {
  if (!storeId) return 0;
  const rows = loadPendingKioskOrders(storeId);
  if (rows.length === 0) return 0;

  const remaining: PendingKioskOrder[] = [];
  for (const row of rows) {
    try {
      await submitKioskOrder(row.storeId, row.order, row.eventType, row.addedItems);
    } catch (e) {
      // 永久拒絕（售罄 / 未授權 / payload 有問題）→ 重試都冇用，直接放棄並大聲記錄，
      // 唔好霸住隊列令客人每次入頁都見到「N 張待傳」。
      if (e instanceof KioskOrderRejectedError) {
        console.error(
          `[kiosk-outbox] 訂單 ${row.order.localOrderNo ?? row.order.id} 被伺服器永久拒絕，已由隊列移除：${e.message}`,
        );
        continue;
      }
      const attempts = row.attempts + 1;
      if (attempts <= 10) remaining.push({ ...row, attempts });
    }
  }
  savePendingKioskOrders(storeId, remaining);
  return remaining.length;
}
