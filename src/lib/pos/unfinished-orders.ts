/**
 * 「未完成訂單」判定 —— 交班前提示嘅**唯一真源**（2026-11-03）。
 *
 * ## 為咩要有呢個檔案
 *
 * 2026-11-02 實案：線上單客人已經付款，店員冇喺 POS 完成就直接交班。
 * 錢係啱嘅（Ledger 已付款單逐張加總），但訂單狀態仍然停喺「未完成」——
 * 交班流程完全冇提示，員工走咗都唔知。
 *
 * ## 口徑（商家 2026-11-03 拍板）
 *
 * 「**任何未完成狀態嘅訂單都要提**」，包括線下單同未付款嘅線上單。
 *
 * | 來源 | 算未完成 | 排除 |
 * |---|---|---|
 * | 本地 `pos_orders` | `draft` / `sent_to_kitchen` / `paid` / `reopened` | `settled` / `cancelled` / `refunded` / `partially_refunded`；平台單（`aomi` / `mfood`） |
 * | Ledger 線上單 | 任何**非終態**（`pending` / `accepted` / `preparing` / `ready` / `delivering` …），唔理付款狀態 | `completed` / `cancelled` / `refunded` |
 *
 * 本地口徑同報表「未結帳」完全一致（見 `offline-report.ts` 嘅狀態表），
 * 唔可以自己另作一套，否則交班提示同報表 KPI 會夾唔到。
 *
 * ## 兩個關鍵紀律
 *
 * ① **平台單唔提**：澳覓／MFOOD 單由平台 App 自己管流程，POS 嘅 `status` 只係
 *    一個投影；將佢哋算「未完成」＝每班都誤報一堆，員工會學識無視提示。
 *
 * ② **線上單要同本地投影去重**：同一張單如果本地已經有投影（任何狀態），
 *    Ledger 嗰行就唔再列 —— 有投影就以本地狀態為準。否則同一張單會出現兩次，
 *    而且「本地已 settled、Ledger 未 completed」嘅同步滯後會被誤報成未完成。
 *
 * ## 為何係純模組
 *
 * `npm test` ＝ `node --test`（唔認 `@/` alias），所以零 `@/` import、
 * 所有 import 相對 + 顯式 `.ts`。`platform-order.ts` 同 `order-event-time.ts`
 * 本身就係零 import，可以安全拉入。
 */

import { isPlatformOrderSource } from "./platform-order.ts";
import { orderEventInstant, type TimeStampableOrder } from "./order-event-time.ts";

/** 本地 POS 單嘅「未完成」狀態（＝報表「未結帳」口徑）。 */
export const UNFINISHED_LOCAL_STATUSES = ["draft", "sent_to_kitchen", "paid", "reopened"] as const;

/** 線上（Ledger）終態：呢啲唔算未完成。 */
const TERMINAL_ONLINE_STATUSES = ["completed", "cancelled", "canceled", "refunded", "closed"] as const;

/** 交班提示最多列幾多行（UI 只顯示頭幾行，其餘摺成「另有 N 張」）。 */
export const UNFINISHED_PREVIEW_LIMIT = 5;

/** 本地單嘅結構型別（唔綁死 `PosOrder`，方便單測同 server 側重用）。 */
export type UnfinishedLocalOrderLike = TimeStampableOrder & {
  id: string;
  status?: string | null;
  source?: string | null;
  onlineOrderId?: string | null;
  localOrderNo?: string;
  tableName?: string;
  total?: number;
  prepaidAmount?: number;
};

/** 線上單嘅結構型別（唔綁死 `LedgerOnlineOrder`）。 */
export type UnfinishedOnlineOrderLike = TimeStampableOrder & {
  id: string;
  status?: string | null;
  paymentStatus?: string | null;
  total?: number;
  paidAmount?: number;
  pickupCode?: string;
  tabType?: string;
};

export type UnfinishedItem =
  | {
      source: "local";
      id: string;
      /** 呢張單係唔係已經收咗錢（本地 `paid` / 有預付金額）。 */
      paid: boolean;
      amount: number;
      eventAt: number;
      /** 原始狀態值（顯示文案由 UI 映射，唔喺純模組寫死中文）。 */
      status: string;
      order: UnfinishedLocalOrderLike;
    }
  | {
      source: "online";
      id: string;
      paid: boolean;
      amount: number;
      eventAt: number;
      status: string;
      order: UnfinishedOnlineOrderLike;
    };

