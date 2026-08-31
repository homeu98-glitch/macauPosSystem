import type { DiscountPreset, OrderItem } from "@/lib/types";

/**
 * 折扣工具函數（docs/折扣需求）。
 *
 * rate 語義：百分比數字 0-100。
 * - 80 = 8 折（收 80 元 / 原價 100）
 * - 100 = 冇折扣
 * - 50 = 5 折
 * 介面輸入同顯示都唔帶「%」號（見設置 tab）。
 */

/** 全單折扣：由總額計應減金額。rate 係百分比（80 = 8 折）。 */
export function discountAmountFromRate(total: number, rate: number): number {
  const safeRate = Number.isFinite(rate) ? rate : 100;
  return roundMoney((total * (100 - safeRate)) / 100);
}

/** 單品折扣後單價（每單位）。 */
export function discountedUnitPrice(unitPrice: number, rate?: number): number {
  if (rate == null || !Number.isFinite(rate)) return unitPrice;
  return roundMoney((unitPrice * rate) / 100);
}

/** 單品折扣後小計（單價 × 數量）。 */
export function discountedItemTotal(item: Pick<OrderItem, "price" | "quantity" | "discountRate">): number {
  return discountedUnitPrice(item.price, item.discountRate) * item.quantity;
}

/** 折讓金額（單品原價小計 - 折後小計）。 */
export function itemDiscountSaving(item: Pick<OrderItem, "price" | "quantity" | "discountRate">): number {
  const original = item.price * item.quantity;
  return roundMoney(original - discountedItemTotal(item));
}

/** 由折扣預設 id 搵返 preset；搵唔到返 undefined（表示「冇折扣」）。 */
export function findDiscountPreset(discounts: DiscountPreset[], id: string | null | undefined): DiscountPreset | undefined {
  if (!id) return undefined;
  return discounts.find((d) => d.id === id);
}

/** 生成新折扣預設 id（避免同 id 碰撞）。 */
export function newDiscountId(): string {
  return `disc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
