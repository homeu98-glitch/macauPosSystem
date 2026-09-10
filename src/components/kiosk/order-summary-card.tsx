"use client";

import type { PosOrder } from "@/lib/types";

/** 客人端金額顯示：一律 2 位小數（同小計 / 總計一致，亦避免 36.300000000000004 類浮點噪音）。 */
export function money2(value: number): string {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/**
 * 「本枱已落單 / 落單成功」明細卡 —— **兩頁共用**（審查 P2-6）。
 *
 * 舊版 `/menu` 同 `/order` 各有一份近乎逐字重複嘅 `OrderSummaryCard`，
 * 已經出現過分歧（一邊改咗另一邊漏）。抽成共用元件，改一處即刻兩邊生效。
 */
export function OrderSummaryCard({
  order,
  title,
  className = "",
}: {
  order: PosOrder;
  title: string;
  className?: string;
}) {
  return (
    <div className={`rounded-xl bg-amber-50 p-3 text-left ${className}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold text-amber-800">{title}</span>
        <span className="text-xs text-amber-600">#{order.localOrderNo}</span>
      </div>
      <div className="space-y-1.5">
        {order.items.map((it, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <span className="min-w-0 flex-1 truncate text-stone-800">
              {it.name}
              {it.selectedSpecs && it.selectedSpecs.length > 0 && (
                <span className="ml-1 text-xs text-stone-400">
                  ({it.selectedSpecs.map((s) => s.optionLabel).join(" / ")})
                </span>
              )}
            </span>
            <span className="ml-2 shrink-0 text-stone-500">x{it.quantity}</span>
            <span className="ml-2 w-16 shrink-0 text-right text-stone-700">
              MOP {money2(it.price * it.quantity)}
            </span>
          </div>
        ))}
      </div>
      {order.orderNote ? (
        <div className="mt-2 break-words text-xs text-stone-500">備註：{order.orderNote}</div>
      ) : null}
      <div className="mt-2 flex items-center justify-between border-t border-amber-200 pt-2 text-sm">
        <span className="font-medium text-amber-800">枱上總計</span>
        <span className="font-bold text-amber-900">MOP {money2(order.total)}</span>
      </div>
    </div>
  );
}
