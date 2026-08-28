"use client";

import { useCallback, useEffect, useState } from "react";

type InvProduct = {
  id: string;
  store_id: string;
  name: string;
  category: string | null;
  unit: string;
  current_qty: number;
  avg_unit_cost: number;
  last_purchase_date: string | null;
  last_supplier: string | null;
  reorder_level: number;
  note: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

const money = (n: number) =>
  `MOP ${Number(n || 0).toLocaleString("zh-MO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number, d = 2) =>
  Number(n || 0).toLocaleString("zh-MO", { maximumFractionDigits: d });

type Props = {
  merchantId: string;
  account: string;
};

export function InventoryTable({ merchantId, account }: Props) {
  const [products, setProducts] = useState<InvProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<InvProduct | null | undefined>(undefined); // undefined=closed, null=new
  const [stocktaking, setStocktaking] = useState<InvProduct | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<InvProduct | null>(null);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/inventory/products?store=${encodeURIComponent(merchantId)}`);
      const json = await res.json();
      if (!json.ok) setErr(json.error || "載入失敗");
      else setProducts(json.products ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "網絡錯誤");
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const doSync = async () => {
    setSyncMsg(null);
    setErr(null);
    try {
      const res = await fetch(`/api/inventory/products/sync-from-receipts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ store: merchantId, account }),
      });
      const json = await res.json();
      if (!json.ok) setErr(json.error || "同步失敗");
      else {
        const s = json.summary as { created: number; updated: number; total_after: number; scanned_receipts: number; scanned_items: number };
        setSyncMsg(`同步完成：新增 ${s.created} 個，更新 ${s.updated} 個（掃描 ${s.scanned_receipts} 張收據 / ${s.scanned_items} 個品項，總計 ${s.total_after} 個庫存品）`);
        void loadProducts();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "網絡錯誤");
    }
  };

  const doDelete = async (p: InvProduct) => {
    try {
      const res = await fetch(`/api/inventory/products/${p.id}?store=${encodeURIComponent(merchantId)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!json.ok) setErr(json.error || "刪除失敗");
      else {
        setConfirmDelete(null);
        void loadProducts();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "網絡錯誤");
    }
  };

  // Stats
  const totalCount = products.length;
  const stockValue = products.reduce((s, p) => s + (p.current_qty || 0) * (p.avg_unit_cost || 0), 0);
  const lowStock = products.filter((p) => p.reorder_level > 0 && p.current_qty < p.reorder_level).length;

  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-slate-600">
            庫存表（POS 內建・{totalCount} 個）
            <span className="ml-2 text-xs font-normal text-slate-400">
              基於 expenseRecorder 收據，可盤點/手動維護
            </span>
          </h2>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void doSync()}
            className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white"
          >
            從收據同步
          </button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"
          >
            ＋ 新增庫存品
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
          {err}
          <button type="button" className="ml-2 underline" onClick={() => setErr(null)}>
            知道了
          </button>
        </div>
      )}
      {syncMsg && (
        <div className="mb-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
          {syncMsg}
          <button type="button" className="ml-2 underline" onClick={() => setSyncMsg(null)}>
            知道了
          </button>
        </div>
      )}

      {/* KPI */}
      <div className="mb-3 grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">庫存品項數</div>
          <div className="mt-1 text-lg font-semibold">{totalCount}</div>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">庫存總值（成本）</div>
          <div className="mt-1 text-lg font-semibold">{money(stockValue)}</div>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <div className="text-xs text-amber-700">低庫存警示</div>
          <div className="mt-1 text-lg font-semibold text-amber-700">{lowStock}</div>
        </div>
      </div>

      {/* 列表 */}
      {loading ? (
        <p className="text-sm text-slate-500">載入中…</p>
      ) : products.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
          尚無庫存品。點「從收據同步」從 expenseRecorder 收據帶入，或「新增庫存品」手動建立。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {products.map((p) => {
            const isLow = p.reorder_level > 0 && p.current_qty < p.reorder_level;
            return (
              <div
                key={p.id}
                className={`rounded-2xl border bg-white p-4 ${isLow ? "border-amber-300 ring-1 ring-amber-200" : "border-slate-200"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-medium text-slate-900">{p.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                      {p.category && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                          {p.category}
                        </span>
                      )}
                      <span>單位：{p.unit}</span>
                    </div>
                  </div>
                  {isLow && (
                    <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-300">
                      低庫存
                    </span>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <div className="text-xs text-slate-500">目前庫存量</div>
                    <div className="text-base font-semibold">{num(p.current_qty, 3)}</div>
                    <div className="text-[11px] text-slate-400">門檻 {num(p.reorder_level, 3)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">加權單價</div>
                    <div className="text-base font-semibold">{money(p.avg_unit_cost)}</div>
                    <div className="text-[11px] text-slate-400">
                      {p.last_purchase_date ? `最後採購 ${p.last_purchase_date}` : "—"}
                    </div>
                  </div>
                </div>

                {p.last_supplier && (
                  <div className="mt-2 text-xs text-slate-500">最後供應商：{p.last_supplier}</div>
                )}

                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    className="flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-200"
                  >
                    編輯
                  </button>
                  <button
                    type="button"
                    onClick={() => setStocktaking(p)}
                    className="flex-1 rounded-xl bg-amber-500 px-3 py-2.5 text-sm font-semibold text-white hover:bg-amber-600"
                  >
                    盤點
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(p)}
                    className="rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-600 hover:bg-red-100"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing !== undefined && (
        <ProductFormModal
          initial={editing}
          merchantId={merchantId}
          onClose={() => setEditing(undefined)}
          onSaved={() => void loadProducts()}
        />
      )}

      {stocktaking && (
        <StocktakeModal
          product={stocktaking}
          onClose={() => setStocktaking(null)}
          onSaved={() => void loadProducts()}
        />
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-white p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-slate-900">刪除庫存品？</h3>
            <p className="mt-2 text-sm text-slate-600">
              確定要刪除「{confirmDelete.name}」？所有盤點紀錄也會一併刪除，無法復原。
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="flex-1 rounded-xl bg-slate-100 py-3 text-sm font-medium text-slate-700"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void doDelete(confirmDelete)}
                className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-semibold text-white"
              >
                刪除
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------- 新增/編輯庫存品 ---------------- */
function ProductFormModal({
  initial,
  merchantId,
  onClose,
  onSaved,
}: {
  initial: InvProduct | null;
  merchantId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [unit, setUnit] = useState(initial?.unit ?? "unit");
  const [reorder, setReorder] = useState(String(initial?.reorder_level ?? "0"));
  const [note, setNote] = useState(initial?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) return setErr("請填寫品名");
    setSaving(true);
    setErr(null);
    try {
      const body = {
        store: merchantId,
        name: name.trim(),
        category: category.trim() || undefined,
        unit: unit.trim() || "unit",
        reorder_level: Number(reorder) || 0,
        note: note.trim() || undefined,
      };
      const url = initial ? `/api/inventory/products/${initial.id}?store=${encodeURIComponent(merchantId)}` : `/api/inventory/products`;
      const method = initial ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.ok) setErr(json.error || "儲存失敗");
      else {
        onSaved();
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "網絡錯誤");
    } finally {
      setSaving(false);
    }
  };

  const fieldCls =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-base text-slate-900 outline-none focus:border-slate-400";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xl font-semibold">{initial ? "編輯庫存品" : "新增庫存品"}</h3>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
            關閉
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">品名</label>
            <input className={fieldCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：雞蛋、牛肉" />
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">品類</label>
              <input className={fieldCls} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="例如：食材、清潔用品" />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">單位</label>
              <input className={fieldCls} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="unit / kg / 盒" />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">補貨門檻</label>
            <input
              className={fieldCls}
              inputMode="decimal"
              value={reorder}
              onChange={(e) => setReorder(e.target.value)}
              placeholder="0 = 不警示"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">備註</label>
            <textarea
              className={`${fieldCls} min-h-[80px]`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="選填"
            />
          </div>
          {err && <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">{err}</div>}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full rounded-2xl bg-emerald-600 py-3.5 text-base font-semibold text-white disabled:opacity-60"
          >
            {saving ? "儲存中…" : "儲存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 盤點 modal ---------------- */
function StocktakeModal({
  product,
  onClose,
  onSaved,
}: {
  product: InvProduct;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [qty, setQty] = useState(String(product.current_qty ?? 0));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const merchantId = product.store_id;

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/inventory/products/${product.id}/adjust?store=${encodeURIComponent(merchantId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ new_qty: Number(qty), reason }),
        },
      );
      const json = await res.json();
      if (!json.ok) setErr(json.error || "盤點失敗");
      else {
        onSaved();
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "網絡錯誤");
    } finally {
      setSaving(false);
    }
  };

  const fieldCls =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-base text-slate-900 outline-none focus:border-slate-400";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xl font-semibold">盤點：{product.name}</h3>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
            關閉
          </button>
        </div>
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600 ring-1 ring-slate-200">
            目前庫存量：<span className="font-semibold text-slate-900">{num(product.current_qty, 3)} {product.unit}</span>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">盤點後新庫存量</label>
            <input
              className={fieldCls}
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="輸入實際庫存量"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">異動原因（選填）</label>
            <input
              className={fieldCls}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：盤點 / 損耗 / 退貨"
            />
          </div>
          {err && <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">{err}</div>}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full rounded-2xl bg-amber-500 py-3.5 text-base font-semibold text-white disabled:opacity-60"
          >
            {saving ? "儲存中…" : "確認盤點"}
          </button>
        </div>
      </div>
    </div>
  );
}