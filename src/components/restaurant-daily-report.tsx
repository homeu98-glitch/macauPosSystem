"use client";

import { useEffect, useMemo, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import {
  getMerchantMemberSummary,
  getMerchantReportSummary,
  type LedgerMemberSummary,
  type LedgerReportSummary,
} from "@/lib/ledger/reports";
import { restoreLedgerSession } from "@/lib/ledger/session";
import { fetchPurchaseSummary, type PurchaseSummary } from "@/lib/inventory-stats";
import {
  loadAuthSession,
  loadBootstrapCache,
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
  footfallFocusKey,
  footfallTotalInRange,
  loadFootfallAll,
  saveFootfallDay,
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
  /** true = 部分樣本缺 servedAt，用落單→結帳估算 */
  estimated: boolean;
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
  serving: ServingStats;
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
  for (const o of inRange) {
    const sm = servingMinutes(o);
    if (sm) {
      servingSamples.push(sm.ms);
      if (sm.estimated) servingEstimated = true;
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
  const [member, setMember] = useState<LedgerMemberSummary | null>(null);
  const [lowStock, setLowStock] = useState<
    Array<{ name: string; qty: number; unit: string; par: number }> | null
  >(null);
  const [footfallMap, setFootfallMap] = useState<Record<string, number>>(() => loadFootfallAll());
  const [footfallInput, setFootfallInput] = useState<number>(
    () => footfallMap[footfallFocusKey(range)] ?? 0,
  );
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
    async function safeMember(r: ReportRangeKey): Promise<LedgerMemberSummary | null> {
      try {
        const restored = await restoreLedgerSession();
        if (!restored) return null;
        return await getMerchantMemberSummary(r);
      } catch {
        return null;
      }
    }
    async function load() {
      setLoading(true);
      setLedgerError(null);
      const [sel, d7, yest, mem] = await Promise.all([
        safeLedger(range),
        safeLedger("7d"),
        range === "today" ? safeLedger("yesterday") : Promise.resolve(null),
        safeMember(range),
      ]);

      const acc = loadAuthSession()?.account;
      const [purSel, purYest] = await Promise.all([
        acc ? fetchPurchaseSummary(acc, range) : Promise.resolve(null),
        range === "today" && acc ? fetchPurchaseSummary(acc, "yesterday") : Promise.resolve(null),
      ]);

      if (cancelled) return;
      setLedger({ sel, d7, yest });
      setMember(mem);
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

  // 範圍切換時，將人流輸入框同步到該範圍嘅焦點日（昨天範圍＝記昨天，否則今天）。
  useEffect(() => {
    setFootfallInput(loadFootfallAll()[footfallFocusKey(range)] ?? 0);
  }, [range]);

  const agg = useMemo(() => aggregate(orders, range), [orders, range]);
  const aggYest = useMemo(() => (range === "today" ? aggregate(orders, "yesterday") : null), [orders, range]);
  const agg7d = useMemo(() => aggregate(orders, "7d"), [orders]);

  const focusKey = footfallFocusKey(range);
  const footfallTotal = footfallTotalInRange(footfallMap, range);
  const conversion = footfallTotal > 0 && agg.covers > 0 ? agg.covers / footfallTotal : null;

  function saveFootfall() {
    setFootfallMap(saveFootfallDay(focusKey, footfallInput));
  }

  const grossProfit = useMemo(() => {
    const cogs = purchase.sel?.paid ?? 0;
    return agg.revenue - cogs;
  }, [agg.revenue, purchase.sel]);

  const grossProfitYest = useMemo(() => {
    if (!aggYest) return null;
    const cogs = purchase.yest?.paid ?? 0;
    return aggYest.revenue - cogs;
  }, [aggYest, purchase.yest]);

  const avgTicket = agg.count > 0 ? agg.revenue / agg.count : 0;
  const avgTicketYest = aggYest && aggYest.count > 0 ? aggYest.revenue / aggYest.count : 0;

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

            {/* 核心 KPI 帶 */}
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Kpi label="營業額" value={formatMoney(agg.revenue)} highlight delta={pct(agg.revenue, aggYest?.revenue ?? null)} />
              <Kpi
                label="毛利（估）"
                value={formatMoney(grossProfit)}
                highlight
                delta={grossProfitYest === null ? null : pct(grossProfit, grossProfitYest)}
              />
              <Kpi label="訂單數" value={String(agg.count)} delta={pct(agg.count, aggYest?.count ?? null)} />
              <Kpi label="客單價" value={formatMoney(avgTicket)} delta={pct(avgTicket, avgTicketYest)} />
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
                  {member?.memberCount != null ? (
                    <Pill kind="amber">會員數 {member.memberCount}</Pill>
                  ) : (
                    <Pill kind="amber">會員數 —（待接 RPC）</Pill>
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

              <Card title="出餐時間" tag={agg.serving.estimated ? "含估算" : "實測"}>
                {agg.serving.count === 0 ? (
                  <Empty />
                ) : (
                  <div className="grid gap-2">
                    <div className="grid grid-cols-3 gap-2 text-center">
                      <Metric label="平均" value={`${agg.serving.avgMin.toFixed(1)} 分`} />
                      <Metric label="中位數" value={`${agg.serving.medianMin.toFixed(1)} 分`} />
                      <Metric label="P95" value={`${agg.serving.p95Min.toFixed(1)} 分`} warn={agg.serving.p95Min > 15} />
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      樣本 {agg.serving.count} 單
                      {agg.serving.estimated
                        ? "（部分舊單缺時間戳，以落單→結帳估算）"
                        : "（送廚房→出餐實測）"}
                    </div>
                  </div>
                )}
              </Card>
            </div>

            {/* 模塊 5 人流 + 低庫存預警 */}
            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card title="當日人流（入店人次）" tag="手動記錄 · 轉化率">
                <div className="flex items-baseline gap-2">
                  <div className="text-3xl font-extrabold text-indigo-600">{footfallTotal}</div>
                  <div className="text-xs text-slate-500">選取範圍累計入店人次</div>
                </div>
                {conversion != null ? (
                  <div className="mt-1 text-xs text-slate-500">
                    堂食轉化率 {Math.round(conversion * 100)}%（覆蓋 {agg.covers} 人 / 人流 {footfallTotal}）
                  </div>
                ) : null}
                <div className="mt-3 flex items-end gap-2">
                  <div>
                    <div className="text-[11px] text-slate-400">{focusKey} 入店人次</div>
                    <input
                      type="number"
                      value={footfallInput}
                      onChange={(e) => setFootfallInput(Number(e.target.value) || 0)}
                      className="mt-1 w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                    />
                  </div>
                  <button
                    className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
                    onClick={saveFootfall}
                    type="button"
                  >
                    儲存
                  </button>
                </div>
                <div className="mt-2 text-[11px] text-slate-400">
                  無門口計數硬件，由店員/老闆於收銀端記低每日人流；轉化率＝覆蓋人數 ÷ 入店人次。
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
              人流（入店人次）為收銀端手動記錄（無門口計數硬件），轉化率＝覆蓋人數 ÷ 入店人次。出餐時間為「送廚房→出餐」實測（舊單缺時間戳時自動以落單→結帳估算，標「含估算」）；食材消耗依 BOM 配方 × 已售份數計算（於「配方管理」填寫後方精確）。
              毛利為「營業額 − 買貨成本（已付）」估算；會員數待 Ledger 部署 get_merchant_member_summary RPC 後自動顯示。
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
}: {
  label: string;
  value: string;
  highlight?: boolean;
  delta: { arrow: string; cls: string } | null;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${highlight ? "text-orange-600" : "text-slate-900"}`}>{value}</div>
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
