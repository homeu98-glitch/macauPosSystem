"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  getMerchantReportSummary,
  type LedgerReportSummary,
} from "@/lib/ledger/reports";
import { restoreLedgerSession } from "@/lib/ledger/session";
import { getOrderDetail, listMerchantOrders, fetchAdminLedgerOrders, type LedgerOrderDetailItem } from "@/lib/ledger/orders";
import type { LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import { paymentModeLabel } from "@/lib/ledger/order-mapper";
import { fetchPurchaseSummary, type PurchaseSummary } from "@/lib/inventory-stats";
import {
  loadAuthSession,
  loadBootstrapCache,
  loadDeletedOrderIds,
  loadOrders,
  loadPosLocalSettings,
  loadSoldOutState,
  savePosLocalSettings,
} from "@/lib/storage";
import { orderMatchesReportRange, ledgerReportRangeForKey, type ReportRangeKey } from "@/lib/ledger/report-period";
import {
  computeIngredientConsumption,
  inMacauMonth,
  loadBom,
  type BomEntry,
} from "@/lib/restaurant-bom";
import {
  computeFootfallFromOrders,
} from "@/lib/restaurant-footfall";
import { formatMoney } from "@/lib/format";
import { buildOnlineOrderDetailNotes, buildOrderDetailNotes } from "@/lib/pos/order-notes";
import { OrderDetailList, type OrderDetailRow } from "@/components/order-detail-list";
import { posDeviceAuthHeaders, refreshPosDeviceTokenIfNeeded } from "@/lib/pos/pos-sync-auth";
import { readNetworkOnline } from "@/lib/use-network-online";
import type { PosOrder, PosLocalSettings } from "@/lib/types";
import Link from "next/link";

// 篩選順序統一：今天 / 昨天 / 7天 / 30天 / 全部（置右上）
const FILTERS: Array<{ key: ReportRangeKey; label: string }> = [
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "7d", label: "7天" },
  { key: "30d", label: "30天" },
  { key: "all", label: "全部" },
];

function macauHour(iso: string): number {
  try {
    const s = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Macau",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(iso));
    return parseInt(s, 10) || 0;
  } catch {
    return new Date(iso).getHours();
  }
}

interface DishRow {
  /** 聚合 key：`menuItemId|下單當時菜品名`。快閃餐改名／改價（ID 不變）時唔同名稱各自一行。 */
  key: string;
  /** 下單當時快照菜品名（唔強制對應返當前餐牌名稱）。 */
  name: string;
  offlineQty: number;
  onlineQty: number;
  revenue: number;
}

interface TableRow {
  tableId: string;
  name: string;
  orders: number;
  covers: number;
}

interface ServingStats {
  count: number;
  avgMin: number;
  medianMin: number;
  p95Min: number;
  /** true = 部分樣本缺時間戳，以落單→結帳/updatedAt 估算 */
  estimated: boolean;
}

/** 堂食/外賣流程每個步驟嘅統計（avg / median / P95 / 樣本數 / 估算標記）。 */
interface StepStats {
  count: number;
  avgMin: number;
  medianMin: number;
  p95Min: number;
  estimated: boolean;
}

/** 堂食（無出餐概念）：以「下單 → 送廚 → 結帳 → 整體」三段呈現。 */
interface DineInServingBreakdown {
  orderToKitchen: StepStats;
  kitchenToSettle: StepStats;
  total: StepStats;
}

/** 快餐 / 外賣（有明確出餐）：「下單 → 送廚 → 出餐 → 完成 → 整體」四段呈現。 */
interface QuickServingBreakdown {
  orderToKitchen: StepStats;
  kitchenToServed: StepStats;
  servedToSettled: StepStats;
  total: StepStats;
}

/** 單張單嘅出餐分鐘數。有 sentToKitchenAt + servedAt 即實測；否則估算（落單→結帳）。 */
function servingMinutes(o: PosOrder): { ms: number; estimated: boolean } | null {
  const sent = o.sentToKitchenAt ? Date.parse(o.sentToKitchenAt) : null;
  const served = o.servedAt ? Date.parse(o.servedAt) : null;
  if (sent && served) return { ms: Math.max(0, served - sent), estimated: false };
  const s = sent ?? Date.parse(o.createdAt);
  const e = served ?? (o.originalSettledAt ? Date.parse(o.originalSettledAt) : Date.parse(o.updatedAt));
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return { ms: Math.max(0, e - s), estimated: true };
}

function emptyStepStats(): StepStats {
  return { count: 0, avgMin: 0, medianMin: 0, p95Min: 0, estimated: false };
}

/** 收集「落單 → 送廚」、「送廚 → 出餐」、「出餐 → 結帳」、「整體」嘅樣本，傳回每段統計。 */
function quickStepsForOrder(o: PosOrder): {
  orderToKitchen: { ms: number; estimated: boolean } | null;
  kitchenToServed: { ms: number; estimated: boolean } | null;
  servedToSettled: { ms: number; estimated: boolean } | null;
  total: { ms: number; estimated: boolean } | null;
} {
  const created = Date.parse(o.createdAt);
  const sent = o.sentToKitchenAt ? Date.parse(o.sentToKitchenAt) : null;
  const served = o.servedAt ? Date.parse(o.servedAt) : null;
  const settled = o.originalSettledAt
    ? Date.parse(o.originalSettledAt)
    : o.status === "settled" || o.status === "partially_refunded" || o.status === "refunded"
      ? Date.parse(o.updatedAt)
      : NaN;
  return {
    orderToKitchen:
      sent && Number.isFinite(created) ? { ms: Math.max(0, sent - created), estimated: false } : null,
    kitchenToServed:
      sent && served ? { ms: Math.max(0, served - sent), estimated: false } : null,
    servedToSettled:
      served && Number.isFinite(settled) ? { ms: Math.max(0, settled - served), estimated: false } : null,
    total:
      Number.isFinite(created) && Number.isFinite(settled)
        ? { ms: Math.max(0, settled - created), estimated: false }
        : null,
  };
}

/** 堂食：下單 → 送廚 → 結帳 → 整體。缺時間戳嘅步驟用 fallback 估算。 */
function dineInStepsForOrder(o: PosOrder): {
  orderToKitchen: { ms: number; estimated: boolean } | null;
  kitchenToSettle: { ms: number; estimated: boolean } | null;
  total: { ms: number; estimated: boolean } | null;
} {
  const created = Date.parse(o.createdAt);
  const sent = o.sentToKitchenAt ? Date.parse(o.sentToKitchenAt) : null;
  const settled = o.originalSettledAt
    ? Date.parse(o.originalSettledAt)
    : o.status === "settled" || o.status === "partially_refunded" || o.status === "refunded"
      ? Date.parse(o.updatedAt)
      : NaN;
  return {
    orderToKitchen:
      sent && Number.isFinite(created) ? { ms: Math.max(0, sent - created), estimated: false } : null,
    kitchenToSettle:
      sent && Number.isFinite(settled) ? { ms: Math.max(0, settled - sent), estimated: false } : null,
    total:
      Number.isFinite(created) && Number.isFinite(settled)
        ? { ms: Math.max(0, settled - created), estimated: false }
        : null,
  };
}

function summarizeSteps(samples: Array<{ ms: number; estimated: boolean }>): StepStats {
  if (samples.length === 0) return emptyStepStats();
  const sortedMs = samples.map((s) => s.ms).sort((a, b) => a - b);
  const total = sortedMs.reduce((s, v) => s + v, 0);
  return {
    count: samples.length,
    avgMin: total / samples.length / 60000,
    medianMin: medianOf(sortedMs) / 60000,
    p95Min: p95Of(sortedMs) / 60000,
    estimated: samples.some((s) => s.estimated),
  };
}

function medianOf(sortedMs: number[]): number {
  const n = sortedMs.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sortedMs[(n - 1) / 2];
  return (sortedMs[n / 2 - 1] + sortedMs[n / 2]) / 2;
}

function p95Of(sortedMs: number[]): number {
  const n = sortedMs.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1));
  return sortedMs[idx];
}

interface Agg {
  revenue: number;
  count: number;
  covers: number;
  discount: number;
  voidQty: number;
  voidAmt: number;
  dishes: DishRow[];
  tables: TableRow[];
  byHour: number[];
  onlineRevenue: number;
  offlineRevenue: number;
  totalSoldQty: number;
  /** 兼容舊 serving 欄位（出餐分鐘數），保留以便其他模塊用。 */
  serving: ServingStats;
  /** 堂食時長：下單 → 送廚 → 結帳 → 整體 */
  dineInServing: DineInServingBreakdown;
  /** 外賣 / 快餐時長：下單 → 送廚 → 出餐 → 完成 → 整體 */
  quickServing: QuickServingBreakdown;
  /**
   * 應收金額合計：菜品未優惠前的原價金額（= Σ item.price × quantity + serviceCharge + tax）。
   * 注意：item.price = 落單時嘅 base price（未套單品 discountRate）；serviceChargeAmount / taxAmount
   * 直接由 order 拎。對於純 Ledger 線上單冇本地 OrderItem，會由 subtotalBeforeDiscount 補上。
   */
  receivableTotal: number;
  /**
   * 實收金額合計：菜品優惠後商家實際收到的金額（= order.total）。對於 Ledger 線上單
   * 即 paidAmount / total。
   */
  paidTotal: number;
  /**
   * 支付方式分項：key = 已中文化的支付方式名（POS 用 order.paymentMethod、Ledger 用 paymentModeLabel）。
   * value = { receivable, paid, count }。
   */
  paymentBreakdown: PaymentBreakdown;
  /**
   * 訂單明細（逐筆）：與支付方式分項同一批訂單（線下 in-range 已結帳 + Ledger 純線上單），
   * 按結賬時間倒序。欄位見 {@link OrderDetailRow}。
   */
  orderDetails: OrderDetailRow[];
}

/** 一行支付方式統計：應收 / 實收 / 訂單數。 */
interface PaymentMethodBucket {
  receivable: number;
  paid: number;
  count: number;
}
type PaymentBreakdown = Record<string, PaymentMethodBucket>;

interface MenuMeta {
  /** menuItemId → MenuItem */
  itemMap: Map<string, { categoryId: string; name: string }>;
  /** categoryId → category name */
  categoryMap: Map<string, string>;
  /** 菜名 → MenuItem（fallback 配對用） */
  nameMap: Map<string, { categoryId: string; name: string }>;
  /** 正規化菜名 → MenuItem（去空白小寫 fallback） */
  normalizedNameMap: Map<string, { categoryId: string; name: string }>;
  /** 原始 bootstrap 摘要，用於診斷 */
  boot: {
    storeId: string;
    storeName: string;
    menuItemCount: number;
    categoryCount: number;
    lastUpdatedAt: string;
    sampleMenuItemIds: string[];
    sampleCategoryIds: string[];
    /** 當前餐牌菜品名樣本（前 12 個），用嚟同「未匹配菜品名」肉眼對照 */
    sampleMenuItemNames: string[];
  };
}

function buildMenuMeta(): MenuMeta {
  const boot = loadBootstrapCache();
  const items = boot?.menuItems ?? [];
  const categories = boot?.categories ?? [];
  const itemMap = new Map<string, { categoryId: string; name: string }>();
  const nameMap = new Map<string, { categoryId: string; name: string }>();
  const normalizedNameMap = new Map<string, { categoryId: string; name: string }>();
  for (const m of items) {
    if (!itemMap.has(m.id)) itemMap.set(m.id, { categoryId: m.categoryId, name: m.name });
    if (!nameMap.has(m.name)) nameMap.set(m.name, { categoryId: m.categoryId, name: m.name });
    const key = normalizeMenuName(m.name);
    if (key && !normalizedNameMap.has(key)) normalizedNameMap.set(key, { categoryId: m.categoryId, name: m.name });
  }
  return {
    itemMap,
    categoryMap: new Map(categories.map((c) => [c.id, c.name])),
    nameMap,
    normalizedNameMap,
    boot: {
      storeId: boot?.storeId ?? "",
      storeName: boot?.storeName ?? "",
      menuItemCount: items.length,
      categoryCount: categories.length,
      lastUpdatedAt: boot?.lastUpdatedAt ?? "",
      sampleMenuItemIds: items.slice(0, 5).map((m) => m.id),
      sampleCategoryIds: categories.slice(0, 5).map((c) => c.id),
      sampleMenuItemNames: items.slice(0, 12).map((m) => m.name),
    },
  };
}

/** 菜名正規化：去掉所有空白 + 轉小寫。只用作 fallback 配對。 */
function normalizeMenuName(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/** 按 menuItemId → name → normalized name 嘅順序，喺 bootstrap 搵對應嘅 MenuItem。
 *  用嚟處理 Ledger 明細帶冇前綴 product id、但本地 bootstrap 用 `ledger-` 前綴 id 嘅情況。 */
function resolveMenuMetaItem(
  menuItemId: string,
  itemName: string,
  meta: MenuMeta,
): { categoryId: string; name: string; matchedBy: "id" | "name" | "normalized" | null } {
  const byId = meta.itemMap.get(menuItemId);
  if (byId) return { ...byId, matchedBy: "id" };
  const byName = meta.nameMap.get(itemName);
  if (byName) return { ...byName, matchedBy: "name" };
  const key = normalizeMenuName(itemName);
  const byNorm = key ? meta.normalizedNameMap.get(key) : undefined;
  if (byNorm) return { ...byNorm, matchedBy: "normalized" };
  return { categoryId: "", name: "", matchedBy: null };
}

/** 判斷訂單是否應計入銷售統計（菜品 / 營業額 / 桌台 / 尖峰時段）。
 *  - 線下 POS 單：只統計 settled。
 *  - 帶 onlineOrderId 的單（不論單據嚟自 POS 定 Ledger 同步）：settled 或 paid 都計。
 *  - 退款狀態（refunded / partially_refunded）一律不計入銷售。
 *  export：admin panel「全部商家」彙總報表（admin-all-report）沿用同一口徑。 */
export function isSaleCountable(o: PosOrder): boolean {
  if (o.status === "refunded" || o.status === "partially_refunded") return false;
  if (o.status === "settled" || o.status === "paid") return true;
  return false;
}

/** 訂單狀態碼 → 中文標籤（報表提示文案同狀態分佈顯示用）。 */
const POS_ORDER_STATUS_LABELS: Record<string, string> = {
  draft: "未送單",
  sent_to_kitchen: "已送廚房（未結帳）",
  paid: "已付款",
  settled: "已結帳",
  reopened: "已重開",
  cancelled: "已作廢",
  partially_refunded: "部分退款",
  refunded: "已退款",
};

function statusLabelOf(status: string): string {
  return POS_ORDER_STATUS_LABELS[status] ?? status;
}

/** 掃描 localStorage 內 macau-pos/stores/&#123;storeId&#125;/orders 同 macau-pos/orders 嘅單數，
 *  用嚟排查「舊分店（60000003 等）資料殘留」嘅來源。
 *  - storageOrdersByStore：分店 ID → 訂單數
 *  - legacyOrdersCount：macau-pos/orders 舊全域 key 嘅單數（v1 之前嘅 unscoped 殘留） */
function scanStorageOrders(): {
  storageOrdersByStore: Record<string, number>;
  legacyOrdersCount: number;
} {
  const result: { storageOrdersByStore: Record<string, number>; legacyOrdersCount: number } = {
    storageOrdersByStore: {},
    legacyOrdersCount: 0,
  };
  if (typeof window === "undefined") return result;
  try {
    const prefix = "macau-pos/stores/";
    const suffix = "/orders";
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k) continue;
      if (k === `macau-pos/orders`) {
        try {
          const raw = window.localStorage.getItem(k);
          const arr = raw ? (JSON.parse(raw) as unknown[]) : [];
          result.legacyOrdersCount = Array.isArray(arr) ? arr.length : 0;
        } catch {
          // ignore parse error
        }
        continue;
      }
      if (k.startsWith(prefix) && k.endsWith(suffix)) {
        const storeId = k.slice(prefix.length, k.length - suffix.length);
        try {
          const raw = window.localStorage.getItem(k);
          const arr = raw ? (JSON.parse(raw) as unknown[]) : [];
          result.storageOrdersByStore[storeId] = Array.isArray(arr) ? arr.length : 0;
        } catch {
          result.storageOrdersByStore[storeId] = -1; // 標記 parse 失敗
        }
      }
    }
  } catch {
    // localStorage 可能喺 SSR / 私隱模式存取失敗
  }
  return result;
}

/** Ledger 線上單明細（訂單 + 菜品快照），畀菜品銷售排行 / 時長統計用。 */
type OnlineDishSource = { order: LedgerOnlineOrder; items: LedgerOrderDetailItem[] };

/** 線上單 fulfillmentType → 餐台欄顯示標籤（線上單冇實體餐台號）。 */
function onlineFulfillmentLabel(fulfillmentType?: string): string {
  const t = String(fulfillmentType ?? "").toLowerCase();
  if (t === "dine_in") return "線上·堂食";
  if (t === "takeaway" || t === "delivery") return "線上·外賣";
  if (t === "pickup" || t === "self_pickup") return "線上·自取";
  return "線上";
}

