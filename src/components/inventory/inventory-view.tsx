"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { loadAuthSession } from "@/lib/storage";
import { REPORT_RANGE_OPTIONS, reportRangeLabel, type ReportRangeKey } from "@/lib/ledger/report-period";
import { PAYMENT_METHOD_LABEL, type PurchaseSummary } from "@/lib/inventory-stats";
import { AreaChart } from "./charts/AreaChart";
import { DonutChart } from "./charts/DonutChart";
import { LineChart } from "./charts/LineChart";
import { InventoryTable } from "./inventory-table";

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
  category?: string;
  raw_ocr_data?: { receipt_number?: string; payment_method?: string; payment_status?: string; category?: string } | null;
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

const PAYMENT_METHODS = ["on_delivery", "cash", "card", "transfer"] as const;
const STATUS_LABEL: Record<string, string> = { paid: "已付款", unpaid: "未付款" };
const todayStr = () => new Date().toLocaleDateString("en-CA");

/* ---------------- 收據表單（置中 modal，可編輯/刪除） ---------------- */
type FormItem = { name: string; unit_price: string; quantity: string };
type FormState = {
  id?: string;
  merchant_name: string;
  date: string;
  receipt_number: string;
  category: string;
  payment_method: string;
  payment_status: string;
  items: FormItem[];
};

function emptyForm(): FormState {
  return {
    merchant_name: "",
    date: todayStr(),
    receipt_number: "",
    category: "",
    payment_method: "on_delivery",
    payment_status: "unpaid",
    items: [{ name: "", unit_price: "", quantity: "1" }],
  };
}

function formFromReceipt(r: Receipt): FormState {
  return {
    id: r.id,
    merchant_name: r.merchant_name,
    date: r.receipt_date,
    receipt_number: r.raw_ocr_data?.receipt_number ?? "",
    category: r.category ?? "",
    payment_method: r.payment_method,
    payment_status: r.payment_status,
    items: r.items.length
      ? r.items.map((it) => ({ name: it.name, unit_price: String(it.unit_price), quantity: String(it.quantity) }))
      : [{ name: "", unit_price: "", quantity: "1" }],
  };
}

