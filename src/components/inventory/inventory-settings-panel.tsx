"use client";

import { useEffect, useRef, useState } from "react";

import { moveWithin, orderKeys, reorderByStored, usageCount } from "@/lib/inventory-order";
import type { PaymentMethodDef } from "@/lib/inventory-stats";

import { InventoryTable } from "./inventory-table";

/** 供應商（來源：expenseRecorder `merchants`，經 `GET /api/inventory/merchants`）。 */
export type Supplier = { id: string; name: string };

/**
 * 設置面板嘅四個區塊（＝確認稿 `scr-set` 嘅 4 個 chips）。
 *
 * 為何係「多選」而唔係四選一嘅 tab：
 * 確認稿畫嘅係**供應商 ＋ 品類兩個 panel 同時並排**（兩者都係「開單時要揀嘅主檔」，
 * 擺埋一齊睇先知道邊個供應商／品類仲未建）。單選 tab 會令商家要撳兩次先睇齊兩邊。
 * 所以 chips ＝「要唔要顯示呢個 panel」，預設開 供應商 ＋ 品類，最少要開一個。
 */
type PanelId = "supplier" | "category" | "product" | "payment";

const PANEL_ORDER: PanelId[] = ["supplier", "category", "product", "payment"];

const PANEL_LABEL: Record<PanelId, string> = {
  supplier: "供應商",
  category: "品類",
  product: "庫存品",
  payment: "支付方式顯示",
};

type Msg = { ok: boolean; text: string } | null;

type DragState = { kind: "supplier" | "category"; from: number; to: number };

