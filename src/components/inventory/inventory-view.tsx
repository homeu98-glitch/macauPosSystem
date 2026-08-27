"use client";

import { useCallback, useEffect, useState } from "react";

import { loadAuthSession } from "@/lib/storage";
import { REPORT_RANGE_OPTIONS, reportRangeLabel, type ReportRangeKey } from "@/lib/ledger/report-period";
import type { PurchaseSummary } from "@/lib/inventory-stats";

type ReceiptItem = {
  id: string;
  name: string;
  unit_price: number;
  quantity: number;
};

type Receipt = {
  id: string;
  total_amount: number;
  receipt_date: string;
  merchant_id?: string | null;
  merchant_name: string;
  payment_method: string;
  payment_status: string;
  raw_ocr_data?: { receipt_number?: string; payment_method?: string; payment_status?: string } | null;
  items: ReceiptItem[];
};

type ReceiptsResponse = {
  ok: boolean;
  matched?: boolean;
  schemaReady?: boolean;
  range?: ReportRangeKey;
  receipts?: Receipt[];
  summary?: PurchaseSummary;
  message?: string;
  error?: string;
};

const money = (n: number) =>
  `MOP ${Number(n || 0).toLocaleString("zh-MO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  on_delivery: "貨到付款",
  cash: "現金",
  card: "信用卡",
  transfer: "轉帳",
  unknown: "未知",
};

function paymentMethodLabel(value: string): string {
  return PAYMENT_METHOD_LABEL[value] ?? value ?? "未知";
}

export function InventoryView() {
  const [account, setAccount] = useState<string | null>(null);
  const [storeName, setStoreName] = useState<string>("");
  const [range, setRange] = useState<ReportRangeKey>("today");
  const [data, setData] = useState<ReceiptsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const s = loadAuthSession();
    if (s?.account) {
      setAccount(s.account);
      setStoreName(s.name || "");
    }
  }, []);

  const loadAll = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/inventory/receipts?account=${encodeURIComponent(account)}&range=${range}`);
      const json = (await res.json()) as ReceiptsResponse;
      setData(json);
      if (!json.ok && json.error) setError(json.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [account, range]);

  useEffect(() => {
    if (account) void loadAll();
  }, [account, loadAll]);

  const receipts = data?.receipts ?? [];
  const summary = data?.summary;
  const rangeLabel = reportRangeLabel(range);

  if (!account) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-50 p-6 text-slate-500">
        請先登入 POS 才能檢視庫存。
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-slate-50 p-4 text-slate-900 md:p-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">庫存管理</h1>
            <p className="text-sm text-slate-500">
              店別：{storeName || account} ・ 帳號：{account}
            </p>
          </div>
          <button
            onClick={() => void loadAll()}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          >
            重新整理
          </button>
        </header>

        {/* 時間篩選 */}
        <div className="mb-4 flex flex-wrap gap-2">
          {REPORT_RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setRange(opt.key)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                range === opt.key
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
              }`}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>

        {data && data.schemaReady === false && (
          <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            expenseRecorder 資料表尚未建立（receipts 不存在）。請在 expenseRecorder 專案執行
            supabase_schema.sql。
          </div>
        )}
        {data && data.matched === false && (
          <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            在 expenseRecorder 找不到與此 8 位帳號相同的店戶，暫無可顯示的收據。
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
            {error}
          </div>
        )}

        {/* KPI：區間買貨統計 */}
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">{rangeLabel}總支出</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{money(summary?.total ?? 0)}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">收據數</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{summary?.count ?? 0}</div>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="text-xs text-emerald-700">已付</div>
            <div className="mt-1 text-lg font-semibold text-emerald-700">{money(summary?.paid ?? 0)}</div>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <div className="text-xs text-amber-700">未付</div>
            <div className="mt-1 text-lg font-semibold text-amber-700">{money(summary?.unpaid ?? 0)}</div>
          </div>
        </div>

        {/* 收據清單 */}
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-slate-600">收據清單（expenseRecorder・{rangeLabel}）</h2>
          {loading ? (
            <p className="text-sm text-slate-500">載入中…</p>
          ) : receipts.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              尚無收據。請在 expenseRecorder 記錄收據後，於此處檢視。
            </div>
          ) : (
            <ul className="space-y-3">
              {receipts.map((r) => {
                const open = expandedId === r.id;
                const lineNo = r.raw_ocr_data?.receipt_number;
                const paid = r.payment_status === "paid";
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setExpandedId(open ? null : r.id)}
                      className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:bg-slate-50"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-base font-medium text-slate-900">{r.merchant_name}</div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {r.receipt_date}
                            {lineNo ? ` ・ #${lineNo}` : ""} ・ {r.items.length} 項
                          </div>
                          <div className="mt-0.5 text-xs text-slate-400">
                            付款方式：{paymentMethodLabel(r.payment_method)}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-base font-semibold text-slate-900">{money(r.total_amount)}</div>
                          <span
                            className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              paid ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                            }`}
                          >
                            {paid ? "已付款" : "未付款"}
                          </span>
                          <div className="mt-1 text-[11px] text-slate-400">{open ? "收起" : "展開"}</div>
                        </div>
                      </div>

                      {open && (
                        <div className="mt-3 border-t border-slate-100 pt-3">
                          <table className="w-full text-left text-sm">
                            <thead className="text-slate-400">
                              <tr>
                                <th className="py-1 pr-2 font-normal">品名</th>
                                <th className="py-1 pr-2 text-right font-normal">單價</th>
                                <th className="py-1 pr-2 text-right font-normal">數量</th>
                                <th className="py-1 text-right font-normal">小計</th>
                              </tr>
                            </thead>
                            <tbody className="text-slate-700">
                              {r.items.length === 0 ? (
                                <tr>
                                  <td colSpan={4} className="py-2 text-center text-slate-400">
                                    無品項明細
                                  </td>
                                </tr>
                              ) : (
                                r.items.map((it) => (
                                  <tr key={it.id} className="border-t border-slate-50">
                                    <td className="py-1 pr-2">{it.name}</td>
                                    <td className="py-1 pr-2 text-right">{money(it.unit_price)}</td>
                                    <td className="py-1 pr-2 text-right">{Number(it.quantity || 0)}</td>
                                    <td className="py-1 text-right">
                                      {money(Number(it.unit_price || 0) * Number(it.quantity || 0))}
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 統計區：鏡像 Expense recorder */}
        {summary && summary.count > 0 && (
          <section className="space-y-4">
            <h2 className="text-sm font-medium text-slate-600">統計（{rangeLabel}）</h2>

            {/* 供應商統計 */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">供應商統計（Top 5）</div>
              {summary.supplierStats.length === 0 ? (
                <div className="text-sm text-slate-400">無資料</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {summary.supplierStats.slice(0, 5).map((s) => (
                    <li key={s.name} className="flex items-center justify-between py-2 text-sm">
                      <span className="text-slate-700">{s.name}</span>
                      <span className="text-slate-500">
                        {s.count} 張 ・ <span className="font-semibold text-slate-900">{money(s.total)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 近 6 月支出 */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">近 6 月支出</div>
              {summary.monthlyExpenses.length === 0 ? (
                <div className="text-sm text-slate-400">無資料</div>
              ) : (
                <ul className="space-y-2">
                  {summary.monthlyExpenses.map((m) => {
                    const max = Math.max(...summary.monthlyExpenses.map((x) => x.amount), 1);
                    const pct = max > 0 ? Math.round((m.amount / max) * 100) : 0;
                    return (
                      <li key={m.key} className="flex items-center gap-3 text-sm">
                        <span className="w-10 shrink-0 text-slate-500">{m.name}</span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                          <div className="h-full rounded-full bg-slate-400" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="w-24 shrink-0 text-right font-semibold text-slate-900">{money(m.amount)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* 價格漲跌 */}
            <div className="flex gap-3">
              <div className="flex-1 rounded-2xl border border-red-200 bg-red-50 p-4">
                <div className="text-xs text-red-700">價格上漲項</div>
                <div className="mt-1 text-2xl font-semibold text-red-700">{summary.trend.up}</div>
              </div>
              <div className="flex-1 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="text-xs text-emerald-700">價格下降項</div>
                <div className="mt-1 text-2xl font-semibold text-emerald-700">{summary.trend.down}</div>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
