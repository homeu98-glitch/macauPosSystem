"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { loadAuthSession } from "@/lib/storage";
import type { PosOrder } from "@/lib/types";

/**
 * Admin panel · 店鋪總覽（view-only，唯一寫操作 = 啟用/停用商家）。
 *
 * - 商家列表 + 每店營業統計：GET /api/admin/merchants（Ledger service-role + POS 聚合）
 * - 啟用 / 停用：PATCH /api/admin/merchants/status（寫 Ledger merchants.status；
 *   suspended 後該店全部賬號無法登入 POS——/api/ledger/login 內置檢查）
 * - 下單明細：GET /api/admin/orders，可按店舖 + 日期區間篩選（只讀）
 */

type MerchantStats = {
  todayOrders: number;
  todayRevenue: number;
  d7Orders: number;
  d7Revenue: number;
  lastOrderAt: string | null;
};

type AdminMerchant = {
  id: string;
  name: string;
  status: string;
  stats: MerchantStats;
};

function fmtMop(n: number): string {
  return `MOP ${n.toLocaleString("zh-Hant", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Macau",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

function macauDateInput(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Macau" }).format(d);
}

const ORDER_STATUSES = ["pending", "confirmed", "sent_to_kitchen", "ready", "served", "settled", "paid", "cancelled", "refunded", "partially_refunded"];

function statusBadge(status: string) {
  if (status === "active") {
    return <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">營業中</span>;
  }
  if (status === "suspended") {
    return <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">已停用</span>;
  }
  return <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">未知</span>;
}

function orderStatusBadge(status: string) {
  const map: Record<string, string> = {
    settled: "bg-green-100 text-green-700",
    paid: "bg-green-100 text-green-700",
    cancelled: "bg-red-100 text-red-700",
    refunded: "bg-amber-100 text-amber-700",
    partially_refunded: "bg-amber-100 text-amber-700",
  };
  const cls = map[status] ?? "bg-slate-100 text-slate-600";
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>;
}

export default function AdminDashboardPage() {
  const router = useRouter();
  const [merchants, setMerchants] = useState<AdminMerchant[]>([]);
  const [ledgerConfigured, setLedgerConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyMerchantId, setBusyMerchantId] = useState<string | null>(null);

  // 商家列表分頁（2026-09-06 修）：固定 30 筆/頁，避開超長列表溢出螢幕
  const MERCHANTS_PAGE_SIZE = 30;
  const [merchantPage, setMerchantPage] = useState(1);
  // 搜尋關鍵字（即時過濾商家名稱）
  const [merchantSearch, setMerchantSearch] = useState("");
  // 跳轉營業報表時嘅 hover highlight merchantId（純視覺反饋，唔影響邏輯）
  const [hoveredMerchantId, setHoveredMerchantId] = useState<string | null>(null);

  // 下單明細篩選
  const [filterStore, setFilterStore] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState<string>(() => macauDateInput(new Date()));
  const [dateTo, setDateTo] = useState<string>(() => macauDateInput(new Date()));
  const [orders, setOrders] = useState<PosOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const loadMerchants = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = loadAuthSession()?.adminSessionToken;
      if (!token) {
        setError("未授權，請先登入。");
        return;
      }
      const res = await fetch("/api/admin/merchants", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as { ok?: boolean; merchants?: AdminMerchant[]; ledgerConfigured?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? `載入失敗（HTTP ${res.status}）`);
        return;
      }
      setMerchants(json.merchants ?? []);
      setLedgerConfigured(json.ledgerConfigured !== false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMerchants();
  }, [loadMerchants]);

  async function toggleMerchant(m: AdminMerchant, e: React.MouseEvent) {
    // 問題 3（2026-09-06 修）：啟用/停用按鈕點擊時要 stopPropagation，避免冒泡到
    // <tr> 嘅「點擊跳轉營業報表」handler。
    e.stopPropagation();
    const next = m.status === "suspended" ? "active" : "suspended";
    const verb = next === "suspended" ? "停用" : "啟用";
    if (!window.confirm(`確定要${verb}「${m.name}」嗎？\n\n${next === "suspended" ? "停用後該店全部賬號將無法登入 POS。" : "啟用後該店賬號可正常登入 POS。"}`)) {
      return;
    }
    setBusyMerchantId(m.id);
    try {
      const token = loadAuthSession()?.adminSessionToken;
      const res = await fetch("/api/admin/merchants/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token ?? ""}` },
        body: JSON.stringify({ merchantId: m.id, status: next }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        window.alert(json.error ?? `操作失敗（HTTP ${res.status}）`);
        return;
      }
      await loadMerchants();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMerchantId(null);
    }
  }

  // 問題 3（2026-09-06 修）：點擊商家列表某一行 → 直接跳轉該店嘅營業報表。
  // 沿用 admin/reports 嘅 ?merchantId= URL 約定（避免 prop drilling）。
  function goToMerchantReport(merchantId: string) {
    router.push(`/admin/reports?merchantId=${encodeURIComponent(merchantId)}`);
  }

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersError(null);
    try {
      const token = loadAuthSession()?.adminSessionToken;
      if (!token) {
        setOrdersError("未授權，請先登入。");
        return;
      }
      const params = new URLSearchParams({ limit: "500" });
      if (filterStore !== "all") params.set("storeId", filterStore);
      if (dateFrom) params.set("start", `${dateFrom}T00:00:00+08:00`);
      if (dateTo) params.set("end", `${dateTo}T23:59:59+08:00`);
      const res = await fetch(`/api/admin/orders?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = (await res.json()) as { ok?: boolean; orders?: PosOrder[]; error?: string };
      if (!res.ok || !json.ok) {
        setOrdersError(json.error ?? `載入失敗（HTTP ${res.status}）`);
        setOrders([]);
        return;
      }
      setOrders(json.orders ?? []);
    } catch (err) {
      setOrdersError(err instanceof Error ? err.message : String(err));
    } finally {
      setOrdersLoading(false);
    }
  }, [dateFrom, dateTo, filterStore]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  const totals = useMemo(() => {
    return merchants.reduce(
      (acc, m) => ({
        todayOrders: acc.todayOrders + m.stats.todayOrders,
        todayRevenue: acc.todayRevenue + m.stats.todayRevenue,
        d7Orders: acc.d7Orders + m.stats.d7Orders,
        d7Revenue: acc.d7Revenue + m.stats.d7Revenue,
        active: acc.active + (m.status === "active" ? 1 : 0),
      }),
      { todayOrders: 0, todayRevenue: 0, d7Orders: 0, d7Revenue: 0, active: 0 },
    );
  }, [merchants]);

  const storeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of merchants) map.set(m.id, m.name);
    return map;
  }, [merchants]);

  // 問題 2 + 7（2026-09-06 修）：商家列表分頁 + 名稱即時搜尋。
  // - filteredMerchants：按搜尋關鍵字過濾（不區分大小寫、支援中英）。
  // - paginatedMerchants：當前頁（MERCHANTS_PAGE_SIZE 筆）嘅子集。
  // - totalMerchantPages：總頁數（搜尋結果為空時 = 0）。
  // 商家變動／搜尋變動時自動重置 page=1，避免分頁錯位指向空白頁。
  const filteredMerchants = useMemo(() => {
    const q = merchantSearch.trim().toLowerCase();
    if (!q) return merchants;
    return merchants.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [merchants, merchantSearch]);

  useEffect(() => {
    setMerchantPage(1);
  }, [merchantSearch, merchants.length]);

  const totalMerchantPages = Math.max(
    1,
    Math.ceil(filteredMerchants.length / MERCHANTS_PAGE_SIZE),
  );
  const safeMerchantPage = Math.min(Math.max(merchantPage, 1), totalMerchantPages);
  const paginatedMerchants = useMemo(() => {
    const start = (safeMerchantPage - 1) * MERCHANTS_PAGE_SIZE;
    return filteredMerchants.slice(start, start + MERCHANTS_PAGE_SIZE);
  }, [filteredMerchants, safeMerchantPage]);

  return (
    <AdminShell>
      <div className="space-y-6">
        {!ledgerConfigured && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            未配置 <code>LEDGER_SERVICE_ROLE_KEY</code>：商家列表只顯示 POS DB 有單嘅店（以 merchant ID 顯示），啟用/停用功能不可用。
          </div>
        )}

        {/* KPI */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            { label: "商家總數", value: String(merchants.length) },
            { label: "營業中", value: String(totals.active) },
            { label: "今日總營業額", value: fmtMop(totals.todayRevenue) },
            { label: "今日總單數", value: String(totals.todayOrders) },
            { label: "7 日總營業額", value: fmtMop(totals.d7Revenue) },
          ].map((kpi) => (
            <div key={kpi.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-xs text-slate-500">{kpi.label}</p>
              <p className="mt-1 text-lg font-semibold text-slate-900">{kpi.value}</p>
            </div>
          ))}
        </div>

        {/* 商家列表 */}
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
            <h2 className="mr-auto text-sm font-semibold text-slate-900">商家列表</h2>
            {/* 問題 7（2026-09-06 修）：商家名稱即時搜尋，例如輸入「表」即時顯示「表嫂美食」 */}
            <label className="flex items-center gap-1 text-xs text-slate-500">
              <span className="hidden sm:inline">搜尋</span>
              <input
                type="search"
                value={merchantSearch}
                onChange={(e) => setMerchantSearch(e.target.value)}
                placeholder="商家名稱 / ID…"
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900 outline-none focus:border-blue-500"
              />
            </label>
            <button
              type="button"
              onClick={() => void loadMerchants()}
              className="rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
            >
              重新載入
            </button>
          </div>
          {error && <p className="px-4 py-3 text-sm text-red-600">{error}</p>}
          {loading ? (
            <p className="px-4 py-6 text-sm text-slate-500">載入中…</p>
          ) : merchants.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">尚無商家資料。</p>
          ) : filteredMerchants.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">搜尋「{merchantSearch}」沒有匹配商家。</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="px-4 py-2 font-medium">商家</th>
                      <th className="px-4 py-2 font-medium">狀態</th>
                      <th className="px-4 py-2 text-right font-medium">今日單數</th>
                      <th className="px-4 py-2 text-right font-medium">今日營業額</th>
                      <th className="px-4 py-2 text-right font-medium">7日單數</th>
                      <th className="px-4 py-2 text-right font-medium">7日營業額</th>
                      <th className="px-4 py-2 font-medium">最近落單</th>
                      <th className="px-4 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedMerchants.map((m) => {
                      const isHover = hoveredMerchantId === m.id;
                      return (
                        <tr
                          key={m.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => goToMerchantReport(m.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              goToMerchantReport(m.id);
                            }
                          }}
                          onMouseEnter={() => setHoveredMerchantId(m.id)}
                          onMouseLeave={() => setHoveredMerchantId((prev) => (prev === m.id ? null : prev))}
                          title="點擊查看「營業報表」"
                          className={`cursor-pointer border-b border-slate-100 transition-colors last:border-0 hover:bg-blue-50/60 focus:bg-blue-50/60 focus:outline-none ${
                            isHover ? "bg-blue-50/60" : ""
                          }`}
                        >
                          <td className="px-4 py-2.5 font-medium text-slate-900">{m.name}</td>
                          <td className="px-4 py-2.5">{statusBadge(m.status)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{m.stats.todayOrders}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtMop(m.stats.todayRevenue)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{m.stats.d7Orders}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{fmtMop(m.stats.d7Revenue)}</td>
                          <td className="px-4 py-2.5 text-slate-600">{fmtTime(m.stats.lastOrderAt)}</td>
                          <td className="px-4 py-2.5 text-right">
                            {m.status === "active" || m.status === "suspended" ? (
                              <button
                                type="button"
                                disabled={busyMerchantId === m.id}
                                onClick={(e) => void toggleMerchant(m, e)}
                                className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                                  m.status === "active"
                                    ? "border border-red-200 text-red-600 hover:bg-red-50"
                                    : "border border-green-200 text-green-700 hover:bg-green-50"
                                }`}
                              >
                                {busyMerchantId === m.id ? "處理中…" : m.status === "active" ? "停用" : "啟用"}
                              </button>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* 問題 2（2026-09-06 修）：商家列表分頁控制（固定 30 筆/頁）。
                  顯示「總筆數 / 當前頁 / 總頁數」 + 上一頁/下一頁按鈕，避免長列表溢出。 */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-2 text-xs text-slate-500">
                <span>
                  共 <span className="font-semibold text-slate-700">{filteredMerchants.length}</span> 筆商家
                  {filteredMerchants.length !== merchants.length ? (
                    <span className="ml-1 text-slate-400">（已從 {merchants.length} 筆中過濾）</span>
                  ) : null}
                  · 第 <span className="font-semibold text-slate-700">{safeMerchantPage}</span> / {totalMerchantPages} 頁
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={safeMerchantPage <= 1}
                    onClick={() => setMerchantPage((p) => Math.max(1, p - 1))}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ‹ 上一頁
                  </button>
                  <button
                    type="button"
                    disabled={safeMerchantPage >= totalMerchantPages}
                    onClick={() => setMerchantPage((p) => Math.min(totalMerchantPages, p + 1))}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    下一頁 ›
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        {/* 下單明細 */}
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 px-4 py-3">
            <h2 className="mr-auto text-sm font-semibold text-slate-900">下單明細</h2>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              店舖
              <select
                value={filterStore}
                onChange={(e) => setFilterStore(e.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
              >
                <option value="all">全部</option>
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              由
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              至
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
              />
            </label>
            <button
              type="button"
              onClick={() => void loadOrders()}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              查詢
            </button>
          </div>
          {ordersError && <p className="px-4 py-3 text-sm text-red-600">{ordersError}</p>}
          {ordersLoading ? (
            <p className="px-4 py-6 text-sm text-slate-500">載入中…</p>
          ) : orders.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">篩選條件內沒有訂單。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                    <th className="px-4 py-2 font-medium">時間</th>
                    <th className="px-4 py-2 font-medium">店舖</th>
                    <th className="px-4 py-2 font-medium">單號</th>
                    <th className="px-4 py-2 font-medium">狀態</th>
                    <th className="px-4 py-2 font-medium">來源</th>
                    <th className="px-4 py-2 text-right font-medium">金額</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.slice(0, 200).map((o) => (
                    <tr key={o.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-2 tabular-nums text-slate-600">{fmtTime(o.createdAt)}</td>
                      <td className="px-4 py-2 text-slate-900">{storeNameById.get(o.storeId ?? "") ?? o.storeId ?? "—"}</td>
                      <td className="px-4 py-2 font-mono text-xs text-slate-600">{o.localOrderNo ?? o.id.slice(0, 8)}</td>
                      <td className="px-4 py-2">{orderStatusBadge(o.status)}</td>
                      <td className="px-4 py-2 text-xs text-slate-600">{o.source ?? "pos"}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtMop(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {orders.length > 200 && (
                <p className="px-4 py-2 text-xs text-slate-500">只顯示最近 200 張（共 {orders.length} 張），請縮小日期範圍查看更多。</p>
              )}
            </div>
          )}
        </section>

        <p className="text-xs text-slate-400">
          狀態口徑：{ORDER_STATUSES.join(" / ")}。銷售統計只計 settled / paid（同單店報表一致），退款與取消不計入營業額。
        </p>
      </div>
    </AdminShell>
  );
}
