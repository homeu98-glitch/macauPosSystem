"use client";

import { useEffect, useState } from "react";

/** 供應商（來源：expenseRecorder `merchants`，經 `GET /api/inventory/merchants`）。 */
export type Supplier = { id: string; name: string };

type Tab = "supplier" | "category";

type Msg = { ok: boolean; text: string } | null;

/**
 * 「庫存・設置」面板（2026-09-25）。
 *
 * 為何要把供應商 CRUD 由主頁搬入嚟：原本供應商嘅新增／改名／刪除**直接攤喺庫存頁中間**，
 * 每日都用到嘅收據清單反而被推到下面；而且收銀台多數係觸屏，誤觸「刪除」成本好高。
 * 搬入一個要主動撳入嚟嘅設置面板之後：
 *   · 主頁只剩「收據 + 庫存 + 統計」；
 *   · 刪除改為**兩步確認**；
 *   · 品類同供應商擺埋一齊（兩者都係「開單時要揀嘅主檔」）。
 *
 * ⚠️ 供應商係**跨店全表唯一**（expenseRecorder `merchants.name` 有全域 unique 約束）。
 *    所以同一間分店唔可以各自建一個同名供應商，撞名時
 *    `POST /api/inventory/merchants` 會回 `ALREADY_EXISTS`（本店已有）或
 *    `NAME_TAKEN`（其他店已用），兩者嘅文案已經分開講清楚。
 */
