"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { loadRetailProducts, saveRetailProducts } from "@/lib/storage";
import type { RetailProduct } from "@/lib/retail/types";
import {
  applyInventoryCounts,
  inventoryRows,
  inventorySummary,
  inventoryToCsv,
  replenishSuggestions,
  type InventoryRow,
  type ReplenishSuggestion,
} from "@/lib/retail/inventory-ops";
import { categoriesOf } from "@/lib/retail/catalog-ops";

const money = (v: number) => `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;

/** 顯示數量：稱重商品可以有小數，其餘整數化（免得顯示 48.000） */
const fmtQty = (qty: number, unit: string) =>
  unit === "kg" ? `${(Number.isFinite(qty) ? qty : 0).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}` : String(Math.round(qty));

type Toast = { tone: "ok" | "err" | "info"; text: string };
type Tab = "low" | "all";

export function RetailInventory() {
  const [products, setProducts] = useState<RetailProduct[]>([]);
  const [tab, setTab] = useState<Tab>("low");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  /** 盤點草稿：key = `${productId}::${variantId ?? ""}` → 輸入字串 */
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    setProducts(loadRetailProducts());
  }, []);

  const flash = useCallback((tone: Toast["tone"], text: string) => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  /** 寫入一定要檢查回傳值（靜默失敗 = reload 打回原形） */
  const persist = useCallback(
    (next: RetailProduct[], okText: string) => {
      setProducts(next);
      const wrote = saveRetailProducts(next);
      if (!wrote) {
        flash("err", "寫入失敗（儲存空間不足 / 私隱模式）→ 改動可能未儲存");
        return false;
      }
      flash("ok", okText);
      return true;
    },
    [flash],
  );

  const summary = useMemo(() => inventorySummary(products), [products]);
  const suggestions = useMemo(() => replenishSuggestions(products), [products]);
  const allRows = useMemo(() => inventoryRows(products), [products]);

  /** 只出「需要補貨」嘅列（缺貨 + 低庫存） */
  const lowKeys = useMemo(
    () => new Set(suggestions.map((s) => keyOf(s.productId, s.variantId))),
    [suggestions],
  );

  const rows = useMemo(() => {
    const base = tab === "low" ? allRows.filter((r) => lowKeys.has(keyOf(r.productId, r.variantId))) : allRows;
    const kw = query.trim().toLowerCase();
    return base.filter((r) => {
      if (category && r.categoryId !== category) return false;
      if (kw && !r.label.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [allRows, tab, lowKeys, query, category]);

  /** 有幾多行改過（未提交） */
  const dirtyCount = useMemo(
    () =>
      Object.entries(draft).filter(([k, v]) => {
        const row = allRows.find((r) => keyOf(r.productId, r.variantId) === k);
        if (!row || v.trim() === "") return false;
        return Math.abs(Number(v) - row.qty) > 1e-9;
      }).length,
    [draft, allRows],
  );

  const commit = useCallback(() => {
    const counts: Array<{ productId: string; variantId?: string; qty: number }> = [];
    for (const [k, v] of Object.entries(draft)) {
      if (v.trim() === "") continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const row = allRows.find((r) => keyOf(r.productId, r.variantId) === k);
      if (!row) continue;
      if (Math.abs(n - row.qty) < 1e-9) continue;
      counts.push({ productId: row.productId, variantId: row.variantId, qty: n });
    }
    if (counts.length === 0) {
      flash("info", "冇改動");
      return;
    }
    const r = applyInventoryCounts(products, counts);
    if (r.skipped.length > 0) {
      // 唔可以靜默 —— 母體 / 唔追蹤庫存商品改極都唔會生效
      flash("err", `${r.skipped.length} 個目標改唔到（母體 / 唔追蹤庫存）`);
    }
    if (persist(r.products, `已更新 ${r.edits.length} 項庫存`)) setDraft({});
  }, [draft, allRows, products, persist, flash]);

  /** 一鍵套用補貨建議（把建議量直接加上去） */
  const applyReplenish = useCallback(() => {
    if (suggestions.length === 0) {
      flash("info", "冇需要補貨嘅商品");
      return;
    }
    const counts = suggestions.map((s) => ({
      productId: s.productId,
      variantId: s.variantId,
      qty: s.targetQty,
    }));
    const r = applyInventoryCounts(products, counts);
    persist(r.products, `已補貨 ${r.edits.length} 項（補到警戒線 × 2）`);
  }, [suggestions, products, persist, flash]);

  const exportCsv = useCallback(() => {
    const csv = inventoryToCsv(products);
    void navigator.clipboard
      ?.writeText(csv)
      .then(() => flash("ok", `盤點表已複製（${csv.split("\n").length - 1} 行）`))
      .catch(() => flash("err", "複製失敗 — 瀏覽器唔准存取剪貼板"));
  }, [products, flash]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div>
          <div className="text-[15px] font-bold">庫存管理</div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
            <span>品項 {summary.skuCount}</span>
            <span className={summary.outCount > 0 ? "font-semibold text-rose-600" : ""}>
              缺貨 {summary.outCount}
            </span>
            <span className={summary.lowCount > 0 ? "font-semibold text-amber-600" : ""}>
              低庫存 {summary.lowCount}
            </span>
            <span>庫存值 {money(summary.totalValue)}（成本價）</span>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button
            className="rounded-xl border border-slate-300 px-3 py-2.5 text-[12px] font-semibold text-slate-700 hover:bg-slate-50"
            onClick={exportCsv}
            type="button"
          >
            複製盤點表
          </button>
          <button
            className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2.5 text-[12px] font-semibold text-orange-700 hover:bg-orange-100"
            onClick={applyReplenish}
            type="button"
          >
            一鍵補貨（{suggestions.length}）
          </button>
        </div>
      </header>

      {summary.missingCostCount > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12px] font-semibold text-amber-800">
          ⚠️ {summary.missingCostCount} 件商品冇填成本 → 庫存值會偏低，毛利報表亦會唔準。去「商品」頁補。
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
          <button
            className={`min-h-[36px] rounded-lg px-3 text-[12px] font-semibold ${tab === "low" ? "bg-white text-orange-700 shadow-sm" : "text-slate-600"}`}
            onClick={() => setTab("low")}
            type="button"
          >
            要補貨（{suggestions.length}）
          </button>
          <button
            className={`min-h-[36px] rounded-lg px-3 text-[12px] font-semibold ${tab === "all" ? "bg-white text-orange-700 shadow-sm" : "text-slate-600"}`}
            onClick={() => setTab("all")}
            type="button"
          >
            全部庫存（{allRows.length}）
          </button>
        </div>
        <input
          className="w-full max-w-[240px] rounded-xl border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-orange-400"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜商品名"
          value={query}
        />
        <button
          className={`min-h-[36px] rounded-full px-3 text-[12px] font-semibold ${category === "" ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"}`}
          onClick={() => setCategory("")}
          type="button"
        >
          全部
        </button>
        {categoriesOf(products).map((c) => (
          <button
            key={c}
            className={`min-h-[36px] rounded-full px-3 text-[12px] font-semibold ${category === c ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"}`}
            onClick={() => setCategory(c)}
            type="button"
          >
            {c}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {products.length === 0 ? (
          <p className="mt-10 text-center text-[13px] text-slate-400">
            未有商品 → 去「商品」頁新增或者匯入 CSV
          </p>
        ) : rows.length === 0 ? (
          <p className="mt-10 text-center text-[13px] text-slate-400">
            {tab === "low" ? "冇商品需要補貨 🎉" : "冇符合嘅商品"}
          </p>
        ) : (
          <>
            <div className="hidden items-center gap-3 px-3 pb-2 text-[11px] font-semibold text-slate-500 md:flex">
              <span className="min-w-0 flex-1">商品</span>
              <span className="w-[90px] text-right">現有</span>
              <span className="w-[90px] text-right">警戒線</span>
              <span className="w-[110px] text-right">盤點後</span>
            </div>
            <div className="grid gap-2">
              {rows.map((r) => (
                <InventoryLine
                  key={keyOf(r.productId, r.variantId)}
                  draft={draft[keyOf(r.productId, r.variantId)] ?? ""}
                  onDraft={(v) =>
                    setDraft((d) => ({ ...d, [keyOf(r.productId, r.variantId)]: v }))
                  }
                  row={r}
                  suggestion={suggestions.find(
                    (s) => s.productId === r.productId && s.variantId === r.variantId,
                  )}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* 底部提交條（有改動才出，避免長期佔位） */}
      {dirtyCount > 0 ? (
        <div className="sticky bottom-20 z-20 flex items-center gap-3 border-t border-orange-200 bg-orange-50 px-4 py-3 md:bottom-0">
          <span className="text-[12.5px] font-semibold text-orange-800">
            已改 {dirtyCount} 項（未儲存）
          </span>
          <button
            className="ml-auto min-h-[40px] rounded-xl border border-slate-300 bg-white px-4 text-[12px] font-semibold text-slate-600"
            onClick={() => setDraft({})}
            type="button"
          >
            放棄
          </button>
          <button
            className="min-h-[40px] rounded-xl bg-orange-600 px-5 text-[12.5px] font-bold text-white hover:bg-orange-700"
            onClick={commit}
            type="button"
          >
            儲存盤點
          </button>
        </div>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 md:bottom-8">
          <div
            className={`rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white shadow-lg ${
              toast.tone === "ok" ? "bg-emerald-600" : toast.tone === "err" ? "bg-rose-600" : "bg-slate-800"
            }`}
          >
            {toast.text}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function keyOf(productId: string, variantId?: string): string {
  return variantId ? `${productId}::${variantId}` : productId;
}

function InventoryLine({
  row,
  suggestion,
  draft,
  onDraft,
}: {
  row: InventoryRow;
  suggestion?: ReplenishSuggestion;
  draft: string;
  onDraft: (v: string) => void;
}) {
  const tone =
    row.health === "out"
      ? "border-rose-200 bg-rose-50/40"
      : row.health === "low"
        ? "border-amber-200 bg-amber-50/40"
        : "border-slate-200 bg-white";

  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${tone}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`text-[13px] font-semibold ${row.isActive ? "" : "text-slate-400 line-through"}`}>
            {row.label}
          </span>
          {row.health === "out" ? <Pill tone="rose">缺貨</Pill> : null}
          {row.health === "low" ? <Pill tone="amber">低庫存</Pill> : null}
          {row.isParent ? <Pill tone="slate">母體</Pill> : null}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-slate-500">
          <span>{row.categoryId || "未分類"}</span>
          <span>{row.unit}</span>
          {row.stockValue > 0 ? <span>值 {money(row.stockValue)}</span> : null}
          {suggestion ? (
            <span className="font-semibold text-orange-700">
              建議補 {fmtQty(suggestion.suggestQty, row.unit)} {row.unit}
            </span>
          ) : null}
        </div>
      </div>

      <div className="w-[90px] text-right">
        <div className="text-[15px] font-bold tabular-nums">{fmtQty(row.qty, row.unit)}</div>
        <div className="text-[10px] text-slate-400">現有</div>
      </div>
      <div className="w-[90px] text-right">
        <div className="text-[13px] tabular-nums text-slate-600">{fmtQty(row.reorderLevel, row.unit)}</div>
        <div className="text-[10px] text-slate-400">警戒線</div>
      </div>

      <div className="w-[110px]">
        <input
          className="min-h-[40px] w-full rounded-lg border border-slate-300 px-2.5 text-right text-[14px] tabular-nums outline-none focus:border-orange-400 disabled:bg-slate-100 disabled:text-slate-400"
          disabled={row.isParent}
          inputMode="decimal"
          onChange={(e) => onDraft(e.target.value)}
          placeholder={row.isParent ? "不可改" : "盤點"}
          value={draft}
        />
      </div>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: string }) {
  const tones: Record<string, string> = {
    rose: "bg-rose-100 text-rose-700",
    amber: "bg-amber-100 text-amber-800",
    slate: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tones[tone] ?? tones.slate}`}>
      {children}
    </span>
  );
}
