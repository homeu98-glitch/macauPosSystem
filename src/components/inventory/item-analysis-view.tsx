"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  collectAnalysisFilterOptions,
  filterItemAnalysisRows,
  formatAnalysisQty,
  summarizeItemAnalysis,
  type AmountRankPoint,
  type CategorySharePoint,
  type ItemAnalysisRow,
  type ItemAnalysisSortKey,
  type ItemAnalysisSummary,
} from "@/lib/item-analysis";
import { DonutChart } from "./charts/DonutChart";

/* ─────────────── 型別 ─────────────── */

type AnalysisResponse = {
  ok: boolean;
  matched?: boolean | null;
  schemaReady?: boolean;
  stockRangeIgnored?: boolean;
  /** 該店戶在 expenseRecorder 嘅收據總數；`null` ＝ 未探測／探測失敗。 */
  receiptCount?: number | null;
  rows?: ItemAnalysisRow[];
  summary?: ItemAnalysisSummary;
  amountRanking?: AmountRankPoint[];
  categoryBreakdown?: CategorySharePoint[];
  message?: string;
  warning?: string;
  error?: string;
};

/* ─────────────── 格式 ─────────────── */

const money = (n: number) =>
  `MOP ${Number(n || 0).toLocaleString("zh-MO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** 漲跌幅：四捨五入至整數%；`null` ⇒ 「—」（**唔可以報 0%**）。 */
const pct = (n: number | null): string => (n === null ? "—" : `${n > 0 ? "+" : ""}${Math.round(n)}%`);

/** 表內佔比：一位小數。 */
const share = (n: number | null): string => (n === null ? "—" : `${n.toFixed(1)}%`);

const SORT_OPTIONS: Array<{ key: ItemAnalysisSortKey; label: string }> = [
  { key: "change_desc", label: "漲幅 高→低" },
  { key: "change_asc", label: "漲幅 低→高" },
  { key: "value_desc", label: "庫存金額 高→低" },
  { key: "share_desc", label: "金額佔比 高→低" },
  { key: "name_asc", label: "品項名稱" },
];

/** 分類／供應商嘅 select 用哨兵值（空字串喺 `<option value>` 會變 undefined 行為）。 */
const ANY = "__any__";

/* ─────────────── 小元件 ─────────────── */

function DirectionBadge({ row }: { row: ItemAnalysisRow }) {
  if (row.direction === "new") {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
        首次記錄
      </span>
    );
  }
  if (row.direction === "same") {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
        持平
      </span>
    );
  }
  const up = row.direction === "up";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 tabular-nums ${
        up ? "bg-red-50 text-red-700 ring-red-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"
      }`}
    >
      {up ? "▲" : "▼"} {pct(row.changePercent)}
    </span>
  );
}

function KpiCard({
  label,
  value,
  sub,
  tone = "plain",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "plain" | "red" | "amber";
}) {
  const box =
    tone === "red"
      ? "border-red-200 bg-red-50"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50"
        : "border-slate-200 bg-white";
  const text = tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-slate-900";
  const lab = tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-slate-500";
  return (
    /* 🔴 `flex flex-col` + `h-full`：2×2 網格（手機）下四張卡嘅 sub-text 行數唔同
       （「庫存總值」兩行、「漲價品項」三行），唔用 flex 撐高就會出現參差高度。
       `items-stretch`（grid 預設）＋ `h-full` ＝ 每行兩張卡一樣高。 */
    <div className={`flex h-full flex-col rounded-2xl border p-4 ${box}`}>
      <div className={`text-xs ${lab}`}>{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${text}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] leading-snug text-slate-400">{sub}</div> : null}
    </div>
  );
}

/* ─────────────── 主體 ─────────────── */

