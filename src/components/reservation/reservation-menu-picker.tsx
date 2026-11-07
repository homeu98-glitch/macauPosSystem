"use client";

/**
 * 預點菜選菜界面 —— **刻意同 `/pos` 點餐頁同一套視覺**。
 *
 * ## 為什麼是「視覺複製、邏輯複用」
 *
 * `pos-app.tsx` 有 9336 行，分類／網格／購物車全部內聯，沒有可 import 的元件。
 * 直接抽會動到主收銀台，回歸風險太高。
 * 所以這裡只複製 JSX 與 class（橙色、整卡可點、右上「已加 N」），
 * 但**計價一律用現成純函數**（`computeReservationTotals` / `itemNetPrice`），
 * 規格彈窗直接用 `ItemSpecModal`。
 *
 * 將來若真的把 `/pos` 的選菜抽成 `<MenuPicker>`，這個檔案就是驗收基準 ——
 * 畫面應該一模一樣。
 */

import { useMemo, useState } from "react";

import { ItemSpecModal } from "@/components/item-spec-modal";
import { computeReservationTotals, itemNetPrice } from "@/lib/pos/reservation/items";
import { formatMoney } from "@/lib/pos/reservation/labels";
import type { ReservationItem } from "@/lib/pos/reservation/types";
import type { MenuCategory, MenuItem, MenuSpecGroup } from "@/lib/types";

const ALL = "__all__";

function specTextOf(groups: readonly MenuSpecGroup[] | undefined, specs: Record<string, string[]>): string {
  if (!groups) return "";
  const parts: string[] = [];
  for (const group of groups) {
    const ids = specs[group.id] ?? [];
    for (const id of ids) {
      const option = group.options.find((o) => o.id === id);
      if (option) parts.push(option.label);
    }
  }
  return parts.join(" · ");
}

function specDeltaOf(groups: readonly MenuSpecGroup[] | undefined, specs: Record<string, string[]>): number {
  if (!groups) return 0;
  let delta = 0;
  for (const group of groups) {
    const ids = specs[group.id] ?? [];
    for (const id of ids) {
      const option = group.options.find((o) => o.id === id);
      if (option) delta += option.priceDelta;
    }
  }
  return delta;
}

