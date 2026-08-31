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

/**
 * 訂單所有單品折扣總和（money）。摺入全單小計後再做稅／服務費 / 全單折扣，
 * 所以呢個值係「原本單品原價小計 - 摺咗單品折扣嘅 subtotal」嘅差。
 *
 * 用於顯示「優惠 XXX（單品折扣）」呢行，比 `order.discountAmount` 更精準——
 * 後者只反映全單折扣；單品折扣已內含喺 subtotal / total 內，唔會重複計算。
 */
export function orderItemDiscountTotal(items: OrderItem[]): number {
  return roundMoney(items.reduce((sum, item) => sum + itemDiscountSaving(item), 0));
}

/**
 * 訂單總折扣 = 單品折扣 + 全單折扣 money 金額。
 * 用於顯示「折扣 XXX」一行嘅總和（用戶需求：查看內要見到折扣多少、優惠多少）。
 */
export function orderTotalDiscount(
  items: OrderItem[],
  wholeOrderDiscountAmount: number,
): number {
  return roundMoney(orderItemDiscountTotal(items) + Math.max(0, wholeOrderDiscountAmount ?? 0));
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
