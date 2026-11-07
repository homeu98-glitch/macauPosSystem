/**
 * 服務端核價 —— **唔信前端傳嚟嘅任何金額**。
 *
 * ## 為什麼一定要在 server 重算
 *
 * 訂位預點菜會直接影響「預付多少錢」。如果信前端：
 *   · 客人可以改 `unitPrice` 用 $0.01 訂一圍菜；
 *   · 會員折扣可以自己寫 10 折（1 折）；
 *   · 已下架的菜可以照樣落單。
 *
 * 所以前端只准傳 `menuItemId / qty / specs`，
 * 價錢、菜名、折扣一律由呢個函數按**菜單現價 + 店鋪折扣**重新填。
 *
 * @see items.ts `sanitizeReservationItems()` —— 第一層結構收斂
 */

import { computeReservationTotals, itemNetPrice, type ReservationTotals } from "./items.ts";
import type { ReservationItem } from "./types.ts";

/** 核價所需的最小菜單欄位（對應 `pos_bootstrap_config.menu_items` 的項目）。 */
export type MenuItemLite = {
  id: string;
  name: string;
  price: number;
  memberPrice?: number | null;
  /** 時價菜：無法在訂位階段定價，一律拒絕。 */
  isMarketPrice?: boolean;
  /** 已下架 / 售罄標記（若菜單有帶）。 */
  soldOut?: boolean;
  /** 停售（`active === false`）。 */
  active?: boolean;
};

export type PricedReservation = {
  items: ReservationItem[];
  totals: ReservationTotals;
  /** 被拒絕的項目（不存在 / 時價 / 停售），讓 UI 可以提示。 */
  rejected: Array<{ menuItemId: string; reason: "not_found" | "market_price" | "inactive" }>;
};

/**
 * 按菜單現價重算預點菜。
 *
 * @param discountRate 全店會員折扣率（90 = 9 折）；`null` = 無折扣。
 */
export function priceReservationItems(params: {
  raw: Array<{ menuItemId: string; qty: number; specs: Record<string, string[]>; specText: string }>;
  menuItems: readonly MenuItemLite[];
  discountRate: number | null;
  now?: Date;
}): PricedReservation {
  const now = params.now ?? new Date();
  const byId = new Map(params.menuItems.map((item) => [item.id, item]));
  const items: ReservationItem[] = [];
  const rejected: PricedReservation["rejected"] = [];

  for (const entry of params.raw) {
    const menuItem = byId.get(entry.menuItemId);
    if (!menuItem) {
      rejected.push({ menuItemId: entry.menuItemId, reason: "not_found" });
      continue;
    }
    if (menuItem.isMarketPrice) {
      rejected.push({ menuItemId: entry.menuItemId, reason: "market_price" });
      continue;
    }
    if (menuItem.active === false || menuItem.soldOut === true) {
      rejected.push({ menuItemId: entry.menuItemId, reason: "inactive" });
      continue;
    }

    const unitPrice = Number(menuItem.price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      rejected.push({ menuItemId: entry.menuItemId, reason: "not_found" });
      continue;
    }

    items.push({
      menuItemId: menuItem.id,
      name: menuItem.name,
      specText: entry.specText,
      specs: entry.specs,
      qty: entry.qty,
      unitPrice,
      memberPrice:
        typeof menuItem.memberPrice === "number" && Number.isFinite(menuItem.memberPrice)
          ? menuItem.memberPrice
          : null,
      discountRate: params.discountRate,
      snapshotAt: now.toISOString(),
    });
  }

  return { items, totals: computeReservationTotals(items), rejected };
}

/** 單項折後價（給 UI 顯示用，跟 items.ts 同一套規則）。 */
export function previewNetPrice(item: Pick<ReservationItem, "unitPrice" | "memberPrice" | "discountRate">): number {
  return itemNetPrice(item);
}
