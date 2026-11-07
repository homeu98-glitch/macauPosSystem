"use client";

/**
 * 訂位頁取菜單 —— 先讀本機快取，冇就即場拉一次。
 *
 * ## 為什麼要兜底
 *
 * 訂位頁（`/reservations`）同收銀台（`/pos`）係兩個路由。店員有機會**直接**
 * 打開訂位頁（例如由書籤或上一輪 session），此時本機未必有 `bootstrap` 快取。
 * 冇菜單 ⇒ `toOrderItems()` 會全部當「找不到」⇒ 入座後購物車空空，
 * 而畫面又冇報錯 —— 典型「靜靜壞」。
 *
 * 所以：有快取用快取（零延遲），冇就拉 `/api/pos/bootstrap`（公開端點，已限流）。
 */

import { loadBootstrapCache } from "@/lib/storage";
import type { MenuCategory, MenuItem } from "@/lib/types";

export type MenuSource = {
  menuItems: MenuItem[];
  categories: MenuCategory[];
  /** 全店會員折扣率（90 = 9 折）；null = 無。 */
  memberDiscountRate: number | null;
};

const cache = new Map<string, MenuSource>();

export function peekMenuSource(storeId: string): MenuSource | null {
  const hit = cache.get(storeId);
  if (hit) return hit;
  const bootstrap = loadBootstrapCache(storeId);
  if (!bootstrap?.menuItems?.length) return null;
  const rate = bootstrap.rules?.memberDiscountRate;
  const source: MenuSource = {
    menuItems: bootstrap.menuItems,
    categories: bootstrap.categories ?? [],
    memberDiscountRate: typeof rate === "number" && rate > 0 && rate < 100 ? rate : null,
  };
  cache.set(storeId, source);
  return source;
}

export async function resolveMenuSource(storeId: string): Promise<MenuSource> {
  const cached = peekMenuSource(storeId);
  if (cached) return cached;

  try {
    const res = await fetch(`/api/pos/bootstrap?storeId=${encodeURIComponent(storeId)}`, {
      cache: "no-store",
    });
    const json = (await res.json()) as {
      menuItems?: MenuItem[];
      categories?: MenuCategory[];
      rules?: { memberDiscountRate?: number };
    };
    const rate = json.rules?.memberDiscountRate;
    const source: MenuSource = {
      menuItems: Array.isArray(json.menuItems) ? json.menuItems : [],
      categories: Array.isArray(json.categories) ? json.categories : [],
      memberDiscountRate: typeof rate === "number" && rate > 0 && rate < 100 ? rate : null,
    };
    if (source.menuItems.length > 0) cache.set(storeId, source);
    return source;
  } catch {
    return { menuItems: [], categories: [], memberDiscountRate: null };
  }
}

/** 測試 / 切店時清掉記憶體快取。 */
export function clearMenuSourceCache(storeId?: string): void {
  if (storeId) cache.delete(storeId);
  else cache.clear();
}
