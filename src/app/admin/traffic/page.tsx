"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminShell } from "@/components/admin-shell";
import { loadAuthSession } from "@/lib/storage";
import {
  EGRESS_FREE_QUOTA_BYTES,
  formatBytes,
  quotaLevel,
  summarizeEgressUsage,
  type EgressUsageRow,
} from "@/lib/pos/egress-usage";

/**
 * Admin panel · 雲端用量（2026-09-22，migration 0048）。
 *
 * ## 為何要有呢一頁
 *
 * Supabase Dashboard 只會俾**專案總數**，但一個專案裡面有**多間店**
 * （`pos_*` 全部按 `store_id` 隔離）。2026-09-22 商家問「加多一兩間店會唔會爆
 * 5 GB 免費額」，Dashboard 答唔到 —— 結果要人手拉 Supabase ＋ Vercel log 反推，
 * 最後發現 **92% 流量來自一部跑舊 bundle 嘅分頁**（690 MB/小時）。
 *
 * 呢一頁將件事變成**一眼睇得到**：邊間店、邊一日、邊條路徑食流量，距離爆額有幾遠。
 *
 * ## 資料來源同計量口徑（一定要講清楚，唔可以誤導）
 *
 * · 資料：`GET /api/admin/traffic?days=N`（`pos_egress_daily`，由 server route
 *   `jsonWithEgressLog()` 順手記帳，見 `@/lib/pos/egress-meter-server`）。
 * · 量到嘅係「**Vercel Function → 瀏覽器／APK**」嘅 response bytes。
 *   Supabase 帳單官方口徑係「**Supabase → Vercel Function**」——方向相反、數量級一致。
 *   ⇒ 用嚟做**店與店／路徑與路徑嘅相對比較同趨勢**足夠；**精確對帳單請睇 Supabase Dashboard**。
 * · 現時已計量嘅路徑：`pos/state`（最大）、`pos/print-jobs/status`。
 *   其餘路徑（bootstrap／shift／templates／sync…）單次細，未接入計量
 *   ⇒ 呢頁係**主要來源**而唔係全量總數。
 * · 匯總邏輯一律用 `@/lib/pos/egress-usage`（純函式，14 條單測），
 *   API 只回原始 row ⇒ 兩邊口徑唔會漂移。
 */

interface ApiStore {
  id: string;
  name: string;
}

interface ApiResponse {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  error?: string;
  days?: number;
  today?: string;
  windowDays?: string[];
  quotaBytes?: number;
  rows?: EgressUsageRow[];
  stores?: ApiStore[];
}

const RANGE_OPTIONS = [
  { days: 7, label: "7 日" },
  { days: 14, label: "14 日" },
  { days: 30, label: "30 日" },
  { days: 90, label: "90 日" },
];

