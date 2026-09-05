"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  getMerchantReportSummary,
  type LedgerReportSummary,
} from "@/lib/ledger/reports";
import { restoreLedgerSession } from "@/lib/ledger/session";
import { getOrderDetail, listMerchantOrders, type LedgerOrderDetailItem } from "@/lib/ledger/orders";
import type { LedgerOnlineOrder } from "@/lib/ledger/order-mapper";
import { fetchPurchaseSummary, type PurchaseSummary } from "@/lib/inventory-stats";
import {
  loadAuthSession,
  loadBootstrapCache,
  loadDeletedOrderIds,
  loadOrders,
  loadSoldOutState,
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
import type { PosOrder } from "@/lib/types";
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
}

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
 *  - 退款狀態（refunded / partially_refunded）一律不計入銷售。 */
function isSaleCountable(o: PosOrder): boolean {
  if (o.status === "refunded" || o.status === "partially_refunded") return false;
  if (o.status === "settled" || o.status === "paid") return true;
  return false;
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

  const dishMap = new Map<string, DishRow>();
  const tableMap = new Map<string, TableRow>();
  const byHour = new Array<number>(24).fill(0);

  for (const o of inRange) {
    revenue += o.total;
    discount += o.discountAmount;
    covers += o.partySize ?? 0;
    const isOnline = !!o.onlineOrderId;
    if (isOnline) onlineRevenue += o.total;
    else offlineRevenue += o.total;

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
  for (const { items } of onlineWithItems ?? []) {
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

export function RestaurantDailyReport() {
  const [range, setRange] = useState<ReportRangeKey>("today");
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

  const merchantId = useReportMerchantId();
  const merchantIdForQuery = merchantId ?? ""; // 穩定型別用，空字串代表 dev 模式不帶 storeId
  const monthKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(new Date()).substring(0, 7);
  const bom: BomEntry[] = useMemo(() => loadBom(merchantId ?? ""), [merchantId]);

  // 雲端訂單補載序號：改變佢會強制重跑 backfill effect（切店 / 手動重新拉取）。
  const [backfillSeq, setBackfillSeq] = useState(0);

  // 切店 / 首次確認 merchantId 時立即清空舊店數據，杜絕閃現外店資料。
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
  }, [merchantId]);

  // 菜品銷售排行「更多」彈窗
  const [dishModalOpen, setDishModalOpen] = useState(false);
  const [dishModalPage, setDishModalPage] = useState(1);
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
    () => loadBootstrapCache(merchantId ?? undefined)?.storeName ?? "本店",
    [merchantId],
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
    merchantId,
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

  useEffect(() => {
    let cancelled = false;
    async function backfillOrders() {
      setDebugInfo((prev) => ({
        ...prev,
        status: "loading",
        merchantId,
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
        for (let page = 0; page < MAX_PAGES; page++) {
          const offset = page * PAGE;
          const rangeQs = period
            ? `&start=${encodeURIComponent(period.start)}&end=${encodeURIComponent(period.end)}`
            : "";
          const url = merchantId
            ? `/api/pos/state?storeId=${encodeURIComponent(merchantId)}&limit=${PAGE}&offset=${offset}&ordersOnly=1${rangeQs}`
            : `/api/pos/state?limit=${PAGE}&offset=${offset}&ordersOnly=1${rangeQs}`;
          lastUrl = url;
          const res = await fetch(url);
          lastHttpStatus = res.status;
          if (!res.ok) {
            cloudFailed = true;
            lastError = `HTTP ${res.status} ${res.statusText}`;
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
        if (!merchantId) return true; // dev 模式未登入：放行
        return o.storeId === merchantId;
      };

      // 雲端有單 → 以雲端為唯一可信源。
      // 雲端空 + 失敗 → fallback 本機 orders（離線模式仍可用）。
      // 雲端空 + 成功 → 該店確實冇單，顯示空狀態（**唔可以用本機 orders 覆蓋**——可能係舊 store 殘留）。
      let final: PosOrder[];
      if (fetched.length > 0) {
        final = fetched.filter((o) => !deletedIds.has(o.id) && belongsToStore(o));
      } else if (cloudFailed) {
        final = localOrders.filter((o) => !deletedIds.has(o.id) && belongsToStore(o));
      } else {
        final = [];
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
        status: cloudFailed && fetched.length === 0 ? "error" : "success",
        merchantId,
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
  }, [merchantId, backfillSeq, range]);

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
        const period = backfillRangeFor(range);
        const PAGE = 500;
        const MAX_PAGES = 8; // 上限 4000 單，足以覆蓋繁忙餐廳 30 日滾動窗口
        const rangeStartMs = period ? Date.parse(period.start) : null;
        const rangeEndMs = period ? Date.parse(period.end) : null;
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
  }, [merchantId, range]);

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
  }, [range, merchantId, merchantIdForQuery]);

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
      if (!merchantId || countableOnlineOrders.length === 0) {
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

  const ticketMopYest = aggYest && aggYest.count > 0 ? aggYest.revenue / aggYest.count : 0;

  /** 「線下 vs 線上」分拆：
   *  - 線下 = POS 收銀單且 *無* onlineOrderId（純現場收銀），由 POS DB 算；
   *  - 線上 = Ledger 總（`orderCount` / `orderPaidMop`）減去線下，涵蓋：
   *      · POS 接單的線上單（帶 onlineOrderId）
   *      · 其他渠道的單（kiosk / 外賣平台 / 微信小程序等不經過 POS DB 的）
   *  - 總值優先用 Ledger RPC（覆蓋整店全渠道，較 POS DB 權威）；
   *    若 Ledger 連不上則 fallback POS DB（離線模式仍可用）。
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
        onlineCount: Math.max(0, ledgerCount - offlineCount),
        onlineRevenueMop: Math.max(0, ledgerRevenueMop - offlineRevenueMop),
        totalCount: ledgerCount,
        totalRevenueMop: ledgerRevenueMop,
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
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          {/* 標題 + 右上篩選 */}
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">店鋪每日營運總結</div>
                <div className="mt-1 text-sm text-slate-500">
                  {storeName} · {todayKey}（澳門）· 篩選影響全部模塊
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

          <div className="flex-1 overflow-auto p-4">
            {ledgerError ? (
              <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {ledgerError}
              </div>
            ) : null}

            {/* DevTools debug panel：協助排查「報表打開後冇內容」 */}
            <div className="mb-3 rounded-xl border border-slate-200 bg-white shadow-sm">
              <button
                type="button"
                onClick={() => setDebugOpen((v) => !v)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                <span>
                  診斷面板（{debugInfo.status === "loading" ? "載入中" : debugInfo.status === "error" ? "異常" : "就緒"}）
                </span>
                <span className="text-slate-400">{debugOpen ? "▲" : "▼"}</span>
              </button>
              {debugOpen ? (
                <div className="space-y-2 border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <span className="block text-slate-400">merchantId</span>
                      <span className="font-mono font-medium break-all">{debugInfo.merchantId || "(未設定)"}</span>
                    </div>
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <span className="block text-slate-400">最後 HTTP 狀態</span>
                      <span className="font-mono font-medium">{debugInfo.lastHttpStatus ?? "未發送"}</span>
                    </div>
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <span className="block text-slate-400">雲端拉回單數</span>
                      <span className="font-mono font-medium">{debugInfo.fetchedCount}</span>
                    </div>
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <span className="block text-slate-400">最終顯示單數</span>
                      <span className="font-mono font-medium">{debugInfo.finalCount}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <span className="block text-slate-400">本機 localStorage 單數</span>
                      <span className="font-mono font-medium">{debugInfo.localCount}</span>
                    </div>
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <span className="block text-slate-400">耗時</span>
                      <span className="font-mono font-medium">{debugInfo.durationMs ?? "-"} ms</span>
                    </div>
                    <div className="rounded bg-slate-50 px-2 py-1">
                      <span className="block text-slate-400">payload.ok</span>
                      <span className="font-mono font-medium">{String(debugInfo.lastPayloadOk)}</span>
                    </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">最後錯誤</span>
                    <span className="font-mono font-medium break-all text-red-600">{debugInfo.lastError || "無"}</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">狀態分佈</span>
                    <span className="break-all font-mono font-medium">
                      {Object.entries(debugInfo.statusBreakdown)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(", ") || "-"}
                    </span>
                  </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">可計入營業單數</span>
                    <span className="font-mono font-medium">{debugInfo.countedStatus}</span>
                  </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">匹配當前範圍</span>
                    <span className="font-mono font-medium">
                      {debugInfo.matchedCurrentRange} / {debugInfo.countedStatus}
                    </span>
                  </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">匹配昨天範圍</span>
                    <span className="font-mono font-medium">{debugInfo.matchedYesterday}</span>
                  </div>
                </div>
                {/* 60000003 等舊分店殘留診斷：列示本批訂單內各 storeId 嘅分佈 + localStorage 內
                    各分店 orders key 嘅單數。命中 storeId 唔等於當前 merchantId =「外店污染」。 */}
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">訂單 storeId 分佈</span>
                    <span className="break-all font-mono font-medium">
                      {Object.entries(debugInfo.storeIdBreakdown)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(", ") || "-"}
                    </span>
                  </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">外店單數（storeId ≠ 當前）</span>
                    <span
                      className={`font-mono font-medium ${
                        debugInfo.foreignStoreCount > 0 ? "text-rose-600" : "text-slate-700"
                      }`}
                    >
                      {debugInfo.foreignStoreCount}
                    </span>
                  </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">菜品大類命中當前菜單</span>
                    <span className="font-mono font-medium">
                      {debugInfo.matchedCategoryCount} /{" "}
                      {debugInfo.matchedCategoryCount + debugInfo.unmatchedCategoryCount}
                    </span>
                  </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">未命中當前菜單嘅類別數</span>
                    <span
                      className={`font-mono font-medium ${
                        debugInfo.unmatchedCategoryCount > 0 ? "text-rose-600" : "text-slate-700"
                      }`}
                    >
                      {debugInfo.unmatchedCategoryCount}
                    </span>
                  </div>
                </div>
                {/* 菜單匹配診斷：顯示 bootstrap cache 狀態同逐條 item 嘅配對方式。 */}
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">bootstrap cache 菜單摘要</span>
                    <span className="break-all font-mono text-slate-700">
                      {debugInfo.bootstrapSummary.menuItemCount > 0
                        ? `${debugInfo.bootstrapSummary.storeName}（${debugInfo.bootstrapSummary.storeId}）· ${debugInfo.bootstrapSummary.menuItemCount} 個菜品 · ${debugInfo.bootstrapSummary.categoryCount} 個分類 · 更新於 ${debugInfo.bootstrapSummary.lastUpdatedAt || "?"}`
                        : "(無 bootstrap cache 或 menuItems 為空)"}
                    </span>
                    {debugInfo.bootstrapSummary.sampleMenuItemIds.length > 0 ? (
                      <div className="mt-1 text-[10px] text-slate-500">
                        菜品 ID 樣本：{debugInfo.bootstrapSummary.sampleMenuItemIds.join(", ")}
                      </div>
                    ) : null}
                    {debugInfo.bootstrapSummary.sampleMenuItemNames.length > 0 ? (
                      <div className="text-[10px] text-slate-500">
                        當前餐牌菜品名（前 12）：{debugInfo.bootstrapSummary.sampleMenuItemNames.join("、")}
                      </div>
                    ) : null}
                    {debugInfo.bootstrapSummary.sampleCategoryIds.length > 0 ? (
                      <div className="text-[10px] text-slate-500">
                        分類 ID 樣本：{debugInfo.bootstrapSummary.sampleCategoryIds.join(", ")}
                      </div>
                    ) : null}
                  </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">菜品配對方式統計</span>
                    <span className="break-all font-mono text-slate-700">
                      {Object.entries(debugInfo.dishMatchBreakdown)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(", ") || "-"}
                    </span>
                    <div className="mt-1 text-[10px] text-slate-500">
                      id=ID直接命中 · name=菜名命中 · normalized=正規化菜名命中 · unmatched=完全無法對照
                    </div>
                    {Object.keys(debugInfo.unmatchedItemNames).length > 0 ? (
                      <div className="mt-1 text-[10px] text-rose-600">
                        未匹配菜品（名稱 × 數量）：
                        {Object.entries(debugInfo.unmatchedItemNames)
                          .map(([k, v]) => `${k}×${v}`)
                          .join("、")}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">
                      localStorage 各分店 orders（macau-pos/stores/&#123;storeId&#125;/orders）
                    </span>
                    <span className="break-all font-mono text-slate-700">
                      {Object.entries(debugInfo.storageOrdersByStore).length > 0
                        ? Object.entries(debugInfo.storageOrdersByStore)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(", ")
                        : "(無)"}
                    </span>
                  </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">localStorage legacy（macau-pos/orders）</span>
                    <span
                      className={`break-all font-mono font-medium ${
                        debugInfo.legacyOrdersCount > 0 ? "text-rose-600" : "text-slate-700"
                      }`}
                    >
                      {debugInfo.legacyOrdersCount} 筆
                    </span>
                  </div>
                </div>
                {debugInfo.rangeStart && debugInfo.rangeEnd ? (
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">本次請求嘅澳門時間區間 [start, end]</span>
                    <span className="break-all font-mono text-slate-700">
                      {debugInfo.rangeStart} → {debugInfo.rangeEnd}
                    </span>
                  </div>
                ) : null}
                <div className="rounded bg-slate-50 px-2 py-1">
                  <span className="block text-slate-400">最後請求 URL</span>
                  <span className="break-all font-mono text-slate-700">{debugInfo.lastUrl || "尚未請求"}</span>
                </div>
                {debugInfo.sampleDates.length > 0 ? (
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">前 5 筆訂單樣本（status | createdAt | total）</span>
                    <ul className="mt-1 list-inside list-disc font-mono text-slate-700">
                      {debugInfo.sampleDates.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setBackfillSeq((n) => n + 1)}
                      className="rounded bg-orange-500 px-2 py-1 text-xs font-semibold text-white hover:bg-orange-600"
                    >
                      重新拉取訂單
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        console.log("[report debug]", debugInfo);
                        console.log("[report orders]", orders);
                      }}
                      className="rounded bg-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-300"
                    >
                      Console.log 狀態 + 訂單
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {/* 核心 KPI 帶 */}
            {dataReady ? (
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Kpi
                  label="營業額"
                  value={formatMoney(onlineOfflineSplit.totalRevenueMop)}
                  highlight
                  delta={pct(onlineOfflineSplit.totalRevenueMop, aggYest?.revenue ?? null)}
                  subtitle={`線下 ${formatMoney(onlineOfflineSplit.offlineRevenueMop)} · 線上 ${formatMoney(onlineOfflineSplit.onlineRevenueMop)}`}
                />
                <Kpi
                  label="毛利（估）"
                  value={formatMoney(grossProfit)}
                  highlight
                  delta={grossProfitYest === null ? null : pct(grossProfit, grossProfitYest)}
                />
                <Kpi
                  label="訂單數"
                  value={String(onlineOfflineSplit.totalCount)}
                  delta={pct(onlineOfflineSplit.totalCount, aggYest?.count ?? null)}
                  subtitle={`線下 ${onlineOfflineSplit.offlineCount} 單 · 線上 ${onlineOfflineSplit.onlineCount} 單`}
                />
                <Kpi
                  label="客單價"
                  value={formatMoney(
                    onlineOfflineSplit.totalCount > 0
                      ? onlineOfflineSplit.totalRevenueMop / onlineOfflineSplit.totalCount
                      : 0,
                  )}
                  delta={pct(
                    onlineOfflineSplit.totalCount > 0
                      ? onlineOfflineSplit.totalRevenueMop / onlineOfflineSplit.totalCount
                      : 0,
                    ticketMopYest,
                  )}
                />
                <Kpi label="覆蓋人數" value={String(agg.covers)} delta={pct(agg.covers, aggYest?.covers ?? null)} />
                <Kpi
                  label="會員充值"
                  value={formatMoney(ledger.sel?.topupMop ?? 0)}
                  delta={ledger.yest ? pct(ledger.sel?.topupMop ?? 0, ledger.yest.topupMop) : null}
                />
              </div>
            ) : (
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex h-16 items-center justify-center">
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500" role="status" aria-label="載入中" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 模塊 1 + 模塊 2：食材消耗（BOM 精確化） */}
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

            {/* 模塊 3 + 模塊 6 */}
            <div className="mb-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
              <Card title="菜品銷售排行" tag="按下單當時快照名稱 · 線上＋線下" loading={!dataReady}>
                {agg.dishes.length === 0 ? (
                  <Empty />
                ) : (
                  <div className="grid gap-1">
                    <div className="mb-1 rounded bg-slate-50 px-2 py-1.5 text-[11px] text-slate-500">
                      依訂單內快照名稱／價格聚合：快閃餐改名改價（菜品 ID 不變）時，唔同日期嘅名稱會各自一行（例如 A 餐、B 餐分開顯示），歷史訂單唔會因改名而對唔上當前餐牌。線上部分由 Ledger 訂單明細（get_order_detail）併入。
                    </div>
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

              <Card title="會員充值 & 會員數" tag="來源：Ledger" loading={!dataReady}>
                <div className="flex items-baseline gap-2">
                  <div className="text-3xl font-extrabold text-indigo-600">
                    {formatMoney(ledger.sel?.topupMop ?? 0)}
                  </div>
                  <div className="text-xs text-slate-500">充值金額（{FILTERS.find((f) => f.key === range)?.label}）</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {ledger.sel?.memberCount != null ? (
                    <Pill kind="amber">會員數 {ledger.sel.memberCount}</Pill>
                  ) : (
                    <Pill kind="amber">會員數 —（未連線）</Pill>
                  )}
                  <Pill kind="green">線上渠道佔比 {Math.round(onlineShare * 100)}%</Pill>
                  <Pill kind="slate">會員餘額扣減 {formatMoney(ledger.sel?.orderBalancePaidMop ?? 0)}</Pill>
                </div>
              </Card>
            </div>

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
                <div className="mt-2 text-[11px] text-slate-400">
                  柱高與柱頂數值為該環節平均時長（分鐘），樣本 0 顯示 —；堂食以「送廚 → 結帳」涵蓋製作同服務時間，外賣以「出餐 → 完成」反映等待取餐/外送時間。Ledger 純線上單冇送廚／出餐時間戳，只以「下單 → 付款完成」估算整體（計入 estimated 樣本）。
                </div>
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
              毛利為「營業額 − 買貨成本（已付）」估算；會員數來自 Ledger `get_merchant_report_summary` 的 member_count（未連線時顯示 —）。
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
}: {
  label: string;
  value: string;
  highlight?: boolean;
  delta: { arrow: string; cls: string } | null;
  /** 大數下方的小字（如「線下/線上」分拆）。 */
  subtitle?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${highlight ? "text-orange-600" : "text-slate-900"}`}>{value}</div>
      {subtitle ? <div className="mt-0.5 text-[11px] text-slate-500">{subtitle}</div> : null}
      {delta ? <div className={`mt-1 text-[11px] ${delta.cls}`}>{delta.arrow}</div> : null}
    </div>
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
