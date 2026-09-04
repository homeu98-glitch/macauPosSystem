"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  getMerchantReportSummary,
  type LedgerReportSummary,
} from "@/lib/ledger/reports";
import { restoreLedgerSession } from "@/lib/ledger/session";
import { fetchPurchaseSummary, type PurchaseSummary } from "@/lib/inventory-stats";
import {
  loadAuthSession,
  loadBootstrapCache,
  loadDeletedOrderIds,
  loadOrders,
  loadSoldOutState,
} from "@/lib/storage";
import { orderMatchesReportRange, type ReportRangeKey } from "@/lib/ledger/report-period";
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
  menuItemId: string;
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

function aggregate(orders: PosOrder[], range: ReportRangeKey): Agg {
  const closed = orders.filter(
    (o) => o.status === "settled" || o.status === "partially_refunded" || o.status === "refunded",
  );
  const inRange = closed.filter((o) => orderMatchesReportRange(o, range));

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
      const d =
        dishMap.get(it.menuItemId) ??
        { menuItemId: it.menuItemId, name: it.name, offlineQty: 0, onlineQty: 0, revenue: 0 };
      d.revenue += it.price * it.quantity;
      if (isOnline) d.onlineQty += it.quantity;
      else d.offlineQty += it.quantity;
      dishMap.set(it.menuItemId, d);
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

export function RestaurantDailyReport() {
  const [range, setRange] = useState<ReportRangeKey>("today");
  const [orders, setOrders] = useState<PosOrder[]>(() => loadOrders());
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

  const merchantId = loadAuthSession()?.merchantId ?? "default";
  const monthKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(new Date()).substring(0, 7);
  const bom: BomEntry[] = useMemo(() => loadBom(merchantId), [merchantId]);
  const consRange = useMemo(
    () => computeIngredientConsumption(orders, (o) => orderMatchesReportRange(o, range), bom),
    [orders, range, bom],
  );
  const consMonth = useMemo(
    () => computeIngredientConsumption(orders, (o) => inMacauMonth(o, monthKey), bom),
    [orders, monthKey, bom],
  );

  const storeName = loadBootstrapCache()?.storeName ?? "本店";
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
  const [backfillSeq, setBackfillSeq] = useState(0);

  // DevTools debug panel state：用嚟喺瀏覽器直接觀察報表載入流程。
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugInfo, setDebugInfo] = useState<{
    status: "idle" | "loading" | "success" | "error";
    merchantId: string;
    fetchedCount: number;
    localCount: number;
    finalCount: number;
    lastUrl: string;
    lastHttpStatus: number | null;
    lastPayloadOk?: boolean;
    lastError: string | null;
    durationMs: number | null;
    statusBreakdown: Record<string, number>;
    matchedToday: number;
    countedStatus: number;
    sampleDates: string[];
  }>({
    status: "idle",
    merchantId,
    fetchedCount: 0,
    localCount: 0,
    finalCount: 0,
    lastUrl: "",
    lastHttpStatus: null,
    lastError: null,
    durationMs: null,
    statusBreakdown: {},
    matchedToday: 0,
    countedStatus: 0,
    sampleDates: [],
  });

  useEffect(() => {
    let cancelled = false;
    async function backfillOrders() {
      setDebugInfo((prev) => ({
        ...prev,
        status: "loading",
        merchantId,
        lastError: null,
        durationMs: null,
        statusBreakdown: {},
        matchedToday: 0,
        countedStatus: 0,
        sampleDates: [],
      }));
      const start = performance.now();

      // 分頁拉全量訂單（今天/7天/30天/全部都用同一份全集，再喺前端按範圍過濾）。
      // PAGE=1000、MAX_PAGES=10 → 上限 10000 單，覆蓋絕大多數餐廳幾個月嘅歷史；
      // 每頁加 ordersOnly=1 跳過 queue/printJobs/deviceConfig，只拉 pos_orders。
      const PAGE = 1000;
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
          const url = merchantId
            ? `/api/pos/state?storeId=${encodeURIComponent(merchantId)}&limit=${PAGE}&offset=${offset}&ordersOnly=1`
            : `/api/pos/state?limit=${PAGE}&offset=${offset}&ordersOnly=1`;
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
      const localOrders = loadOrders();

      // 雲端有單 → 以雲端為唯一可信源。
      // 雲端空 + 失敗 → fallback 本機 orders（離線模式仍可用）。
      // 雲端空 + 成功 → 該店確實冇單，顯示空狀態（**唔可以用本機 orders 覆蓋**——可能係舊 store 殘留）。
      let final: PosOrder[];
      if (fetched.length > 0) {
        final = fetched.filter((o) => !deletedIds.has(o.id));
      } else if (cloudFailed) {
        final = localOrders.filter((o) => !deletedIds.has(o.id));
      } else {
        final = [];
      }
      setOrders(final);

      // 診斷用：拆解訂單狀態同日期分佈
      const statusBreakdown: Record<string, number> = {};
      for (const o of final) {
        statusBreakdown[o.status] = (statusBreakdown[o.status] ?? 0) + 1;
      }
      const counted = final.filter(
        (o) => o.status === "settled" || o.status === "partially_refunded" || o.status === "refunded",
      );
      const matchedToday = counted.filter((o) => orderMatchesReportRange(o, "today")).length;
      const sampleDates = final.slice(0, 5).map((o) => `${o.status} | ${o.createdAt} | total=${o.total}`);

      setDebugInfo({
        status: cloudFailed && fetched.length === 0 ? "error" : "success",
        merchantId,
        fetchedCount: fetched.length,
        localCount: localOrders.length,
        finalCount: final.length,
        lastUrl,
        lastHttpStatus,
        lastPayloadOk,
        lastError,
        durationMs: Math.round(performance.now() - start),
        statusBreakdown,
        matchedToday,
        countedStatus: counted.length,
        sampleDates,
      });
    }
    void backfillOrders();
    return () => {
      cancelled = true;
    };
  }, [merchantId, backfillSeq]);

  // 訂閱 authSession 變更：切換帳號時重置 orders 並強制重跑 backfill。
  // root cause 修復（2026-09-04）：React 唔會自動訂閱 localStorage，冇呢個 listener
  // 嘅話切換帳號後 React state 仍係舊店嘅 orders。
  useEffect(() => {
    function onAuthChanged() {
      setOrders([]);
      setBackfillSeq((n) => n + 1);
    }
    window.addEventListener("pos-auth-changed", onAuthChanged);
    return () => {
      window.removeEventListener("pos-auth-changed", onAuthChanged);
    };
  }, []);

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
        const invRes = await fetch(`/api/inventory/products?store=${encodeURIComponent(merchantId)}`);
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
      } catch {
        setLowStock(null);
      }

      if (!sel && !d7) setLedgerError("尚未連線 Ledger，會員/線上數據未能讀取（其餘模塊正常）。");
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [range, merchantId]);

  const agg = useMemo(() => aggregate(orders, range), [orders, range]);
  const aggYest = useMemo(() => (range === "today" ? aggregate(orders, "yesterday") : null), [orders, range]);
  const agg7d = useMemo(() => aggregate(orders, "7d"), [orders]);

  /**
   * docs/任務：當日人流改為完全由訂單自動計算，唔再由使用者手動輸入。
   * - 堂食（tableId !== "counter"）→ partySize 加總
   * - 快餐 / 外賣 / 自取（tableId === "counter"）→ 一單 = 1 人
   * 純參考數字，唔影響營業額 / 結帳口徑。
   */
  const footfallTotal = useMemo(() => computeFootfallFromOrders(orders, range), [orders, range]);
  const conversion = footfallTotal > 0 && agg.covers > 0 ? agg.covers / footfallTotal : null;

  // 拆開堂食 / 快餐 兩類人流，方便報表顯示（商家一望就知邊類佔多）。
  const footfallBreakdown = useMemo(() => {
    const terminal = orders.filter(
      (o) => o.status === "settled" || o.status === "partially_refunded" || o.status === "refunded",
    );
    const inRange = terminal.filter((o) => orderMatchesReportRange(o, range));
    let dineIn = 0;
    let counter = 0;
    for (const o of inRange) {
      if (o.tableId === "counter") counter += 1;
      else dineIn += Math.max(1, o.partySize ?? 1);
    }
    return { dineIn, counter };
  }, [orders, range]);

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
    const inRange = orders
      .filter(
        (o) =>
          o.status === "settled" || o.status === "partially_refunded" || o.status === "refunded",
      )
      .filter((o) => orderMatchesReportRange(o, range));
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
  }, [orders]);

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

  const peakHour = agg.byHour.indexOf(Math.max(...agg.byHour));
  const maxHour = Math.max(...agg.byHour, 1);

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
                    <span className="block text-slate-400">匹配今天範圍</span>
                    <span className="font-mono font-medium">{debugInfo.matchedToday}</span>
                  </div>
                  <div className="rounded bg-slate-50 px-2 py-1">
                    <span className="block text-slate-400">範圍鍵</span>
                    <span className="font-mono font-medium">{range}</span>
                  </div>
                </div>
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

            {/* 模塊 1 + 模塊 2：食材消耗（BOM 精確化） */}
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card title="食材消耗（本月）" tag="BOM × 已售份數">
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

              <Card title="食材使用量排行" tag="本月 · 按成本">
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
              <Card title="菜品銷售排行" tag="線上＋線下合併 · 渠道標籤">
                {agg.dishes.length === 0 ? (
                  <Empty />
                ) : (
                  <div className="grid gap-1">
                    {agg.dishes.slice(0, 8).map((d) => {
                      const total = d.offlineQty + d.onlineQty;
                      const ch = d.onlineQty > 0 && d.offlineQty > 0 ? "mix" : d.onlineQty > 0 ? "off" : "in";
                      return (
                        <div key={d.menuItemId} className="flex items-center justify-between border-b border-slate-100 py-2 last:border-0">
                          <div>
                            <div className="text-sm font-semibold text-slate-900">
                              {d.name}
                              <ChannelChip kind={ch} />
                            </div>
                            <div className="mt-0.5 text-xs text-slate-500">
                              線下 {d.offlineQty} · 線上 {d.onlineQty}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-semibold text-slate-900">{total} 份</div>
                            <div className="text-xs text-slate-400">{formatMoney(d.revenue)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>

              <Card title="會員充值 & 會員數" tag="來源：Ledger">
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
              <Card title="沽清菜品" tag="即時">
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

              <Card title="最熱門桌台排行" tag="單數 · 覆蓋人數">
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
              <Card title="尖峰時段（每小時訂單）" tag={`高峰約 ${peakHour}:00`}>
                <div className="grid grid-cols-12 gap-1">
                  {agg.byHour.map((c, h) => (
                    <div
                      key={h}
                      title={`${h}:00 · ${c} 單`}
                      className="flex h-7 items-end justify-center rounded text-[9px] text-white"
                      style={{
                        background: c >= maxHour * 0.7 ? "#ef4444" : c >= maxHour * 0.4 ? "#fb923c" : "#cbd5e1",
                      }}
                    >
                      {c > 0 ? c : ""}
                    </div>
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <Metric label="退菜率" value={`${Math.round(voidRate * 100)}%`} warn={voidRate > 0.03} />
                  <Metric label="折扣佔比" value={`${Math.round(discountRatio * 100)}%`} warn={discountRatio > 0.15} />
                  <Metric label="線上佔比" value={`${Math.round(onlineShare * 100)}%`} />
                </div>
              </Card>

              <Card title="營運指標 · 同環比" tag="vs 7 日均值">
                <div className="grid gap-1">
                  <Row label="營業額（7日均）" value={formatMoney(rev7dAvg)} />
                  <Row label="線上渠道佔比（7日均）" value={`${Math.round(onlineShare7d * 100)}%`} />
                  <Row label="會員充值（7日均）" value={formatMoney(topup7dAvg)} />
                  <Row label="總售出份數" value={`${agg.totalSoldQty} 份`} />
                </div>
              </Card>

              <Card
                title="時長統計（堂食 / 外賣）"
                tag={
                  agg.dineInServing.total.estimated || agg.quickServing.total.estimated ? "含估算" : "實測"
                }
              >
                {agg.dineInServing.total.count === 0 && agg.quickServing.total.count === 0 ? (
                  <Empty />
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="mb-1.5 text-xs font-semibold text-slate-700">堂食時長</div>
                      <div className="grid gap-1.5">
                        <StepRow
                          label="下單 → 送廚"
                          stats={agg.dineInServing.orderToKitchen}
                        />
                        <StepRow
                          label="送廚 → 結帳"
                          stats={agg.dineInServing.kitchenToSettle}
                        />
                        <StepRow
                          label="下單 → 結帳（整體）"
                          stats={agg.dineInServing.total}
                          bold
                        />
                      </div>
                    </div>
                    <div>
                      <div className="mb-1.5 text-xs font-semibold text-slate-700">快餐 / 外賣時長</div>
                      <div className="grid gap-1.5">
                        <StepRow
                          label="下單 → 送廚"
                          stats={agg.quickServing.orderToKitchen}
                        />
                        <StepRow
                          label="送廚 → 出餐"
                          stats={agg.quickServing.kitchenToServed}
                        />
                        <StepRow
                          label="出餐 → 完成"
                          stats={agg.quickServing.servedToSettled}
                        />
                        <StepRow
                          label="下單 → 完成（整體）"
                          stats={agg.quickServing.total}
                          bold
                        />
                      </div>
                    </div>
                  </div>
                )}
                <div className="mt-2 text-[11px] text-slate-400">
                  每步列出平均 / 中位數 / P95，樣本 0 嘅步驟顯示 —；堂食以「送廚 → 結帳」涵蓋製作同服務時間，外賣/快餐以「出餐 → 完成」反映等待取餐/外送嘅時間。
                </div>
              </Card>
            </div>

            {/* 模塊 5 人流 + 低庫存預警 */}
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card title="當日人流（入店人次）" tag="自動計算 · 參考用">
                <div className="flex items-baseline gap-2">
                  <div className="text-3xl font-extrabold text-indigo-600">{footfallTotal}</div>
                  <div className="text-xs text-slate-500">選取範圍累計入店人次</div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <div className="text-slate-400">堂食</div>
                    <div className="mt-0.5 text-sm font-semibold text-slate-900">{footfallBreakdown.dineIn} 人</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                    <div className="text-slate-400">快餐 / 外賣</div>
                    <div className="mt-0.5 text-sm font-semibold text-slate-900">{footfallBreakdown.counter} 單</div>
                  </div>
                </div>
                {conversion != null ? (
                  <div className="mt-2 text-xs text-slate-500">
                    堂食轉化率 {Math.round(conversion * 100)}%（覆蓋 {agg.covers} 人 / 人流 {footfallTotal}）
                  </div>
                ) : null}
                <div className="mt-2 text-[11px] text-slate-400">
                  由訂單自動計算：堂食依 partySize 加總、快餐/外賣一單算一人。純參考用，無門口計數硬件嘅替代方案。
                </div>
              </Card>

              <Card title="低庫存預警" tag="current_qty ≤ par（reorder_level）">
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

function Card({ title, tag, children }: { title: string; tag?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-base font-semibold text-slate-900">{title}</div>
        {tag ? <div className="text-xs text-slate-400">{tag}</div> : null}
      </div>
      {children}
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

/** 顯示一個流程步驟嘅平均 / 中位數 / P95；count = 0 時全部顯示 —。 */
function StepRow({ label, stats, bold }: { label: string; stats: StepStats; bold?: boolean }) {
  const noData = stats.count === 0;
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5 ${
        bold ? "bg-slate-50" : ""
      }`}
    >
      <div className={`min-w-0 truncate text-xs ${bold ? "font-semibold text-slate-800" : "text-slate-600"}`}>
        {label}
      </div>
      <div className="flex shrink-0 items-baseline gap-2 text-[11px]">
        <span className="text-slate-400">avg</span>
        <span className={`w-12 text-right font-semibold ${noData ? "text-slate-300" : "text-slate-900"}`}>
          {noData ? "—" : `${stats.avgMin.toFixed(1)} 分`}
        </span>
        <span className="text-slate-400">med</span>
        <span className={`w-12 text-right font-semibold ${noData ? "text-slate-300" : "text-slate-900"}`}>
          {noData ? "—" : `${stats.medianMin.toFixed(1)}`}
        </span>
        <span className="text-slate-400">P95</span>
        <span
          className={`w-12 text-right font-semibold ${
            noData
              ? "text-slate-300"
              : stats.p95Min > 20
                ? "text-rose-600"
                : "text-slate-900"
          }`}
        >
          {noData ? "—" : `${stats.p95Min.toFixed(1)}`}
        </span>
      </div>
    </div>
  );
}