export default function AdminTrafficPage() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (rangeDays: number) => {
    setLoading(true);
    setError(null);
    try {
      // 🔴 admin API 用 `Authorization: Bearer <adminSessionToken>`（同 `/api/admin/sessions`
      // 完全一樣嘅鑑權）。冇帶 ⇒ server 回 401 ⇒ 頁面只會見到「未授權」而 KPI 全部 0
      // （2026-09-22 首次上線就係漏咗呢個 header）。
      const token = loadAuthSession()?.adminSessionToken;
      if (!token) {
        setError("未授權，請重新登入管理後台。");
        setData(null);
        return;
      }
      const res = await fetch(`/api/admin/traffic?days=${rangeDays}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) {
        setError(res.status === 401 ? "未授權，請重新登入管理後台。" : `讀取失敗（HTTP ${res.status}）。`);
        setData(null);
        return;
      }
      setData((await res.json()) as ApiResponse);
    } catch {
      setError("網絡錯誤，請稍後再試。");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const storeNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of data?.stores ?? []) map.set(s.id, s.name);
    return map;
  }, [data]);

  const summary = useMemo(
    () => summarizeEgressUsage(data?.rows ?? [], Date.now(), days, EGRESS_FREE_QUOTA_BYTES),
    [data, days],
  );

  const available = data?.available !== false;
  const maxDaily = useMemo(
    () =>
      summary.stores.reduce(
        (max, s) => s.daily.reduce((m, d) => Math.max(m, d.bytes), max),
        0,
      ),
    [summary],
  );

  const quotaRatioPct = (summary.totals.quotaRatio * 100).toFixed(1);

  /** 用量越接近配額越要留意（同 KPI 卡一致嘅顏色語義）。 */
  function toneOf(bytes: number): { text: string; sub: string } {
    const level = quotaLevel(bytes, EGRESS_FREE_QUOTA_BYTES);
    if (level === "danger") return { text: "text-red-600", sub: "text-red-500" };
    if (level === "warn") return { text: "text-amber-600", sub: "text-amber-500" };
    return { text: "text-slate-900", sub: "text-slate-400" };
  }

  return (
    <AdminShell>
      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">雲端用量</h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              每一家店各自嘅雲端流量（按澳門日期）。用嚟回答「邊間店食咗幾多」、
              「加多一兩間店會唔會爆免費額」。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.days}
                type="button"
                onClick={() => setDays(option.days)}
                className={`min-h-[36px] rounded-lg border px-3 text-xs ${
                  days === option.days
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {option.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void load(days)}
              className="min-h-[36px] rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50"
            >
              重新載入
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {!available ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
            <p className="font-medium">用量計量尚未啟用</p>
            <p className="mt-1 text-xs">
              {data?.reason ?? "需要喺 Supabase SQL Editor 跑 migration 0048（pos_egress_daily）。"}
            </p>
            <p className="mt-1 text-xs text-amber-800">
              未跑之前，所有 POS 功能**完全不受影響**（計量係純附加、失敗會自動停用）。
            </p>
          </div>
        ) : null}

        {/* KPI：固定 5 格（沿既有 KPI 帶規則，唔另開第 6 張卡） */}
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {[
            {
              label: "本月總用量",
              value: formatBytes(summary.totals.monthBytes),
              sub: `免費額 5 GB 嘅 ${quotaRatioPct}%`,
              tone: toneOf(summary.totals.monthBytes).text,
              subTone: toneOf(summary.totals.monthBytes).sub,
            },
            {
              label: "今日用量",
              value: formatBytes(summary.totals.todayBytes),
              sub: `澳門 ${data?.today ?? "-"}`,
              tone: "text-slate-900",
              subTone: "text-slate-400",
            },
            {
              label: "有用量嘅店",
              value: `${summary.totals.storeCount}`,
              sub: `最近 ${days} 日窗口`,
              tone: "text-slate-900",
              subTone: "text-slate-400",
            },
            {
              label: "推算全月",
              value: formatBytes(
                summary.stores.reduce((sum, s) => sum + s.projectedMonthBytes, 0),
              ),
              sub: "按本月至今日均推算",
              tone: toneOf(
                summary.stores.reduce((sum, s) => sum + s.projectedMonthBytes, 0),
              ).text,
              subTone: toneOf(
                summary.stores.reduce((sum, s) => sum + s.projectedMonthBytes, 0),
              ).sub,
            },
            {
              label: "仲可容納",
              value: `${summary.totals.affordableStores} 間店`,
              sub: "按現時單店用量推算",
              tone: "text-slate-900",
              subTone: "text-slate-400",
            },
          ].map((kpi) => (
            <div key={kpi.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-xs text-slate-500">{kpi.label}</p>
              <p className={`mt-1 text-lg font-semibold tabular-nums ${kpi.tone}`}>{kpi.value}</p>
              <p className={`mt-1 text-[11px] ${kpi.subTone}`}>{kpi.sub}</p>
            </div>
          ))}
        </div>

        {loading ? (
          <p className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500">
            載入中…
          </p>
        ) : summary.stores.length === 0 ? (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white px-6 py-8 text-center">
            <p className="text-sm text-slate-600">最近 {days} 日未有用量紀錄。</p>
            <p className="mt-1 text-xs text-slate-400">
              {available
                ? "若果店舖正在營業但仍然冇紀錄，可能係 migration 0048 未跑（計量會自動停用）。"
                : "跑完 migration 0048 之後，用量會由下一個請求開始累積。"}
            </p>
          </div>
        ) : (
          <section className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="grid grid-cols-[minmax(0,1.4fr)_110px_110px_150px_150px_minmax(0,1.2fr)] items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-500">
              <span>店舖</span>
              <span className="text-right">今日</span>
              <span className="text-right">本月</span>
              <span className="text-right">佔免費額</span>
              <span>最近走勢</span>
              <span>頭幾條路徑（本月）</span>
            </div>
            {summary.stores.map((store) => {
              const tone = toneOf(store.monthBytes);
              const level = quotaLevel(store.monthBytes, EGRESS_FREE_QUOTA_BYTES);
              return (
                <div
                  key={store.storeId}
                  className="grid grid-cols-[minmax(0,1.4fr)_110px_110px_150px_150px_minmax(0,1.2fr)] items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {storeNames.get(store.storeId) ?? "（未知店名）"}
                    </p>
                    <p className="truncate text-[11px] text-slate-400">{store.storeId}</p>
                  </div>
                  <p className="text-right text-sm tabular-nums text-slate-700">
                    {formatBytes(store.todayBytes)}
                  </p>
                  <p className={`text-right text-sm font-semibold tabular-nums ${tone.text}`}>
                    {formatBytes(store.monthBytes)}
                  </p>
                  <div className="text-right">
                    <p className={`text-sm tabular-nums ${tone.text}`}>
                      {(store.quotaRatio * 100).toFixed(1)}%
                    </p>
                    <p className={`text-[11px] ${tone.sub}`}>
                      {level === "danger" ? "接近／超出配額" : level === "warn" ? "留意" : "正常"}
                    </p>
                  </div>
                  <div>
                    <div className="flex h-6 items-end gap-[2px]">
                      {store.daily.map((d) => {
                        const h =
                          maxDaily > 0 ? Math.max(2, Math.round((d.bytes / maxDaily) * 24)) : 2;
                        return (
                          <span
                            key={d.day}
                            title={`${d.day}：${formatBytes(d.bytes)}`}
                            style={{ height: `${h}px`, width: "5px" }}
                            className={`inline-block rounded-sm ${
                              d.bytes > 0 ? "bg-blue-400" : "bg-slate-200"
                            }`}
                          />
                        );
                      })}
                    </div>
                    <p className="mt-0.5 text-[10px] text-slate-400">
                      {store.daily[0]?.day.slice(5)} → {store.daily[store.daily.length - 1]?.day.slice(5)}
                    </p>
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    {store.topRoutes.length === 0 ? (
                      <p className="text-[11px] text-slate-400">本月無紀錄</p>
                    ) : (
                      store.topRoutes.slice(0, 3).map((route) => (
                        <div key={route.route} className="flex items-center justify-between gap-2">
                          <span className="truncate text-[11px] text-slate-600">{route.route}</span>
                          <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
                            {formatBytes(route.bytes)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        )}

        <div className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-[11px] leading-relaxed text-slate-500">
          <p className="font-medium text-slate-600">計量口徑（唔可以當帳單數字）</p>
          <p className="mt-1">
            · 呢度量到嘅係「Vercel Function → 瀏覽器／APK」嘅 response bytes；Supabase 帳單
            官方口徑係「Supabase → Vercel Function」。方向相反、數量級一致 ⇒
            <strong> 適合做店與店／路徑與路徑嘅比較同趨勢</strong>，精確對帳單請睇 Supabase Dashboard。
          </p>
          <p className="mt-1">
            · 現時已計量：<code className="rounded bg-slate-100 px-1">pos/state</code>、
            <code className="rounded bg-slate-100 px-1">pos/print-jobs/status</code>（兩者佔歷史觀測絕大部分）。
            「免費額 5 GB」係**專案總額**，唔係每店配額 ⇒「仲可容納幾間店」係按現時單店用量推算嘅參考值。
          </p>
          <p className="mt-1">
            · 計量係**純附加**：寫入失敗（例如 migration 未跑）會自動停用，唔會影響落單／出紙／讀取。
          </p>
        </div>
      </div>
    </AdminShell>
  );
}
