"use client";

import { useEffect, useState } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { AuthGuard } from "@/components/auth-guard";
import {
  bomKey,
  type BomEntry,
  type BomIngredient,
} from "@/lib/restaurant-bom";
import { loadAuthSession, loadBootstrapCache } from "@/lib/storage";

function BomManager() {
  const [entries, setEntries] = useState<BomEntry[]>([]);
  const [saved, setSaved] = useState(false);

  const merchantId = loadAuthSession()?.merchantId ?? "default";
  const menuItems = loadBootstrapCache()?.menuItems ?? [];

  useEffect(() => {
    const raw = localStorage.getItem(bomKey(merchantId));
    if (raw) {
      try {
        const v = JSON.parse(raw);
        if (Array.isArray(v)) setEntries(v as BomEntry[]);
      } catch {
        /* ignore */
      }
    }
  }, [merchantId]);

  function entryFor(menuItemId: string): BomEntry {
    return entries.find((e) => e.menuItemId === menuItemId) ?? { menuItemId, ingredients: [] };
  }

  function updateIngredients(menuItemId: string, ingredients: BomIngredient[]) {
    setSaved(false);
    setEntries((prev) => {
      const others = prev.filter((e) => e.menuItemId !== menuItemId);
      if (ingredients.length === 0) return others;
      return [...others, { menuItemId, ingredients }];
    });
  }

  function save() {
    localStorage.setItem(bomKey(merchantId), JSON.stringify(entries));
    setSaved(true);
  }

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-100">
      <AppSidebar />
      <div className="flex h-[100dvh] overflow-hidden md:pl-[72px]">
        <main className="flex h-full flex-1 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-white px-4 py-4">
            <div className="text-lg font-semibold text-slate-900">配方管理（BOM）</div>
            <div className="mt-1 text-sm text-slate-500">
              填寫每款菜品用到的食材與用量，每日總結嘅「食材消耗」模塊會自動按已售份數展開計算。
            </div>
          </div>

          <div className="flex-1 overflow-auto p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-xs text-slate-400">共 {menuItems.length} 款菜品 · 已設配方 {entries.length} 款</div>
              <button
                className="rounded-lg bg-orange-500 px-3 py-2 text-xs font-semibold text-white"
                onClick={save}
                type="button"
              >
                儲存全部配方
              </button>
            </div>
            {saved ? (
              <div className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                已儲存。
              </div>
            ) : null}

            {menuItems.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-400">
                尚未載入餐牌，請先於 POS 完成 Ledger 同步。
              </div>
            ) : (
              <div className="grid gap-3">
                {menuItems.map((m) => {
                  const entry = entryFor(m.id);
                  return (
                    <BomRowCard
                      key={m.id}
                      dishName={m.name}
                      ingredients={entry.ingredients}
                      onChange={(ings) => updateIngredients(m.id, ings)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function BomRowCard({
  dishName,
  ingredients,
  onChange,
}: {
  dishName: string;
  ingredients: BomIngredient[];
  onChange: (ings: BomIngredient[]) => void;
}) {
  function setRow(i: number, patch: Partial<BomIngredient>) {
    onChange(ingredients.map((ing, idx) => (idx === i ? { ...ing, ...patch } : ing)));
  }
  function addRow() {
    onChange([...ingredients, { name: "", quantity: 0, unit: "份", unitCost: 0 }]);
  }
  function removeRow(i: number) {
    onChange(ingredients.filter((_, idx) => idx !== i));
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="mb-2 text-sm font-semibold text-slate-900">{dishName}</div>
      {ingredients.length === 0 ? (
        <div className="text-xs text-slate-400">未設定食材。</div>
      ) : (
        <div className="grid gap-2">
          {ingredients.map((ing, i) => (
            <div key={i} className="grid grid-cols-[1.4fr_0.9fr_0.8fr_1fr_auto] items-center gap-2">
              <input
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                placeholder="食材名"
                value={ing.name}
                onChange={(e) => setRow(i, { name: e.target.value })}
              />
              <input
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                type="number"
                placeholder="用量"
                value={ing.quantity || ""}
                onChange={(e) => setRow(i, { quantity: Number(e.target.value) || 0 })}
              />
              <input
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                placeholder="單位"
                value={ing.unit}
                onChange={(e) => setRow(i, { unit: e.target.value })}
              />
              <input
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
                type="number"
                placeholder="單位成本 MOP"
                value={ing.unitCost || ""}
                onChange={(e) => setRow(i, { unitCost: Number(e.target.value) || 0 })}
              />
              <button
                className="rounded-lg px-2 py-1.5 text-xs text-rose-600 hover:bg-rose-50"
                onClick={() => removeRow(i)}
                type="button"
              >
                刪
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        className="mt-2 rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        onClick={addRow}
        type="button"
      >
        ＋ 加食材
      </button>
    </div>
  );
}

export default function BomPage() {
  return (
    <AuthGuard>
      <BomManager />
    </AuthGuard>
  );
}