export function InventorySettingsPanel({
  open,
  onClose,
  account,
  suppliers,
  onSuppliersChanged,
  categories,
  onSaveCategories,
  highlightSupplierId,
}: {
  open: boolean;
  onClose: () => void;
  account: string;
  suppliers: Supplier[];
  onSuppliersChanged: () => void | Promise<void>;
  categories: string[];
  onSaveCategories: (next: string[]) => void | Promise<void>;
  /** 撞「本店已存在」時要高亮返嗰一行，令用戶知佢其實一早喺度。 */
  highlightSupplierId?: string | null;
}) {
  const [tab, setTab] = useState<Tab>("supplier");
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const [supplierDraft, setSupplierDraft] = useState("");
  const [editingSupplier, setEditingSupplier] = useState<{ id: string; name: string } | null>(null);
  const [confirmDeleteSupplierId, setConfirmDeleteSupplierId] = useState<string | null>(null);

  const [categoryDraft, setCategoryDraft] = useState("");
  const [editingCategory, setEditingCategory] = useState<{ from: string; to: string } | null>(null);
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMsg(null);
      setEditingSupplier(null);
      setConfirmDeleteSupplierId(null);
      setEditingCategory(null);
      setConfirmDeleteCategory(null);
    }
  }, [open]);

  if (!open) return null;

  /* ─────────────── 供應商 ─────────────── */

  async function createSupplier() {
    const name = supplierDraft.trim();
    if (!name || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/inventory/merchants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, name }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; code?: string };
      await onSuppliersChanged();
      if (json.ok) {
        setSupplierDraft("");
        setMsg({ ok: true, text: `已新增「${name}」，可以喺新增收據時選用。` });
      } else {
        // 撞名唔清空輸入：等用戶睇到係邊個名撞，方便改字。
        setMsg({ ok: false, text: json.error || "新增供應商失敗" });
      }
    } catch {
      setMsg({ ok: false, text: "網絡錯誤" });
    } finally {
      setBusy(false);
    }
  }

  async function renameSupplier(id: string, name: string) {
    const trimmed = name.trim();
    const current = suppliers.find((s) => s.id === id)?.name ?? "";
    if (!trimmed || trimmed === current) {
      setEditingSupplier(null);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/inventory/merchants/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, name: trimmed }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      await onSuppliersChanged();
      setEditingSupplier(null);
      setMsg(json.ok ? { ok: true, text: "已更新供應商名稱。" } : { ok: false, text: json.error || "修改失敗" });
    } catch {
      setMsg({ ok: false, text: "網絡錯誤" });
    } finally {
      setBusy(false);
    }
  }

  async function deleteSupplier(id: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/inventory/merchants/${id}?account=${encodeURIComponent(account)}`, {
        method: "DELETE",
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      await onSuppliersChanged();
      setConfirmDeleteSupplierId(null);
      setMsg(json.ok ? { ok: true, text: "已刪除供應商。" } : { ok: false, text: json.error || "刪除失敗" });
    } catch {
      setMsg({ ok: false, text: "網絡錯誤" });
    } finally {
      setBusy(false);
    }
  }

  /* ─────────────── 品類 ─────────────── */

  async function addCategory() {
    const name = categoryDraft.trim();
    if (!name) return;
    if (categories.some((c) => c === name)) {
      setMsg({ ok: false, text: `已經有「${name}」呢個品類。` });
      return;
    }
    await onSaveCategories([...categories, name]);
    setCategoryDraft("");
    setMsg({ ok: true, text: `已新增品類「${name}」。` });
  }

  async function renameCategory(from: string, to: string) {
    const trimmed = to.trim();
    if (!trimmed || trimmed === from) {
      setEditingCategory(null);
      return;
    }
    if (categories.some((c) => c === trimmed)) {
      setMsg({ ok: false, text: `已經有「${trimmed}」呢個品類。` });
      setEditingCategory(null);
      return;
    }
    await onSaveCategories(categories.map((c) => (c === from ? trimmed : c)));
    setEditingCategory(null);
    setMsg({
      ok: true,
      text: `已改名為「${trimmed}」。⚠️ 舊收據仍然顯示「${from}」，改名唔會追溯。`,
    });
  }

  async function deleteCategory(name: string) {
    await onSaveCategories(categories.filter((c) => c !== name));
    setConfirmDeleteCategory(null);
    setMsg({ ok: true, text: `已刪除品類「${name}」。舊收據不受影響。` });
  }

  /* ─────────────── 共用 UI ─────────────── */

  const fieldCls =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-base text-slate-900 outline-none focus:border-slate-400";
  // 觸屏：所有可撳元素最少 44px 高，唔用 text-xs 做撳制文字。
  const btnPrimary = "rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50";
  const btnGhost = "rounded-xl bg-white px-4 py-3 text-sm font-medium text-slate-700 ring-1 ring-slate-200";
  const btnDanger = "rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-600 ring-1 ring-red-200";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="text-xl font-semibold text-slate-900">庫存・設置</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              供應商同品類都係「開單時要揀嘅主檔」，喺呢度集中管理
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700">
            關閉
          </button>
        </div>

        {/* 分頁：觸屏用大按鈕，唔用下拉 */}
        <div className="flex gap-2 px-5 pt-4">
          {([
            { id: "supplier" as const, label: `供應商（${suppliers.length}）` },
            { id: "category" as const, label: `品類（${categories.length}）` },
          ]).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
                setMsg(null);
              }}
              className={`flex-1 rounded-xl px-4 py-3 text-sm font-semibold transition ${
                tab === t.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {msg && (
            <div
              className={`flex items-start justify-between gap-3 rounded-xl px-4 py-3 text-sm ring-1 ${
                msg.ok ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-amber-50 text-amber-800 ring-amber-200"
              }`}
            >
              <span>{msg.text}</span>
              <button type="button" className="shrink-0 underline" onClick={() => setMsg(null)}>
                知道了
              </button>
            </div>
          )}

          {tab === "supplier" ? (
            <>
              <div className="flex gap-2">
                <input
                  className={fieldCls}
                  value={supplierDraft}
                  onChange={(e) => setSupplierDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void createSupplier();
                  }}
                  placeholder="輸入供應商名稱"
                  aria-label="新增供應商名稱"
                />
                <button type="button" onClick={() => void createSupplier()} disabled={busy} className={btnPrimary}>
                  新增
                </button>
              </div>

              <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500 ring-1 ring-slate-100">
                ⚠️ 供應商名稱係<b>全系統唯一</b>：如果另一個帳號已經用過同一個名，
                你嘅店就建立唔到（系統會明確講明係「已被其他帳號使用」）。
                相同名稱嘅供應商只會有一個，收據仍然各自掛喺自己嘅店。
              </p>

              {suppliers.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                  尚無供應商。喺上面輸入名稱撳「新增」就得，之後開收據會直接出現喺選單。
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
                  {suppliers.map((s) => (
                    <li
                      key={s.id}
                      className={`px-4 py-3 ${
                        highlightSupplierId === s.id ? "bg-amber-50 ring-1 ring-inset ring-amber-300" : ""
                      }`}
                    >
                      {editingSupplier?.id === s.id ? (
                        <input
                          autoFocus
                          className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-base outline-none"
                          defaultValue={s.name}
                          onBlur={(e) => void renameSupplier(s.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void renameSupplier(s.id, (e.target as HTMLInputElement).value);
                            if (e.key === "Escape") setEditingSupplier(null);
                          }}
                        />
                      ) : confirmDeleteSupplierId === s.id ? (
                        <div className="space-y-2">
                          <p className="text-sm font-medium text-red-700">
                            確定刪除「{s.name}」？已經有用過嘅收據會擋住刪除。
                          </p>
                          <div className="flex gap-2">
                            <button type="button" className={`${btnGhost} flex-1`} onClick={() => setConfirmDeleteSupplierId(null)}>
                              取消
                            </button>
                            <button
                              type="button"
                              className="flex-1 rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                              disabled={busy}
                              onClick={() => void deleteSupplier(s.id)}
                            >
                              確定刪除
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left text-base text-slate-800"
                            onClick={() => setEditingSupplier({ id: s.id, name: s.name })}
                            title="撳一下改名"
                          >
                            {s.name}
                          </button>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              className={btnGhost}
                              onClick={() => setEditingSupplier({ id: s.id, name: s.name })}
                            >
                              改名
                            </button>
                            <button type="button" className={btnDanger} onClick={() => setConfirmDeleteSupplierId(s.id)}>
                              刪除
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  className={fieldCls}
                  value={categoryDraft}
                  onChange={(e) => setCategoryDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addCategory();
                  }}
                  placeholder="輸入品類名稱（例如：食材）"
                  aria-label="新增品類名稱"
                />
                <button type="button" onClick={() => void addCategory()} className={btnPrimary}>
                  新增
                </button>
              </div>

              <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-500 ring-1 ring-slate-100">
                品類只係你門店自己嘅分類標籤，唔影響帳目。喺呢度建好之後，
                新增收據／庫存單嘅「品類」欄就會變成直接揀，唔使每次手打。
              </p>

              {categories.length === 0 ? (
                <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
                  尚無品類。冇品類都開得到收據（品類欄可以手動輸入），但建立清單之後會快好多。
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
                  {categories.map((c) => (
                    <li key={c} className="px-4 py-3">
                      {editingCategory?.from === c ? (
                        <input
                          autoFocus
                          className="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-base outline-none"
                          defaultValue={c}
                          onBlur={(e) => void renameCategory(c, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void renameCategory(c, (e.target as HTMLInputElement).value);
                            if (e.key === "Escape") setEditingCategory(null);
                          }}
                        />
                      ) : confirmDeleteCategory === c ? (
                        <div className="space-y-2">
                          <p className="text-sm font-medium text-red-700">確定刪除品類「{c}」？（舊收據唔會受影響）</p>
                          <div className="flex gap-2">
                            <button type="button" className={`${btnGhost} flex-1`} onClick={() => setConfirmDeleteCategory(null)}>
                              取消
                            </button>
                            <button
                              type="button"
                              className="flex-1 rounded-xl bg-red-600 px-4 py-3 text-sm font-semibold text-white"
                              onClick={() => void deleteCategory(c)}
                            >
                              確定刪除
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-base text-slate-800">{c}</span>
                          <div className="flex shrink-0 gap-2">
                            <button
                              type="button"
                              className={btnGhost}
                              onClick={() => setEditingCategory({ from: c, to: c })}
                            >
                              改名
                            </button>
                            <button type="button" className={btnDanger} onClick={() => setConfirmDeleteCategory(c)}>
                              刪除
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
