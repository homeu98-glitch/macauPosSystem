"use client";

import { useCallback, useEffect, useState } from "react";

import { loadAuthSession } from "@/lib/storage";

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
  raw_ocr_data?: { receipt_number?: string; payment_method?: string } | null;
  items: ReceiptItem[];
};

type ReceiptsResponse = {
  ok: boolean;
  matched?: boolean;
  schemaReady?: boolean;
  receipts?: Receipt[];
  message?: string;
  error?: string;
};

function todayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Macau" });
}

const money = (n: number) =>
  `MOP ${Number(n || 0).toLocaleString("zh-MO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function InventoryView() {
  const [account, setAccount] = useState<string | null>(null);
  const [storeName, setStoreName] = useState<string>("");
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
      const res = await fetch(`/api/inventory/receipts?account=${encodeURIComponent(account)}`);
      const json = (await res.json()) as ReceiptsResponse;
      setData(json);
      if (!json.ok && json.error) setError(json.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    if (account) void loadAll();
  }, [account, loadAll]);

  const receipts = data?.receipts ?? [];
  const tk = todayKey();
  const mk = tk.slice(0, 7);
  const todayTotal = receipts
    .filter((r) => (r.receipt_date || "").slice(0, 10) === tk)
    .reduce((s, r) => s + Number(r.total_amount || 0), 0);
  const monthTotal = receipts
    .filter((r) => (r.receipt_date || "").slice(0, 7) === mk)
    .reduce((s, r) => s + Number(r.total_amount || 0), 0);

  if (!account) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-50 p-6 text-slate-500">
        請先登入 POS 才能檢視庫存。
      </div>
    );
  }

  const kpis = [
    { label: "今日收據總額", value: money(todayTotal) },
    { label: "本月收據總額", value: money(monthTotal) },
    { label: "收據筆數", value: String(receipts.length) },
  ];

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

        <div className="mb-5 grid grid-cols-3 gap-3">
          {kpis.map((k) => (
            <div key={k.label} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="text-xs text-slate-500">{k.label}</div>
              <div className="mt-1 text-lg font-semibold text-slate-900">{k.value}</div>
            </div>
          ))}
        </div>

        <section>
          <h2 className="mb-3 text-sm font-medium text-slate-600">收據清單（expenseRecorder）</h2>
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
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setExpandedId(open ? null : r.id)}
                      className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:bg-slate-50"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-base font-medium text-slate-900">{r.receipt_date}</div>
                          <div className="text-xs text-slate-500">
                            {lineNo ? `收據號 ${lineNo} ・ ` : ""}
                            {r.items.length} 項
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-base font-semibold text-slate-900">{money(r.total_amount)}</div>
                          <div className="text-xs text-slate-400">{open ? "收起" : "展開"}</div>
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
      </div>
    </div>
  );
}