function ReceiptFormModal({
  open,
  initial,
  supplierNames,
  account,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: Receipt | null;
  supplierNames: string[];
  account: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(emptyForm());
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [askDelete, setAskDelete] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial ? formFromReceipt(initial) : emptyForm());
      setErr(null);
      setAskDelete(false);
    }
  }, [open, initial]);

  if (!open) return null;

  const setItem = (i: number, patch: Partial<FormItem>) =>
    setForm((f) => ({ ...f, items: f.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) }));

  const total = form.items.reduce((s, it) => s + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0);

  const save = async () => {
    setErr(null);
    if (!form.merchant_name.trim()) return setErr("請填寫供應商");
    if (!form.date) return setErr("請選擇收據日期");
    const items = form.items
      .filter((it) => it.name.trim())
      .map((it) => ({ name: it.name.trim(), unit_price: Number(it.unit_price) || 0, quantity: Number(it.quantity) || 1 }));
    const payload = {
      account,
      merchant_name: form.merchant_name.trim(),
      receipt_number: form.receipt_number || undefined,
      category: form.category.trim() || undefined,
      payment_method: form.payment_method,
      payment_status: form.payment_status,
      date: form.date,
      total_amount: Math.round(total * 100) / 100,
      items,
    };
    setSaving(true);
    try {
      const res = form.id
        ? await fetch(`/api/inventory/receipts/${form.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/inventory/receipts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
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

  const doDelete = async () => {
    if (!form.id || !account) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(`/api/inventory/receipts/${form.id}?account=${encodeURIComponent(account)}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.ok) setErr(json.error || "刪除失敗");
      else {
        onSaved();
        onClose();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "網絡錯誤");
    } finally {
      setSaving(false);
      setAskDelete(false);
    }
  };

  // 加大輸入框：py-3.5 + text-base，品項 row 用 grid 對齊讓格寬合理
  const fieldCls =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-3.5 text-base text-slate-900 outline-none focus:border-slate-400";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-5 pb-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-xl font-semibold text-slate-900">{form.id ? "編輯收據" : "新增收據"}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200"
          >
            關閉
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">供應商</label>
            <input
              list="supplier-list"
              className={fieldCls}
              value={form.merchant_name}
              onChange={(e) => setForm({ ...form, merchant_name: e.target.value })}
              placeholder="輸入或選擇供應商"
            />
            <datalist id="supplier-list">
              {supplierNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">品類</label>
              <input
                className={fieldCls}
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="例如：食材、清潔用品、餐具"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">收據編號</label>
              <input
                className={fieldCls}
                value={form.receipt_number}
                onChange={(e) => setForm({ ...form, receipt_number: e.target.value })}
                placeholder="選填"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">收據日期</label>
            <input
              type="date"
              className={fieldCls}
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">付款方式</label>
              <select
                className={fieldCls}
                value={form.payment_method}
                onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m] ?? m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">付款狀態</label>
              <select
                className={fieldCls}
                value={form.payment_status}
                onChange={(e) => setForm({ ...form, payment_status: e.target.value })}
              >
                <option value="paid">已付款</option>
                <option value="unpaid">未付款</option>
              </select>
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">品項</label>
              <button
                type="button"
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
                onClick={() => setForm({ ...form, items: [...form.items, { name: "", unit_price: "", quantity: "1" }] })}
              >
                ＋ 品項
              </button>
            </div>
            <div className="space-y-2">
              {form.items.map((it, i) => (
                <div key={i} className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <input
                      className={fieldCls}
                      value={it.name}
                      onChange={(e) => setItem(i, { name: e.target.value })}
                      placeholder="品名"
                    />
                  </div>
                  <input
                    className={`${fieldCls} w-28`}
                    inputMode="decimal"
                    value={it.unit_price}
                    onChange={(e) => setItem(i, { unit_price: e.target.value })}
                    placeholder="單價"
                  />
                  <input
                    className={`${fieldCls} w-20`}
                    inputMode="decimal"
                    value={it.quantity}
                    onChange={(e) => setItem(i, { quantity: e.target.value })}
                    placeholder="數量"
                  />
                  <button
                    type="button"
                    className="shrink-0 rounded-xl bg-red-50 px-4 py-3.5 text-base font-medium text-red-600 hover:bg-red-100"
                    onClick={() => setForm({ ...form, items: form.items.filter((_, idx) => idx !== i) })}
                    aria-label="刪除品項"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-xl bg-slate-50 px-4 py-3.5 text-base font-semibold text-slate-900 ring-1 ring-slate-200">
            <span>合計</span>
            <span>{money(total)}</span>
          </div>

          {err && (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">{err}</div>
          )}

          {form.id && !askDelete && (
            <button
              type="button"
              onClick={() => setAskDelete(true)}
              className="w-full rounded-2xl border border-red-200 bg-red-50 py-3 text-base font-semibold text-red-600 hover:bg-red-100"
            >
              刪除收據
            </button>
          )}

          {form.id && askDelete && (
            <div className="space-y-2 rounded-2xl border border-red-200 bg-red-200/40 bg-red-50 p-4">
              <p className="text-sm font-medium text-red-800">確定要刪除這張收據嗎？此操作不可復原。</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAskDelete(false)}
                  className="flex-1 rounded-xl bg-white py-3 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void doDelete()}
                  disabled={saving}
                  className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {saving ? "刪除中…" : "確定刪除"}
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="w-full rounded-2xl bg-emerald-600 py-3.5 text-base font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {saving ? "儲存中…" : "儲存收據"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InventoryView() {
  const [account, setAccount] = useState<string | null>(null);
  const [storeName, setStoreName] = useState<string>("");
  const [merchantId, setMerchantId] = useState<string | null>(null);
  const [range, setRange] = useState<ReportRangeKey>("today");
  const [data, setData] = useState<ReceiptsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formInitial, setFormInitial] = useState<Receipt | null>(null);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  const [merchantDraft, setMerchantDraft] = useState("");
  const [editingSupplier, setEditingSupplier] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    const s = loadAuthSession();
    if (s?.account) {
      setAccount(s.account);
      setStoreName(s.name || "");
      if (s.merchantId) setMerchantId(s.merchantId);
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

  const receipts = useMemo(() => data?.receipts ?? [], [data]);
  const summary = data?.summary;
  const rangeLabel = reportRangeLabel(range);

  const suppliers = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of receipts) if (r.merchant_id) map.set(r.merchant_id, r.merchant_name);
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [receipts]);
  const supplierNames = useMemo(() => suppliers.map((s) => s.name), [suppliers]);

  const doCreateMerchant = async () => {
    if (!account || !merchantDraft.trim()) return;
    try {
      const res = await fetch(`/api/inventory/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, name: merchantDraft.trim() }),
      });
      const json = await res.json();
      if (json.ok) {
        setMerchantDraft("");
        void loadAll();
      } else setDeleteMsg(json.error || "新增供應商失敗");
    } catch {
      setDeleteMsg("網絡錯誤");
    }
  };

  const doDeleteMerchant = async (id: string) => {
    if (!account) return;
    try {
      const res = await fetch(`/api/inventory/merchants/${id}?account=${encodeURIComponent(account)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (json.ok) void loadAll();
      else setDeleteMsg(json.error || "刪除供應商失敗");
    } catch {
      setDeleteMsg("網絡錯誤");
    }
  };

  const doRenameMerchant = async (id: string, name: string) => {
    if (!account || !name.trim()) return;
    try {
      const res = await fetch(`/api/inventory/merchants/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, name: name.trim() }),
      });
      const json = await res.json();
      if (json.ok) {
        setEditingSupplier(null);
        void loadAll();
      } else setDeleteMsg(json.error || "修改供應商失敗");
    } catch {
      setDeleteMsg("網絡錯誤");
    }
  };

  const openReceiptModal = (r: Receipt | null) => {
    setFormInitial(r);
    setFormOpen(true);
  };

  if (!account) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-50 p-6 text-slate-500">
        請先登入 POS 才能檢視庫存。
      </div>
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-slate-50 p-4 text-slate-900 md:p-6">
      <div className="mx-auto max-w-[1600px]">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">庫存管理</h1>
            <p className="text-sm text-slate-500">
              店別：{storeName || account} ・ 帳號：{account}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => openReceiptModal(null)}
              className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"
            >
              ＋ 新增收據
            </button>
            <button
              onClick={() => void loadAll()}
              className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white"
            >
              重新整理
            </button>
          </div>
        </header>

        {/* 時間篩選 */}
        <div className="mb-4 flex flex-wrap gap-2">
          {REPORT_RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setRange(opt.key)}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                range === opt.key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
              }`}
              type="button"
            >
              {opt.label}
            </button>
          ))}
        </div>

        {data && data.schemaReady === false && (
          <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            expenseRecorder 資料表尚未建立（receipts 不存在）。請在 expenseRecorder 專案執行 supabase_schema.sql。
          </div>
        )}
        {data && data.matched === false && (
          <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            在 expenseRecorder 找不到與此 8 位帳號相同的店戶，暫無可顯示的收據。
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">{error}</div>
        )}
        {deleteMsg && (
          <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200">
            {deleteMsg}
            <button type="button" className="ml-2 underline" onClick={() => setDeleteMsg(null)}>
              知道了
            </button>
          </div>
        )}

        {/* KPI */}
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

        {/* 收據清單：點擊任意位置開啟置中 modal（編輯+刪除） */}
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-slate-600">
            收據清單（expenseRecorder・{rangeLabel}）
            <span className="ml-2 text-xs font-normal text-slate-400">點擊任一卡片開啟編輯</span>
          </h2>
          {loading ? (
            <p className="text-sm text-slate-500">載入中…</p>
          ) : receipts.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              尚無收據。點擊「新增收據」建立第一張。
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {receipts.map((r) => {
                const paid = r.payment_status === "paid";
                const lineNo = r.raw_ocr_data?.receipt_number;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => openReceiptModal(r)}
                    className="rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-400 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-300"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-medium text-slate-900">{r.merchant_name}</div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {r.receipt_date}
                          {lineNo ? ` ・ #${lineNo}` : ""} ・ {r.items.length} 項
                        </div>
                        <div className="mt-0.5 text-xs text-slate-400">
                          付款方式：{PAYMENT_METHOD_LABEL[r.payment_method] ?? r.payment_method}
                        </div>
                        {r.category && (
                          <div className="mt-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                            {r.category}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <div className="text-base font-semibold text-slate-900">{money(r.total_amount)}</div>
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                            paid
                              ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                              : "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                          }`}
                        >
                          {STATUS_LABEL[r.payment_status] ?? r.payment_status}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 供應商管理 */}
        <section className="mb-6">
          <h2 className="mb-3 text-sm font-medium text-slate-600">供應商（新增 / 修改 / 刪除）</h2>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex gap-2">
              <input
                className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-900 outline-none focus:border-slate-400"
                value={merchantDraft}
                onChange={(e) => setMerchantDraft(e.target.value)}
                placeholder="新增供應商名稱"
              />
              <button
                type="button"
                onClick={() => void doCreateMerchant()}
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white"
              >
                新增
              </button>
            </div>
            {suppliers.length === 0 ? (
              <div className="text-sm text-slate-400">尚無供應商。</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {suppliers.map((s) => (
                  <li key={s.id} className="flex items-center justify-between py-2">
                    {editingSupplier?.id === s.id ? (
                      <input
                        autoFocus
                        className="flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none"
                        defaultValue={s.name}
                        onBlur={(e) => void doRenameMerchant(s.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter")
                            void doRenameMerchant(s.id, (e.target as HTMLInputElement).value);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="flex-1 text-left text-sm text-slate-700"
                        onClick={() => setEditingSupplier({ id: s.id, name: s.name })}
                      >
                        {s.name}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void doDeleteMerchant(s.id)}
                      className="ml-3 rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-600"
                    >
                      刪除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 庫存表（POS 內建庫存概念） */}
        {merchantId && (
          <InventoryTable merchantId={merchantId} account={account} />
        )}

        {/* 統計（多圖表） */}
        {summary && summary.count > 0 && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">近 6 月支出</div>
              <AreaChart data={summary.monthlyExpenses.map((m) => ({ label: m.name, value: m.amount }))} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">供應商支出佔比（Top 8）</div>
              <DonutChart data={summary.supplierStats.slice(0, 8).map((s) => ({ label: s.name, value: s.total }))} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">付款方式分佈</div>
              {summary.paymentMethodBreakdown.length === 0 ? (
                <div className="text-sm text-slate-400">無資料</div>
              ) : (
                <DonutChart
                  data={summary.paymentMethodBreakdown.map((b) => ({ label: b.label, value: b.total }))}
                />
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-slate-700">付款狀態</div>
              <DonutChart
                data={[
                  { label: "已付", value: summary.paid },
                  { label: "未付", value: summary.unpaid },
                ]}
              />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 xl:col-span-2">
              <div className="mb-2 text-sm font-semibold text-slate-700">價格漲跌趨勢（按月）</div>
              <LineChart data={summary.priceTrendSeries.map((p) => ({ label: p.name, up: p.up, down: p.down }))} />
            </div>

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

      <ReceiptFormModal
        open={formOpen}
        initial={formInitial}
        supplierNames={supplierNames}
        account={account}
        onClose={() => setFormOpen(false)}
        onSaved={() => void loadAll()}
      />
    </div>
  );
}