/** PosOrder → 訂單明細行（訂單號 / 折扣備註 / 餐台 / 應收 / 優惠金額 / 實收 / 收款類型 / 收銀員 / 結賬時間）。 */
function posOrderToDetailRow(o: PosOrder, receivable: number): OrderDetailRow {
  return {
    id: o.id,
    orderNo: o.localOrderNo,
    table: o.tableName || o.tableId,
    receivable,
    paid: o.total,
    method: o.paymentMethod ?? "未記錄",
    cashier: o.settledByName ?? o.settledBy ?? "未記錄",
    settledAt: o.originalSettledAt ?? o.updatedAt,
    // 折扣 / 免單 / 抹零備註（2026-09-11 需求 #2）：推導邏輯集中喺 order-notes，
    // 同交班明細、訂單紀錄用同一套，確保三處完全一致。
    notes: buildOrderDetailNotes(o),
  };
}

function aggregate(orders: PosOrder[], range: ReportRangeKey, onlineWithItems?: OnlineDishSource[]): Agg {
  const counted = orders.filter((o) => isSaleCountable(o));
  const inRange = counted.filter((o) => orderMatchesReportRange(o, range));

  let revenue = 0;
  let covers = 0;
  let discount = 0;
  let voidQty = 0;
  let voidAmt = 0;
  let onlineRevenue = 0;
  let offlineRevenue = 0;
  let totalSoldQty = 0;
  let receivableTotal = 0;
  let paidTotal = 0;

  const dishMap = new Map<string, DishRow>();
  const tableMap = new Map<string, TableRow>();
  const byHour = new Array<number>(24).fill(0);
  const paymentBreakdown: PaymentBreakdown = {};
  const orderDetails: OrderDetailRow[] = [];

  for (const o of inRange) {
    revenue += o.total;
    discount += o.discountAmount;
    covers += o.partySize ?? 0;
    const isOnline = !!o.onlineOrderId;
    if (isOnline) onlineRevenue += o.total;
    else offlineRevenue += o.total;

    // 應收 = Σ(item.price × quantity) + serviceCharge + tax
    //  - item.price = 落單時嘅 base price（未套單品 discountRate），已包含 voided 菜品的原價
    //  - 服務費 + 稅都按未優惠前嘅 subtotal 計，所以原價合計 + service + tax = 「原價金額」
    // 實收 = o.total（已扣全單 discount + 抹零 + 服務費 + 稅 後商家實際收嘅）
    const itemsGross = o.items.reduce((sum, it) => sum + it.price * it.quantity, 0);
    const orderReceivable =
      itemsGross + (o.serviceChargeAmount ?? 0) + (o.taxAmount ?? 0);
    receivableTotal += orderReceivable;
    paidTotal += o.total;

    // 支付方式分項（線上單可能嘅 paymentMethod 為 "線上" / 自訂字串，保留原樣）
    const method = o.paymentMethod ?? "未記錄";
    const bucket = paymentBreakdown[method] ?? { receivable: 0, paid: 0, count: 0 };
    bucket.receivable += orderReceivable;
    bucket.paid += o.total;
    bucket.count += 1;
    paymentBreakdown[method] = bucket;

    // 訂單明細（逐筆）：同支付方式分項同一口徑
    orderDetails.push(posOrderToDetailRow(o, orderReceivable));

    byHour[macauHour(o.createdAt)] += 1;

    const tr =
      tableMap.get(o.tableId) ?? { tableId: o.tableId, name: o.tableName, orders: 0, covers: 0 };
    tr.orders += 1;
    tr.covers += o.partySize ?? 0;
    tableMap.set(o.tableId, tr);

    for (const it of o.items) {
      if (it.voided) {
        voidQty += it.quantity;
        voidAmt += it.price * it.quantity;
        continue;
      }
      totalSoldQty += it.quantity;

      // 按「下單當時快照」聚合：menuItemId + 訂單內記錄嘅菜品名（快照）。
      // 快閃餐只改名／改價（Ledger 菜品 ID 不變）時，唔同名稱／價格各自一行：
      // 今天叫 A 餐、明天叫 B 餐 → 報表顯示「A餐 X 份、B餐 Y 份」，
      // 唔會強制對應返當前餐牌名稱，歷史訂單亦唔會因改名而「失蹤」。
      // 金額用訂單內快照價 it.price（落單當時賣出嘅價錢）。
      const key = `${it.menuItemId}|${it.name}`;
      const d =
        dishMap.get(key) ?? { key, name: it.name, offlineQty: 0, onlineQty: 0, revenue: 0 };
      d.revenue += it.price * it.quantity;
      if (isOnline) d.onlineQty += it.quantity;
      else d.offlineQty += it.quantity;
      dishMap.set(key, d);
    }
  }

  // Ledger 純線上單菜品明細（get_order_detail 攞返嚟，可能從未入 POS DB）：
  // 以「線上」渠道併入菜品銷售排行。聚合 key 同 POS 快照一致（menuItemId|名稱），
  // 名稱用 Ledger 明細快照，唔強制對應當前餐牌。
  for (const { order: onlineOrder, items } of onlineWithItems ?? []) {
    // 同一張單只入帳一次（合併應收／實收／支付方式分項）
    const orderPaid = Number(onlineOrder.total ?? onlineOrder.paidAmount ?? 0);
    const orderReceivable = Number(
      onlineOrder.subtotalBeforeDiscount ?? onlineOrder.total + (onlineOrder.discountAmount ?? 0),
    );
    // 應收 fallback：若 subtotalBeforeDiscount 同 discountAmount 都冇，就退而用 paid
    const safeReceivable = Number.isFinite(orderReceivable) && orderReceivable > 0 ? orderReceivable : orderPaid;
    receivableTotal += safeReceivable;
    paidTotal += orderPaid;
    // 支付方式：Ledger 用 paymentModeLabel 翻譯 paymentMode（balance → 餘額扣點、in_store → 到店付款）
    const method = paymentModeLabel(onlineOrder.paymentMode) || "線上單";
    const bucket = paymentBreakdown[method] ?? { receivable: 0, paid: 0, count: 0 };
    bucket.receivable += safeReceivable;
    bucket.paid += orderPaid;
    bucket.count += 1;
    paymentBreakdown[method] = bucket;

    // 訂單明細（逐筆）：Ledger 純線上單冇餐台號 → 用履約方式標籤；收銀員 = 下單客人
    orderDetails.push({
      id: onlineOrder.id,
      // 線上單冇 localOrderNo → 第一列顯示「線上單」+ 取餐碼
      pickupCode: onlineOrder.pickupCode,
      table: onlineFulfillmentLabel(onlineOrder.fulfillmentType),
      receivable: safeReceivable,
      paid: orderPaid,
      method,
      cashier: "客人",
      settledAt: onlineOrder.updatedAt ?? onlineOrder.createdAt ?? "",
      // 線上單折扣：Ledger 側只有金額冇原因文字 → 統一顯示「線上優惠」chip。
      notes: buildOnlineOrderDetailNotes(onlineOrder.discountAmount),
    });

    for (const it of items) {
      const name = it.name || "(未知菜品)";
      const qty = Math.max(0, Number(it.qty) || 0);
      if (qty === 0) continue;
      const price = Number(it.unitPrice ?? 0);
      const key = `${it.menuItemId ?? name}|${name}`;
      const d = dishMap.get(key) ?? { key, name, offlineQty: 0, onlineQty: 0, revenue: 0 };
      d.onlineQty += qty;
      d.revenue += price * qty;
      dishMap.set(key, d);
    }
  }

  const dishes = Array.from(dishMap.values()).sort(
    (a, b) => b.offlineQty + b.onlineQty - (a.offlineQty + a.onlineQty),
  );
  const tables = Array.from(tableMap.values()).sort((a, b) => b.orders - a.orders);

  const servingSamples: number[] = [];
  let servingEstimated = false;
  const dineInOrderToKitchen: Array<{ ms: number; estimated: boolean }> = [];
  const dineInKitchenToSettle: Array<{ ms: number; estimated: boolean }> = [];
  const dineInTotal: Array<{ ms: number; estimated: boolean }> = [];
  const quickOrderToKitchen: Array<{ ms: number; estimated: boolean }> = [];
  const quickKitchenToServed: Array<{ ms: number; estimated: boolean }> = [];
  const quickServedToSettled: Array<{ ms: number; estimated: boolean }> = [];
  const quickTotal: Array<{ ms: number; estimated: boolean }> = [];
  for (const o of inRange) {
    const sm = servingMinutes(o);
    if (sm) {
      servingSamples.push(sm.ms);
      if (sm.estimated) servingEstimated = true;
    }
    if (o.tableId === "counter") {
      // 快餐 / 自取 / 外賣：有明確出餐概念
      const steps = quickStepsForOrder(o);
      if (steps.orderToKitchen) quickOrderToKitchen.push(steps.orderToKitchen);
      if (steps.kitchenToServed) quickKitchenToServed.push(steps.kitchenToServed);
      if (steps.servedToSettled) quickServedToSettled.push(steps.servedToSettled);
      if (steps.total) quickTotal.push(steps.total);
    } else {
      // 堂食：無出餐，以「送廚 → 結帳」當作整體服務時間
      const steps = dineInStepsForOrder(o);
      if (steps.orderToKitchen) dineInOrderToKitchen.push(steps.orderToKitchen);
      if (steps.kitchenToSettle) dineInKitchenToSettle.push(steps.kitchenToSettle);
      if (steps.total) dineInTotal.push(steps.total);
    }
  }

  // Ledger 純線上單（可能從未入 POS DB）：冇送廚／出餐時間戳，
  // 只可以用「下單 createdAt → 付款完成 updatedAt」估算整體時長（標記 estimated）。
  // 依 fulfillmentType 分桶：dine_in → 堂食；其他（takeaway / delivery）→ 快餐 / 外賣。
  for (const { order: o } of onlineWithItems ?? []) {
    const created = Date.parse(o.createdAt ?? "");
    const done = Date.parse(o.updatedAt ?? "");
    if (!Number.isFinite(created) || !Number.isFinite(done)) continue;
    const sample = { ms: Math.max(0, done - created), estimated: true };
    if (String(o.fulfillmentType ?? "").toLowerCase() === "dine_in") dineInTotal.push(sample);
    else quickTotal.push(sample);
  }
  servingSamples.sort((a, b) => a - b);
  const servingCount = servingSamples.length;
  const serving: ServingStats = {
    count: servingCount,
    avgMin: servingCount ? servingSamples.reduce((s, v) => s + v, 0) / servingCount / 60000 : 0,
    medianMin: medianOf(servingSamples) / 60000,
    p95Min: p95Of(servingSamples) / 60000,
    estimated: servingEstimated,
  };

  const dineInServing: DineInServingBreakdown = {
    orderToKitchen: summarizeSteps(dineInOrderToKitchen),
    kitchenToSettle: summarizeSteps(dineInKitchenToSettle),
    total: summarizeSteps(dineInTotal),
  };
  const quickServing: QuickServingBreakdown = {
    orderToKitchen: summarizeSteps(quickOrderToKitchen),
    kitchenToServed: summarizeSteps(quickKitchenToServed),
    servedToSettled: summarizeSteps(quickServedToSettled),
    total: summarizeSteps(quickTotal),
  };

  return {
    revenue,
    count: inRange.length,
    covers,
    discount,
    voidQty,
    voidAmt,
    dishes,
    tables,
    byHour,
    onlineRevenue,
    offlineRevenue,
    totalSoldQty,
    serving,
    dineInServing,
    quickServing,
    receivableTotal,
    paidTotal,
    paymentBreakdown,
    // 結賬時間倒序（最新單喺最上）；缺時間戳嘅排尾
    orderDetails: orderDetails.sort((a, b) => {
      const ta = a.settledAt ? Date.parse(a.settledAt) : 0;
      const tb = b.settledAt ? Date.parse(b.settledAt) : 0;
      return tb - ta;
    }),
  };
}

type Suggestion = { level: "r" | "o" | "i"; title: string; action: string };

const LEVEL_LABEL: Record<Suggestion["level"], string> = { r: "立即", o: "關注", i: "資訊" };

/** 持續訂閱 authSession 變化，確保切換店鋪後 merchantId 即時更新。
 *  解決 root cause：React 唔會自動訂閱 localStorage，直接喺 render call loadAuthSession()
 *  可能會喺切換帳號後短暫讀取舊店 merchantId。 */
function useReportMerchantId(): string | null {
  const [merchantId, setMerchantId] = useState<string | null>(() => loadAuthSession()?.merchantId ?? null);
  useEffect(() => {
    function sync() {
      setMerchantId(loadAuthSession()?.merchantId ?? null);
    }
    window.addEventListener("pos-auth-changed", sync);
    return () => window.removeEventListener("pos-auth-changed", sync);
  }, []);
  return merchantId;
}

/** 報表 backfill 需要嘅最大時間區間：
 *  - today / yesterday / 7d / 30d：按實際區間拉，減少 payload 同確保唔會被分頁截斷。
 *  - all：用 365 日滾動窗口（同 Ledger RPC 一致；足夠覆蓋絕大多數餐廳營運週期）。 */
function backfillRangeFor(range: ReportRangeKey, now = new Date()): { start: string; end: string } | null {
  if (range === "all") return ledgerReportRangeForKey("all", now);
  return ledgerReportRangeForKey(range, now);
}

export type RestaurantDailyReportProps = {
  /** admin panel 模式：覆寫 merchantId（唔經 auth session / POS 登入）。
   *  傳入即視為「admin 模式」：Ledger 會員類 RPC（需要 merchant JWT）會跳過，
   *  POS 訂單數據（/api/pos/state?storeId=）照常拉取——該 API 係 server service-role。 */
  merchantIdOverride?: string;
  /** admin 模式：顯示用店名（admin 裝置冇該店 bootstrap cache，fallback「本店」冇意義）。 */
  storeNameOverride?: string;
  /** admin「全部」模式：唔指定 merchantId，跨店彙總所有商家嘅 POS 訂單。
   *  訂單由 adminOrderFetcher 提供；本機 fallback / 店鋪過濾全部停用。 */
  allStoresMode?: boolean;
  /** admin 模式訂單 fetcher（GET /api/admin/orders，需 admin token，由 admin 頁面注入）。
   *  帶 `storeId` = 單店；唔帶 = 跨店彙總（「全部商家」模式）。 */
  adminOrderFetcher?: (params: {
    storeId?: string;
    start?: string;
    end?: string;
    limit: number;
    offset: number;
  }) => Promise<PosOrder[]>;
  /** 初始報表範圍（唔傳 = "today"）。
   *  admin 報表頁嘅「重新載入」用 remount（key 帶 refreshSeq）重置本組件全部 state，
   *  靠呢個 prop 喺 remount 後還原用戶已選嘅範圍（今日/昨日/7天/30天/全部），
   *  否則刷新完會彈返「今日」。 */
  initialRange?: ReportRangeKey;
  /** 範圍變更通知上一層 —— 畀 admin 頁面記住用戶選擇，remount 後用 initialRange 還原。 */
  onRangeChange?: (range: ReportRangeKey) => void;
  /** 軟刷新信號（自動刷新用）：值一變即重跑 POS 訂單 / Ledger 線上單 / Ledger 彙總三條
   *  fetch effect，**唔 remount、唔清舊數據** → 畫面上一直有數字，新數據返嚟先換。
   *  由外殼 `RestaurantDailyReport` 注入；直接使用本組件（唔經外殼）時唔傳即可。 */
  refreshToken?: number;
  /** 載入狀態通知：true = 至少有個數據源仲載入緊（初次 mount 亦為 true）。 */
  onBusyChange?: (busy: boolean) => void;
  /** 載入錯誤摘要（POS 訂單 / Ledger 線上單 / 線上單明細 / Ledger 彙總），冇錯傳 null。 */
  onLoadError?: (message: string | null) => void;
};

/** 報表自動刷新間隔（只喺分頁可見時執行）。 */
const AUTO_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
/** 兩次刷新之間嘅最短間隔 —— 去抖（避免 interval 同 visibilitychange 撞埋一齊）。 */
const MIN_REFRESH_GAP_MS = 20 * 1000;

