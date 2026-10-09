"use client";

import type { OrderItem } from "@/lib/types";
import { formatMoney } from "@/lib/format";
import { discountedUnitPrice, itemDiscountSaving, orderItemDiscountTotal } from "@/lib/pos/discount";
import { useT } from "@/components/lang-provider";

/**
 * 訂單明細嘅折扣顯示組件（HTML 純樣式、無 React hook / state）。
 *
 * 用戶需求：所有顯示訂單明細嘅位置都需要見到「折扣多少／優惠多少」。
 * 兩個層次：
 *  1. 單品折扣：原價（line-through）+ 折後價（amber），同「優惠 X」一行
 *  2. 全單折扣：訂單底部一行「折扣 X」反映 `discountAmount` money
 *
 * 唔顯示（return null）嘅條件：
 *  - 冇單品折扣 + 冇全單折扣 → 整個 component 唔 render（避免噪音）。
 *
 * 用法：
 *  ```tsx
 *  <OrderDiscountRow items={order.items} currency={...} />
 *  <OrderItemDiscountLine item={item} currency={...} />
 *  ```
 *
 * 注：呢組件純展示，唔 trigger 任何 state 變更。
 */

export type OrderItemDiscountLineProps = {
  item: OrderItem;
  currency: string;
  /** "compact" = 同行右邊顯示優惠金額；"inline" = 只顯示折後價（用於一行 row 已有其他內容時） */
  variant?: "compact" | "inline";
};

/** 單品折扣行：原價（line-through）+ 折後價 + 優惠金額（compact）/ 淨折後價（inline）。 */
export function OrderItemDiscountLine({ item, currency, variant = "compact" }: OrderItemDiscountLineProps) {
  // ⚠️ useT() 一定要喺所有 early return 之前（Rules of Hooks）。
  const t = useT();
  if (item.discountRate == null || !Number.isFinite(item.discountRate) || item.discountRate >= 100) {
    return null;
  }
  const discounted = discountedUnitPrice(item.price, item.discountRate);
  const saving = itemDiscountSaving(item);
  if (variant === "inline") {
    return (
      <span className="font-semibold tabular-nums text-amber-700">
        {formatMoney(discounted * item.quantity, currency)}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-semibold tabular-nums text-amber-700">{formatMoney(discounted * item.quantity, currency)}</span>
      <span className="text-[11px] text-slate-400 line-through tabular-nums">
        {t("原 {amt}", { amt: formatMoney(item.price * item.quantity, currency) })}
      </span>
      <span className="text-[11px] font-semibold text-emerald-700">
        {t("優惠 {amt}", { amt: formatMoney(saving, currency) })}
      </span>
    </span>
  );
}

export type OrderDiscountRowProps = {
  items: OrderItem[];
  currency: string;
  /** 全單折扣 money（order.discountAmount，已經計好嘅金額）。undefined = 冇。 */
  wholeOrderDiscountAmount?: number;
  /**
   * 系統抹零 money（docs/88 §5.1，order.roundingAmount）。會獨立顯示一行「系統抹零」，
   * 並計入「合計優惠」總減免。undefined / 0 = 冇。
   */
  roundingAmount?: number;
  /** 顯示樣式："block" = 完整一行；"compact" = 同其他 row 對齊嘅細字一行 */
  variant?: "block" | "compact";
};

/**
 * 訂單底部折扣行：列出「單品折扣總額」「全單折扣」「系統抹零」分項，最後合計。
 * 當 total == 0 時唔 render。
 *
 * 2026-10-08：加 `roundingAmount` —— 抹零係影響實收嘅調整（docs/88），
 * 必須喺所有訂單明細位見到，並計入「合計優惠」總減免（用家要求「優惠」反映抹零）。
 */
export function OrderDiscountRow({ items, currency, wholeOrderDiscountAmount, roundingAmount, variant = "block" }: OrderDiscountRowProps) {
  // ⚠️ useT() 一定要喺 early return（total <= 0）之前（Rules of Hooks）。
  const t = useT();
  const itemSaving = orderItemDiscountTotal(items);
  const wholeSaving = Math.max(0, Number(wholeOrderDiscountAmount ?? 0));
  const roundingSaving = Math.max(0, Number(roundingAmount ?? 0));
  const total = round2(itemSaving + wholeSaving + roundingSaving);
  if (total <= 0) return null;
  const sizeText = variant === "compact" ? "text-xs" : "text-sm";
  return (
    <div className={`grid gap-1 ${variant === "compact" ? "" : "mt-1"}`}>
      {itemSaving > 0 ? (
        <div className={`flex items-center justify-between ${sizeText}`}>
          <span className="text-slate-500">{t("單品折扣")}</span>
          <span className="font-semibold tabular-nums text-emerald-700">-{formatMoney(itemSaving, currency)}</span>
        </div>
      ) : null}
      {wholeSaving > 0 ? (
        <div className={`flex items-center justify-between ${sizeText}`}>
          <span className="text-slate-500">{t("全單折扣")}</span>
          <span className="font-semibold tabular-nums text-emerald-700">-{formatMoney(wholeSaving, currency)}</span>
        </div>
      ) : null}
      {roundingSaving > 0 ? (
        <div className={`flex items-center justify-between ${sizeText}`}>
          <span className="text-slate-500">{t("抹零")}</span>
          <span className="font-semibold tabular-nums text-emerald-700">-{formatMoney(roundingSaving, currency)}</span>
        </div>
      ) : null}
      {total > 0 ? (
        <div className={`flex items-center justify-between border-t border-slate-100 pt-1 ${sizeText}`}>
          <span className="font-semibold text-slate-700">{t("合計優惠")}</span>
          <span className="font-bold tabular-nums text-emerald-700">-{formatMoney(total, currency)}</span>
        </div>
      ) : null}
    </div>
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}