"use client";

import { useCallback, useEffect, useState } from "react";

import { loadAuthSession } from "@/lib/storage";

type Product = {
  id: string;
  name: string;
  unit: string;
  unit_cost: number;
  current_qty: number;
  reorder_level: number | null;
  product_key?: string | null;
  sku?: string | null;
};

type StockInRow = {
  id: string;
  total_amount: number;
  category?: string | null;
  created_at?: string;
};

type Summary = {
  ok: boolean;
  schemaReady?: boolean;
  productsSchemaReady?: boolean;
  date?: string;
  actualStockInCost?: number;
  todayExpense?: number;
  inventoryValue?: number;
  lowStockCount?: number;
  todayStockIn?: StockInRow[];
  lowStock?: Product[];
  error?: string;
};

const money = (n: number) =>
  `MOP ${Number(n || 0).toLocaleString("zh-MO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function InventoryView() {
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [storeName, setStoreName] = useState<string>("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<Partial<Product> & { editingId?: string | null }>({ editingId: null });
  const [saving, setSaving] = useState(false);

  // M2.5 入貨登記（POS 側）
  const [stockRows, setStockRows] = useState<{ name: string; unitPrice: string; quantity: string; unit: string }[]>([
    { name: "", unitPrice: "", quantity: "", unit: "" },
  ]);
  const [stockSaving, setStockSaving] = useState(false);

  useEffect(() => {
    const s = loadAuthSession();
    if (s?.merchantId) {
      setMerchantId(s.merchantId);
      setStoreName(s.name || "");
    }
  }, []);

  const loadAll = useCallback(async () => {
    if (!merchantId) return;
    setLoading(true);
    setError(null);
    try {
      const [sRes, pRes] = await Promise.all([
        fetch(`/api/inventory/summary?storeId=${encodeURIComponent(merchantId)}`),
        fetch(`/api/inventory/products?storeId=${encodeURIComponent(merchantId)}`),
      ]);
      const sData = (await sRes.json()) as Summary;
      const pData = (await pRes.json()) as { ok: boolean; products?: Product[]; error?: string };
      setSummary(sData);
      if (pData.ok) setProducts(pData.products ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    if (merchantId) void loadAll();
  }, [merchantId, loadAll]);

  async function saveProduct() {
    if (!merchantId || !form.name?.trim()) return;
    setSaving(true);
    try {
      const payload = {
        storeId: merchantId,
        id: form.editingId ?? undefined,
        name: form.name,
        unit: form.unit || "unit",
        unit_cost: Number(form.unit_cost || 0),
        current_qty: Number(form.current_qty || 0),
        reorder_level: Number(form.reorder_level || 0),
        product_key: form.product_key || null,
        sku: form.sku || null,
      };
      const res = await fetch("/api/inventory/products", {
        method: form.editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setError(data.error || "儲存失敗");
        return;
      }
      resetForm();
      await loadAll();
    } finally {
      setSaving(false);
    }
  }

  async function deleteProduct(id: string) {
    if (!merchantId) return;
    if (!window.confirm("確定刪除此庫存品？")) return;
    const res = await fetch(`/api/inventory/products?id=${id}&storeId=${encodeURIComponent(merchantId)}`, {
      method: "DELETE",
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      setError(data.error || "刪除失敗");
      return;
    }
    await loadAll();
  }

  function startEdit(p: Product) {
    setForm({
      editingId: p.id,
      name: p.name,
      unit: p.unit,
      unit_cost: p.unit_cost,
      current_qty: p.current_qty,
      reorder_level: p.reorder_level ?? 0,
      product_key: p.product_key ?? undefined,
      sku: p.sku ?? undefined,
    });
  }

  function resetForm() {
    setForm({ editingId: null });
  }

  function addStockRow() {
    setStockRows((r) => [...r, { name: "", unitPrice: "", quantity: "", unit: "" }]);
  }
  function updateStockRow(idx: number, field: "name" | "unitPrice" | "quantity" | "unit", val: string) {
    setStockRows((r) => r.map((row, i) => (i === idx ? { ...row, [field]: val } : row)));
  }
  function removeStockRow(idx: number) {
    setStockRows((r) => (r.length === 1 ? r : r.filter((_, i) => i !== idx)));
  }
  const stockTotal = stockRows.reduce((s, row) => s + (Number(row.unitPrice) || 0) * (Number(row.quantity) || 0), 0);

  async function submitStockIn() {
    if (!merchantId) return;
    const cleaned = stockRows.filter((r) => r.name.trim() && Number(r.unitPrice) > 0 && Number(r.quantity) > 0);
    if (cleaned.length === 0) {
      setError("請至少填一項：品名 + 單價 + 數量");
      return;
    }
    setStockSaving(true);
    try {
      const res = await fetch("/api/inventory/stock-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: merchantId,
          items: cleaned.map((r) => ({
            name: r.name.trim(),
            unitPrice: Number(r.unitPrice),
            quantity: Number(r.quantity),
            unit: r.unit.trim() || "unit",
          })),
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; schemaReady?: boolean };
      if (!data.ok) {
        setError(data.error || "入貨登記失敗");
        return;
      }
      setStockRows([{ name: "", unitPrice: "", quantity: "", unit: "" }]);
      await loadAll();
    } finally {
      setStockSaving(false);
    }
  }

  if (!merchantId) {
    return (
      <div className="h-full w-full overflow-y-auto bg-slate-900 p-6 text-slate-300">
        請先登入 POS 才能檢視庫存。
      </div>
    );
  }

  const kpi = [
    { label: "今日用料成本", value: money(summary?.actualStockInCost ?? 0), accent: true },
    { label: "今日支出", value: money(summary?.todayExpense ?? 0) },
    { label: "庫存總值", value: money(summary?.inventoryValue ?? 0) },
    {
      label: "低庫存警示",
      value: String(summary?.lowStockCount ?? 0),
      warn: (summary?.lowStockCount ?? 0) > 0,
    },
  ];

  return (
    <div className="h-full w-full overflow-y-auto bg-slate-900 p-4 text-slate-100 md:p-6">
      <div className="mx-auto max-w-5xl">
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">庫存管理</h1>
            <p className="text-sm text-slate-400">
              店別：{storeName || merchantId} ・ 日期：{summary?.date || new Date().toISOString().slice(0, 10)}
            </p>
          </div>
          <button
            onClick={() => void loadAll()}
            className="rounded-lg bg-slate-700 px-3 py-2 text-sm hover:bg-slate-600"
          >
            重新整理
          </button>
        </header>

        {summary && summary.schemaReady === false && (
          <div className="mb-4 rounded-lg bg-amber-500/20 px-4 py-3 text-sm text-amber-200">
            庫存資料表尚未建立（receipts 缺少 store_id/receipt_type）。請在 expenseRecorder 專案執行 M2 遷移 SQL。
          </div>
        )}
        {summary && summary.productsSchemaReady === false && (
          <div className="mb-4 rounded-lg bg-amber-500/20 px-4 py-3 text-sm text-amber-200">
            尚未建立 inv_products 表，庫存主檔與低庫存警示暫不顯示。請執行 M2 遷移 SQL。
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg bg-red-500/20 px-4 py-3 text-sm text-red-200">{error}</div>
        )}

        {/* KPI 卡 */}
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {kpi.map((k) => (
            <div
              key={k.label}
              className={`rounded-xl p-4 ${
                k.accent ? "bg-orange-500/15 ring-1 ring-orange-500/40" : "bg-slate-800"
              }`}
            >
              <div className="text-xs text-slate-400">{k.label}</div>
              <div
                className={`mt-1 text-lg font-bold ${
                  k.warn ? "text-red-300" : k.accent ? "text-orange-300" : "text-slate-100"
                }`}
              >
                {k.value}
              </div>
            </div>
          ))}
        </div>

        {/* 今日入貨單（expenseRecorder 側） */}
        <section className="mb-6 rounded-xl bg-slate-800 p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">今日入貨單（expenseRecorder）</h2>
          {loading ? (
            <p className="text-sm text-slate-400">載入中…</p>
          ) : (summary?.todayStockIn?.length ?? 0) === 0 ? (
            <p className="text-sm text-slate-400">
              今日尚無入貨單。可用上方「入貨登記」直接登記（自動標記 stock_in）。
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {summary?.todayStockIn?.map((r) => (
                <li key={r.id} className="flex justify-between border-b border-slate-700/50 py-1">
                  <span className="text-slate-300">{r.category || "入貨"}</span>
                  <span className="font-semibold text-slate-100">{money(r.total_amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 入貨登記（POS 側，寫入 receipts stock_in + 自動過帳庫存） */}
        <section className="mb-6 rounded-xl bg-slate-800 p-4">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">入貨登記</h2>
          <p className="mb-3 text-xs text-slate-400">
            在此登記今日入貨，自動計入「今日用料成本」並過帳庫存（加權平均單價）。
          </p>
          <div className="space-y-2">
            {stockRows.map((row, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-2">
                <input
                  list="inv-product-names"
                  className="col-span-5 rounded bg-slate-700 px-2 py-1 text-sm"
                  placeholder="品名*"
                  value={row.name}
                  onChange={(e) => updateStockRow(idx, "name", e.target.value)}
                />
                <input
                  className="col-span-2 rounded bg-slate-700 px-2 py-1 text-sm"
                  type="number"
                  placeholder="單價*"
                  value={row.unitPrice}
                  onChange={(e) => updateStockRow(idx, "unitPrice", e.target.value)}
                />
                <input
                  className="col-span-2 rounded bg-slate-700 px-2 py-1 text-sm"
                  type="number"
                  placeholder="數量*"
                  value={row.quantity}
                  onChange={(e) => updateStockRow(idx, "quantity", e.target.value)}
                />
                <input
                  className="col-span-2 rounded bg-slate-700 px-2 py-1 text-sm"
                  placeholder="單位"
                  value={row.unit}
                  onChange={(e) => updateStockRow(idx, "unit", e.target.value)}
                />
                <button
                  className="col-span-1 rounded bg-slate-600 px-2 py-1 text-sm hover:bg-slate-500 disabled:opacity-40"
                  onClick={() => removeStockRow(idx)}
                  disabled={stockRows.length === 1}
                  aria-label="移除該項"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <datalist id="inv-product-names">
            {products.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={addStockRow} className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600">
              + 加一項
            </button>
            <button
              onClick={() => void submitStockIn()}
              disabled={stockSaving}
              className="rounded bg-orange-500 px-4 py-1 text-sm font-semibold text-white disabled:opacity-40"
            >
              {stockSaving ? "登記中…" : "登記入貨"}
            </button>
            <span className="text-sm text-slate-400">合計：{money(stockTotal)}</span>
          </div>
        </section>

        {/* 庫存主檔 */}
        <section className="rounded-xl bg-slate-800 p-4">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">庫存主檔</h2>

          <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-slate-900/60 p-3 md:grid-cols-6">
            <input
              className="rounded bg-slate-700 px-2 py-1 text-sm"
              placeholder="品名*"
              value={form.name ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <input
              className="rounded bg-slate-700 px-2 py-1 text-sm"
              placeholder="單位"
              value={form.unit ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
            />
            <input
              className="rounded bg-slate-700 px-2 py-1 text-sm"
              type="number"
              placeholder="單價"
              value={form.unit_cost ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, unit_cost: Number(e.target.value) }))}
            />
            <input
              className="rounded bg-slate-700 px-2 py-1 text-sm"
              type="number"
              placeholder="現有量"
              value={form.current_qty ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, current_qty: Number(e.target.value) }))}
            />
            <input
              className="rounded bg-slate-700 px-2 py-1 text-sm"
              type="number"
              placeholder="補貨水位"
              value={form.reorder_level ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, reorder_level: Number(e.target.value) }))}
            />
            <div className="flex gap-1">
              <button
                onClick={() => void saveProduct()}
                disabled={saving || !form.name?.trim()}
                className="flex-1 rounded bg-orange-500 px-2 py-1 text-sm font-semibold text-white disabled:opacity-40"
              >
                {form.editingId ? "更新" : "新增"}
              </button>
              {form.editingId && (
                <button onClick={resetForm} className="rounded bg-slate-600 px-2 py-1 text-sm">
                  取消
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-400">
                <tr>
                  <th className="py-2 pr-2">品名</th>
                  <th className="py-2 pr-2">單位</th>
                  <th className="py-2 pr-2 text-right">單價</th>
                  <th className="py-2 pr-2 text-right">現有量</th>
                  <th className="py-2 pr-2 text-right">庫存價值</th>
                  <th className="py-2 pr-2">狀態</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {products.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-slate-400">
                      尚無庫存品，請上方新增。
                    </td>
                  </tr>
                ) : (
                  products.map((p) => {
                    const value = Number(p.unit_cost || 0) * Number(p.current_qty || 0);
                    const low = Number(p.current_qty || 0) <= Number(p.reorder_level || 0);
                    return (
                      <tr key={p.id} className="border-t border-slate-700/50">
                        <td className="py-2 pr-2">{p.name}</td>
                        <td className="py-2 pr-2 text-slate-400">{p.unit}</td>
                        <td className="py-2 pr-2 text-right">{money(p.unit_cost)}</td>
                        <td className="py-2 pr-2 text-right">{Number(p.current_qty || 0)}</td>
                        <td className="py-2 pr-2 text-right">{money(value)}</td>
                        <td className="py-2 pr-2">
                          {low ? (
                            <span className="rounded bg-red-500/20 px-2 py-0.5 text-xs text-red-300">低庫存</span>
                          ) : (
                            <span className="text-slate-500">正常</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            onClick={() => startEdit(p)}
                            className="mr-2 text-xs text-slate-300 hover:text-white"
                          >
                            編輯
                          </button>
                          <button
                            onClick={() => void deleteProduct(p.id)}
                            className="text-xs text-red-300 hover:text-red-200"
                          >
                            刪除
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