/**
 * 「庫存 › 品項分析」。
 *
 * 🔴 為何獨立一個 component（唔直接寫入 `inventory-view.tsx`）：
 *    `inventory-view.tsx` 已經 1400+ 行；分析畫面自己有一份 fetch／篩選／排序 state，
 *    塞入去會令主檔過萬行。用 component 隔離亦令佢**只喺切到該 tab 時才掛載**，
 *    唔會喺「總覽」白白打多一個請求（egress 敏感）。
 *
 * 🔴 顏色語意：**成本升 ＝ 紅／成本跌 ＝ 綠**。
 *    呢個同 reports 頁嘅「營業額升 ＝ 綠」**方向相反**，係刻意嘅（見線框圖 §7）。
 *    唔可以照抄 reports 嘅 `pct()` helper。
 *
 * 🔴 空狀態 ≠ 零：`summary.stockTotal === 0` 或者 `avgChangePercent === null` 一律出「—」，
 *    唔可以渲染 `MOP 0.00` 或者 `0%`（會令商家以為真係零，而實際上係「冇資料」）。
 */
export function ItemAnalysisView({
  account,
  merchantId,
  supplierOrder,
  categoryOrder,
}: {
  account: string | null;
  merchantId: string | null;
  supplierOrder: string[];
  categoryOrder: string[];
}) {
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 🔴 一鍵同步：空狀態時若偵測到「有收據但冇庫存品」就提供。
   *
   * 為何要做呢個：商家錄完收據後**冇任何提示**要去按「從收據同步」，
   * 而該步喺「設置 → 庫存品」入面（要自己搵）。實際發生過連續兩日
   * 錄咗 35 張收據都冇同步 ⇒ 分析頁永遠空白而唔知點解。
   * 呢度直接喺空狀態出掣，唔使人離開當前頁面去搵。
   */
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const [onlyUp, setOnlyUp] = useState(false);
  const [category, setCategory] = useState<string>(ANY);
  const [supplier, setSupplier] = useState<string>(ANY);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<ItemAnalysisSortKey>("change_desc");

  const load = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ store: merchantId });
      if (account) qs.set("account", account);
      const res = await fetch(`/api/inventory/item-analysis?${qs.toString()}`);
      const json = (await res.json()) as AnalysisResponse;
      setData(json);
      if (!json.ok && json.error) setError(json.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [account, merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 觸發「從收據同步」再重載分析。
   *
   * ⚠️ 同 `inventory-table.tsx` 嘅 `doSync` 打同一支 API（單一寫入路徑），
   *    唔喺呢度自砌第二套同步邏輯 —— 基準價嘅鎖定時機只有一個真源。
   */
  const doSync = useCallback(async () => {
    if (!merchantId || !account) return;
    setSyncing(true);
    setSyncMsg(null);
    setError(null);
    try {
      const res = await fetch("/api/inventory/products/sync-from-receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ store: merchantId, account }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        summary?: { created: number; updated: number; total_after: number };
      };
      if (!json.ok) {
        setError(json.error || "同步失敗");
      } else {
        const s = json.summary;
        setSyncMsg(
          s
            ? `同步完成：新增 ${s.created} 個、更新 ${s.updated} 個，共 ${s.total_after} 個庫存品。`
            : "同步完成。",
        );
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, [account, merchantId, load]);

  const allRows = useMemo(() => data?.rows ?? [], [data]);
  const summary = data?.summary ?? null;

  const options = useMemo(
    () =>
      collectAnalysisFilterOptions(allRows, {
        // 商家拖過嘅次序要跟；不過收藏喺 `PosLocalSettings` 嘅係**名**，唔係 id
        categories: categoryOrder,
        suppliers: supplierOrder,
      }),
    [allRows, categoryOrder, supplierOrder],
  );

  const rows = useMemo(
    () =>
      filterItemAnalysisRows(
        allRows,
        {
          onlyUp,
          category: category === ANY ? "" : category,
          supplier: supplier === ANY ? "" : supplier,
          query,
        },
        sortKey,
      ),
    [allRows, onlyUp, category, supplier, query, sortKey],
  );

  /** 目前篩選出嘅子集摘要（同 KPI 嘅全量摘要唔同，呢個要即時反映篩選）。 */
  const viewSummary = useMemo(() => summarizeItemAnalysis(rows), [rows]);

  /** 圖表用**未篩選**嘅全量（線框圖 §4：圖表係「整體分佈」，唔跟清單篩選）。 */
  const ranking = data?.amountRanking ?? [];
  const categories = data?.categoryBreakdown ?? [];
  const rankMax = ranking.reduce((m, p) => Math.max(m, p.value), 0);

  const hasAnyFilter = onlyUp || category !== ANY || supplier !== ANY || query.trim().length > 0;

  if (!merchantId) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        尚未綁定門店，無法顯示品項分析。
      </div>
    );
  }

  return (
    <section>
      {/* 基準價口徑說明 —— 商家睇到數字前一定要知「同邊個價比」 */}
      <div className="mb-4 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs leading-relaxed text-slate-600">
        <span className="font-semibold text-slate-800">基準價口徑：</span>
        「上漲金額」嘅基準 ＝ 該品項<span className="font-semibold text-slate-800">首次進貨紀錄嘅單價</span>
        （歷史最早一筆收據），<span className="font-semibold text-slate-800">一經鎖定永不覆寫</span>；
        對比對象係「加權最新單價」。冇首次進貨紀錄 ⇒ 標
        <span className="mx-1 inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
          首次記錄
        </span>
        並<span className="font-semibold text-slate-800">排除喺漲跌統計外</span>。
      </div>

      {/* 警告：migration 0065 未跑 —— 呢個係靜默錯誤，一定要明確講 */}
      {data?.warning && (
        <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          {data.warning}
        </div>
      )}
      {data && data.schemaReady === false && (
        <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          expenseRecorder 資料表尚未建立，部分資訊無法顯示。
        </div>
      )}
      {data && data.message && !data.warning && (
        <div className="mb-4 rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200">
          {data.message}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
          {error}
          <button type="button" className="ml-2 underline" onClick={() => void load()}>
            重試
          </button>
        </div>
      )}

      {/* 篩選 / 排序列 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOnlyUp((v) => !v)}
          aria-pressed={onlyUp}
          className={`inline-flex min-h-[36px] items-center rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${
            onlyUp
              ? "bg-red-600 text-white ring-red-600"
              : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50"
          }`}
        >
          只看漲價品項
        </button>

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="min-h-[36px] rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
        >
          <option value={ANY}>分類：全部</option>
          {options.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          className="min-h-[36px] rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
        >
          <option value={ANY}>供應商：全部</option>
          {options.suppliers.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <span className="flex-1" />

        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as ItemAnalysisSortKey)}
          className="min-h-[36px] rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              排序：{o.label}
            </option>
          ))}
        </select>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋品項名稱…"
          className="min-h-[36px] w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 sm:w-56"
        />
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">載入中…</p>
      ) : allRows.length === 0 ? (
        /* 🔴 空狀態要分兩種，唔可以當同一件事：
             (a) 有收據但未同步 → 一鍵同步掣（真正嘅解法，商家唔使去別處搵）
             (b) 真係冇收據     → 普通說明
           之前只出 (b) 嘅文案，商家有 35 張收據都見到「尚無庫存品」而唔知點解。 */
        data && (data.receiptCount ?? 0) > 0 ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-center">
            <p className="text-sm font-semibold text-amber-900">
              偵測到 {data.receiptCount} 張收據，但尚未同步成庫存品
            </p>
            <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-amber-800">
              品項分析只讀「庫存品」主檔。收據錄入後需要同步一次，系統才會把品項、
              加權進價與<span className="font-semibold">首次進貨基準價</span>帶入。
            </p>
            <button
              type="button"
              onClick={() => void doSync()}
              disabled={syncing}
              className="mt-4 inline-flex min-h-[40px] items-center rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {syncing ? "同步中…" : "立即從收據同步"}
            </button>
            {syncMsg && <p className="mt-3 text-xs text-amber-800">{syncMsg}</p>}
            {error && <p className="mt-3 text-xs text-red-700">{error}</p>}
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            尚無庫存品。請先到「設置 → 庫存品」按「從收據同步」帶入品項。
          </div>
        )
      ) : (
        <>
          {/* KPI 四卡（全量口徑，唔跟篩選 —— 同報表頁嘅「總覽」語意一致） */}
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard
              label="庫存總值（成本）"
              value={money(summary?.stockTotal ?? 0)}
              sub={`Σ 庫存數量 × 加權進價 ・ 全部 ${summary?.itemCount ?? 0} 個品項`}
            />
            <KpiCard
              label="品項總數"
              value={String(summary?.itemCount ?? 0)}
              sub={`${summary?.categoryCount ?? 0} 個分類 ・ ${summary?.supplierCount ?? 0} 個供應商`}
            />
            <KpiCard
              tone="red"
              label="漲價品項"
              value={String(summary?.upCount ?? 0)}
              sub={`佔全部品項 ${(summary?.upSharePercent ?? 0).toFixed(1)}%（已排除 ${
                summary?.newCount ?? 0
              } 個首次記錄）`}
            />
            <KpiCard
              tone="amber"
              label="漲價影響金額"
              value={money(summary?.totalUpAmount ?? 0)}
              sub={
                (summary?.totalDownAmount ?? 0) < 0
                  ? `（最新 − 首次進貨價）× 現有庫存 ・ 另有跌價 −${money(
                      Math.abs(summary?.totalDownAmount ?? 0),
                    )}（分開計）`
                  : "（最新 − 首次進貨價）× 現有庫存量"
              }
            />
          </div>

          {/* 圖表區 */}
          <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-1 text-sm font-semibold text-slate-700">品項庫存金額排名</div>
              <div className="mb-3 text-xs text-slate-400">長條＝MOP 金額；括號＝佔庫存總值百分比</div>
              {ranking.length === 0 ? (
                <div className="text-sm text-slate-400">無資料</div>
              ) : (
                <div className="space-y-2">
                  {ranking.map((p) => (
                    <div key={p.name} className="flex items-center gap-2 text-xs">
                      {/* 品項名：120px 起，窄屏可縮但唔可以撐爆；`title` 補回被截嘅全名 */}
                      <span className="w-[100px] shrink-0 truncate text-slate-600 sm:w-[130px]" title={p.name}>
                        {p.name}
                      </span>
                      <span className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <span
                          className="block h-full rounded-full bg-slate-800"
                          style={{ width: rankMax > 0 ? `${(p.value / rankMax) * 100}%` : "0%" }}
                        />
                      </span>
                      {/* 🔴 唔可以用固定 w-32：`MOP 18,360.00（49.9%）` 12px 下約 150px
                          （實測 2026-10-07），窄過就會斷行成兩行、條形圖高度唔一致。 */}
                      <span className="shrink-0 whitespace-nowrap text-right tabular-nums text-slate-700">
                        {money(p.value)}
                        <span className="ml-1 text-slate-400">（{share(p.sharePercent)}）</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-1 text-sm font-semibold text-slate-700">分類佔比</div>
              <div className="mb-3 text-xs text-slate-400">按庫存金額</div>
              {categories.length === 0 ? (
                <div className="text-sm text-slate-400">無資料</div>
              ) : (
                <DonutChart
                  data={categories.map((c) => ({ label: c.label ?? "未分類", value: c.value }))}
                />
              )}
            </div>
          </div>

          {/* 漲價清單表 */}
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium text-slate-600">
              {onlyUp ? "價格上漲品項清單" : "全部品項・價格變動"}
              <span className="ml-2 text-xs font-normal text-slate-400">
                依「{SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? "漲幅"}」排序 ・ 紅色＝成本上升（對門店不利）
              </span>
            </h2>
            {hasAnyFilter && (
              <button
                type="button"
                onClick={() => {
                  setOnlyUp(false);
                  setCategory(ANY);
                  setSupplier(ANY);
                  setQuery("");
                }}
                className="text-xs text-slate-500 underline decoration-dotted hover:text-slate-700"
              >
                清除篩選（顯示 {rows.length} / {allRows.length}）
              </button>
            )}
          </div>

          {rows.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              目前篩選條件下冇品項。
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => {
                  setOnlyUp(false);
                  setCategory(ANY);
                  setSupplier(ANY);
                  setQuery("");
                }}
              >
                清除篩選
              </button>
            </div>
          ) : (
            <>
              {/* ── 桌面版表格（md 以上） ── */}
              <div className="hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="px-4 py-3 font-medium">品項</th>
                      <th className="px-3 py-3 font-medium">分類</th>
                      <th className="px-3 py-3 text-right font-medium">庫存數量</th>
                      <th className="px-3 py-3 text-right font-medium">庫存金額</th>
                      <th className="px-3 py-3 text-right font-medium">金額佔比</th>
                      <th className="px-3 py-3 text-right font-medium">原價（首次進貨）</th>
                      <th className="px-3 py-3 text-right font-medium">最新單價</th>
                      <th className="px-3 py-3 text-right font-medium">上漲金額</th>
                      <th className="px-3 py-3 text-right font-medium">漲幅</th>
                      <th className="px-4 py-3 font-medium">供應商</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-900">{r.name}</td>
                        <td className="px-3 py-3">
                          {r.category ? (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                              {r.category}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">未分類</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-slate-700">
                          {formatAnalysisQty(r.currentQty, r.unit)}
                        </td>
                        <td className="px-3 py-3 text-right tabular-nums text-slate-900">{money(r.stockValue)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-slate-600">
                          {share(r.valueSharePercent)}
                        </td>
                        {r.baselineUnitCost === null ? (
                          <td colSpan={2} className="px-3 py-3 text-right text-xs text-slate-400">
                            首次記錄，無基準價可比
                          </td>
                        ) : (
                          <>
                            <td className="px-3 py-3 text-right tabular-nums text-slate-600">
                              {money(r.baselineUnitCost)}
                              {r.baselineAt ? (
                                <span className="ml-1 text-[10px] text-slate-400">{r.baselineAt}</span>
                              ) : null}
                            </td>
                            <td className="px-3 py-3 text-right font-semibold tabular-nums text-slate-900">
                              {money(r.latestUnitCost)}
                            </td>
                          </>
                        )}
                        <td
                          className={`px-3 py-3 text-right font-semibold tabular-nums ${
                            r.direction === "up"
                              ? "text-red-600"
                              : r.direction === "down"
                                ? "text-emerald-600"
                                : "text-slate-400"
                          }`}
                        >
                          {r.changeAmount === null
                            ? "—"
                            : `${r.changeAmount > 0 ? "+" : r.changeAmount < 0 ? "−" : ""}${money(
                                Math.abs(r.changeAmount),
                              )}`}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <DirectionBadge row={r} />
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {r.supplier ?? <span className="text-slate-400">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-200 bg-slate-50 font-semibold text-slate-900">
                      <td className="px-4 py-3" colSpan={2}>
                        合計（{viewSummary.itemCount} 個品項）
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-400">—</td>
                      <td className="px-3 py-3 text-right tabular-nums">{money(viewSummary.stockTotal)}</td>
                      <td className="px-3 py-3 text-right tabular-nums text-slate-500">
                        {allRows.length > 0 && viewSummary.stockTotal > 0
                          ? share((viewSummary.stockTotal / (summary?.stockTotal ?? 1)) * 100)
                          : "—"}
                      </td>
                      <td colSpan={2} className="px-3 py-3 text-right text-xs font-normal text-slate-500">
                        平均漲幅{" "}
                        {viewSummary.avgChangePercent === null
                          ? "—（無可比基準）"
                          : `${pct(viewSummary.avgChangePercent)}`}
                        （已排除首次記錄）
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {/* 🔴 漲／跌分開兩行，唔可以互相抵消 */}
                        <span className={viewSummary.totalUpAmount > 0 ? "text-red-600" : "text-slate-400"}>
                          +{money(viewSummary.totalUpAmount)}
                        </span>
                        <br />
                        <span className="text-[11px] font-normal text-emerald-600">
                          −{money(Math.abs(viewSummary.totalDownAmount))}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                          {viewSummary.upCount} 漲 {viewSummary.downCount} 跌 {viewSummary.newCount} 新
                        </span>
                      </td>
                      <td className="px-4 py-3" />
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* ── 手機版卡片（md 以下） ── */}
              <div className="space-y-3 md:hidden">
                {rows.map((r) => (
                  <div key={r.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-medium text-slate-900">{r.name}</div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {r.category ?? "未分類"} ・ {r.supplier ?? "—"} ・{" "}
                          {formatAnalysisQty(r.currentQty, r.unit)}
                        </div>
                      </div>
                      <DirectionBadge row={r} />
                    </div>

                    <div className="mt-3 flex items-end justify-between gap-3">
                      <div className="text-sm">
                        {r.baselineUnitCost === null ? (
                          <span className="text-xs text-slate-400">首次記錄，無基準價可比</span>
                        ) : (
                          <span className="tabular-nums">
                            <span className="text-slate-400 line-through">{money(r.baselineUnitCost)}</span>
                            <span className="mx-1 text-slate-400">→</span>
                            <span className="font-semibold text-slate-900">{money(r.latestUnitCost)}</span>
                          </span>
                        )}
                      </div>
                      <div className="text-right text-xs text-slate-500">
                        上漲金額
                        <div
                          className={`text-base font-semibold tabular-nums ${
                            r.direction === "up"
                              ? "text-red-600"
                              : r.direction === "down"
                                ? "text-emerald-600"
                                : "text-slate-400"
                          }`}
                        >
                          {r.changeAmount === null
                            ? "—"
                            : `${r.changeAmount > 0 ? "+" : r.changeAmount < 0 ? "−" : ""}${money(
                                Math.abs(r.changeAmount),
                              )}`}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                      <span>
                        庫存金額 <span className="font-semibold text-slate-700">{money(r.stockValue)}</span>
                      </span>
                      <span>佔總值 {share(r.valueSharePercent)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        /*
                         * 🔴 佔比為 null（總值 0）或 0 時唔畫條 —— 畫一條 0 寬嘅 div
                         *    喺某些瀏覽器會殘留一個圓點（rounded-full + 1px 寬），
                         *    睇落似一個無意義嘅項目符號。
                         * 另外設定 min-width 令極細佔比（<1%）仍然睇得見係一條線而唔係一粒點。
                         */
                        className={`h-full rounded-full bg-slate-800 ${
                          (r.valueSharePercent ?? 0) > 0 ? "min-w-[2px]" : "hidden"
                        }`}
                        style={{ width: `${Math.min(100, r.valueSharePercent ?? 0)}%` }}
                      />
                    </div>
                  </div>
                ))}

                {/* 置底合計條 */}
                <div className="rounded-2xl bg-slate-900 px-4 py-3 text-white">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">合計（{viewSummary.itemCount} 個品項）</div>
                      <div className="mt-0.5 text-[11px] opacity-60">
                        {viewSummary.upCount} 漲 ・ {viewSummary.downCount} 跌 ・ {viewSummary.newCount} 首次記錄
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-base font-semibold tabular-nums">{money(viewSummary.stockTotal)}</div>
                      <div className="mt-0.5 text-[11px] opacity-60">
                        漲 +{money(viewSummary.totalUpAmount)} ・ 跌 −{money(Math.abs(viewSummary.totalDownAmount))}
                        （分開計）
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
                欄位口徑：庫存金額 ＝ <span className="font-medium">current_qty × avg_unit_cost</span>；原價 ＝{" "}
                <span className="font-medium">baseline_unit_cost</span>（該品項首次進貨紀錄嘅單價，一經鎖定永不覆寫）；
                上漲金額 ＝ <span className="font-medium">(最新單價 − 原價) × current_qty</span>；漲幅 ＝{" "}
                <span className="font-medium">(最新 − 原價) ÷ 原價 × 100%</span>，四捨五入至整數。
                「首次記錄」品項完全唔入漲跌統計（唔當 0% 報）。跌幅用綠色（成本下降對門店有利）。
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