export type UnfinishedSummary = {
  /** 已排序：已付款優先，再按事件時間舊→新。 */
  items: UnfinishedItem[];
  total: number;
  localCount: number;
  onlineCount: number;
  /** 已付款（錢已收，但工序未完成）。 */
  paidCount: number;
  paidAmount: number;
  /** 未付款。 */
  unpaidCount: number;
};

/**
 * 本地單係唔係未完成。
 *
 * ⚠️ 平台單（`source` = `aomi` / `mfood`）一律唔算 —— 見檔頭紀律①。
 */
export function isUnfinishedLocalOrder(order: {
  status?: string | null;
  source?: string | null;
}): boolean {
  if (isPlatformOrderSource(order.source)) return false;
  const status = String(order.status ?? "").trim();
  return (UNFINISHED_LOCAL_STATUSES as readonly string[]).includes(status);
}

/** 線上單係唔係未完成（唔理付款狀態；終態一律排除）。 */
export function isUnfinishedOnlineOrder(order: { status?: string | null }): boolean {
  const status = String(order.status ?? "").trim().toLowerCase();
  // 狀態缺失唔當未完成：寧願唔提，都唔好製造一堆假警報令員工無視提示。
  if (!status) return false;
  if (status.includes("cancel")) return false;
  return !TERMINAL_ONLINE_STATUSES.some((terminal) => status === terminal || status.includes(terminal));
}

/**
 * 併合本地＋線上未完成單。
 *
 * @param params.localOrders  **全量**本地單（唔好預先篩走 settled —— 去重要用佢哋嘅
 *                            `onlineOrderId`，否則「本地已完成、Ledger 滯後」會誤報）。
 * @param params.onlineOrders Ledger 單（已付款＋未付款一齊傳；重複 id 會自動去重）。
 */
export function collectUnfinishedOrders(params: {
  localOrders: readonly UnfinishedLocalOrderLike[];
  onlineOrders: readonly UnfinishedOnlineOrderLike[];
}): UnfinishedSummary {
  const localOnlineIds = new Set<string>();
  for (const order of params.localOrders) {
    const onlineId = String(order.onlineOrderId ?? "").trim();
    if (onlineId) localOnlineIds.add(onlineId);
  }

  const localOpen = params.localOrders.filter(isUnfinishedLocalOrder);

  const seenOnline = new Set<string>();
  const onlineOpen: UnfinishedOnlineOrderLike[] = [];
  for (const order of params.onlineOrders) {
    const id = String(order.id ?? "").trim();
    if (!id || seenOnline.has(id)) continue;
    seenOnline.add(id);
    if (localOnlineIds.has(id)) continue; // 本地有投影 → 以本地為準（見檔頭紀律②）
    if (!isUnfinishedOnlineOrder(order)) continue;
    onlineOpen.push(order);
  }

  const items: UnfinishedItem[] = [
    ...localOpen.map<UnfinishedItem>((order) => ({
      source: "local",
      id: order.id,
      paid: String(order.status ?? "") === "paid" || (Number(order.prepaidAmount ?? 0) || 0) > 0,
      amount: Number(order.total ?? 0) || 0,
      eventAt: orderEventInstant(order),
      status: String(order.status ?? ""),
      order,
    })),
    ...onlineOpen.map<UnfinishedItem>((order) => ({
      source: "online",
      id: order.id,
      paid: String(order.paymentStatus ?? "") === "paid",
      amount: Number(order.total ?? order.paidAmount ?? 0) || 0,
      eventAt: orderEventInstant(order),
      status: String(order.status ?? ""),
      order,
    })),
  ];

  // 排序：已付款優先（錢已收 = 最需要確認），再按事件時間舊→新（最舊嗰張最易被遺忘）。
  items.sort((a, b) => {
    if (a.paid !== b.paid) return a.paid ? -1 : 1;
    const at = a.eventAt || Number.MAX_SAFE_INTEGER;
    const bt = b.eventAt || Number.MAX_SAFE_INTEGER;
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });

  const paidItems = items.filter((item) => item.paid);
  const localCount = items.filter((item) => item.source === "local").length;
  const onlineCount = items.length - localCount;

  return {
    items,
    total: items.length,
    localCount,
    onlineCount,
    paidCount: paidItems.length,
    paidAmount: Math.round(paidItems.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
    unpaidCount: items.length - paidItems.length,
  };
}
