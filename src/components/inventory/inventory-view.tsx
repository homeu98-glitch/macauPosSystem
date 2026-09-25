"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { loadAuthSession, loadPosLocalSettings, normalizePosLocalSettings, savePosLocalSettings } from "@/lib/storage";
import { REPORT_RANGE_OPTIONS, reportRangeLabel, splitReportRangeArg, type ReportRangeArg, type ReportRangeKey } from "@/lib/ledger/report-period";
import { DateRangeFilterChips } from "@/components/date-range-filter-chips";
import {
  buildPurchaseSummary,
  normalizePaymentMethod,
  paymentMethodLabelMap,
  paymentMethodsForScope,
  DEFAULT_PAYMENT_METHODS,
  type PaymentMethodDef,
  type PurchaseSummary,
} from "@/lib/inventory-stats";
import { AreaChart } from "./charts/AreaChart";
import { DonutChart } from "./charts/DonutChart";
import { LineChart } from "./charts/LineChart";
import { InventoryTable } from "./inventory-table";
import { InventorySettingsPanel, type Supplier } from "./inventory-settings-panel";

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

/** 歷史品項建議（`GET /api/inventory/receipt-items`）。 */
type ItemSuggestion = { name: string; unit_price: number; last_date: string; count: number };

const money = (n: number) =>
  `MOP ${Number(n || 0).toLocaleString("zh-MO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const todayStr = () => new Date().toLocaleDateString("en-CA");

const ALL_METHODS = "all";

/* ---------------- 收據表單（置中 modal，可編輯/刪除） ---------------- */

type FormItem = { name: string; unit_price: string; quantity: string };
type FormState = {
  id?: string;
  /** 由下拉選單揀選時帶 id（server 直接用，唔行 upsert ⇒ 唔會撞 unique）。 */
  merchant_id: string;
  /** 手動輸入／新增時用（server 會 upsert 建立）。 */
  merchant_name: string;
  date: string;
  receipt_number: string;
  category: string;
  payment_method: string;
  payment_status: string;
  items: FormItem[];
};

function emptyForm(paymentMethods: PaymentMethodDef[]): FormState {
  return {
    merchant_id: "",
    merchant_name: "",
    date: todayStr(),
    receipt_number: "",
    category: "",
    // 第一個可用嘅進貨付款方式做預設（主檔次序 = 商家想嘅優先次序）。
    payment_method: paymentMethods[0]?.code ?? "on_delivery",
    payment_status: "unpaid",
    items: [{ name: "", unit_price: "", quantity: "1" }],
  };
}

function formFromReceipt(r: Receipt): FormState {
  return {
    id: r.id,
    merchant_id: r.merchant_id ?? "",
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
  suppliers,
  categories,
  paymentMethods,
  labelMap,
  recentItems,
  account,
  onClose,
  onSaved,
  onSuppliersChanged,
}: {
  open: boolean;
  initial: Receipt | null;
  suppliers: Supplier[];
  categories: string[];
  /** 進貨可見嘅付款方式（已按 scope 過濾，保持主檔次序）。 */
  paymentMethods: PaymentMethodDef[];
  labelMap: Record<string, string>;
  recentItems: ItemSuggestion[];
  account: string;
  onClose: () => void;
  onSaved: () => void;
  onSuppliersChanged: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(() => emptyForm(paymentMethods));
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [askDelete, setAskDelete] = useState(false);

  /** 即時新增供應商（唔使跳出 modal 去「設置」）。 */
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const [supplierHint, setSupplierHint] = useState<{ ok: boolean; text: string } | null>(null);

  /** 品類「其他…」手動輸入模式。 */
  const [manualCategory, setManualCategory] = useState(false);

  /** 目前展開歷史品項建議嘅品項行（-1 = 冇）。 */
  const [pickerIndex, setPickerIndex] = useState<number>(-1);

  useEffect(() => {
    if (open) {
      setForm(initial ? formFromReceipt(initial) : emptyForm(paymentMethods));
      setErr(null);
      setAskDelete(false);
      setShowNewSupplier(false);
      setNewSupplierName("");
      setSupplierHint(null);
      setManualCategory(false);
      setPickerIndex(-1);
    }
    // paymentMethods 唔列入 deps：開 modal 一刻嘅主檔就夠，途中變更唔應該重設用戶輸入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  if (!open) return null;

  const setItem = (i: number, patch: Partial<FormItem>) =>
    setForm((f) => ({ ...f, items: f.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) }));

  const total = form.items.reduce((s, it) => s + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0);

  // 供應商：優先認 id。若收據嘅 merchant_id 唔喺清單入面（例如已被刪／未同步），
  // 兜去「手動輸入」模式用 name 顯示，避免 select 顯示空白。
  const knownSupplier = Boolean(form.merchant_id) && suppliers.some((s) => s.id === form.merchant_id);
  const supplierSelectValue = knownSupplier ? form.merchant_id : form.merchant_name ? "__custom__" : "";
  const showManualSupplier = supplierSelectValue === "__custom__";

  /**
   * 品類選單：設置清單 ∪ 現有值。
   * 舊收據嘅品類可能係自由文字（設置清單未加過），唔可以令佢喺選單消失
   * —— 否則用戶一改其他欄位儲存就會靜靜將品類改走。
   *
   * ⚠️ 刻意**唔用 `useMemo`**：呢個檔上面有 `if (!open) return null` early return，
   * 喺佢之後再呼叫 hook 會直接違反 rules-of-hooks（lint error）。
   * 呢個計算是 O(n) 而且 n 係品類數（幾個），完全冇需要 memo。
   */
  const categoryOptions = (() => {
    const list = [...categories];
    const current = form.category.trim();
    if (current && !list.includes(current)) list.push(current);
    return list;
  })();

  const suggestionsFor = (query: string): ItemSuggestion[] => {
    const q = query.trim().toLowerCase();
    const list = q ? recentItems.filter((i) => i.name.toLowerCase().includes(q)) : recentItems;
    return list.slice(0, 8);
  };

  const applySuggestion = (i: number, s: ItemSuggestion) => {
    setItem(i, {
      name: s.name,
      // 只喺單價空白時才自動填：唔好蓋走用戶已經改過嘅價錢。
      unit_price: form.items[i]?.unit_price?.trim() ? form.items[i].unit_price : String(s.unit_price || ""),
    });
    setPickerIndex(-1);
  };

  const createSupplier = async () => {
    const name = newSupplierName.trim();
    if (!name || creatingSupplier) return;
    setCreatingSupplier(true);
    setSupplierHint(null);
    try {
      const res = await fetch(`/api/inventory/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, name }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        id?: string;
        error?: string;
        code?: string;
        merchant?: { id: string; name: string };
      };
      await onSuppliersChanged();

      if (json.ok && json.id) {
        setForm((f) => ({ ...f, merchant_id: String(json.id), merchant_name: name }));
        setShowNewSupplier(false);
        setNewSupplierName("");
        setSupplierHint({ ok: true, text: `已新增並選用「${name}」。` });
      } else if (json.code === "ALREADY_EXISTS" && json.merchant?.id) {
        // 本店已有同名 → 直接選用，唔當錯誤（用戶目標只係「用呢個供應商」）。
        setForm((f) => ({ ...f, merchant_id: String(json.merchant!.id), merchant_name: json.merchant!.name }));
        setShowNewSupplier(false);
        setNewSupplierName("");
        setSupplierHint({ ok: true, text: `「${json.merchant.name}」已經存在，已自動選用。` });
      } else {
        // NAME_TAKEN = 其他帳號已用同名（全表唯一），要講清楚唔係本店嘅問題。
        setSupplierHint({ ok: false, text: json.error || "新增供應商失敗" });
      }
    } catch {
      setSupplierHint({ ok: false, text: "網絡錯誤" });
    } finally {
      setCreatingSupplier(false);
    }
  };

  const save = async () => {
    setErr(null);
    if (!form.merchant_id && !form.merchant_name.trim()) return setErr("請選擇或輸入供應商");
    if (!form.date) return setErr("請選擇收據日期");
    const items = form.items
      .filter((it) => it.name.trim())
      .map((it) => ({ name: it.name.trim(), unit_price: Number(it.unit_price) || 0, quantity: Number(it.quantity) || 1 }));
    const payload = {
      account,
      // 有 id 就送 id（server 直接採用，唔會 upsert by name ⇒ 唔會撞 unique）；
      // 冇 id（手動輸入／新供應商）先至送 name。
      merchant_id: form.merchant_id || undefined,
      merchant_name: form.merchant_name.trim() || undefined,
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
  /** 觸屏 chip：付款方式／品類都用呢個，唔用下拉（下拉喺觸屏要兩步、選項細）。 */
  const chipCls = (active: boolean) =>
    `rounded-xl px-4 py-3 text-base font-medium transition ${
      active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"
    }`;
  const labelCls = "mb-1.5 block text-sm font-medium text-slate-700";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
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

        <div className="space-y-5">
          {/* ── 供應商：下拉（已有）＋ 即時新增 ── */}
          <div>
            <label className={labelCls}>供應商</label>
            <div className="flex gap-2">
              <select
                className={fieldCls}
                value={supplierSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "__custom__") setForm({ ...form, merchant_id: "", merchant_name: form.merchant_name });
                  else if (!v) setForm({ ...form, merchant_id: "", merchant_name: "" });
                  else {
                    const hit = suppliers.find((s) => s.id === v);
                    setForm({ ...form, merchant_id: v, merchant_name: hit?.name ?? "" });
                  }
                }}
              >
                <option value="">— 選擇供應商 —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value="__custom__">其他（手動輸入）</option>
              </select>
              <button
                type="button"
                onClick={() => {
                  setShowNewSupplier((v) => !v);
                  setSupplierHint(null);
                }}
                className="shrink-0 rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-semibold text-white"
              >
                ＋ 新增
              </button>
            </div>

            {showNewSupplier && (
              <div className="mt-2 flex gap-2">
                <input
                  autoFocus
                  className={fieldCls}
                  value={newSupplierName}
                  onChange={(e) => setNewSupplierName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createSupplier();
                  }}
                  placeholder="新供應商名稱，撳「建立」"
                  aria-label="新供應商名稱"
                />
                <button
                  type="button"
                  onClick={() => void createSupplier()}
                  disabled={creatingSupplier}
                  className="shrink-0 rounded-xl bg-emerald-600 px-4 py-3.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {creatingSupplier ? "建立中…" : "建立"}
                </button>
              </div>
            )}

            {showManualSupplier && (
              <input
                className={`${fieldCls} mt-2`}
                value={form.merchant_name}
                onChange={(e) => setForm({ ...form, merchant_id: "", merchant_name: e.target.value })}
                placeholder="輸入供應商名稱（新的會自動建立）"
                aria-label="供應商名稱"
              />
            )}

            {supplierHint && (
              <p
                className={`mt-2 rounded-xl px-3 py-2 text-xs font-medium ${
                  supplierHint.ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-800"
                }`}
              >
                {supplierHint.text}
              </p>
            )}

            <p className="mt-1.5 text-xs text-slate-400">
              {suppliers.length === 0
                ? "尚無供應商，撳「＋ 新增」即時建立。"
                : "由已建立的供應商選擇；揀現有供應商唔會重複建立。"}
            </p>
          </div>

          {/* ── 品類：chip 直接揀（觸屏），清單由「設置」管理 ── */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700">品類</label>
              <button
                type="button"
                onClick={() => {
                  setManualCategory((v) => !v);
                  if (manualCategory) setForm((f) => ({ ...f, category: "" }));
                }}
                className="text-xs font-medium text-slate-500 underline"
              >
                {manualCategory ? "改為揀清單" : "其他（手動輸入）"}
              </button>
            </div>
            {manualCategory || categoryOptions.length === 0 ? (
              <>
                <input
                  className={fieldCls}
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="輸入品類（例如：食材）"
                  aria-label="品類"
                />
                {categoryOptions.length === 0 && (
                  <p className="mt-1.5 text-xs text-slate-400">
                    未建立品類清單。可以喺「庫存 → 設置 → 品類」建立，之後就唔使每次手打。
                  </p>
                )}
              </>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={chipCls(!form.category)}
                  onClick={() => setForm({ ...form, category: "" })}
                >
                  不指定
                </button>
                {categoryOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={chipCls(form.category === c)}
                    onClick={() => setForm({ ...form, category: c })}
                  >
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className={labelCls}>收據編號</label>
              <input
                className={fieldCls}
                value={form.receipt_number}
                onChange={(e) => setForm({ ...form, receipt_number: e.target.value })}
                placeholder="選填"
              />
            </div>
            <div>
              <label className={labelCls}>收據日期</label>
              <input
                type="date"
                className={fieldCls}
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </div>
          </div>

          {/* ── 付款方式：chip（主檔驅動） ── */}
          <div>
            <label className={labelCls}>付款方式</label>
            <div className="flex flex-wrap gap-2">
              {paymentMethods.length === 0 ? (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  系統未設定任何「進貨」付款方式，請聯絡管理員喺後台設定。
                </p>
              ) : (
                paymentMethods.map((m) => (
                  <button
                    key={m.code}
                    type="button"
                    className={chipCls(form.payment_method === m.code)}
                    onClick={() => setForm({ ...form, payment_method: m.code })}
                  >
                    {m.label}
                  </button>
                ))
              )}
            </div>
            {/* 舊收據嘅付款方式若唔喺主檔（已停用／被改），仍然要顯示得到，否則一儲存就靜靜改走。 */}
            {form.payment_method &&
              !paymentMethods.some((m) => m.code === form.payment_method) && (
                <p className="mt-1.5 text-xs text-amber-700">
                  原本係「{labelMap[form.payment_method] ?? form.payment_method}」（呢個方式已停用或唔喺主檔）。
                  揀上面任何一個就會覆蓋。
                </p>
              )}
          </div>

          <div>
            <label className={labelCls}>付款狀態</label>
            <div className="flex flex-wrap gap-2">
              {([
                { code: "unpaid", label: "未付款" },
                { code: "paid", label: "已付款" },
              ] as const).map((s) => (
                <button
                  key={s.code}
                  type="button"
                  className={chipCls(form.payment_status === s.code)}
                  onClick={() => setForm({ ...form, payment_status: s.code })}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-slate-400">
              「月結」通常先記「未付款」，月底結算後記得返嚟改做「已付款」。
            </p>
          </div>

          {/* ── 品項：支援歷史品項快速選取 ── */}
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
            <div className="space-y-3">
              {form.items.map((it, i) => {
                const suggestions = pickerIndex === i ? suggestionsFor(it.name) : [];
                return (
                  <div key={i}>
                    {/* 🔴 2026-09-25 修正：以前係 `flex` + `${fieldCls} w-28`，而 fieldCls
                        內含 `w-full`；本專案 Tailwind v4 產生順序係 `.w-full` 喺 `.w-28`
                        之後 ⇒ `w-full` 勝出 ⇒ 單價／數量 flex-basis = 100%，
                        `flex-1`（basis 0）嘅品名欄分到 **0 寬** ⇒ 睇唔到亦撳唔到。
                        改用 grid 固定軌寬（每格入面 w-full = 軌寬，唔會再互相搶位），
                        窄螢幕則換行：品名一整行，單價／數量／刪除第二行。 */}
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_5rem_auto]">
                      <div className="col-span-2 min-w-0 sm:col-span-1">
                        <input
                          className={fieldCls}
                          value={it.name}
                          onChange={(e) => {
                            setItem(i, { name: e.target.value });
                            setPickerIndex(i);
                          }}
                          onFocus={() => setPickerIndex(i)}
                          onBlur={() => window.setTimeout(() => setPickerIndex((cur) => (cur === i ? -1 : cur)), 150)}
                          placeholder="品名"
                          aria-label={`第 ${i + 1} 項品名`}
                        />
                      </div>
                      <input
                        className={fieldCls}
                        inputMode="decimal"
                        value={it.unit_price}
                        onChange={(e) => setItem(i, { unit_price: e.target.value })}
                        placeholder="單價"
                        aria-label={`第 ${i + 1} 項單價`}
                      />
                      <input
                        className={fieldCls}
                        inputMode="decimal"
                        value={it.quantity}
                        onChange={(e) => setItem(i, { quantity: e.target.value })}
                        placeholder="數量"
                        aria-label={`第 ${i + 1} 項數量`}
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

                    {suggestions.length > 0 && (
                      <div className="mt-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                        <p className="px-2 pb-1 text-xs font-medium text-slate-500">
                          最近用過（撳一下自動填入品名，單價空白時一併填入）
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {suggestions.map((s) => (
                            <button
                              key={s.name}
                              type="button"
                              /* 🔴 用 onPointerDown + preventDefault 而唔係 onClick：
                                 撳落去嘅一刻 input 會先 blur，而 onBlur 會收埋個建議清單
                                 ⇒ onClick 永遠唔會觸發（建議清單「撳唔到」）。 */
                              onPointerDown={(e) => {
                                e.preventDefault();
                                applySuggestion(i, s);
                              }}
                              className="rounded-xl bg-white px-3 py-2.5 text-sm font-medium text-slate-800 ring-1 ring-slate-200"
                            >
                              {s.name}
                              {s.unit_price ? (
                                <span className="ml-2 text-xs font-normal text-slate-400">
                                  {money(s.unit_price)}
                                </span>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
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
            <div className="space-y-2 rounded-2xl border border-red-200 bg-red-50 p-4">
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
  /** 時間範圍（2026-09-13 加「自訂」後升級為 ReportRangeArg）。 */
  const [range, setRange] = useState<ReportRangeArg>("today");
  const [data, setData] = useState<ReceiptsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [formInitial, setFormInitial] = useState<Receipt | null>(null);

  /** 供應商**全部**清單（直接由 merchants 表讀，唔再由收據反推）。 */
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  /** 撞「已存在」時 highlight 返嗰個供應商（設置面板內）。 */
  const [highlightSupplierId, setHighlightSupplierId] = useState<string | null>(null);
  /** 「庫存・設置」面板（供應商＋品類）。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 進貨品類清單（來源：`PosLocalSettings.invCategories`）。 */
  const [categories, setCategories] = useState<string[]>([]);

  /**
   * 支付方式主檔（admin 統一設置，`GET /api/inventory/payment-methods`）。
   * 初值用內建預設，避免首屏付款方式 chip 一片空白（會閃一下）。
   */
  const [masterMethods, setMasterMethods] = useState<PaymentMethodDef[]>(DEFAULT_PAYMENT_METHODS);
  const [masterWarning, setMasterWarning] = useState<string | null>(null);

  /** 歷史品項建議（`GET /api/inventory/receipt-items`），開 modal 時用。 */
  const [recentItems, setRecentItems] = useState<ItemSuggestion[]>([]);

  /** 付款方式篩選：`"all"` 或其中一個 method code。 */
  const [methodFilter, setMethodFilter] = useState<string>(ALL_METHODS);

  useEffect(() => {
    const s = loadAuthSession();
    if (s?.account) {
      setAccount(s.account);
      setStoreName(s.name || "");
      if (s.merchantId) setMerchantId(s.merchantId);
    }
    setCategories(loadPosLocalSettings().invCategories);
  }, []);

  const loadAll = useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    try {
      const { key, custom } = splitReportRangeArg(range);
      const qs = new URLSearchParams({ account, range: key });
      if (key === "custom" && custom) {
        qs.set("start", custom.start);
        qs.set("end", custom.end);
      }
      const res = await fetch(`/api/inventory/receipts?${qs.toString()}`);
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
  const rangeLabel = reportRangeLabel(range);

  /**
   * 🔴 2026-09-25：供應商改由 `GET /api/inventory/merchants` 讀全量。
   * 舊寫法係由「range 過濾後嘅 receipts」反推 ⇒ 冇收據嘅供應商唔會出現、
   * 換 range 又會消失，係「新增咗但睇唔到」同「重複新增撞 key」嘅根因。
   */
  const loadSuppliers = useCallback(async () => {
    if (!account) return;
    try {
      const res = await fetch(`/api/inventory/merchants?account=${encodeURIComponent(account)}`);
      const json = (await res.json()) as { ok?: boolean; merchants?: Array<{ id: string; name: string }> };
      if (json.ok && Array.isArray(json.merchants)) {
        setSuppliers(
          json.merchants
            .map((m) => ({ id: String(m.id), name: String(m.name ?? "") }))
            .filter((m) => m.id && m.name),
        );
      } else setSuppliers([]);
    } catch {
      setSuppliers([]);
    }
  }, [account]);

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  /** 讀 admin 支付方式主檔（一個細請求，失敗都用內建預設頂住）。 */
  const loadPaymentMethods = useCallback(async () => {
    try {
      const res = await fetch(`/api/inventory/payment-methods`);
      const json = (await res.json()) as {
        ok?: boolean;
        methods?: PaymentMethodDef[];
        warning?: string;
      };
      if (json.ok && Array.isArray(json.methods)) {
        setMasterMethods(json.methods);
        setMasterWarning(json.warning ?? null);
      }
    } catch {
      // 網絡問題：維持內建預設，唔中斷庫存頁。
    }
  }, []);

  useEffect(() => {
    void loadPaymentMethods();
  }, [loadPaymentMethods]);

  /** 讀歷史品項（用嚟做新增收據嘅快速選取）。 */
  const loadRecentItems = useCallback(async () => {
    if (!account) return;
    try {
      const res = await fetch(`/api/inventory/receipt-items?account=${encodeURIComponent(account)}`);
      const json = (await res.json()) as { ok?: boolean; items?: ItemSuggestion[] };
      if (json.ok && Array.isArray(json.items)) setRecentItems(json.items);
      else setRecentItems([]);
    } catch {
      setRecentItems([]);
    }
  }, [account]);

  useEffect(() => {
    void loadRecentItems();
  }, [loadRecentItems]);

  /** 儲存品類清單（門店層設定，經 `PosLocalSettings` 同步）。 */
  const saveCategories = useCallback(async (next: string[]) => {
    const merged = normalizePosLocalSettings({ ...loadPosLocalSettings(), invCategories: next });
    savePosLocalSettings(merged);
    setCategories(merged.invCategories);
  }, []);

  /** 進貨可見嘅付款方式（主檔 + scope 過濾）。 */
  const purchaseMethods = useMemo(() => paymentMethodsForScope(masterMethods, "purchase"), [masterMethods]);

  /** code → 顯示名（主檔優先，內建標籤兜底，令舊單據嘅 key 唔會變裸英文）。 */
  const labelMap = useMemo(() => paymentMethodLabelMap(masterMethods), [masterMethods]);

  /**
   * 付款方式篩選（2026-09-25 加）：client-side 過濾，**零新增請求**。
   * 由範圍查詢本身已經拉齊晒 range 內嘅收據，喺本機再揀付款方式最慳 egress。
   */
  const methodCounts = useMemo(() => {
    const map = new Map<string, number>();
    // normalize：expenseRecorder 舊資料有機會存中文（「月結」），server 雖然已經正規化，
    // 呢度再兜一次，確保「月結」chip 數得到。
    for (const r of receipts) {
      const key = normalizePaymentMethod(r.payment_method);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [receipts]);

  /**
   * 篩選 chip 嘅 key 集合 = **主檔全部 code** ∪ **當前資料出現過嘅 code**。
   *
   * 為何唔淨係用主檔：admin 停用／改走某個 code 之後，舊收據照樣存住嗰個 code。
   * 若 chip 只跟主檔，嗰批舊單就會**冇任何 chip 撳得到**（＝篩選唔到，亦睇唔出有幾多張）。
   * 為何唔淨係用資料：呢個正是 2026-09-25「睇唔到有月結選項」嘅根因
   * —— 當月結收據數為 0，chip 就完全唔出現，商家以為冇呢個功能。
   */
  const methodFilterKeys = useMemo(() => {
    const keys: string[] = [];
    const push = (k: string) => {
      if (k && !keys.includes(k)) keys.push(k);
    };
    for (const m of masterMethods) push(m.code);
    for (const r of receipts) push(normalizePaymentMethod(r.payment_method));
    return keys;
  }, [masterMethods, receipts]);

  const methodFilterOptions = useMemo(
    () => [
      { key: ALL_METHODS, label: `全部（${receipts.length}）` },
      ...methodFilterKeys.map((m) => ({
        key: m,
        // 0 張都會出現（只要喺主檔內）：唔會因為暫時冇月結收據而「睇唔到有月結呢個選項」。
        label: `${labelMap[m] ?? m}（${methodCounts.get(m) ?? 0}）`,
      })),
    ],
    [receipts.length, methodFilterKeys, methodCounts, labelMap],
  );

  const visibleReceipts = useMemo(
    () =>
      methodFilter === ALL_METHODS
        ? receipts
        : receipts.filter((r) => normalizePaymentMethod(r.payment_method) === methodFilter),
    [receipts, methodFilter],
  );

  /**
   * KPI／統計一定要跟住篩選行，否則「淨睇月結」時上面嘅總支出仍然係全部付款方式，
   * 兩個數字互相打臉。server 只計 range，所以非「全部」時喺本機用同一個
   * `buildPurchaseSummary()` 重算（純函式，口徑同 server 一致）。
   */
  const summary: PurchaseSummary | undefined = useMemo(() => {
    if (!data) return undefined;
    if (methodFilter === ALL_METHODS) return data.summary;
    return buildPurchaseSummary(visibleReceipts);
  }, [data, methodFilter, visibleReceipts]);

  const methodLabel = methodFilter === ALL_METHODS ? "" : `${labelMap[methodFilter] ?? methodFilter}・`;

  const openReceiptModal = (r: Receipt | null) => {
    setFormInitial(r);
    setFormOpen(true);
    void loadRecentItems();
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
            {/* 供應商／品類由主頁搬入「設置」：避免每日用嘅收據清單被主檔管理推到下面，
                同時令刪除供應商呢類破壞性操作多一步（觸屏誤觸成本高）。 */}
            <button
              onClick={() => {
                setHighlightSupplierId(null);
                setSettingsOpen(true);
              }}
              className="rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-slate-700 ring-1 ring-slate-200"
            >
              設置
            </button>
            <button
              onClick={() => void loadAll()}
              className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white"
            >
              重新整理
            </button>
          </div>
        </header>

        {/* 時間篩選（2026-09-13：改用共用元件，加「自訂」） */}
        <div className="mb-4 flex flex-wrap gap-2">
          <DateRangeFilterChips
            options={REPORT_RANGE_OPTIONS}
            value={splitReportRangeArg(range).key}
            custom={splitReportRangeArg(range).custom}
            onChange={(key, custom) => setRange(custom ? { key, custom } : key)}
          />
        </div>

        {/* 付款方式篩選（2026-09-25：改由 admin 主檔驅動） */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500">付款方式</span>
          <DateRangeFilterChips
            options={methodFilterOptions}
            value={methodFilter}
            onChange={(key) => setMethodFilter(key)}
          />
        </div>

        {masterWarning && (
          <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            {masterWarning}
          </div>
        )}
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
        {/* KPI */}
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">
              {rangeLabel}
              {methodLabel}總支出
            </div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{money(summary?.total ?? 0)}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">收據數</div>
            <div className="mt-1 text-lg font-semibold text-slate-900">
              {summary?.count ?? 0}
              {methodFilter !== ALL_METHODS && visibleReceipts.length !== receipts.length ? (
                <span className="ml-1 text-xs font-normal text-slate-400">／{receipts.length}</span>
              ) : null}
            </div>
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
            收據清單（expenseRecorder・{rangeLabel}
            {methodFilter !== ALL_METHODS ? `・${labelMap[methodFilter] ?? methodFilter}` : ""}）
            <span className="ml-2 text-xs font-normal text-slate-400">
              共 {visibleReceipts.length} 張
              {methodFilter !== ALL_METHODS ? `（全部付款方式 ${receipts.length} 張）` : ""} ・ 點擊任一卡片開啟編輯
            </span>
          </h2>
          {loading ? (
            <p className="text-sm text-slate-500">載入中…</p>
          ) : receipts.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              尚無收據。點擊「新增收據」建立第一張。
            </div>
          ) : visibleReceipts.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              {rangeLabel}內冇「{labelMap[methodFilter] ?? methodFilter}」嘅收據（共 {receipts.length} 張其他付款方式）。
              <button type="button" className="ml-2 underline" onClick={() => setMethodFilter(ALL_METHODS)}>
                睇全部
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {visibleReceipts.map((r) => {
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
                          付款方式：{labelMap[normalizePaymentMethod(r.payment_method)] ?? r.payment_method}
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
                          {paid ? "已付款" : "未付款"}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
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
                  data={summary.paymentMethodBreakdown.map((b) => ({
                    label: labelMap[b.method] ?? b.label,
                    value: b.total,
                  }))}
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
        suppliers={suppliers}
        categories={categories}
        paymentMethods={purchaseMethods}
        labelMap={labelMap}
        recentItems={recentItems}
        account={account}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          void loadAll();
          void loadSuppliers();
          void loadRecentItems();
        }}
        onSuppliersChanged={async () => {
          await loadSuppliers();
        }}
      />

      <InventorySettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        account={account}
        suppliers={suppliers}
        onSuppliersChanged={async () => {
          await loadSuppliers();
          await loadAll();
        }}
        categories={categories}
        onSaveCategories={saveCategories}
        highlightSupplierId={highlightSupplierId}
      />
    </div>
  );
}