/**
 * 自動刷新外殼（2026-09-10）。
 *
 * ## 點解要有
 *
 * 報表只在 mount 時拉一次數據，**補推／結帳之後畫面唔會自己更新**。
 * 2026-09-10 生產實例：對賬守護 17:51 已經把 3 張殭屍單補推上雲、DB 只剩 1 張未結帳，
 * 但商家 18:02 睇住嘅報表仍然寫「未結帳 3 張」—— 商家就係憑住一個過期畫面
 * 嚟問「點解 iPad 同步唔到」，白白浪費一輪排查。
 *
 * ## 做法：軟刷新（唔 remount）
 *
 * 原本想用 admin「重新載入」嗰套 `key` remount —— 但**唔得**：remount 會令
 * `dataReady` 由 false 重新嚟過，全頁 11 張卡一齊變 skeleton，每 3 分鐘閃一次；
 * 而且會丟失滾動位置同正在編輯嘅欄位（毛利率 inline edit）。自動刷新係背景行為，
 * 唔應該搶走用戶手上嘅畫面。
 *
 * 所以改為傳 `refreshToken` 落主體，由主體**加落三條數據 effect 嘅依賴陣列**
 * （POS 訂單 backfill / Ledger 線上單 / Ledger 彙總）。舊數據一直留在畫面上，
 * 直到新數據返嚟先換 —— 同大部分 dashboard 嘅行為一致。
 * 範圍經 `initialRange` / `onRangeChange` 保住（其實唔 remount 都唔會丟）。
 *
 * ## 幾時刷
 *
 * - 每 `AUTO_REFRESH_INTERVAL_MS`（3 分鐘）一次，**只喺分頁可見時**；
 * - 分頁由隱藏變可見（商戶切返嚟）→ 即刻刷（`MIN_REFRESH_GAP_MS` 去抖）。
 *
 * ⚠️ **離線時唔刷**：離線下報表會 fallback 讀本機暫存訂單，把一個正常嘅雲端畫面
 * 刷成「本機版」係降級唔係更新。等 `online` 事件 + 下一個 interval 自然會追上。
 */
export function RestaurantDailyReport(props: RestaurantDailyReportProps = {}) {
  // 每次 +1 = 要求主體軟刷新一次（見上方「做法」）。
  const [refreshToken, setRefreshToken] = useState(0);
  // 範圍提升到外殼：主體唔再 remount，但 keep 住呢個提升冇壞處
  // （admin 頁面自己 remount 我哋時，`initialRange` 仍然要有人記住）。
  const [range, setRange] = useState<ReportRangeKey>(props.initialRange ?? "today");
  const lastRefreshRef = useRef(0);
  const onRangeChange = props.onRangeChange;

  const bump = useCallback(() => {
    const now = Date.now();
    if (now - lastRefreshRef.current < MIN_REFRESH_GAP_MS) return;
    lastRefreshRef.current = now;
    setRefreshToken((t) => t + 1);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!readNetworkOnline()) return;
      bump();
    }, AUTO_REFRESH_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (!readNetworkOnline()) return;
      bump();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // 網絡由斷變通：即刻補一次（唔使等最多 3 分鐘嘅 interval）。
    const onOnline = () => bump();
    window.addEventListener("online", onOnline);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [bump]);

  const handleRange = useCallback(
    (next: ReportRangeKey) => {
      setRange(next);
      onRangeChange?.(next);
    },
    [onRangeChange],
  );

  return (
    <RestaurantDailyReportBody
      {...props}
      refreshToken={refreshToken}
      initialRange={range}
      onRangeChange={handleRange}
    />
  );
}