export function ReservationMenuPicker({
  menuItems,
  categories,
  discountRate,
  initial,
  title,
  subtitle,
  onClose,
  onConfirm,
}: {
  menuItems: MenuItem[];
  categories: MenuCategory[];
  discountRate: number | null;
  initial: ReservationItem[];
  title: string;
  subtitle: string;
  onClose: () => void;
  onConfirm: (items: ReservationItem[]) => void;
}) {
  const [categoryId, setCategoryId] = useState<string>(ALL);
  const [keyword, setKeyword] = useState("");
  const [items, setItems] = useState<ReservationItem[]>(initial);
  const [specTarget, setSpecTarget] = useState<MenuItem | null>(null);

  const categoriesWithAll = useMemo(
    () => [{ id: ALL, name: "全部" }, ...categories],
    [categories],
  );

  const visible = useMemo(() => {
    const key = keyword.trim();
    return menuItems.filter((item) => {
      if (categoryId !== ALL && item.categoryId !== categoryId) return false;
      if (key && !item.name.includes(key)) return false;
      return true;
    });
  }, [menuItems, categoryId, keyword]);

  const totals = useMemo(() => computeReservationTotals(items), [items]);

  const qtyOf = (menuItemId: string) =>
    items.filter((i) => i.menuItemId === menuItemId).reduce((sum, i) => sum + i.qty, 0);

  const addItem = (menuItem: MenuItem, specs: Record<string, string[]>) => {
    const delta = specDeltaOf(menuItem.specGroups, specs);
    const specText = specTextOf(menuItem.specGroups, specs);
    const unitPrice = Number(menuItem.price) + delta;
    const key = `${menuItem.id}::${specText}`;

    setItems((prev) => {
      const index = prev.findIndex((row) => `${row.menuItemId}::${row.specText}` === key);
      if (index >= 0) {
        const next = [...prev];
        const row = next[index];
        if (row) next[index] = { ...row, qty: Math.min(99, row.qty + 1) };
        return next;
      }
      return [
        ...prev,
        {
          menuItemId: menuItem.id,
          name: menuItem.name,
          specText,
          specs,
          qty: 1,
          unitPrice,
          memberPrice: typeof menuItem.memberPrice === "number" ? menuItem.memberPrice : null,
          discountRate,
          snapshotAt: new Date().toISOString(),
        },
      ];
    });
  };

  const handlePick = (menuItem: MenuItem) => {
    if (menuItem.specGroups && menuItem.specGroups.length > 0) {
      setSpecTarget(menuItem);
      return;
    }
    addItem(menuItem, {});
  };

  const changeQty = (menuItemId: string, specText: string, delta: number) => {
    setItems((prev) =>
      prev
        .map((row) =>
          row.menuItemId === menuItemId && row.specText === specText
            ? { ...row, qty: Math.min(99, row.qty + delta) }
            : row,
        )
        .filter((row) => row.qty > 0),
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] flex flex-col bg-slate-50">
        {/* 上下文條（橙色） */}
        <div className="shrink-0 border-b border-orange-200 bg-gradient-to-r from-orange-50 to-amber-50 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="min-h-[34px] shrink-0 rounded-lg border border-orange-200 bg-white px-3 text-[12px] font-bold text-orange-700"
              onClick={onClose}
              type="button"
            >
              ← 返回
            </button>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-bold text-orange-900">{title}</div>
              <div className="mt-0.5 text-[11px] text-orange-700">
                {subtitle}　·　選好之後只存進訂位單，<b>不會出廚房單</b>
              </div>
            </div>
            <div className="shrink-0 text-[12px] font-bold text-orange-800">
              已選 {totals.qty} 件 · {formatMoney(totals.payable)}
            </div>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 md:grid-cols-[150px_1fr_300px]">
          {/* 分類 */}
          <aside className="flex gap-1.5 overflow-x-auto border-b border-slate-200 bg-white px-2 py-2 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:py-3">
            {categoriesWithAll.map((category) => (
              <button
                key={category.id}
                className={`shrink-0 rounded-xl px-3 py-2 text-left text-[12.5px] font-semibold md:w-full ${
                  categoryId === category.id ? "bg-orange-500 text-white" : "bg-slate-50 text-slate-600"
                }`}
                onClick={() => setCategoryId(category.id)}
                type="button"
              >
                {category.name}
              </button>
            ))}
          </aside>

          {/* 菜品 */}
          <section className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
              <input
                className="h-9 w-full max-w-xs rounded-xl border border-slate-200 px-3 text-[12.5px] outline-none focus:border-orange-400"
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜尋商品"
                value={keyword}
              />
              <span className="ml-auto text-[11px] font-semibold text-slate-400">{visible.length} 項</span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {visible.map((item) => {
                  const qty = qtyOf(item.id);
                  const market = item.isMarketPrice === true;
                  const net = itemNetPrice({
                    unitPrice: item.price,
                    memberPrice: typeof item.memberPrice === "number" ? item.memberPrice : null,
                    discountRate,
                  });
                  return (
                    <button
                      key={item.id}
                      className={`relative flex min-h-[112px] flex-col justify-between rounded-2xl border border-slate-200 bg-white p-2.5 text-left shadow-sm transition ${
                        market ? "opacity-50" : "hover:-translate-y-0.5 hover:border-orange-300"
                      }`}
                      disabled={market}
                      onClick={() => handlePick(item)}
                      type="button"
                    >
                      {qty > 0 ? (
                        <span className="absolute right-1.5 top-1.5 rounded-full bg-orange-500 px-1.5 py-px text-[10px] font-bold leading-tight text-white">
                          x{qty}
                        </span>
                      ) : null}
                      <div className="min-w-0">
                        <div className="line-clamp-2 break-words text-[12.5px] font-semibold leading-snug text-slate-900">
                          {item.name}
                        </div>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="text-[13.5px] font-bold text-slate-900">
                          {market ? "時價菜" : formatMoney(net)}
                        </div>
                        <div
                          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                            market ? "bg-amber-50 text-amber-700" : "bg-orange-50 text-orange-600"
                          }`}
                        >
                          {market ? "不支援預訂" : "加入"}
                        </div>
                      </div>
                      {net !== item.price && !market ? (
                        <div className="text-[10px] text-slate-400 line-through">{formatMoney(item.price)}</div>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {visible.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-[12.5px] text-slate-400">
                  沒有符合條件的商品
                </div>
              ) : null}
            </div>
          </section>

          {/* 已選 */}
          <aside className="flex min-h-0 flex-col border-t border-slate-200 bg-white md:border-l md:border-t-0">
            <div className="flex shrink-0 items-baseline justify-between border-b border-slate-100 px-3 py-2.5">
              <span className="text-[12.5px] font-bold text-slate-800">已選（{items.length}）</span>
              <span className="text-[10.5px] text-slate-400">可改數量</span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
              {items.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-slate-400">尚未選菜</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {items.map((row) => (
                    <div
                      key={`${row.menuItemId}::${row.specText}`}
                      className="flex items-start gap-2 border-b border-dashed border-slate-100 pb-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-bold text-slate-800">{row.name}</div>
                        {row.specText ? (
                          <div className="text-[10.5px] text-slate-400">{row.specText}</div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          className="h-6 w-6 rounded-md border border-slate-200 text-[13px] text-slate-600"
                          onClick={() => changeQty(row.menuItemId, row.specText, -1)}
                          type="button"
                        >
                          −
                        </button>
                        <span className="min-w-[14px] text-center text-[12px] font-bold">{row.qty}</span>
                        <button
                          className="h-6 w-6 rounded-md border border-orange-200 bg-orange-50 text-[13px] text-orange-600"
                          onClick={() => changeQty(row.menuItemId, row.specText, 1)}
                          type="button"
                        >
                          ＋
                        </button>
                      </div>
                      <div className="w-[52px] shrink-0 text-right text-[12px] font-bold tabular-nums text-slate-800">
                        {formatMoney(itemNetPrice(row) * row.qty)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-slate-100 px-3 py-2.5">
              <div className="flex justify-between text-[11.5px] text-slate-500">
                <span>原價</span>
                <span className="tabular-nums">{formatMoney(totals.subtotal)}</span>
              </div>
              {totals.discount > 0 ? (
                <div className="flex justify-between text-[11.5px] font-semibold text-emerald-700">
                  <span>會員折扣</span>
                  <span className="tabular-nums">−{formatMoney(totals.discount)}</span>
                </div>
              ) : null}
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-[12.5px] font-bold text-slate-800">預點合計</span>
                <span className="text-[19px] font-bold tabular-nums text-orange-700">
                  {formatMoney(totals.payable)}
                </span>
              </div>
              <button
                className="mt-2 h-11 w-full rounded-xl bg-orange-500 text-[13.5px] font-bold text-white"
                onClick={() => onConfirm(items)}
                type="button"
              >
                完成選菜，返回訂位
              </button>
              <div className="mt-1 text-center text-[10px] text-slate-400">
                到店開枱時按當日菜牌重算
              </div>
            </div>
          </aside>
        </div>
      </div>

      {specTarget ? (
        <ItemSpecModal
          onClose={() => setSpecTarget(null)}
          onConfirm={(specs) => {
            addItem(specTarget, specs);
            setSpecTarget(null);
          }}
          open
          specGroups={specTarget.specGroups ?? []}
          title={specTarget.name}
        />
      ) : null}
    </>
  );
}