/**
 * 「庫存・設置」面板（2026-09-25 初版、2026-09-26 對齊確認稿）。
 *
 * ## 為何係彈窗而唔係獨立一頁（商家拍板）
 *
 * 確認稿係全頁畫面；商家明確要求**保持彈窗**。彈窗好處：唔會離開庫存頁
 * （改完供應商即刻返去開單）、唔會多一條可以直接輸入／refresh 嘅路徑。
 * 所以呢度用 `max-w-5xl` 嘅寬彈窗去容納「兩個 panel 並排」。
 *
 * ## 為何唔加「保存」按鈕（同確認稿唔同，刻意）
 *
 * 確認稿右上角有「保存」。但呢個面板嘅每一項操作（新增／改名／刪除）都係
 * **即時寫入**（打 API 或寫 local settings），冇 pending state。加一個唔知
 * 儲存咩嘅「保存」只會令商家以為「唔撳就唔會生效」⇒ 反而製造資料遺失。
 * 所以改用「完成」，並喺標題下面寫明「改動即時儲存」。
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
  merchantId,
  suppliers,
  onSuppliersChanged,
  supplierOrder,
  onSaveSupplierOrder,
  categories,
  categoryOrder,
  onSaveCategories,
  onSaveCategoryOrder,
  paymentMethods,
  paymentWarning,
  highlightSupplierId,
  onProductsChanged,
}: {
  open: boolean;
  onClose: () => void;
  account: string;
  /** 庫存品 panel 用（`InventoryTable` 需要）。 */
  merchantId?: string | null;
  suppliers: Supplier[];
  onSuppliersChanged: () => void | Promise<void>;
  /** 供應商顯示次序（`PosLocalSettings.invSupplierOrder`，存名字）。 */
  supplierOrder: string[];
  onSaveSupplierOrder: (next: string[]) => void | Promise<void>;
  categories: string[];
  /** 品類顯示次序（`PosLocalSettings.invCategoryOrder`）。 */
  categoryOrder: string[];
  onSaveCategoryOrder: (next: string[]) => void | Promise<void>;
  onSaveCategories: (next: string[]) => void | Promise<void>;
  /** 支付方式主檔（唯讀；由 expenseRecorder admin 派發）。 */
  paymentMethods: PaymentMethodDef[];
  paymentWarning?: string | null;
  /** 撞「本店已存在」時要高亮返嗰一行，令用戶知佢其實一早喺度。 */
  highlightSupplierId?: string | null;
  /** 庫存品有改動（新增／刪除／盤點／同步）→ 通知主頁刷新。 */
  onProductsChanged?: () => void;
}) {
  const [visible, setVisible] = useState<Record<PanelId, boolean>>({
    supplier: true,
    category: true,
    product: false,
    payment: false,
  });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const [supplierDraft, setSupplierDraft] = useState("");
  const [editingSupplier, setEditingSupplier] = useState<{ id: string; name: string } | null>(null);
  const [confirmDeleteSupplierId, setConfirmDeleteSupplierId] = useState<string | null>(null);

  const [categoryDraft, setCategoryDraft] = useState("");
  const [editingCategory, setEditingCategory] = useState<{ from: string; to: string } | null>(null);
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState<string | null>(null);

  /** 「用過 N 次」（lazy：只喺供應商 panel 開住嘅時候先拉一次）。 */
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [usageNote, setUsageNote] = useState<string | null>(null);
  const [usageTick, setUsageTick] = useState(0);

  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragRef = useRef<{ kind: "supplier" | "category"; from: number; to: number; midYs: number[] } | null>(null);
  const supplierListRef = useRef<HTMLUListElement | null>(null);
  const categoryListRef = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    if (open) {
      setMsg(null);
      setEditingSupplier(null);
      setConfirmDeleteSupplierId(null);
      setEditingCategory(null);
      setConfirmDeleteCategory(null);
      setVisible({ supplier: true, category: true, product: false, payment: false });
      setUsageTick((n) => n + 1);
    }
  }, [open]);

  /**
   * 讀「用過幾多次」。
   *
   * 🔴 一定要 lazy（只喺供應商 panel 顯示住嘅時候）＋ 只讀一次：呢支 API 要掃
   * 最近 1500 張收據嘅 `merchant_id`，跟住主頁輪詢會白燒 egress（本專案嘅痛點）。
   */
  useEffect(() => {
    if (!open || !visible.supplier || !account) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/inventory/master-usage?account=${encodeURIComponent(account)}`);
        const json = (await res.json()) as {
          ok?: boolean;
          supplierUsage?: Record<string, number>;
          scanned?: number;
          totalReceipts?: number;
          capped?: boolean;
        };
        if (cancelled) return;
        if (json.ok && json.supplierUsage && typeof json.supplierUsage === "object") {
          setUsage(json.supplierUsage);
        } else {
          setUsage({});
        }
        const scanned = Number(json.scanned) || 0;
        if (json.capped) {
          setUsageNote(`「用過 N 次」依最近 ${scanned} 張收據統計（本店共 ${Number(json.totalReceipts) || scanned} 張）。`);
        } else if (scanned > 0) {
          setUsageNote(`「用過 N 次」依本店 ${scanned} 張收據統計。`);
        } else {
          setUsageNote(null);
        }
      } catch {
        if (!cancelled) {
          setUsage({});
          setUsageNote(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, visible.supplier, account, usageTick]);

  if (!open) return null;

  /* ─────────────── 次序（拖 ⠿）─────────────── */

  const orderedSuppliers = reorderByStored(suppliers, supplierOrder, (s) => s.name);
  const orderedCategories = reorderByStored(categories, categoryOrder, (c) => c);

  function beginDrag(kind: "supplier" | "category", index: number, e: React.PointerEvent<HTMLButtonElement>) {
    const listEl = kind === "supplier" ? supplierListRef.current : categoryListRef.current;
    if (!listEl) return;
    const rows = Array.from(listEl.querySelectorAll<HTMLElement>("[data-drag-row]"));
    const expected = kind === "supplier" ? orderedSuppliers.length : orderedCategories.length;
    // 行數唔對就唔開始拖：寧願冇反應，都唔可以搬錯行（索引同 DOM 一定要一一對應）。
    if (rows.length !== expected) return;
    const midYs = rows.map((row) => {
      const box = row.getBoundingClientRect();
      return (box.top + box.bottom) / 2;
    });
    dragRef.current = { kind, from: index, to: index, midYs };
    setDragState({ kind, from: index, to: index });
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function moveDrag(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    if (!d) return;
    let to = 0;
    for (let i = 0; i < d.midYs.length; i += 1) {
      if (e.clientY >= d.midYs[i]) to = i;
    }
    if (to !== d.to) {
      d.to = to;
      setDragState({ kind: d.kind, from: d.from, to });
    }
  }

  function endDrag() {
    const d = dragRef.current;
    dragRef.current = null;
    setDragState(null);
    if (!d || d.from === d.to) return;
    if (d.kind === "supplier") {
      const next = orderKeys(moveWithin(orderedSuppliers, d.from, d.to), (s) => s.name);
      setMsg({ ok: true, text: "已更新供應商次序。" });
      void onSaveSupplierOrder(next);
    } else {
      const next = orderKeys(moveWithin(orderedCategories, d.from, d.to), (c) => c);
      setMsg({ ok: true, text: "已更新品類次序。" });
      void onSaveCategoryOrder(next);
    }
  }

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
      setUsageTick((n) => n + 1);
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
      // 改名會令「次序」入面嗰個舊名變成孤兒（已經唔存在）。即時用新名補返原位，
      // 否則商家會覺得「改完名就跳去最後」。
      if (json.ok && supplierOrder.includes(current)) {
        await onSaveSupplierOrder(supplierOrder.map((n) => (n === current ? trimmed : n)));
      }
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
    await onSaveCategoryOrder(
      orderKeys([...orderedCategories, name], (c) => c),
    );
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
    if (categoryOrder.includes(from)) {
      await onSaveCategoryOrder(categoryOrder.map((n) => (n === from ? trimmed : n)));
    }
    setEditingCategory(null);
    setMsg({
      ok: true,
      text: `已改名為「${trimmed}」。⚠️ 舊收據仍然顯示「${from}」，改名唔會追溯。`,
    });
  }

  async function deleteCategory(name: string) {
    await onSaveCategories(categories.filter((c) => c !== name));
    if (categoryOrder.includes(name)) {
      await onSaveCategoryOrder(categoryOrder.filter((n) => n !== name));
    }
    setConfirmDeleteCategory(null);
    setMsg({ ok: true, text: `已刪除品類「${name}」。舊收據不受影響。` });
  }

  function togglePanel(id: PanelId) {
    setMsg(null);
    setVisible((cur) => {
      const next = { ...cur, [id]: !cur[id] };
      // 最少要開一個 panel：全部關咗個彈窗會變一片空白，商家以為壞咗。
      if (!PANEL_ORDER.some((k) => next[k])) return cur;
      return next;
    });
  }

  /* ─────────────── 共用 UI ─────────────── */

  const fieldCls =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-base text-slate-900 outline-none focus:border-slate-400";
  // 觸屏：所有可撳元素最少 44px 高，唔用 text-xs 做撳制文字。
  const btnPrimary = "shrink-0 rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50";
  const btnGhost = "rounded-xl bg-white px-3.5 py-2.5 text-sm font-medium text-slate-700 ring-1 ring-slate-200";
  const btnDanger = "rounded-xl bg-red-50 px-3.5 py-2.5 text-sm font-semibold text-red-600 ring-1 ring-red-200";
  /** 拖拽把手：56×44，`touch-action:none` 令手指拖動唔會被誤當成捲動。 */
  const gripCls =
    "flex h-11 w-11 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded-lg text-base text-slate-400 active:cursor-grabbing";

  const shown = PANEL_ORDER.filter((id) => visible[id]);
  const twoCol = shown.length >= 2;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 頂部：標題 ＋ 完成（冇「保存」：改動即時寫入，見檔頭註釋）── */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-xl font-semibold text-slate-900">庫存・設置</h3>
            <p className="mt-0.5 text-xs leading-snug text-slate-500">
              只放「唔常用但一定要改到」嘅主檔：供應商、品類、庫存品、支付方式顯示。改動即時儲存。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white"
          >
            完成
          </button>
        </div>

        {/* ── 4 個 chips：切換要顯示邊幾個 panel（最少一個）── */}
        <div className="flex flex-wrap gap-2 px-5 pt-4" role="group" aria-label="設置區塊">
          {PANEL_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={visible[id]}
              onClick={() => togglePanel(id)}
              className={`inline-flex min-h-[44px] items-center rounded-full px-4 text-sm font-semibold transition ${
                visible[id] ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"
              }`}
            >
              {PANEL_LABEL[id]}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {msg && (
            <div
              className={`mb-4 flex items-start justify-between gap-3 rounded-xl px-4 py-3 text-sm ring-1 ${
                msg.ok ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-amber-50 text-amber-800 ring-amber-200"
              }`}
            >
              <span>{msg.text}</span>
              <button type="button" className="shrink-0 underline" onClick={() => setMsg(null)}>
                知道了
              </button>
            </div>
          )}

          <div className={`grid grid-cols-1 gap-4 ${twoCol ? "md:grid-cols-2" : ""}`}>
            {/* ══════════ 供應商 ══════════ */}
            {visible.supplier && (
              <Panel
                title="供應商"
                hint="可改名、刪除、拖 ⠿ 排序；有收據引用中嘅唔可以刪"
                badge={`${orderedSuppliers.length} 個`}
                testId="panel-supplier"
              >
                <ul ref={supplierListRef} className="flex flex-col gap-2">
                  {orderedSuppliers.length === 0 ? (
                    <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-center text-xs text-slate-500">
                      尚無供應商。喺下面輸入名稱撳「新增」就得，之後開收據會直接出現喺選單。
                    </li>
                  ) : (
                    orderedSuppliers.map((s, index) => {
                      const count = usageCount(usage, s.id);
                      const dragging = dragState?.kind === "supplier" && dragState.from === index;
                      const dropTarget =
                        dragState?.kind === "supplier" && dragState.to === index && dragState.from !== index;
                      return (
                        <li
                          key={s.id}
                          data-drag-row
                          className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border px-2 py-1.5 transition ${
                            dragging
                              ? "border-slate-900 bg-slate-50"
                              : dropTarget
                                ? "border-dashed border-slate-400 bg-slate-50"
                                : "border-slate-100 bg-slate-50/60"
                          } ${highlightSupplierId === s.id ? "ring-2 ring-amber-300" : ""}`}
                        >
                          <button
                            type="button"
                            aria-label={`拖動排序：${s.name}`}
                            title="按住拖動排序"
                            className={gripCls}
                            onPointerDown={(e) => beginDrag("supplier", index, e)}
                            onPointerMove={moveDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                          >
                            ⠿
                          </button>

                          {editingSupplier?.id === s.id ? (
                            <input
                              autoFocus
                              className="min-w-0 rounded-lg border border-slate-300 px-3 py-2.5 text-base outline-none"
                              defaultValue={s.name}
                              onBlur={(e) => void renameSupplier(s.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void renameSupplier(s.id, (e.target as HTMLInputElement).value);
                                if (e.key === "Escape") setEditingSupplier(null);
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="min-w-0 text-left"
                              onClick={() => setEditingSupplier({ id: s.id, name: s.name })}
                              title="撳一下改名"
                            >
                              <span className="block truncate text-sm font-semibold text-slate-800">{s.name}</span>
                              <span className="block text-[11px] text-slate-400">
                                {count > 0 ? `用過 ${count} 次` : "未用過"}
                              </span>
                            </button>
                          )}

                          {editingSupplier?.id === s.id ? (
                            <div className="flex gap-1.5">
                              <button type="button" className={btnGhost} onClick={() => setEditingSupplier(null)}>
                                取消
                              </button>
                            </div>
                          ) : confirmDeleteSupplierId === s.id ? (
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                className={btnGhost}
                                onClick={() => setConfirmDeleteSupplierId(null)}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="rounded-xl bg-red-600 px-3.5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
                                disabled={busy}
                                onClick={() => void deleteSupplier(s.id)}
                              >
                                確定刪除
                              </button>
                            </div>
                          ) : (
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                className={btnGhost}
                                onClick={() => setEditingSupplier({ id: s.id, name: s.name })}
                              >
                                改名
                              </button>
                              <button type="button" className={btnDanger} onClick={() => setConfirmDeleteSupplierId(s.id)}>
                                刪
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })
                  )}
                </ul>

                <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-100">
                  ⚠️ 供應商名稱係<b>全系統唯一</b>：如果另一個帳號已經用過同一個名，你嘅店就建立唔到
                  （系統會明確講明係「已被其他帳號使用」）。
                </p>
                {usageNote && <p className="mt-1.5 text-[11px] text-slate-400">{usageNote}</p>}

                <AddBar
                  value={supplierDraft}
                  onChange={setSupplierDraft}
                  onSubmit={() => void createSupplier()}
                  disabled={busy}
                  placeholder="輸入供應商名稱（例：永發凍肉）"
                  ariaLabel="新增供應商名稱"
                  className={fieldCls}
                  btnClass={btnPrimary}
                />
              </Panel>
            )}

            {/* ══════════ 品類 ══════════ */}
            {visible.category && (
              <Panel
                title="品類"
                hint="新增收據／新增庫存品時會以 chips 形式出現"
                badge={`${orderedCategories.length} 個`}
                testId="panel-category"
              >
                <ul ref={categoryListRef} className="flex flex-col gap-2">
                  {orderedCategories.length === 0 ? (
                    <li className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-center text-xs text-slate-500">
                      尚無品類。冇品類都開得到收據（品類欄可以手動輸入），但建立清單之後會快好多。
                    </li>
                  ) : (
                    orderedCategories.map((c, index) => {
                      const dragging = dragState?.kind === "category" && dragState.from === index;
                      const dropTarget =
                        dragState?.kind === "category" && dragState.to === index && dragState.from !== index;
                      return (
                        <li
                          key={c}
                          data-drag-row
                          className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border px-2 py-1.5 transition ${
                            dragging
                              ? "border-slate-900 bg-slate-50"
                              : dropTarget
                                ? "border-dashed border-slate-400 bg-slate-50"
                                : "border-slate-100 bg-slate-50/60"
                          }`}
                        >
                          <button
                            type="button"
                            aria-label={`拖動排序：${c}`}
                            title="按住拖動排序"
                            className={gripCls}
                            onPointerDown={(e) => beginDrag("category", index, e)}
                            onPointerMove={moveDrag}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                          >
                            ⠿
                          </button>

                          {editingCategory?.from === c ? (
                            <input
                              autoFocus
                              className="min-w-0 rounded-lg border border-slate-300 px-3 py-2.5 text-base outline-none"
                              defaultValue={c}
                              onBlur={(e) => void renameCategory(c, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void renameCategory(c, (e.target as HTMLInputElement).value);
                                if (e.key === "Escape") setEditingCategory(null);
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="min-w-0 text-left"
                              onClick={() => setEditingCategory({ from: c, to: c })}
                              title="撳一下改名"
                            >
                              <span className="block truncate text-sm font-semibold text-slate-800">{c}</span>
                              <span className="block text-[11px] text-slate-400">收據／庫存品共用</span>
                            </button>
                          )}

                          {editingCategory?.from === c ? (
                            <div className="flex gap-1.5">
                              <button type="button" className={btnGhost} onClick={() => setEditingCategory(null)}>
                                取消
                              </button>
                            </div>
                          ) : confirmDeleteCategory === c ? (
                            <div className="flex gap-1.5">
                              <button type="button" className={btnGhost} onClick={() => setConfirmDeleteCategory(null)}>
                                取消
                              </button>
                              <button
                                type="button"
                                className="rounded-xl bg-red-600 px-3.5 py-2.5 text-sm font-semibold text-white"
                                onClick={() => void deleteCategory(c)}
                              >
                                確定刪除
                              </button>
                            </div>
                          ) : (
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                className={btnGhost}
                                onClick={() => setEditingCategory({ from: c, to: c })}
                              >
                                改名
                              </button>
                              <button type="button" className={btnDanger} onClick={() => setConfirmDeleteCategory(c)}>
                                刪
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })
                  )}
                </ul>

                <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-100">
                  品類只係你門店自己嘅分類標籤，唔影響帳目。喺呢度建好之後，新增收據／庫存單嘅「品類」欄就會變成直接揀。
                </p>

                <AddBar
                  value={categoryDraft}
                  onChange={setCategoryDraft}
                  onSubmit={() => void addCategory()}
                  disabled={false}
                  placeholder="輸入品類名稱（例：包裝耗材）"
                  ariaLabel="新增品類名稱"
                  className={fieldCls}
                  btnClass={btnPrimary}
                />
              </Panel>
            )}

            {/* ══════════ 庫存品（掛現成 InventoryTable，唔重寫邏輯）══════════ */}
            {visible.product && (
              <Panel
                title="庫存品"
                hint="由收據同步 / 手動建立；盤點同補貨門檻都喺呢度"
                badge={merchantId ? "POS 內建" : "未綁店"}
                testId="panel-product"
              >
                {merchantId ? (
                  <InventoryTable
                    merchantId={merchantId}
                    account={account}
                    embedded
                    onMutated={onProductsChanged}
                  />
                ) : (
                  <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-xs text-amber-800">
                    未綁定門店（`merchantId` 未有）⇒ 暫時用唔到庫存品。
                  </p>
                )}
              </Panel>
            )}

            {/* ══════════ 支付方式顯示（唯讀，主檔歸 admin）══════════ */}
            {visible.payment && (
              <Panel
                title="支付方式顯示"
                hint="由 admin 統一派發；POS 只可以讀"
                badge={`${paymentMethods.length} 款`}
                testId="panel-payment"
              >
                {paymentMethods.length === 0 ? (
                  <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-xs text-amber-800">
                    讀唔到支付方式主檔，暫時用緊內建預設。請聯絡管理員喺後台確認。
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {paymentMethods.map((m) => (
                      <li
                        key={m.code}
                        className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border px-3 py-2 ${
                          m.enabled ? "border-slate-100 bg-slate-50/60" : "border-slate-200 bg-white opacity-60"
                        }`}
                      >
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-slate-800">{m.label}</span>
                          <span className="block text-[11px] text-slate-400">
                            {m.code} ・ {SCOPE_LABEL[m.scope]}
                          </span>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                            m.enabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          {m.enabled ? "已啟用" : "已停用"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {paymentWarning && <p className="mt-2 text-[11px] text-amber-700">{paymentWarning}</p>}
                <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-100">
                  呢份清單由 <b>expenseRecorder 後台</b>（用 admin 帳號登入嗰邊）統一管理，
                  POS 呢邊<b>只可以讀</b>。要加新款／停用／改次序，請去後台「支付方式」頁。
                </p>
              </Panel>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────── 細件 ─────────────── */

const SCOPE_LABEL: Record<PaymentMethodDef["scope"], string> = {
  both: "進貨＋結帳",
  purchase: "只進貨",
  checkout: "只結帳",
};

function Panel({
  title,
  hint,
  badge,
  testId,
  children,
}: {
  title: string;
  hint: string;
  badge: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section data-panel={testId} className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white">
      <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{hint}</p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
          {badge}
        </span>
      </header>
      <div className="px-3 py-3">{children}</div>
    </section>
  );
}

/**
 * panel 底部嘅「輸入 ＋ 新增」列（確認稿嘅 addbar）。
 *
 * ⚠️ `input` 同 `button` 用 grid 兩軌（`minmax(0,1fr) auto`）而唔用 `flex`：
 * 呢個專案嘅 Tailwind v4 產生次序令 `.w-full` 贏過 `.w-*` 固定寬，
 * flex 環境下好易出現「輸入框撐爆、撳制被推出畫面」。grid 軌寬冇呢個問題。
 */
function AddBar({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  ariaLabel,
  className,
  btnClass,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder: string;
  ariaLabel: string;
  className: string;
  btnClass: string;
}) {
  return (
    <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-slate-100 pt-3">
      <input
        className={className}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      <button type="button" onClick={onSubmit} disabled={disabled} className={btnClass}>
        新增
      </button>
    </div>
  );
}