function RestaurantDailyReportBody(props: RestaurantDailyReportProps = {}) {
  // initialRange 只用作初始值；之後由用戶喺 UI 切。admin 頁面重新載入（remount）
  // 時會把上次嘅範圍傳返入嚟，避免刷新後彈返「今日」。
  const [range, setRange] = useState<ReportRangeKey>(props.initialRange ?? "today");
  // 初始 orders 設為空：避免 hydration / 切店時短暫讀取錯誤 scope 嘅 localStorage。
  // 真正訂單由下方 backfill effect 喺確認 merchantId 後拉取。
  const [orders, setOrders] = useState<PosOrder[]>([]);
  const [ledger, setLedger] = useState<{
    sel: LedgerReportSummary | null;
    d7: LedgerReportSummary | null;
    yest: LedgerReportSummary | null;
  }>({ sel: null, d7: null, yest: null });
  const [purchase, setPurchase] = useState<{ sel: PurchaseSummary | null; yest: PurchaseSummary | null }>({
    sel: null,
    yest: null,
  });
  const [lowStock, setLowStock] = useState<
    Array<{ name: string; qty: number; unit: string; par: number }> | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  // 整體載入門檻：POS 訂單補載 + Ledger 彙總都完成過至少一次，先唔顯示真實資料。
  // 切店 / 切帳號時重置，令報表先顯示 skeleton 再載入新店資料（杜絕閃現舊店）。
  const [backfillDone, setBackfillDone] = useState(false);
  const [ledgerDone, setLedgerDone] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  useEffect(() => {
    if (backfillDone && ledgerDone) setDataReady(true);
  }, [backfillDone, ledgerDone]);
  /** Ledger 線上單每小時計數（澳門時區），用以把尖峰時段圖合併 POS 線下單。 */
  const [onlineByHour, setOnlineByHour] = useState<number[]>(() => new Array<number>(24).fill(0));
  /** 當前範圍內可計入（paid、非 cancelled、區間內）嘅 Ledger 線上單，
   *  用以補入「當日人流」同「時長統計」（呢啲單可能從未入 POS DB）。 */
  const [onlineOrders, setOnlineOrders] = useState<LedgerOnlineOrder[]>([]);
  /** Ledger 線上單明細（order + 菜品快照），畀「菜品銷售排行」線上部分用。 */
  const [onlineDishSource, setOnlineDishSource] = useState<OnlineDishSource[]>([]);
  /** 線上單明細抓取狀態（診斷用）。 */
  const [onlineDetailInfo, setOnlineDetailInfo] = useState<{
    total: number;
    ok: number;
    failed: number;
    status: "idle" | "loading" | "success" | "error";
    lastError: string | null;
  }>({ total: 0, ok: 0, failed: 0, status: "idle", lastError: null });
  /** 最近一次「線上單分鐘小時抓取」嘅筆數／狀態，畀診斷面板睇。 */
  const [onlineFetchInfo, setOnlineFetchInfo] = useState<{
    fetched: number;
    counted: number;
    outOfRange: number;
    cancelled: number;
    unpaid: number;
    status: "idle" | "loading" | "success" | "error" | "skipped";
    lastError: string | null;
  }>({
    fetched: 0,
    counted: 0,
    outOfRange: 0,
    cancelled: 0,
    unpaid: 0,
    status: "idle",
    lastError: null,
  });

  // merchantId 解析：admin panel 傳入 merchantIdOverride 時以佢為準（admin 唔經
  // POS auth session）；POS 報表頁維持原本 useReportMerchantId() 行為不變。
  const sessionMerchantId = useReportMerchantId();
  const isAdminMode = props.merchantIdOverride !== undefined || props.allStoresMode === true;
  const merchantId = isAdminMode ? props.merchantIdOverride : sessionMerchantId;
  // 解構成 primitive / 穩定引用，畀 useEffect 依賴陣列用（避免依賴成個 props 物件）。
  const adminAllStoresMode = props.allStoresMode === true;
  const adminOrderFetcher = props.adminOrderFetcher;
  /** 軟刷新信號（外殼自動刷新注入，見 `refreshToken` prop 說明）。加落下面三條
   *  fetch effect 嘅依賴陣列；**唔可以**加落「切店/切範圍重置」effect，
   *  否則會清空 orders → 全頁 skeleton 閃一下（正正就係要避免嘅嘢）。 */
  const refreshToken = props.refreshToken ?? 0;
  const merchantIdForQuery = merchantId ?? ""; // 穩定型別用，空字串代表 dev 模式不帶 storeId
  const monthKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(new Date()).substring(0, 7);
  const bom: BomEntry[] = useMemo(() => loadBom(merchantId ?? ""), [merchantId]);

  // 雲端訂單補載序號：改變佢會強制重跑 backfill effect（切店 / 手動重新拉取）。
  const [backfillSeq, setBackfillSeq] = useState(0);

  // 切店 / 首次確認 merchantId 時立即清空舊店數據，杜絕閃現外店資料。
  // 切店 / 切範圍 / 切帳號時重置，杜絕閃現舊店／舊範圍資料（2026-09-06 加 range）。
  // 舊版只 merchantId 變化時重置 → 切「全部」→「今天」期間 orders 仍殘留「全部」嘅結果，
  // 新一輪 fetch 尚未返回嘅空窗 UI 顯示舊資料；改為 merchantId / range / adminAllStoresMode
  // 任一變化即清空 + backfillSeq++ 強制重跑 backfill effect。
  useEffect(() => {
    setOrders([]);
    setBackfillDone(false);
    setLedgerDone(false);
    setDataReady(false);
    setOnlineOrders([]);
    setOnlineByHour(new Array<number>(24).fill(0));
    setOnlineDishSource([]);
    setOnlineDetailInfo({ total: 0, ok: 0, failed: 0, status: "idle", lastError: null });
    setOnlineFetchInfo({
      fetched: 0,
      counted: 0,
      outOfRange: 0,
      cancelled: 0,
      unpaid: 0,
      status: "idle",
      lastError: null,
    });
    setBackfillSeq((n) => n + 1);
  }, [merchantId, range, adminAllStoresMode]);

  // 菜品銷售排行「更多」彈窗
  const [dishModalOpen, setDishModalOpen] = useState(false);
  const [dishModalPage, setDishModalPage] = useState(1);
  /**
   * 訂單明細預設收合（2026-09-10）。
   *
   * 訂單明細已移到 KPI 帶**正下方**（用戶要求），而佢係逐筆列表 —— 一間旺場餐廳
   * 一日幾百張單，全部展開會令下面所有區塊被推到很遠。所以預設只出頭
   * `ORDER_DETAIL_PREVIEW` 行，按「顯示全部」才展開。
   */
  const [orderDetailExpanded, setOrderDetailExpanded] = useState(false);
  const ORDER_DETAIL_PREVIEW = 10;
  const DISHES_PER_PAGE = 20;

  const consRange = useMemo(
    () => computeIngredientConsumption(orders, (o) => orderMatchesReportRange(o, range), bom),
    [orders, range, bom],
  );
  const consMonth = useMemo(
    () => computeIngredientConsumption(orders, (o) => inMacauMonth(o, monthKey), bom),
    [orders, monthKey, bom],
  );

  const storeName = useMemo(
    () => props.storeNameOverride ?? loadBootstrapCache(merchantId ?? undefined)?.storeName ?? "本店",
    [merchantId, props.storeNameOverride],
  );
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(new Date());

  // ── 雲端訂單補載（root-cause 修復）─────────────────────────────────────
  // 報表原本只讀 localStorage 訂單（loadOrders()）。換機 / 清 cache / 首次開啟時
  // localStorage 空 → 營業額、毛利、菜品排行、線上佔比全部空白；只有「會員充值」正常，
  // 因為嗰個係直接讀 Ledger 雲端（getMerchantReportSummary），唔經 localStorage。
  // 呢度喺 mount / authSession 變更時從 `/api/pos/state` 拉本店訂單。
  //
  // 注意三點：
  // 1) 唔套 filterResurrectedOrders —— 嗰個係收銀工作台用嚟防止舊終態單「復活」佔枱；
  //    報表正正需要已結帳 / 退款單做營收口徑，所以只過濾本機已真刪除嘅 tombstone。
  // 2) 唔用 mergeOrderLists(loadOrders(), fetched) —— 切換帳號時本機 orders 可能
  //    殘留舊 store scope 嘅單，硬 merge 會把兩間店資料混埋。雲端係單一可信源。
  // 3) 只 setOrders（記憶體），唔 saveOrders 寫返 localStorage —— 避免污染收銀端嘅
  //    「本機工作清單」語義（docs/52 收銀端故意唔復活 server 單邊終態單）。
  //
  // 兜底：雲端 fetch 完全失敗（例如離線）時，先 fallback 用本機 orders（過 tombstone），
  // 等下次 online 再補。但係，雲端有返「空陣列」（fetched.length === 0）就**唔可以**
  // 視為失敗——可能該店真係冇單，要顯示空狀態而唔係 fallback 到可能嘅舊 store 殘留。

  // DevTools debug panel state：用嚟喺瀏覽器直接觀察報表載入流程。
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugInfo, setDebugInfo] = useState<{
    status: "idle" | "loading" | "success" | "error";
    /**
     * 呢一版數字嘅**來源**（2026-09-10 加）。
     *
     * 以前只有 `fetched.length > 0 ? 雲端 : (cloudFailed ? 本機 : 空)` 一行分流，
     * 但**冇任何地方顯示用咗邊個來源** —— 同一個「未結帳 N 張」KPI，
     * 可能係 DB 嘅數，亦可能係某台機 localStorage 嘅數，畫面上一模一樣。
     * 商家無從分辨，排查亦無從入手。
     *
     * - `cloud`：雲端為真源（正常）
     * - `cloud-partial`：雲端中途失敗，只拉到部分訂單 → **數字偏少、唔可信**
     * - `local-fallback`：雲端完全讀唔到，改用本機 localStorage 訂單 → **唔係 DB 數字**
     * - `empty`：雲端成功，但該店該區間真係冇單
     */
    dataSource: "idle" | "cloud" | "cloud-partial" | "local-fallback" | "empty";
    merchantId: string | null;
    currentRange: ReportRangeKey;
    fetchedCount: number;
    localCount: number;
    finalCount: number;
    matchedCurrentRange: number;
    matchedYesterday: number;
    lastUrl: string;
    lastHttpStatus: number | null;
    lastPayloadOk?: boolean;
    lastError: string | null;
    durationMs: number | null;
    statusBreakdown: Record<string, number>;
    countedStatus: number;
    sampleDates: string[];
    rangeStart?: string;
    rangeEnd?: string;
    /** 各 storeId 嘅訂單數量統計（用嚟排查 60000003 殘留）。key = storeId，value = 數量。 */
    storeIdBreakdown: Record<string, number>;
    /** 本機 orders 內 storeId 唔等於當前 merchantId 嘅單數。 */
    foreignStoreCount: number;
    /** 命中當前菜單大類嘅菜品類別數（用嚟判斷「菜單不匹配」嘅比例）。 */
    matchedCategoryCount: number;
    /** 冇命中當前菜單嘅菜品類別數（fallback 用菜品 ID 當 key）。 */
    unmatchedCategoryCount: number;
    /** localStorage 內所有 macau-pos/stores/&#123;storeId&#125;/orders key 嘅快照（storeId → 單數）。 */
    storageOrdersByStore: Record<string, number>;
    /** localStorage 內 macau-pos/orders legacy unscoped key 嘅單數。 */
    legacyOrdersCount: number;
    /** 當前 bootstrap cache 摘要（用嚟排查「未匹配當前菜單」係因為冇匯入 Ledger 餐牌定 ID 唔對）。 */
    bootstrapSummary: {
      storeId: string;
      storeName: string;
      menuItemCount: number;
      categoryCount: number;
      lastUpdatedAt: string;
      sampleMenuItemIds: string[];
      sampleCategoryIds: string[];
      sampleMenuItemNames: string[];
    };
    /** 菜品配對方式統計：id / name / normalized / unmatched。 */
    dishMatchBreakdown: Record<string, number>;
    /** 完全對照唔到當前餐牌嘅菜品名 → 出現次數（用嚟直接睇「邊啲舊菜品變咗孤兒」）。 */
    unmatchedItemNames: Record<string, number>;
  }>({
    status: "idle",
    dataSource: "idle",
    merchantId: merchantId ?? null,
    currentRange: "today",
    fetchedCount: 0,
    localCount: 0,
    finalCount: 0,
    matchedCurrentRange: 0,
    matchedYesterday: 0,
    lastUrl: "",
    lastHttpStatus: null,
    lastError: null,
    durationMs: null,
    statusBreakdown: {},
    countedStatus: 0,
    sampleDates: [],
    storeIdBreakdown: {},
    foreignStoreCount: 0,
    matchedCategoryCount: 0,
    unmatchedCategoryCount: 0,
    storageOrdersByStore: {},
    legacyOrdersCount: 0,
    bootstrapSummary: {
      storeId: "",
      storeName: "",
      menuItemCount: 0,
      categoryCount: 0,
      lastUpdatedAt: "",
      sampleMenuItemIds: [],
      sampleCategoryIds: [],
      sampleMenuItemNames: [],
    },
    dishMatchBreakdown: {},
    unmatchedItemNames: {},
  });

  // ── 向上一層回報：範圍 / 載入狀態 / 載入錯誤 ────────────────────────────
  // admin「營業報表」頁右上角嘅「重新載入」係靠 remount（key 帶 refreshSeq）重跑本組件
  // 全部 effect —— 最徹底嘅刷新，但會連用戶已選範圍一齊重置，所以用呢一組 callback
  // 畀上一層記住 + 還原狀態，同埋知道幾時載入完成 / 失敗。
  // 三個 callback 都係 optional：POS /reports 唔傳，行為同舊版完全一致。
  const notifyRange = props.onRangeChange;
  useEffect(() => {
    notifyRange?.(range);
  }, [range, notifyRange]);

  /** 載入中：POS 訂單補載、Ledger 彙總未完成，或任一線上單抓取仲 loading。
   *  初次 mount 兩個 done flag 都係 false → busy = true（上一層可按佢 disable 按鈕）。 */
  const loadBusy =
    !backfillDone ||
    !ledgerDone ||
    onlineFetchInfo.status === "loading" ||
    onlineDetailInfo.status === "loading";
  const notifyBusy = props.onBusyChange;
  useEffect(() => {
    notifyBusy?.(loadBusy);
  }, [loadBusy, notifyBusy]);

  /** 錯誤摘要：任一個數據源報錯就整段文章畀上一層統一顯示。 */
  const notifyError = props.onLoadError;
  useEffect(() => {
    if (!notifyError) return;
    const parts: string[] = [];
    // admin「全部商家」模式嘅 POS 訂單錯誤已經由上一層嘅 adminOrderFetcher 直接 set state，
    // 呢度唔再重複推上去，避免同一個原因喺提示卡彈兩行。
    if (debugInfo.status === "error" && debugInfo.lastError && !adminOrderFetcher) {
      parts.push(`POS 訂單：${debugInfo.lastError}`);
    }
    if (onlineFetchInfo.status === "error" && onlineFetchInfo.lastError) parts.push(`Ledger 線上單：${onlineFetchInfo.lastError}`);
    if (onlineDetailInfo.status === "error" && onlineDetailInfo.lastError) parts.push(`線上單明細：${onlineDetailInfo.lastError}`);
    if (ledgerError) parts.push(ledgerError);
    notifyError(parts.length > 0 ? parts.join("；") : null);
  }, [
    debugInfo.status,
    debugInfo.lastError,
    onlineFetchInfo.status,
    onlineFetchInfo.lastError,
    onlineDetailInfo.status,
    onlineDetailInfo.lastError,
    ledgerError,
    adminOrderFetcher,
    notifyError,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function backfillOrders() {
      setDebugInfo((prev) => ({
        ...prev,
        status: "loading",
        merchantId: merchantId ?? null,
        currentRange: range,
        lastError: null,
        durationMs: null,
        statusBreakdown: {},
        matchedCurrentRange: 0,
        matchedYesterday: 0,
        countedStatus: 0,
        sampleDates: [],
      }));
      const start = performance.now();

      // 🛡️ 跨店隔離 fail-safe（2026-09-06 修）：冇 merchantId（未登入 / 切店中途）一律唔拉。
      // 舊版呢度會 fetch /api/pos/state 唔帶 storeId → API 返**全部店**訂單，
      // 加上 belongsToStore 對 null merchantId 放行 → 報表顯示晒所有店嘅數據
      // （「同一個 local 就全部顯示」bug 嘅讀取端入口）。寧願空白，都唔跨店。
      // 例外：admin「全部」模式（allStoresMode）——訂單經 adminOrderFetcher
      // （GET /api/admin/orders，admin token 把關）跨店拉取，屬合法全店視角。
      if (!merchantId && !adminAllStoresMode) {
        setOrders([]);
        setDebugInfo((prev) => ({
          ...prev,
          status: "error",
          fetchedCount: 0,
          localCount: 0,
          finalCount: 0,
          lastUrl: "",
          lastError: "未登入（merchantId 缺失）—— 已封鎖跨店讀取，請先登入店舖帳號",
          durationMs: Math.round(performance.now() - start),
          statusBreakdown: {},
          storeIdBreakdown: {},
          foreignStoreCount: 0,
          sampleDates: [],
        }));
        setBackfillDone(true);
        return;
      }

      // 依所選範圍 [start, end] 喺 SQL layer 做日期過濾（`/api/pos/state` 已支援，
      // 同時 `eq("store_id", storeId)` 過濾本店；雙重保險：前端再加 `o.storeId === merchantId`）。
      // - today / yesterday / 7d / 30d → 拉對應 Macau 邊界內嘅單。
      // - all → 用 365 日滾動窗口（同 Ledger RPC 一致），避免唔設 end 拉爆 10000 上限。
      // 分頁 PAGE=2000、MAX_PAGES=10 → 上限 20000 單，足夠覆蓋繁忙餐廳一年歷史。
      const period = backfillRangeFor(range);
      const PAGE = 2000;
      const MAX_PAGES = 10;
      const fetched: PosOrder[] = [];
      let cloudFailed = false;
      let lastUrl = "";
      let lastHttpStatus: number | null = null;
      let lastPayloadOk: boolean | undefined;
      let lastError: string | null = null;
      try {
        if (adminOrderFetcher) {
          // admin 模式：訂單由注入 fetcher 提供（GET /api/admin/orders，admin session token
          // 把關）。**帶 storeId = 單店；唔帶 = 跨店彙總**（「全部商家」模式）。分頁語意同下。
          //
          // ⚠️ 2026-09-10 修（admin 選商家後報「POS 訂單：HTTP 401」）：
          // 單店 admin 模式**唔可以**行下面 `/api/pos/state?storeId=` 嗰條路。該 API 自
          // P0-4 起要求 POS 終端憑證（或 admin token），但 admin 裝置冇 POS 登入 →
          // `posDeviceAuthHeaders()` 係空 → server 一律 401。admin 面板一律行 admin 通道。
          const storeIdParam = adminAllStoresMode ? undefined : merchantId ?? undefined;
          for (let page = 0; page < MAX_PAGES; page++) {
            const offset = page * PAGE;
            lastUrl = `adminOrderFetcher(/api/admin/orders${storeIdParam ? "?storeId=" : ""})`;
            const rows = await adminOrderFetcher({
              storeId: storeIdParam,
              start: period?.start,
              end: period?.end,
              limit: PAGE,
              offset,
            });
            if (cancelled) return;
            fetched.push(...rows);
            if (rows.length < PAGE) break; // 最後一頁
          }
        } else for (let page = 0; page < MAX_PAGES; page++) {
          const offset = page * PAGE;
          const rangeQs = period
            ? `&start=${encodeURIComponent(period.start)}&end=${encodeURIComponent(period.end)}`
            : "";
          const url = merchantId
            ? `/api/pos/state?storeId=${encodeURIComponent(merchantId)}&limit=${PAGE}&offset=${offset}&ordersOnly=1${rangeQs}`
            : `/api/pos/state?limit=${PAGE}&offset=${offset}&ordersOnly=1${rangeQs}`;
          lastUrl = url;
          // 2026-09-10 P0-4：/api/pos/state 需要 POS 終端憑證（先續期，否則 401）。admin 模式
          // （adminOrderFetcher 分支）行另一條 service-role 通道，唔受影響。
          await refreshPosDeviceTokenIfNeeded();
          const res = await fetch(url, { headers: { ...posDeviceAuthHeaders() } });
          lastHttpStatus = res.status;
          if (!res.ok) {
            cloudFailed = true;
            // 讀 server 嘅 `error` 文字，唔好只顯示 `HTTP 401` ——
            // 淨睇 status 分唔出「憑證過期 / 未授權 / 區間參數錯 / 資料庫未配置」，
            // 2026-09-10 admin 單店模式嘅 401 就係因為只見到一句 HTTP 401 而排查咗一輪。
            let detail = "";
            try {
              const body = (await res.json()) as { error?: string };
              if (body?.error) detail = `：${body.error}`;
            } catch {
              /* 非 JSON（例如 gateway 502 嘅 HTML）→ 維持純 status */
            }
            lastError = `HTTP ${res.status} ${res.statusText}${detail}`;
            break;
          }
          const payload = (await res.json()) as { ok?: boolean; orders?: PosOrder[] };
          lastPayloadOk = payload.ok;
          if (cancelled || !payload.ok || !Array.isArray(payload.orders)) {
            cloudFailed = !payload.ok;
            lastError = payload.ok ? "payload.orders 不是陣列" : "payload.ok = false";
            break;
          }
          fetched.push(...payload.orders);
          if (payload.orders.length < PAGE) break; // 最後一頁
        }
      } catch (err) {
        // 中途失敗：下面仍會用已成功拉到嘅部分（best-effort），唔會因一頁失敗而全丟。
        cloudFailed = true;
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (cancelled) return;

      const deletedIds = new Set(loadDeletedOrderIds());
      // 帶 merchantId 讀本機 orders，避免 hydration / 切店嗰陣讀到錯誤 scope 嘅 localStorage。
      const localOrders = merchantId ? loadOrders(merchantId) : [];

      // 嚴格店鋪隔離：只顯示 storeId 同當前 merchantId 一致嘅訂單。
      // 舊版 migration 遺留嘅 undefined storeId 單喺多店環境下無法判斷所屬店，
      // 寧願丟失都唔可以顯示喺錯誤店鋪（呢啲單通常係早期測試髒資料）。
      const belongsToStore = (o: PosOrder) => {
        // admin「全部」模式：全店視角，放行全部（訂單已由 server 端 admin API 把關）。
        if (adminAllStoresMode) return true;
        // 🛡️ 冇 merchantId 一律唔放行（舊版「dev 模式未登入：放行」係跨店後門，
        // 2026-09-06 收口；effect 頂部已對 null merchantId 提前 bail，呢度係第二道保險）。
        if (!merchantId) return false;
        return o.storeId === merchantId;
      };

      // 雲端有單 → 以雲端為唯一可信源。
      // 雲端空 + 失敗 → fallback 本機 orders（離線模式仍可用）。
      // 雲端空 + 成功 → 該店確實冇單，顯示空狀態（**唔可以用本機 orders 覆蓋**——可能係舊 store 殘留）。
      let final: PosOrder[];
      let dataSource: "cloud" | "cloud-partial" | "local-fallback" | "empty";
      if (fetched.length > 0) {
        final = fetched.filter((o) => !deletedIds.has(o.id) && belongsToStore(o));
        // 拉到嘢、但中途有頁失敗（例如第 2 頁 500）→ 只有部分訂單，數字偏少。
        // 以前呢種情況完全靜默（status 仍然 "success"），係一個靜默失真源。
        dataSource = cloudFailed ? "cloud-partial" : "cloud";
      } else if (cloudFailed) {
        // ⚠️ 雲端完全讀唔到 → 改用本機 localStorage 訂單（離線模式仍可用）。
        // 但呢啲**唔係 DB 數字**，必須喺畫面明確講清楚，否則商家會拿住
        // 某台機嘅暫存數字去同人對數。
        final = localOrders.filter((o) => !deletedIds.has(o.id) && belongsToStore(o));
        dataSource = "local-fallback";
      } else {
        final = [];
        dataSource = "empty";
      }
      setOrders(final);

      // 診斷用：拆解訂單狀態同日期分佈；同時統計被前端過濾走嘅外店單數。
      const statusBreakdown: Record<string, number> = {};
      const storeIdBreakdown: Record<string, number> = {};
      let foreignStoreCount = 0;
      for (const o of final) {
        statusBreakdown[o.status] = (statusBreakdown[o.status] ?? 0) + 1;
        const sid = o.storeId ?? "(undefined)";
        storeIdBreakdown[sid] = (storeIdBreakdown[sid] ?? 0) + 1;
      }
      for (const o of fetched) {
        if (merchantId && o.storeId !== undefined && o.storeId !== merchantId) {
          foreignStoreCount += 1;
        }
      }
      for (const o of localOrders) {
        if (merchantId && o.storeId !== undefined && o.storeId !== merchantId) {
          foreignStoreCount += 1;
        }
      }
      const counted = final.filter((o) => isSaleCountable(o));
      const matchedCurrentRange = counted.filter((o) => orderMatchesReportRange(o, range)).length;
      const matchedYesterday = counted.filter((o) => orderMatchesReportRange(o, "yesterday")).length;
      const sampleDates = final.slice(0, 5).map((o) => `${o.status} | createdAt=${o.createdAt} | updatedAt=${o.updatedAt} | total=${o.total} | storeId=${o.storeId ?? "(null)"}`);

      // 菜品匹配診斷：只計「可計入銷售」嘅訂單（settled / paid），
      // 排除 cancelled 測試單 —— 呢啲單唔會出現喺菜品銷售排行，
      // 計入去只會令「未匹配名單」出現髒資料假象。
      const meta = buildMenuMeta();
      const matchedCategorySet = new Set<string>();
      const unmatchedCategorySet = new Set<string>();
      const dishMatchBreakdown: Record<string, number> = {};
      const unmatchedItemNames: Record<string, number> = {};
      for (const o of counted) {
        for (const it of o.items) {
          if (it.voided) continue;
          const resolved = resolveMenuMetaItem(it.menuItemId, it.name, meta);
          const cid = resolved.categoryId || it.menuItemId;
          if (resolved.matchedBy) {
            matchedCategorySet.add(cid);
            dishMatchBreakdown[resolved.matchedBy] = (dishMatchBreakdown[resolved.matchedBy] ?? 0) + 1;
          } else {
            unmatchedCategorySet.add(cid);
            dishMatchBreakdown.unmatched = (dishMatchBreakdown.unmatched ?? 0) + 1;
            const label = `${it.name}(${it.menuItemId.slice(0, 20)}…)`;
            unmatchedItemNames[label] = (unmatchedItemNames[label] ?? 0) + it.quantity;
          }
        }
      }
      const matchedCategoryCount = matchedCategorySet.size;
      const unmatchedCategoryCount = unmatchedCategorySet.size;
      const { storageOrdersByStore, legacyOrdersCount } = scanStorageOrders();

      setDebugInfo({
        // 只要有任何一個雲端請求失敗就算 "error" —— 以前只有「完全失敗且零筆」
        // 才當錯誤，令「部分失敗」靜默出一個偏少嘅數字（2026-09-10 修）。
        status: cloudFailed ? "error" : "success",
        dataSource,
        merchantId: merchantId ?? null,
        currentRange: range,
        fetchedCount: fetched.length,
        localCount: localOrders.length,
        finalCount: final.length,
        matchedCurrentRange,
        matchedYesterday,
        lastUrl,
        lastHttpStatus,
        lastPayloadOk,
        lastError,
        durationMs: Math.round(performance.now() - start),
        statusBreakdown,
        countedStatus: counted.length,
        sampleDates,
        rangeStart: period?.start,
        rangeEnd: period?.end,
        storeIdBreakdown,
        foreignStoreCount,
        matchedCategoryCount,
        unmatchedCategoryCount,
        storageOrdersByStore,
        legacyOrdersCount,
        bootstrapSummary: meta.boot,
        dishMatchBreakdown,
        unmatchedItemNames,
      });
      setBackfillDone(true);
    }
    void backfillOrders();
    return () => {
      cancelled = true;
    };
  }, [merchantId, backfillSeq, range, adminAllStoresMode, adminOrderFetcher, refreshToken]);

  // 訂閱 authSession 變更：切換帳號時重置 orders 並強制重跑 backfill。
  // root cause 修復（2026-09-04）：React 唔會自動訂閱 localStorage，冇呢個 listener
  // 嘅話切換帳號後 React state 仍係舊店嘅 orders。
  useEffect(() => {
    function onAuthChanged() {
      setOrders([]);
      setBackfillDone(false);
      setLedgerDone(false);
      setDataReady(false);
      setBackfillSeq((n) => n + 1);
    }
    window.addEventListener("pos-auth-changed", onAuthChanged);
    return () => {
      window.removeEventListener("pos-auth-changed", onAuthChanged);
    };
  }, []);

  // 尖峰時段：抓 Ledger 線上單（依「下單時間」createdAt）並按澳門時區嘅鐘頭分組，
  // 疊加到 POS 線下單嘅 byHour 上。線上單可能從未入 POS DB（直接由 Ledger / 外送平台落單），
  // 所以必須額外抓一次，避免尖峰時段圖只反映線下收銀。
  useEffect(() => {
    let cancelled = false;
    async function loadOnlineByHour() {
      // 切換範圍時即刻清走舊範圍嘅線上單，避免新數據 fetch 完成前顯示舊資料。
      setOnlineOrders([]);
      setOnlineByHour(new Array<number>(24).fill(0));
      const period = backfillRangeFor(range);
      const rangeStartMs = period ? Date.parse(period.start) : null;
      const rangeEndMs = period ? Date.parse(period.end) : null;

      // 🚀 2026-09-07 修（root cause）：admin 模式改用 service-role 跨店讀 Ledger 線上單，
      // 唔使商戶 JWT（admin 裝置本來就冇商戶身份）。舊版直接 skip → onlineOrders 永遠空
      // → 用戶「線上有好多單但完全睇唔到」。改為經 /api/admin/ledger/orders 讀取後，
      // 沿用同非 admin 一樣嘅 range / cancel / unpaid 過濾邏輯計 byHour 同 kept。
      if (isAdminMode) {
        try {
          setOnlineFetchInfo((prev) => ({ ...prev, status: "loading", lastError: null }));
          const rows = await fetchAdminLedgerOrders({
            merchantId: merchantId ?? null,
            start: period?.start ?? null,
            end: period?.end ?? null,
          });
          if (cancelled) return;
          let outOfRange = 0;
          let cancelledCount = 0;
          let unpaidCount = 0;
          let counted = 0;
          const byHour = new Array<number>(24).fill(0);
          const kept: LedgerOnlineOrder[] = [];
          for (const o of rows) {
            const ts = o.createdAt ?? o.updatedAt;
            if (!ts) continue;
            const t = Date.parse(ts);
            if (!Number.isFinite(t)) continue;
            if (rangeStartMs != null && t < rangeStartMs) {
              outOfRange++;
              continue;
            }
            if (rangeEndMs != null && t > rangeEndMs) {
              outOfRange++;
              continue;
            }
            if (String(o.status ?? "").toLowerCase().includes("cancel")) {
              cancelledCount++;
              continue;
            }
            if (o.paymentStatus !== "paid") {
              unpaidCount++;
              continue;
            }
            const hour = macauHour(ts);
            byHour[hour] += 1;
            counted++;
            kept.push(o);
          }
          if (cancelled) return;
          setOnlineByHour(byHour);
          setOnlineOrders(kept);
          setOnlineFetchInfo({
            fetched: rows.length,
            counted,
            outOfRange,
            cancelled: cancelledCount,
            unpaid: unpaidCount,
            status: "success",
            lastError: null,
          });
        } catch (err) {
          if (cancelled) return;
          setOnlineByHour(new Array<number>(24).fill(0));
          setOnlineOrders([]);
          setOnlineFetchInfo({
            fetched: 0,
            counted: 0,
            outOfRange: 0,
            cancelled: 0,
            unpaid: 0,
            status: "error",
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
        setLedgerDone(true);
        return;
      }
      if (!merchantId) {
        // 未登入 Ledger 商戶 → 唔抓線上單。
        setOnlineByHour(new Array<number>(24).fill(0));
        setOnlineOrders([]);
        setOnlineFetchInfo({
          fetched: 0,
          counted: 0,
          outOfRange: 0,
          cancelled: 0,
          unpaid: 0,
          status: "skipped",
          lastError: "merchantId 未設定",
        });
        return;
      }
      setOnlineFetchInfo((prev) => ({ ...prev, status: "loading", lastError: null }));
      try {
        const restored = await restoreLedgerSession();
        if (!restored) {
          if (cancelled) return;
          setOnlineByHour(new Array<number>(24).fill(0));
        setOnlineOrders([]);
          setOnlineFetchInfo({
            fetched: 0,
            counted: 0,
            outOfRange: 0,
            cancelled: 0,
            unpaid: 0,
            status: "skipped",
            lastError: "尚未登入 Ledger",
          });
          return;
        }

        // 用 cursor-based pagination 撈齊 [rangeStart, rangeEnd] 區間內嘅線上單。
        // RPC 預設 limit=50，呢度調大到 500／頁，並用 since+sinceId 行 cursor。
        // period / rangeStartMs / rangeEndMs 喺函數頂部已計過（admin / 非 admin 共用）。
        const PAGE = 500;
        const MAX_PAGES = 8; // 上限 4000 單，足以覆蓋繁忙餐廳 30 日滾動窗口
        const collected: LedgerOnlineOrder[] = [];
        let cursorSince: string | null = period?.start ?? null;
        let cursorSinceId: string | null = null;
        let outOfRange = 0;
        let cancelledCount = 0;
        let unpaidCount = 0;
        let counted = 0;
        const byHour = new Array<number>(24).fill(0);
        const kept: LedgerOnlineOrder[] = [];

        outer: for (let page = 0; page < MAX_PAGES; page++) {
          const rows = await listMerchantOrders({
            merchantId,
            limit: PAGE,
            since: cursorSince,
            sinceId: cursorSinceId,
          });
          if (cancelled) return;
          if (rows.length === 0) break;

          for (const o of rows) {
            const ts = o.createdAt ?? o.updatedAt;
            if (!ts) continue;
            const t = Date.parse(ts);
            if (!Number.isFinite(t)) continue;

            // 篩掉超出範圍嘅單 + cancelled + unpaid。
            if (rangeStartMs != null && t < rangeStartMs) {
              // 由於 RPC 按 updatedAt DESC 排序，遇到 t < rangeStartMs 即可視為已過期。
              outOfRange++;
              // 如果確定已過 range 起點，後續無需再翻頁。
              break outer;
            }
            if (rangeEndMs != null && t > rangeEndMs) {
              outOfRange++;
              continue;
            }
            if (String(o.status ?? "").toLowerCase().includes("cancel")) {
              cancelledCount++;
              continue;
            }
            if (o.paymentStatus !== "paid") {
              unpaidCount++;
              continue;
            }
            // 依「下單時間」createdAt 入帳；fallback updatedAt。
            const hour = macauHour(ts);
            byHour[hour] += 1;
            counted++;
            kept.push(o);
          }
          collected.push(...rows);

          // 已經走到範圍起點之前、或本頁未填滿 → 結束。
          if (rows.length < PAGE) break;
          const last = rows[rows.length - 1];
          cursorSince = last.updatedAt ?? last.createdAt ?? cursorSince;
          cursorSinceId = last.id;
        }
        if (cancelled) return;

        setOnlineByHour(byHour);
        setOnlineOrders(kept);
        setOnlineFetchInfo({
          fetched: collected.length,
          counted,
          outOfRange,
          cancelled: cancelledCount,
          unpaid: unpaidCount,
          status: "success",
          lastError: null,
        });
      } catch (err) {
        if (cancelled) return;
        setOnlineByHour(new Array<number>(24).fill(0));
        setOnlineOrders([]);
        setOnlineFetchInfo({
          fetched: 0,
          counted: 0,
          outOfRange: 0,
          cancelled: 0,
          unpaid: 0,
          status: "error",
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void loadOnlineByHour();
    return () => {
      cancelled = true;
    };
  }, [merchantId, range, isAdminMode, refreshToken]);

  useEffect(() => {
    async function safeLedger(r: ReportRangeKey): Promise<LedgerReportSummary | null> {
      try {
        const restored = await restoreLedgerSession();
        if (!restored) return null;
        return await getMerchantReportSummary(r);
      } catch {
        return null;
      }
    }

    let cancelled = false;
    async function load() {
      if (isAdminMode) {
        // admin 模式：getMerchantReportSummary / fetchPurchaseSummary 都係按
        // 「當前登入商戶 JWT」取數，admin 裝置冇商戶身份 → 跳過（KPI 大數
        // 改由 POS 訂單聚合提供）。低庫存 API 係 server service-role by store
        // 參數，照常抓。會員充值 / 線上渠道等 Ledger 類模塊會顯示為零值。
        if (cancelled) return;
        setLedger({ sel: null, d7: null, yest: null });
        setPurchase({ sel: null, yest: null });
        setLedgerError(null);
        setLoading(false);
        setLedgerDone(true);
        return;
      }
      setLoading(true);
      setLedgerError(null);
      const [sel, d7, yest] = await Promise.all([
        safeLedger(range),
        safeLedger("7d"),
        range === "today" ? safeLedger("yesterday") : Promise.resolve(null),
      ]);

      const acc = loadAuthSession()?.account;
      const [purSel, purYest] = await Promise.all([
        acc ? fetchPurchaseSummary(acc, range) : Promise.resolve(null),
        range === "today" && acc ? fetchPurchaseSummary(acc, "yesterday") : Promise.resolve(null),
      ]);

      if (cancelled) return;
      setLedger({ sel, d7, yest });
      setPurchase({ sel: purSel?.summary ?? null, yest: purYest?.summary ?? null });

      // 低庫存預警：讀本店 inv_products，current_qty <= reorder_level（par）即低庫存。
      try {
        const storeParam = merchantIdForQuery || (typeof window !== "undefined" ? loadAuthSession()?.merchantId ?? "" : "");
        if (!storeParam) {
          setLowStock(null);
        } else {
          const invRes = await fetch(`/api/inventory/products?store=${encodeURIComponent(storeParam)}`);
          const invJson = await invRes.json();
          if (invJson?.ok && Array.isArray(invJson.products)) {
            const low = invJson.products
              .filter((p: { current_qty: number; reorder_level: number }) => p.reorder_level > 0 && p.current_qty <= p.reorder_level)
              .map((p: { name: string; current_qty: number; unit: string; reorder_level: number }) => ({
                name: p.name,
                qty: Number(p.current_qty) || 0,
                unit: p.unit ?? "份",
                par: Number(p.reorder_level) || 0,
              }))
              .sort((a: { qty: number }, b: { qty: number }) => a.qty - b.qty);
            setLowStock(low);
          } else {
            setLowStock(null);
          }
        }
      } catch {
        setLowStock(null);
      }

      if (!sel && !d7) setLedgerError("尚未連線 Ledger，會員/線上數據未能讀取（其餘模塊正常）。");
      setLoading(false);
      setLedgerDone(true);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [range, merchantId, merchantIdForQuery, isAdminMode, refreshToken]);

  // Ledger 純線上單入報表前，先剔除已經同步入 POS DB 嘅單（以 POS onlineOrderId ↔ Ledger id 對應），
  // 避免人流 / 時長統計雙重計算。剩低嘅就係「從未入 POS DB」嘅線上單。
  const posOnlineIds = useMemo(
    () => new Set(orders.map((o) => o.onlineOrderId).filter((v): v is string => !!v)),
    [orders],
  );
  const countableOnlineOrders = useMemo(
    () => onlineOrders.filter((o) => !posOnlineIds.has(o.id)),
    [onlineOrders, posOnlineIds],
  );

  // Ledger 線上單明細：對「可計入」嘅線上單逐張抓 get_order_detail，
  // 令菜品銷售排行可以涵蓋從未入 POS DB 嘅線上單（快閃餐／線上點餐）。
  // 以 onlineDishKey（訂單 ID 串接）做穩定觸發，避免 countableOnlineOrders
  // 每次 render 產生新 reference 造成無限重抓。
  const onlineDishKey = useMemo(
    () => countableOnlineOrders.map((o) => o.id).join(","),
    [countableOnlineOrders],
  );
  useEffect(() => {
    let cancelled = false;
    async function loadOnlineDetails() {
      if (isAdminMode || !merchantId || countableOnlineOrders.length === 0) {
        setOnlineDishSource([]);
        setOnlineDetailInfo({ total: 0, ok: 0, failed: 0, status: "idle", lastError: null });
        return;
      }
      setOnlineDetailInfo({
        total: countableOnlineOrders.length,
        ok: 0,
        failed: 0,
        status: "loading",
        lastError: null,
      });
      // 上限保護：歷史範圍訂單過多時只抓最近 200 張明細，避免打爆 RPC。
      const MAX_DETAILS = 200;
      const targets = countableOnlineOrders.slice(0, MAX_DETAILS);
      const collected: OnlineDishSource[] = [];
      let failed = 0;
      for (const o of targets) {
        try {
          const detail = await getOrderDetail(o.id);
          if (cancelled) return;
          collected.push({ order: o, items: detail.items ?? [] });
        } catch {
          if (cancelled) return;
          failed += 1;
        }
      }
      if (cancelled) return;
      setOnlineDishSource(collected);
      setOnlineDetailInfo({
        total: countableOnlineOrders.length,
        ok: collected.length,
        failed,
        status: collected.length === 0 && failed > 0 ? "error" : "success",
        lastError: failed > 0 ? `${failed} 單明細抓取失敗` : null,
      });
    }
    void loadOnlineDetails();
    return () => {
      cancelled = true;
    };
    // countableOnlineOrders 由 onlineDishKey 代表；key 變咗先重抓。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchantId, onlineDishKey]);

  const agg = useMemo(
    () => aggregate(orders, range, onlineDishSource),
    [orders, range, onlineDishSource],
  );
  const aggYest = useMemo(() => (range === "today" ? aggregate(orders, "yesterday") : null), [orders, range]);
  const agg7d = useMemo(() => aggregate(orders, "7d"), [orders]);

  /**
   * docs/任務：當日人流改為完全由訂單自動計算，唔再由使用者手動輸入。
   * - 堂食（tableId !== "counter"）→ partySize 加總
   * - 快餐 / 外賣 / 自取（tableId === "counter"）→ 一單 = 1 人
   * 純參考數字，唔影響營業額 / 結帳口徑。
   */
  const posFootfall = useMemo(() => computeFootfallFromOrders(orders, range), [orders, range]);
  // 人流 = POS 訂單人流 + Ledger 純線上單（線上單冇 partySize，一單 = 1 人）。
  const footfallTotal = posFootfall + countableOnlineOrders.length;
  const conversion = footfallTotal > 0 && agg.covers > 0 ? agg.covers / footfallTotal : null;

  // 拆開堂食 / 快餐 / 線上 三類人流，令 total 同 breakdown 可互相解釋。
  // 線上單（Ledger 純線上、冇入 POS DB）一單 = 1 人，計入「快餐 / 外賣 / 線上」。
  const footfallBreakdown = useMemo(() => {
    const terminal = orders.filter((o) => isSaleCountable(o));
    const inRange = terminal.filter((o) => orderMatchesReportRange(o, range));
    let dineIn = 0;
    let counter = 0;
    for (const o of inRange) {
      if (o.tableId === "counter") counter += 1;
      else dineIn += Math.max(1, o.partySize ?? 1);
    }
    const online = countableOnlineOrders.length;
    return { dineIn, counter, online };
  }, [orders, range, countableOnlineOrders]);

  const grossProfit = useMemo(() => {
    const cogs = purchase.sel?.paid ?? 0;
    return agg.revenue - cogs;
  }, [agg.revenue, purchase.sel]);

  const grossProfitYest = useMemo(() => {
    if (!aggYest) return null;
    const cogs = purchase.yest?.paid ?? 0;
    return aggYest.revenue - cogs;
  }, [aggYest, purchase.yest]);

  // 「毛利（估）」手動設定毛利率 %：商家填毛利率（例如 50 = 50%），
  // 毛利估算 = 營業額 × 毛利率%，存落本店 PosLocalSettings（store scope）。
  const [gpMarginPct, setGpMarginPct] = useState<number | null>(null);
  const [gpEditing, setGpEditing] = useState(false);
  const [gpDraft, setGpDraft] = useState("");

  // 切店 / 首次確認 merchantId 時，讀取本店已存嘅毛利率。
  useEffect(() => {
    try {
      const s = loadPosLocalSettings();
      setGpMarginPct(typeof s.grossProfitMarginPct === "number" ? s.grossProfitMarginPct : null);
    } catch {
      setGpMarginPct(null);
    }
  }, [merchantId]);

  // 手動毛利率 → 毛利 = 營業額 × 毛利率%；冇設定就用系統估算（營業額 − 進貨成本）。
  // （displayGrossProfit 依賴 onlineOfflineSplit，喺該 useMemo 宣告後先計算，見下方）

  function saveGpOverride() {
    const num = Number(gpDraft);
    // 空 / 非數 → 清走手動設定，返返系統估算；否則夾喺 0–100% 之間。
    const next = Number.isFinite(num) && gpDraft.trim() !== "" ? Math.min(100, Math.max(0, Math.round(num))) : null;
    setGpMarginPct(next);
    setGpEditing(false);
    try {
      const s = loadPosLocalSettings();
      s.grossProfitMarginPct = next;
      savePosLocalSettings(s);
    } catch {
      /* 儲存失敗唔影響當前顯示 */
    }
  }

  const ticketMopYest = aggYest && aggYest.count > 0 ? aggYest.revenue / aggYest.count : 0;

  /** 「線下 vs 線上」分拆（2026-09-09 修正口徑）：
   *  - 線下 = POS 收銀單且 *無* onlineOrderId（純現場收銀），由 POS DB 算；
   *  - 線上 = Ledger RPC（`orderCount` / `orderPaidMop`），涵蓋：
   *      · POS 接單的線上單（帶 onlineOrderId —— 呢啲唔會喺上面 offline 重複計）
   *      · 其他渠道的單（kiosk / 外賣平台 / 微信小程序等不經過 POS DB 的）
   *  - 總值 = **線下 + 線上相加**。舊實作直接以 Ledger 為總值並「減線下」計線上，
   *    前提假設「Ledger 覆蓋整店全渠道」——但實際 Ledger 只收線上渠道，
   *    POS 現場收銀（現金/卡）永遠唔入 Ledger → 營業額長期只顯示線上部分、
   *    線下收入被隱形（用戶案例：POS 線下 903 vs Ledger 線上 139，營業額錯顯 139）。
   *    修正後雙計風險為零：offline 已排除 onlineOrderId 行，線上全部經 Ledger 計一次。
   *  - Ledger 連不上則 fallback POS DB（離線模式仍可用，線上改用 POS 內帶 onlineOrderId 嘅單）。
   */
  const onlineOfflineSplit = useMemo(() => {
    const inRange = orders.filter((o) => isSaleCountable(o)).filter((o) => orderMatchesReportRange(o, range));
    const offline = inRange.filter((o) => !o.onlineOrderId);
    const offlineCount = offline.length;
    const offlineRevenueMop = offline.reduce((s, o) => s + o.total, 0);

    const ledgerCount = ledger.sel?.orderCount;
    const ledgerRevenueMop = ledger.sel?.orderPaidMop;
    const hasLedger = typeof ledgerCount === "number" && typeof ledgerRevenueMop === "number";

    if (hasLedger) {
      return {
        offlineCount,
        offlineRevenueMop,
        onlineCount: ledgerCount,
        onlineRevenueMop: ledgerRevenueMop,
        totalCount: offlineCount + ledgerCount,
        totalRevenueMop: offlineRevenueMop + ledgerRevenueMop,
        source: "ledger" as const,
      };
    }
    // Ledger 連不上：退回 POS DB 整體（包含帶 onlineOrderId 的線上單）。
    return {
      offlineCount,
      offlineRevenueMop,
      onlineCount: inRange.length - offlineCount,
      onlineRevenueMop: agg.onlineRevenue,
      totalCount: inRange.length,
      totalRevenueMop: agg.revenue,
      source: "pos" as const,
    };
  }, [orders, range, ledger.sel, agg.onlineRevenue, agg.revenue]);

  /**
   * 未結帳訂單統計（2026-09-07 新增）。
   *
   * 背景：admin「營業報表」曾出現「API 成功回傳 N 筆訂單、但報表全空」嘅假象——
   * 因為 `isSaleCountable()` 只計 `settled` / `paid`（正確嘅收入認列口徑），
   * 而實際資料入面大量訂單停喺 `sent_to_kitchen`（已送廚房、未收款）。
   * 呢啲單唔應該計入營業額，但亦唔可以靜默消失，否則使用者只會見到一片空白、
   * 無從判斷係「今日冇單」定「有單但未結帳」。
   *
   * 用途：
   * - KPI 帶顯示「未結帳訂單」筆數 + 金額，令資料可見；
   * - 當區間內有單但 0 筆可計入銷售時，頂部顯示琥珀色提示條解釋原因。
   *
   * 排除：cancelled / refunded / partially_refunded（作廢或已退，唔屬於待收款）。
   * 包含：draft / sent_to_kitchen / reopened。
   */
  const pendingSplit = useMemo(() => {
    const inRange = orders.filter((o) => orderMatchesReportRange(o, range));
    const pending = inRange.filter(
      (o) =>
        !isSaleCountable(o) &&
        o.status !== "cancelled" &&
        o.status !== "refunded" &&
        o.status !== "partially_refunded",
    );
    const statusBreakdown: Record<string, number> = {};
    for (const o of pending) statusBreakdown[o.status] = (statusBreakdown[o.status] ?? 0) + 1;
    return {
      totalInRange: inRange.length,
      count: pending.length,
      amountMop: pending.reduce((s, o) => s + o.total, 0),
      statusBreakdown,
    };
  }, [orders, range]);

  /** 區間內「有單但全部未結帳」→ 需要明確提示，避免使用者誤以為報表壞咗。 */
  const showUnsettledNotice =
    dataReady && pendingSplit.totalInRange > 0 && onlineOfflineSplit.totalCount === 0;

  const unsettledStatusLabel =
    Object.entries(pendingSplit.statusBreakdown)
      .map(([status, n]) => `${statusLabelOf(status)} ${n} 張`)
      .join("、") || "—";

  // 手動毛利率 → 毛利 = 營業額 × 毛利率%；冇設定就用系統估算（營業額 − 進貨成本）。
  const displayGrossProfit =
    gpMarginPct != null ? (onlineOfflineSplit.totalRevenueMop * gpMarginPct) / 100 : grossProfit;

  const soldOut = useMemo(() => {
    const map = loadSoldOutState();
    const names = new Map((loadBootstrapCache()?.menuItems ?? []).map((m) => [m.id, m.name]));
    const items = Object.entries(map)
      .filter(([k, v]) => !k.startsWith("specopt:") && (v?.remainingQty ?? 1) <= 0)
      .map(([k]) => names.get(k) ?? k);
    return items;
  }, []);

  const onlineShare = agg.revenue > 0 ? agg.onlineRevenue / agg.revenue : 0;
  const onlineShare7d = agg7d.revenue > 0 ? agg7d.onlineRevenue / agg7d.revenue : 0;
  const discountRatio = agg.revenue > 0 ? agg.discount / agg.revenue : 0;
  const voidRate = agg.totalSoldQty > 0 ? agg.voidQty / agg.totalSoldQty : 0;
  const rev7dAvg = agg7d.revenue / 7;
  const topup7dAvg = (ledger.d7?.topupMop ?? 0) / 7;

  const suggestions = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];

    if (soldOut.length >= 3) {
      out.push({
        level: "r",
        title: `已沽清 ${soldOut.length} 款菜品`,
        action: `即日補貨；優先處理高銷菜品（${soldOut.slice(0, 2).join("、")}）。`,
      });
    }
    const revDrop = rev7dAvg > 0 && agg.revenue < rev7dAvg * 0.8;
    if (revDrop) {
      out.push({
        level: "r",
        title: "營業額較 7 日均值跌超過 20%",
        action: "推限時優惠或喚醒沉睡會員，拉升淡日營收。",
      });
    }
    if (onlineShare - onlineShare7d > 0.05) {
      out.push({
        level: "o",
        title: `線上渠道佔比上升（${Math.round(onlineShare * 100)}%，7 日均值 ${Math.round(onlineShare7d * 100)}%）`,
        action: "加強線上推廣，並確保廚房產能跟到外送單。",
      });
    }
    if (topup7dAvg > 0 && (ledger.sel?.topupMop ?? 0) < topup7dAvg * 0.7) {
      out.push({
        level: "o",
        title: "會員充值較 7 日均值跌超過 30%",
        action: "推「限時儲值贈 10%」活動，喚醒會員現金回流。",
      });
    }
    if (voidRate > 0.03) {
      out.push({
        level: "o",
        title: `退菜率 ${Math.round(voidRate * 100)}%（高於 3% 閾值）`,
        action: "檢視退菜原因，加強落單確認與出餐品質培訓。",
      });
    }
    if (discountRatio > 0.15) {
      out.push({
        level: "o",
        title: `折扣佔比 ${Math.round(discountRatio * 100)}%（高於 15% 閾值）`,
        action: "檢討優惠門檻，避免無謂折讓蠶食毛利。",
      });
    }
    if (agg.tables.length > 0) {
      const low = agg.tables[agg.tables.length - 1];
      out.push({
        level: "i",
        title: `「${low.name}」使用偏低（${low.orders} 單）`,
        action: "檢視該區擺位／排枱，必要時重新規劃或併枱。",
      });
    }
    const order = { r: 0, o: 1, i: 2 } as const;
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }, [soldOut, agg, rev7dAvg, onlineShare, onlineShare7d, topup7dAvg, ledger.sel, voidRate, discountRatio]);

  function pct(cur: number, prev: number | null): { arrow: string; cls: string } | null {
    if (prev === null || prev === 0) return null;
    const diff = ((cur - prev) / prev) * 100;
    if (Math.abs(diff) < 0.5) return { arrow: "— 持平", cls: "text-slate-400" };
    const up = diff > 0;
    return {
      arrow: `${up ? "▲" : "▼"} ${Math.abs(Math.round(diff))}% vs 昨日`,
      cls: up ? "text-emerald-600" : "text-rose-600",
    };
  }

  // 尖峰時段合併圖：agg.byHour 來自 POS 本機訂單（含帶 onlineOrderId 嘅 POS 線上單）；
  // onlineByHour 來自 Ledger 雲端純線上單（可能從未入 POS DB）。兩者相加先係全渠道。
  // 注意：onlineByHour 可能因 ledger session 過期／網絡失敗而係全 0；UI 嘅 tag 會如實顯示來源。
  const combinedByHour = useMemo(
    () => agg.byHour.map((offlineCount, h) => offlineCount + (onlineByHour[h] ?? 0)),
    [agg.byHour, onlineByHour],
  );
  const peakHour = combinedByHour.indexOf(Math.max(...combinedByHour));
  const maxHour = Math.max(...combinedByHour, 1);
  /** POS 線下單（不論帶唔帶 onlineOrderId）嘅 byHour，畀 tooltip 分拆。 */
  const offlineHourOnly = useMemo(() => agg.byHour.slice(), [agg.byHour]);

  function exportCsv() {
    const rows = orders
      .filter((o) => orderMatchesReportRange(o, range))
      .map((o) => ({
        單號: o.localOrderNo,
        枱號: o.tableName,
        渠道: o.onlineOrderId ? "線上" : "線下",
        狀態: o.status,
        金額: o.total,
        折扣: o.discountAmount,
        入座人數: o.partySize ?? 0,
        支付: o.paymentMethod ?? "",
        時間: o.createdAt,
      }));
    const headers = Object.keys(rows[0] ?? { 單號: "" });
    const csv = [
      headers.join(","),
      ...rows.map((r) => headers.map((k) => `"${String(r[k as keyof typeof r] ?? "").replace(/"/g, '""')}"`).join(",")),
    ].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `每日總結_${range}_${todayKey}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    // 問題 4 + 5（2026-09-06 修）：admin 模式唔需要 POS 收銀台側邊欄，身份綁定錯誤
    // bug 同時消除（POS session 唔再喺 admin 報表頁渲染）。
    // - admin 模式（merchantIdOverride 或 allStoresMode）：
    //   - 唔渲染 <AppSidebar /> → 解決問題 5（移除側邊欄）+ 問題 4（唔再顯示「表嫂美食 65273599」）
    //   - 唔加 md:pl-[72px] → admin 報表撐滿寬度，配合 AdminShell max-w-7xl
    //   - 內容區用 block（見下方），由 AdminShell 嘅 `h-[100dvh] overflow-y-auto`
    //     容器負責頁面滾動（避開 globals.css `body { overflow: hidden }` 鎖死）。
    // - POS 模式（/reports 商家報表）：維持 h-[100dvh] + AppSidebar + md:pl-[72px]，
    //   內容區係 flex-1 + overflow-y-auto（main 高度固定），title bar 固定、內容獨立滾動。
    <div className={isAdminMode ? "bg-slate-100" : "h-[100dvh] overflow-hidden bg-slate-100"}>
      {isAdminMode ? null : <AppSidebar />}
      <div className={isAdminMode ? "" : "flex h-[100dvh] overflow-hidden md:pl-[72px]"}>
        <main className={isAdminMode ? "block" : "flex h-full flex-1 flex-col overflow-hidden"}>
          {/* 標題 + 右上篩選 */}
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">店鋪每日營運總結</div>
                <div className="mt-1 text-sm text-slate-500">
                  {storeName} · {todayKey}（澳門）· 篩選影響全部模塊
                  {/* 自動刷新提示（2026-09-10）：唔講明嘅話，商家見到數字自己變咗會以為壞咗。 */}
                  <span className="text-slate-400"> · 每 3 分鐘自動更新</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                  onClick={exportCsv}
                  type="button"
                >
                  導出 CSV
                </button>
                <div className="flex gap-1.5">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setRange(f.key)}
                      className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
                        range === f.key ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 內容區滾動策略（2026-09-07 第二修）：
              - admin 模式：main 係 block、冇固定高度 parent → 內容自然展開，
                由 AdminShell 嘅 `h-[100dvh] overflow-y-auto` 負責整頁滾動 → 用 block。
              - POS 模式（/reports 商家報表）：main 係 `h-full flex-col overflow-hidden`，
                內容 wrapper 必須係 flex-1 + overflow-y-auto 先有自己嘅滾動容器；
                f1cc8ad 曾一刀切改成 block，令 POS 模式內容超出視口被裁切、成頁滾唔到。
                加 min-h-0 防止 flex item 預設 min-height:auto 令 overflow 失效。 */}
          <div className={isAdminMode ? "block p-4" : "min-h-0 flex-1 overflow-y-auto p-4"}>
            {ledgerError ? (
              <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {ledgerError}
              </div>
            ) : null}

            {/* 2026-09-10 新增：數據來源可見性。
                同一個「未結帳 N 張」KPI，雲端 / 本機 fallback 兩種來源嘅可信度差天共地，
                但以前畫面**一模一樣** —— 商家會拿住某台機嘅暫存數字去同人對數，
                或者把一個偏少嘅數字當成事實嚟追問「點解同步唔到」。
                - cloud-partial：拉到單但中途有頁失敗 → 數字偏少，係靜默失真源。
                - local-fallback：雲端完全讀唔到 → 全部係本機 localStorage 訂單，唔係 DB 數字。 */}
            {debugInfo.dataSource === "cloud-partial" ? (
              <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                <div className="font-semibold">⚠️ 雲端數據只讀到一部分，以下數字未能作準</div>
                <div className="mt-1 text-[13px] text-amber-800">
                  部分分頁讀取失敗（{debugInfo.lastError ?? "網絡不穩"}），未結帳筆數與營業額都會偏少。
                  系統會自動重試，亦可稍後自行重新載入。
                </div>
              </div>
            ) : null}

            {debugInfo.dataSource === "local-fallback" ? (
              <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-900">
                <div className="font-semibold">⚠️ 雲端讀取失敗，以下為本機暫存資料，並非資料庫實際數字</div>
                <div className="mt-1 text-[13px] text-rose-800">
                  目前顯示的是本機快取的訂單，只反映本機畫面，可能與後台或其他裝置不一致。
                  請檢查網絡後重新載入；確認資料是否已上雲，可到 POS 設定頁的「同步健康」。
                </div>
              </div>
            ) : null}

            {/* 2026-09-07 新增：區間內有訂單但全部未結帳 → 明確解釋「點解營業額係 0」，
                避免使用者見到一片空白以為報表壞咗（收入認列只計 settled / paid 係正確口徑）。 */}
            {showUnsettledNotice ? (
              <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                <div className="font-semibold">
                  ⚠️ 本區間有 {pendingSplit.totalInRange} 張訂單，但尚未有任何一張結帳，故營業額顯示為 0
                </div>
                <div className="mt-1 text-[13px] text-amber-800">
                  未結帳 {pendingSplit.count} 張 · 金額 {formatMoney(pendingSplit.amountMop)} · 狀態分佈：
                  {unsettledStatusLabel}
                </div>
                <div className="mt-1 text-xs text-amber-700">
                  營業額只統計「已結帳 / 已付款」的訂單（收入認列口徑）。訂單送廚房後需於收銀台結帳，
                  結帳後即會計入本報表。
                </div>
              </div>
            ) : null}

            {/* 2026-09-07 修：admin 模式嘅 Ledger 數據可見性分兩層。
                - 線上單（public.orders）：已經改用 service-role 跨店讀取（/api/admin/ledger/orders），
                  人流 / 尖峰時段 / 線上單計數都會反映。
                - 會員充值 / 扣點等彙總 KPI：來自 getMerchantReportSummary RPC，商戶由
                  auth.uid() 推導、連 merchantId 參數都冇，admin 裝置冇商戶身份 → 仍顯示為空。 */}
            {isAdminMode ? (
              <div className="mb-3 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-sm text-sky-900">
                <div className="font-semibold">ℹ️ 管理後台模式：線上單經 service-role 讀取已啟用</div>
                <div className="mt-1 text-[13px] text-sky-800">
                  人流、尖峰時段、線上單計數已包含 Ledger 線上單（跨店 / 指定商家均可）。
                  但會員充值 / 扣點等彙總 KPI 來自需要商戶身份（JWT）的 RPC，管理後台帳號冇商戶身份，
                  故此類數字暫時唔會顯示（並非冇數據）。
                </div>
                <div className="mt-1 text-xs text-sky-700">
                  要睇完整會員類 KPI，請用該店商戶帳號登入 POS 後開啟報表；或為 Ledger 加上支援
                  <code className="mx-1 rounded bg-sky-100 px-1">p_merchant_id</code>
                  參數嘅 admin 版 RPC。
                </div>
              </div>
            ) : null}

            {/* DevTools debug panel：暫時由 UI 隱藏 */}
            {false}

            {/* 核心 KPI 帶 — 一律一行 5 格（10 格 → 5-5） */}
            {dataReady ? (
              <>
                {/*
                  核心 KPI：**一律一行 5 格**（10 格 → 5-5），iPad 與電腦版排法一致。
                  ⚠️ 原先寫 `md:grid-cols-3 xl:grid-cols-5`，iPad 橫向內容區約 976px
                  落 `md`（3 格）→ 殘成 3-3-3-1；電腦 ≥1280 落 `xl`（5 格）。
                  家陣固定 5 欄，兩邊都係 5-5（2026-09-10 iPad 版面對齊）。
                */}
                <div className="mb-4 grid grid-cols-5 gap-3">
                  <Kpi
                    label="營業額"
                    value={<Money amount={onlineOfflineSplit.totalRevenueMop} />}
                    highlight
                    delta={pct(onlineOfflineSplit.totalRevenueMop, aggYest?.revenue ?? null)}
                    subtitle={`線下 ${formatMoney(onlineOfflineSplit.offlineRevenueMop)} · 線上 ${formatMoney(onlineOfflineSplit.onlineRevenueMop)}`}
                  />
                  <Kpi
                    label="應收金額合計"
                    value={<Money amount={agg.receivableTotal} />}
                    delta={null}
                    subtitle="原價合計 + 服務費 + 稅"
                  />
                  <Kpi
                    label="實收金額合計"
                    value={<Money amount={agg.paidTotal} />}
                    delta={null}
                    subtitle="優惠後商家實際收到 = order.total"
                  />
                  <Kpi
                    label="訂單數"
                    value={String(onlineOfflineSplit.totalCount)}
                    delta={pct(onlineOfflineSplit.totalCount, aggYest?.count ?? null)}
                    subtitle={`線下 ${onlineOfflineSplit.offlineCount} 單 · 線上 ${onlineOfflineSplit.onlineCount} 單`}
                  />
                  <Kpi
                    label="客單價"
                    value={
                      <Money
                        amount={
                          onlineOfflineSplit.totalCount > 0
                            ? onlineOfflineSplit.totalRevenueMop / onlineOfflineSplit.totalCount
                            : 0
                        }
                      />
                    }
                    delta={pct(
                      onlineOfflineSplit.totalCount > 0
                        ? onlineOfflineSplit.totalRevenueMop / onlineOfflineSplit.totalCount
                        : 0,
                      ticketMopYest,
                    )}
                  />

                {/*
                  以下 5 格同上面 5 格係**同一個 grid** —— ⚠️ 中間**絕對唔可以有 `</div>`**。
                  10 格一次過排才會穩定 5-5；拆兩個 5 格 grid 喺窄螢幕會各自斷行。
                  ⚠️ 2026-09-11 中過：合併時漏刪咗第一個 grid 嘅 `</div>`，令尾 5 格掉出 grid、
                  各自佔滿一行且緊貼無 gap；而 JSX 仍然平衡 → typecheck / eslint / build 全綠捉唔到。
                  未結帳訂單 / 餘額總額 / 會員充值 / 會員扣點 / 毛利（估）
                */}
                  {/* 2026-09-07 新增：未結帳訂單（sent_to_kitchen 等）唔計入營業額，
                      但要顯示出嚟，否則報表會出現「有單但全空」嘅假象。 */}
                  <Kpi
                    label="未結帳訂單"
                    value={`${pendingSplit.count} 張`}
                    delta={null}
                    subtitle={
                      pendingSplit.count > 0
                        ? `${formatMoney(pendingSplit.amountMop)} · ${unsettledStatusLabel}`
                        : "冇待收款訂單"
                    }
                  />
                  <Kpi
                    label="餘額總額"
                    value={ledger.sel?.balanceTotalMop != null ? <Money amount={ledger.sel.balanceTotalMop} /> : "—"}
                    delta={null}
                  />
                  <Kpi
                    label="會員充值"
                    value={<Money amount={ledger.sel?.topupMop ?? 0} />}
                    delta={ledger.yest ? pct(ledger.sel?.topupMop ?? 0, ledger.yest.topupMop) : null}
                    subtitle={`實際 ${formatMoney(ledger.sel?.topupPaidMop ?? 0)} · 贈送 ${formatMoney(ledger.sel?.topupGiftMop ?? 0)}`}
                  />
                  <Kpi
                    label="會員扣點"
                    value={<Money amount={ledger.sel?.deductMop ?? 0} />}
                    delta={ledger.yest ? pct(ledger.sel?.deductMop ?? 0, ledger.yest.deductMop) : null}
                    subtitle={`已付 ${formatMoney(ledger.sel?.deductPaidMop ?? 0)} · 贈送 ${formatMoney(ledger.sel?.deductGiftMop ?? 0)}`}
                  />
                  <Kpi
                    label="毛利（估）"
                    value={
                      gpEditing ? (
                        <span className="flex items-center gap-1">
                          <span className="text-[11px] font-medium text-slate-400">毛利率</span>
                          <input
                            autoFocus
                            type="number"
                            value={gpDraft}
                            onChange={(e) => setGpDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveGpOverride();
                              if (e.key === "Escape") setGpEditing(false);
                            }}
                            className="w-full min-w-0 rounded-md border border-orange-300 px-1 py-0.5 text-2xl font-bold text-orange-600 outline-none focus:ring-1 focus:ring-orange-300"
                          />
                          <span className="text-sm font-medium text-slate-400">%</span>
                        </span>
                      ) : (
                        <Money amount={displayGrossProfit} />
                      )
                    }
                    highlight
                    delta={gpMarginPct != null ? null : grossProfitYest === null ? null : pct(grossProfit, grossProfitYest)}
                    subtitle={gpMarginPct != null ? `毛利率 ${gpMarginPct}%（營業額 × ${gpMarginPct}%）` : "系統估算：營業額 − 進貨成本"}
                    action={
                      gpEditing ? (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={saveGpOverride}
                            className="text-[11px] font-semibold text-orange-600 hover:underline"
                          >
                            儲存
                          </button>
                          <button
                            onClick={() => setGpEditing(false)}
                            className="text-[11px] text-slate-400 hover:underline"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setGpDraft(gpMarginPct != null ? String(gpMarginPct) : "50");
                            setGpEditing(true);
                          }}
                          className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-orange-50 hover:text-orange-600"
                          title="編輯毛利預估值"
                        >
                          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M11 2l3 3L6 13l-3.5.5L3 10z" strokeLinejoin="round" />
                          </svg>
                          edit
                        </button>
                      )
                    }
                  />
                </div>
              </>
            ) : (
              <>
                {/* Skeleton 都要同真身一樣：一個 grid、5 欄、10 格（5-5），否則載入完會「跳版」 */}
                <div className="mb-4 grid grid-cols-5 gap-3">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div key={`sk-${i}`} className="rounded-2xl border border-slate-200 bg-white p-4">
                      <div className="flex h-16 items-center justify-center">
                        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500" role="status" aria-label="載入中" />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/*
              訂單明細：逐筆列出已結帳訂單（線下 POS + Ledger 純線上），口徑同支付方式分項。
              ⚠️ 位置：緊貼 KPI 帶之下（2026-09-10 用戶要求「訂單明細要顯示在格仔下方」）。
              預設只出頭 ORDER_DETAIL_PREVIEW 行 + 「顯示全部」，否則逐筆列表會佔滿首屏，
              把下面所有區塊（菜品排行、食材消耗…）推到很遠。
            */}
            <Card
              title="訂單明細"
              tag={`共 ${agg.orderDetails.length} 張 · 結賬時間倒序`}
              loading={!dataReady}
            >
              {agg.orderDetails.length === 0 ? (
                <div className="text-sm text-slate-500">篩選範圍內暫無已結帳訂單。</div>
              ) : (
                <>
                  <div className="max-h-[420px] overflow-auto rounded-xl border border-slate-200 bg-white">
                    <OrderDetailList
                      rows={
                        orderDetailExpanded
                          ? agg.orderDetails
                          : agg.orderDetails.slice(0, ORDER_DETAIL_PREVIEW)
                      }
                    />
                  </div>
                  {agg.orderDetails.length > ORDER_DETAIL_PREVIEW ? (
                    <button
                      type="button"
                      onClick={() => setOrderDetailExpanded((v) => !v)}
                      className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      {orderDetailExpanded ? "收起" : `顯示全部 ${agg.orderDetails.length} 張`}
                    </button>
                  ) : null}
                </>
              )}
            </Card>

            {/*
              菜品銷售排行：緊接訂單明細之下（2026-09-10 用戶要求）。
              原本同「會員充值 & 會員數」併排喺 `lg:grid-cols-[1.4fr_1fr]`；
              該卡已整張移除 → 呢邊改為全寬單欄。
            */}
            <div className="mb-4">
              <Card title="菜品銷售排行" tag="按下單當時快照名稱 · 線上＋線下" loading={!dataReady}>
                {agg.dishes.length === 0 ? (
                  <Empty />
                ) : (
                  <div className="grid gap-1">
                    {onlineDetailInfo.status === "loading" ? (
                      <div className="mb-1 text-[11px] text-slate-400">
                        正在抓取 Ledger 線上單明細（{onlineDetailInfo.total} 張）…
                      </div>
                    ) : null}
                    {onlineDetailInfo.status === "error" ? (
                      <div className="mb-1 rounded bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
                        Ledger 線上單明細抓取失敗：{onlineDetailInfo.lastError ?? "未知錯誤"}，菜品排行暫時只含 POS 單。
                      </div>
                    ) : null}
                    {onlineDetailInfo.status === "success" && onlineDetailInfo.ok > 0 ? (
                      <div className="mb-1 text-[11px] text-slate-400">
                        已併入 {onlineDetailInfo.ok} 張 Ledger 線上單明細（未入 POS DB 嘅線上單）
                        {onlineDetailInfo.failed > 0 ? ` · ${onlineDetailInfo.failed} 張失敗` : ""}。
                      </div>
                    ) : null}
                    {agg.dishes.slice(0, 8).map((d) => (
                      <DishRowItem key={d.key} d={d} />
                    ))}
                    {agg.dishes.length > 8 ? (
                      <button
                        type="button"
                        onClick={() => {
                          setDishModalPage(1);
                          setDishModalOpen(true);
                        }}
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-100"
                      >
                        更多（共 {agg.dishes.length} 個）
                      </button>
                    ) : null}
                  </div>
                )}
              </Card>

              {/* 菜品銷售排行完整列表彈窗 */}
              {dishModalOpen ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                  <div className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-2xl bg-white p-4 shadow-xl">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <div className="text-base font-semibold text-slate-900">菜品銷售排行</div>
                        <div className="text-xs text-slate-500">共 {agg.dishes.length} 個菜品 · 每頁 {DISHES_PER_PAGE} 個</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDishModalOpen(false)}
                        className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200"
                      >
                        關閉
                      </button>
                    </div>
                    <div className="max-h-[55vh] overflow-y-auto pr-1">
                      {(() => {
                        const pageDishes = agg.dishes.slice((dishModalPage - 1) * DISHES_PER_PAGE, dishModalPage * DISHES_PER_PAGE);
                        return (
                          <div className="grid gap-1">
                            {pageDishes.map((d, i) => (
                              <div key={d.key} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                                    <span className="w-6 shrink-0 text-xs text-slate-400">{(dishModalPage - 1) * DISHES_PER_PAGE + i + 1}.</span>
                                    <span className="truncate">{d.name}</span>
                                    <ChannelChip
                                      kind={d.onlineQty > 0 && d.offlineQty > 0 ? "mix" : d.onlineQty > 0 ? "off" : "in"}
                                    />
                                  </div>
                                  <div className="mt-0.5 pl-8 text-xs text-slate-500">
                                    線下 {d.offlineQty} · 線上 {d.onlineQty}
                                  </div>
                                </div>
                                <div className="shrink-0 text-right">
                                  <div className="text-sm font-semibold text-slate-900">{d.offlineQty + d.onlineQty} 份</div>
                                  <div className="text-xs text-slate-400">{formatMoney(d.revenue)}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                    {agg.dishes.length > DISHES_PER_PAGE ? (
                      <div className="mt-3 flex items-center justify-between">
                        <button
                          type="button"
                          disabled={dishModalPage <= 1}
                          onClick={() => setDishModalPage((p) => Math.max(1, p - 1))}
                          className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-40"
                        >
                          上一頁
                        </button>
                        <span className="text-sm text-slate-600">
                          第 {dishModalPage} / {Math.ceil(agg.dishes.length / DISHES_PER_PAGE)} 頁
                        </span>
                        <button
                          type="button"
                          disabled={dishModalPage >= Math.ceil(agg.dishes.length / DISHES_PER_PAGE)}
                          onClick={() => setDishModalPage((p) => Math.min(Math.ceil(agg.dishes.length / DISHES_PER_PAGE), p + 1))}
                          className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-40"
                        >
                          下一頁
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

            </div>

            {/* 模塊 1 + 模塊 2：食材消耗（BOM 精確化）
                ⚠️ 位置：由 KPI 帶下方移到呢度（2026-09-10）。KPI 下面嘅第一、二個區塊
                要係「訂單明細 → 菜品銷售排行」（用戶指定順序），所以食材消耗讓位。 */}
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card title="食材消耗（本月）" tag="BOM × 已售份數" loading={!dataReady}>
                {!consMonth.hasRecipes ? (
                  <div>
                    <div className="text-xs text-slate-400">尚未設定菜品配方，模塊顯示空白。</div>
                    <Link
                      href="/reports/bom"
                      className="mt-2 inline-block rounded-lg border border-dashed border-orange-300 px-3 py-1.5 text-xs font-semibold text-orange-600 hover:bg-orange-50"
                    >
                      前往「配方管理」填寫 →
                    </Link>
                  </div>
                ) : (
                  <div>
                    <div className="text-3xl font-extrabold text-orange-600">{formatMoney(consMonth.totalAmount)}</div>
                    <div className="mt-1 text-xs text-slate-500">
                      本月食材成本（至今日）· {consMonth.kinds} 款食材
                    </div>
                    <div className="mt-2 text-xs text-slate-400">
                      選取範圍（{FILTERS.find((f) => f.key === range)?.label}）：{formatMoney(consRange.totalAmount)} ·{" "}
                      {consRange.kinds} 款
                    </div>
                  </div>
                )}
              </Card>

              <Card title="食材使用量排行" tag="本月 · 按成本" loading={!dataReady}>
                {!consMonth.hasRecipes ? (
                  <Empty />
                ) : consMonth.rows.length === 0 ? (
                  <div className="text-xs text-slate-400">本月暫無已售菜品配對到配方。</div>
                ) : (
                  <div className="grid gap-1">
                    {consMonth.rows.slice(0, 8).map((r, i) => (
                      <div
                        key={r.name}
                        className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0"
                      >
                        <div className="text-sm font-semibold text-slate-900">
                          <span className="mr-2 text-xs text-slate-400">{i + 1}.</span>
                          {r.name}
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-semibold text-slate-900">
                            {r.qty} {r.unit}
                          </div>
                          <div className="text-xs text-slate-400">{formatMoney(r.amount)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            {/* 支付方式分項：依每種支付方式列出應收 / 實收金額合計 + 訂單數 */}
            <Card title="支付方式分項" tag="應收 = 原價合計 + 服務費 + 稅 · 實收 = order.total" loading={!dataReady}>
              {Object.keys(agg.paymentBreakdown).length === 0 ? (
                <div className="text-sm text-slate-500">篩選範圍內暫無已結帳訂單。</div>
              ) : (
                <div className="overflow-auto rounded-xl border border-slate-200">
                  <table className="w-full border-collapse text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
                      <tr>
                        <th className="border-b border-slate-200 px-3 py-2">支付方式</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">訂單數</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">應收金額合計</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">實收金額合計</th>
                        <th className="border-b border-slate-200 px-3 py-2 text-right">折扣差額</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(agg.paymentBreakdown)
                        .sort(([, a], [, b]) => b.paid - a.paid)
                        .map(([method, bucket]) => {
                          const diff = bucket.receivable - bucket.paid;
                          return (
                            <tr key={method} className="border-b border-slate-100 last:border-b-0">
                              <td className="px-3 py-2 font-semibold text-slate-900">{method}</td>
                              <td className="px-3 py-2 text-right text-slate-700">{bucket.count}</td>
                              <td className="px-3 py-2 text-right font-semibold text-slate-900">
                                {formatMoney(bucket.receivable)}
                              </td>
                              <td className="px-3 py-2 text-right font-semibold text-emerald-700">
                                {formatMoney(bucket.paid)}
                              </td>
                              <td
                                className={`px-3 py-2 text-right ${
                                  diff > 0.01 ? "text-amber-700" : "text-slate-400"
                                }`}
                              >
                                {diff > 0.01 ? `-${formatMoney(diff)}` : formatMoney(0)}
                              </td>
                            </tr>
                          );
                        })}
                      {(() => {
                        // 合計行
                        const totalCount = Object.values(agg.paymentBreakdown).reduce((s, b) => s + b.count, 0);
                        const totalReceivable = Object.values(agg.paymentBreakdown).reduce((s, b) => s + b.receivable, 0);
                        const totalPaid = Object.values(agg.paymentBreakdown).reduce((s, b) => s + b.paid, 0);
                        return (
                          <tr className="bg-slate-50 text-sm font-semibold text-slate-900">
                            <td className="px-3 py-2">合計</td>
                            <td className="px-3 py-2 text-right">{totalCount}</td>
                            <td className="px-3 py-2 text-right">{formatMoney(totalReceivable)}</td>
                            <td className="px-3 py-2 text-right text-emerald-700">{formatMoney(totalPaid)}</td>
                            <td className="px-3 py-2 text-right text-amber-700">
                              {totalReceivable - totalPaid > 0.01
                                ? `-${formatMoney(totalReceivable - totalPaid)}`
                                : formatMoney(0)}
                            </td>
                          </tr>
                        );
                      })()}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* 模塊 7 + 模塊 8 */}
            <div className="mb-4 grid gap-4 md:grid-cols-2">
              <Card title="沽清菜品" tag="即時" loading={!dataReady}>
                <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold ${soldOut.length > 0 ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
                  {soldOut.length} 款沽清
                </span>
                {soldOut.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {soldOut.map((n) => (
                      <span key={n} className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs text-rose-700">
                        {n}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-slate-400">暫無沽清菜品。</div>
                )}
              </Card>

              <Card title="最熱門桌台排行" tag="單數 · 覆蓋人數" loading={!dataReady}>
                {agg.tables.length === 0 ? (
                  <Empty />
                ) : (
                  <div className="grid gap-1">
                    {agg.tables.slice(0, 6).map((t, i) => (
                      <div key={t.tableId} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0">
                        <div className="text-sm font-semibold text-slate-900">
                          <span className="mr-2 text-xs text-slate-400">{i + 1}.</span>
                          {t.name}
                        </div>
                        <div className="text-sm text-slate-700">
                          {t.orders} 單 · {t.covers} 人
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            {/* 補充：尖峰時段 + 出餐時間 + 營運指標 */}
            <div className="mb-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Card
                title="尖峰時段（每小時訂單）"
                tag={
                  onlineFetchInfo.status === "success"
                    ? `POS+Ledger · 高峰約 ${peakHour}:00`
                    : onlineFetchInfo.status === "error"
                      ? `僅 POS · 高峰約 ${peakHour}:00`
                      : `POS · 高峰約 ${peakHour}:00`
                }
                loading={!dataReady}
              >
                <div className="grid grid-cols-12 gap-1">
                  {combinedByHour.map((c, h) => {
                    const offline = offlineHourOnly[h] ?? 0;
                    const online = Math.max(0, c - offline);
                    return (
                      <div
                        key={h}
                        title={`${h}:00 · POS ${offline} 單 + Ledger 線上 ${online} 單 = 共 ${c} 單`}
                        className="relative flex h-7 items-end justify-center overflow-hidden rounded text-[9px] text-white"
                        style={{
                          background: c >= maxHour * 0.7 ? "#ef4444" : c >= maxHour * 0.4 ? "#fb923c" : "#cbd5e1",
                        }}
                      >
                        {/* 線上單疊加層（藍色），上到下垂直堆疊表達「線下 + 線上」總和。 */}
                        {online > 0 && offline > 0 ? (
                          <div
                            className="absolute bottom-0 left-0 right-0 bg-blue-500/70"
                            style={{ height: `${Math.min(100, (online / c) * 100)}%` }}
                            aria-hidden
                          />
                        ) : null}
                        <span className="relative z-10">{c > 0 ? c : ""}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <Metric label="退菜率" value={`${Math.round(voidRate * 100)}%`} warn={voidRate > 0.03} />
                  <Metric label="折扣佔比" value={`${Math.round(discountRatio * 100)}%`} warn={discountRatio > 0.15} />
                  <Metric label="線上佔比" value={`${Math.round(onlineShare * 100)}%`} />
                </div>
                {onlineFetchInfo.status === "error" ? (
                  <div className="mt-2 text-[11px] text-amber-700">
                    Ledger 線上單抓取失敗：{onlineFetchInfo.lastError ?? "未知錯誤"}，尖峰時段僅含 POS 單。
                  </div>
                ) : null}
                {onlineFetchInfo.status === "success" && onlineFetchInfo.outOfRange > 0 ? (
                  <div className="mt-1 text-[11px] text-slate-400">
                    Ledger 抓取 {onlineFetchInfo.fetched} 單 · 入圖 {onlineFetchInfo.counted} · 越界 {onlineFetchInfo.outOfRange}
                    {onlineFetchInfo.cancelled > 0 ? ` · 取消 ${onlineFetchInfo.cancelled}` : ""}
                    {onlineFetchInfo.unpaid > 0 ? ` · 未付 ${onlineFetchInfo.unpaid}` : ""}
                  </div>
                ) : null}
              </Card>

              <Card title="營運指標 · 同環比" tag="vs 7 日均值" loading={!dataReady}>
                <div className="grid gap-1">
                  <Row label="營業額（7日均）" value={formatMoney(rev7dAvg)} />
                  <Row label="線上渠道佔比（7日均）" value={`${Math.round(onlineShare7d * 100)}%`} />
                  <Row label="會員充值（7日均）" value={formatMoney(topup7dAvg)} />
                  <Row label="總售出份數" value={`${agg.totalSoldQty} 份`} />
                </div>
                <div className="mt-2 text-[11px] text-slate-400">
                  營業額同線上佔比基於 POS 訂單 7 日均；會員充值來自 Ledger RPC。
                </div>
              </Card>

              <Card
                title="時長統計（堂食 / 外賣）"
                tag={
                  agg.dineInServing.total.estimated || agg.quickServing.total.estimated ? "含估算" : "實測"
                }
                loading={!dataReady}
              >
                {agg.dineInServing.total.count === 0 && agg.quickServing.total.count === 0 ? (
                  <Empty />
                ) : (
                  <>
                    <DurationBarChart
                      steps={[
                        {
                          label: "堂食·下單→送廚",
                          avgMin: agg.dineInServing.orderToKitchen.avgMin,
                          count: agg.dineInServing.orderToKitchen.count,
                          colorClass: "bg-indigo-500",
                        },
                        {
                          label: "堂食·送廚→結帳",
                          avgMin: agg.dineInServing.kitchenToSettle.avgMin,
                          count: agg.dineInServing.kitchenToSettle.count,
                          colorClass: "bg-indigo-500",
                        },
                        {
                          label: "堂食·整體",
                          avgMin: agg.dineInServing.total.avgMin,
                          count: agg.dineInServing.total.count,
                          colorClass: "bg-indigo-700",
                        },
                        {
                          label: "外賣·下單→送廚",
                          avgMin: agg.quickServing.orderToKitchen.avgMin,
                          count: agg.quickServing.orderToKitchen.count,
                          colorClass: "bg-amber-500",
                        },
                        {
                          label: "外賣·送廚→出餐",
                          avgMin: agg.quickServing.kitchenToServed.avgMin,
                          count: agg.quickServing.kitchenToServed.count,
                          colorClass: "bg-amber-500",
                        },
                        {
                          label: "外賣·出餐→完成",
                          avgMin: agg.quickServing.servedToSettled.avgMin,
                          count: agg.quickServing.servedToSettled.count,
                          colorClass: "bg-amber-500",
                        },
                        {
                          label: "外賣·整體",
                          avgMin: agg.quickServing.total.avgMin,
                          count: agg.quickServing.total.count,
                          colorClass: "bg-amber-700",
                        },
                      ]}
                      maxAvg={Math.max(
                        agg.dineInServing.orderToKitchen.avgMin,
                        agg.dineInServing.kitchenToSettle.avgMin,
                        agg.dineInServing.total.avgMin,
                        agg.quickServing.orderToKitchen.avgMin,
                        agg.quickServing.kitchenToServed.avgMin,
                        agg.quickServing.servedToSettled.avgMin,
                        agg.quickServing.total.avgMin,
                        1,
                      )}
                    />
                    {/* 圖例 */}
                    <div className="mt-3 flex items-center gap-4 text-[11px] text-slate-500">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm bg-indigo-500" />
                        堂食
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="h-2.5 w-2.5 rounded-sm bg-amber-500" />
                        快餐 / 外賣
                      </span>
                      <span>深色 = 整體時長</span>
                    </div>
                  </>
                )}
              </Card>
            </div>

            {/* 模塊 5 人流 + 低庫存預警 */}
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card title="當日人流（入店人次）" tag="自動計算 · 參考用" loading={!dataReady}>
                <div className="flex items-baseline gap-2">
                  <div className="text-3xl font-extrabold text-indigo-600">{footfallTotal}</div>
                  <div className="text-xs text-slate-500">選取範圍累計入店人次</div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <div className="text-slate-400">堂食</div>
                    <div className="mt-0.5 text-sm font-semibold text-slate-900">{footfallBreakdown.dineIn} 人</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <div className="text-slate-400">快餐 / 外賣</div>
                    <div className="mt-0.5 text-sm font-semibold text-slate-900">{footfallBreakdown.counter} 單</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <div className="text-slate-400">Ledger 純線上</div>
                    <div className="mt-0.5 text-sm font-semibold text-slate-900">{footfallBreakdown.online} 單</div>
                  </div>
                </div>
                {conversion != null ? (
                  <div className="mt-2 text-xs text-slate-500">
                    堂食轉化率 {Math.round(conversion * 100)}%（覆蓋 {agg.covers} 人 / 人流 {footfallTotal}）
                  </div>
                ) : null}
                <div className="mt-2 text-[11px] text-slate-400">
                  由訂單自動計算：堂食依 partySize 加總；快餐 / 外賣 / Ledger 純線上一單算一人。三項相加等於上方總人次。純參考用，無門口計數硬件嘅替代方案。
                </div>
              </Card>

              <Card title="低庫存預警" tag="current_qty ≤ par（reorder_level）" loading={!dataReady}>
                {lowStock === null ? (
                  <div className="text-xs text-slate-400">
                    未能讀取庫存（未連線 macau-pos Supabase 或尚無庫存品）。
                  </div>
                ) : lowStock.length === 0 ? (
                  <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-700">
                    庫存充足
                  </span>
                ) : (
                  <div className="grid gap-1">
                    <div className="text-sm font-semibold text-rose-600">{lowStock.length} 款低庫存</div>
                    {lowStock.slice(0, 8).map((p) => (
                      <div
                        key={p.name}
                        className="flex items-center justify-between border-b border-slate-100 py-1.5 last:border-0"
                      >
                        <span className="text-sm text-slate-900">{p.name}</span>
                        <span className="text-xs text-rose-600">
                          {p.qty} / {p.par} {p.unit}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            {/* 模塊 9：自動化優化建議 */}
            {dataReady ? (
              <div className="rounded-2xl border border-orange-200 bg-orange-50/60 p-4">
                <div className="mb-3 text-base font-semibold text-slate-900">🔔 自動化優化建議（{FILTERS.find((f) => f.key === range)?.label}）</div>
                {loading ? (
                  <div className="text-sm text-slate-500">載入中…</div>
                ) : suggestions.length === 0 ? (
                  <div className="text-sm text-slate-500">目前未觸發優化建議，營運狀況健康。</div>
                ) : (
                  <div className="grid gap-2">
                    {suggestions.map((s, i) => (
                      <div key={i} className="flex gap-3 rounded-xl border border-orange-200 bg-white p-3">
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            s.level === "r" ? "bg-rose-100 text-rose-700" : s.level === "o" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {LEVEL_LABEL[s.level]}
                        </span>
                        <div className="text-sm leading-relaxed text-slate-700">
                          <span className="font-semibold text-slate-900">{s.title}：</span>
                          {s.action}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <SectionSkeleton label="自動化優化建議" />
            )}

            <div className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-400">
              說明：營業額／訂單／菜品／桌台／退菜／折扣均來自本機結帳訂單；會員充值與線上餘額扣減來自 Ledger；低庫存預警來自本店 inv_products（current_qty ≤ reorder_level）。
              人流（入店人次）由訂單自動計算：堂食依 partySize 加總、快餐/外賣一單算一人，純參考用。時長統計分開呈現堂食（送廚 → 結帳）同快餐/外賣（送廚 → 出餐 → 完成）各步驟；缺時間戳嘅樣本以落單→結帳/updatedAt 估算，標「含估算」。食材消耗依 BOM 配方 × 已售份數計算（於「配方管理」填寫後方精確）。
              毛利為「營業額 − 買貨成本（已付）」估算。
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  highlight,
  delta,
  subtitle,
  action,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
  delta: { arrow: string; cls: string } | null;
  /** 大數下方的小字（如「線下/線上」分拆）。 */
  subtitle?: string;
  /** 右上角操作位（如「毛利（估）」嘅 edit 掣）。 */
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-slate-500">{label}</div>
        {action}
      </div>
      <div className={`mt-1 text-2xl font-bold ${highlight ? "text-orange-600" : "text-slate-900"}`}>{value}</div>
      {subtitle ? <div className="mt-0.5 text-[11px] text-slate-500">{subtitle}</div> : null}
      {delta ? <div className={`mt-1 text-[11px] ${delta.cls}`}>{delta.arrow}</div> : null}
    </div>
  );
}

/** 金額渲染：貨幣前綴（MOP）縮細，數字保持大號字，避免「MOP 123,456」擠爆格子。 */
function Money({ amount, currency = "MOP" }: { amount: number; currency?: string }) {
  const rounded = Math.round(Number.isFinite(amount) ? amount : 0);
  const grouped = rounded.toLocaleString("en-US");
  return (
    <span className="tabular-nums">
      <span className="mr-1 align-baseline text-sm font-medium text-slate-400">{currency}</span>
      <span>{grouped}</span>
    </span>
  );
}

function Card({ title, tag, children, loading }: { title: string; tag?: string; children: React.ReactNode; loading?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-base font-semibold text-slate-900">{title}</div>
        {tag ? <div className="text-xs text-slate-400">{tag}</div> : null}
      </div>
      {loading ? (
        <div className="flex min-h-[140px] items-center justify-center rounded-xl bg-slate-50">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500" role="status" aria-label="載入中" />
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function SectionSkeleton({ label, height = 140 }: { label?: string; height?: number }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 h-4 w-40 animate-pulse rounded bg-slate-200">{label ? <span className="sr-only">{label}</span> : null}</div>
      <div className="flex items-center justify-center rounded-xl bg-slate-50" style={{ minHeight: height }}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500" role="status" aria-label="載入中" />
      </div>
      <div className="mt-3 space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-slate-100" />
        <div className="h-3 w-4/5 animate-pulse rounded bg-slate-100" />
      </div>
    </div>
  );
}

function DishRowItem({ d }: { d: DishRow }) {
  const total = d.offlineQty + d.onlineQty;
  const ch = d.onlineQty > 0 && d.offlineQty > 0 ? "mix" : d.onlineQty > 0 ? "off" : "in";
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <span className="truncate">{d.name}</span>
          <ChannelChip kind={ch} />
        </div>
        <div className="mt-0.5 text-xs text-slate-500">
          線下 {d.offlineQty} · 線上 {d.onlineQty}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm font-semibold text-slate-900">{total} 份</div>
        <div className="text-xs text-slate-400">{formatMoney(d.revenue)}</div>
      </div>
    </div>
  );
}

function ChannelChip({ kind }: { kind: "off" | "in" | "mix" }) {
  const map = {
    off: { t: "線上", c: "bg-blue-50 text-blue-700" },
    in: { t: "線下", c: "bg-slate-100 text-slate-600" },
    mix: { t: "混合", c: "bg-purple-50 text-purple-700" },
  } as const;
  const v = map[kind];
  return <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold ${v.c}`}>{v.t}</span>;
}

function Pill({ kind, children }: { kind: "amber" | "green" | "slate"; children: React.ReactNode }) {
  const c = {
    amber: "bg-amber-50 text-amber-700",
    green: "bg-emerald-50 text-emerald-700",
    slate: "bg-slate-100 text-slate-600",
  } as const;
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${c[kind]}`}>{children}</span>;
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl bg-slate-50 py-2">
      <div className={`text-sm font-bold ${warn ? "text-rose-600" : "text-slate-900"}`}>{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0">
      <span className="text-sm text-slate-600">{label}</span>
      <span className="text-sm font-semibold text-slate-900">{value}</span>
    </div>
  );
}

function Empty() {
  return <div className="text-xs text-slate-400">此範圍暫無資料。</div>;
}

type DurationBarStep = {
  label: string;
  avgMin: number;
  count: number;
  colorClass: string;
};

/** 垂直柱狀圖：每個環節一根柱，柱頂顯示平均時長（分鐘），堂食／外賣以顏色區分。 */
function DurationBarChart({ steps, maxAvg }: { steps: DurationBarStep[]; maxAvg: number }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3">
      {/* 柱區：高度固定，柱高按 avg / maxAvg 比例（上限 85%，預留數值標籤空間） */}
      <div className="flex h-44 items-end gap-1.5">
        {steps.map((s) => {
          const noData = s.count === 0;
          const pct = !noData && maxAvg > 0 ? Math.min((s.avgMin / maxAvg) * 85, 85) : 2;
          return (
            <div
              key={s.label + s.colorClass}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
            >
              <div
                className={`text-[11px] font-semibold ${noData ? "text-slate-300" : "text-slate-800"}`}
              >
                {noData ? "—" : s.avgMin.toFixed(1)}
              </div>
              <div
                className={`w-full max-w-[44px] rounded-t-md ${noData ? "bg-slate-200" : s.colorClass}`}
                style={{ height: `${pct}%` }}
                title={`${s.label}：平均 ${noData ? "—" : `${s.avgMin.toFixed(1)} 分`}（樣本 ${s.count}）`}
              />
            </div>
          );
        })}
      </div>
      {/* X 軸標籤 */}
      <div className="mt-2 flex gap-1.5 border-t border-slate-200 pt-1.5">
        {steps.map((s) => (
          <div
            key={s.label + s.colorClass}
            className="min-w-0 flex-1 truncate text-center text-[10px] leading-tight text-slate-500"
            title={s.label}
          >
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}
