/**
 * `SeatLine` → `OrderItem` —— 入座開枱時把預點菜變成真正的購物車行。
 *
 * ## 為什麼要這一層
 *
 * `seat-plan` 只回「菜 / 數量 / 當日價 / 折價來源」，
 * 而 POS 購物車需要 `printerGroup`（決定出邊台機）、`selectedSpecs`（要印規格）。
 * 呢啲只有菜單有，所以一定要喺**有菜單嘅地方**做轉換。
 *
 * ## 為什麼唔喺 `pos-app` 做
 *
 * `pos-app.tsx` 9336 行，喺裡面加轉換邏輯等於再埋一粒計時炸彈。
 * 呢度做成純函數，可以單測，亦可以喺訂位頁先計好再深鏈過去。
 */

import type { MenuItem, MenuSpecGroup, OrderItem } from "@/lib/types";
import type { SeatLine } from "./items.ts";

/** 把 `{ groupId: [optionId] }` 還原成 `OrderItem.selectedSpecs`（帶名稱與加價）。 */
export function buildSelectedSpecs(
  groups: readonly MenuSpecGroup[] | undefined,
  specs: Record<string, string[]>,
): NonNullable<OrderItem["selectedSpecs"]> {
  if (!groups || groups.length === 0) return [];
  const out: NonNullable<OrderItem["selectedSpecs"]> = [];

  for (const group of groups) {
    const ids = specs[group.id] ?? [];
    for (const id of ids) {
      const option = group.options.find((o) => o.id === id);
      if (!option) continue;
      out.push({
        groupId: group.id,
        groupName: group.name,
        optionId: option.id,
        optionLabel: option.label,
        priceDelta: option.priceDelta,
      });
    }
  }
  return out;
}

export type SeatToOrderResult = {
  items: OrderItem[];
  /** 菜單找不到的菜（正常情況應該係空；有值代表菜單喺入座途中變咗）。 */
  missing: Array<{ menuItemId: string; name: string }>;
};

/**
 * 入座帶入用：`SeatLine[]` → `OrderItem[]`。
 *
 * ⚠️ `discountRate` / `memberPrice` 要原樣帶過去 ——
 *    收銀台之後用 `orderTotals()` 重算，冇呢兩個值就會計返原價，
 *    同訂位時顯示嘅金額對唔上。
 */
export function toOrderItems(
  lines: readonly SeatLine[],
  menuItems: readonly MenuItem[],
): SeatToOrderResult {
  const byId = new Map(menuItems.map((item) => [item.id, item]));
  const items: OrderItem[] = [];
  const missing: SeatToOrderResult["missing"] = [];

  for (const line of lines) {
    const menuItem = byId.get(line.menuItemId);
    if (!menuItem) {
      missing.push({ menuItemId: line.menuItemId, name: line.name });
      continue;
    }

    const item: OrderItem = {
      menuItemId: menuItem.id,
      name: menuItem.name || line.name,
      quantity: line.qty,
      price: line.unitPrice,
      printerGroup: menuItem.printerGroup,
    };

    const selected = buildSelectedSpecs(menuItem.specGroups, line.specs);
    if (selected.length > 0) item.selectedSpecs = selected;

    if (typeof line.memberPrice === "number") {
      item.memberPrice = line.memberPrice;
    } else if (typeof line.discountRate === "number" && line.discountRate > 0 && line.discountRate < 100) {
      item.discountRate = line.discountRate;
    }

    // 規格文字落 note，令廚房單印得返「少冰 · 少甜」
    if (line.specText && selected.length === 0) {
      item.note = line.specText;
    }

    items.push(item);
  }

  return { items, missing };
}
