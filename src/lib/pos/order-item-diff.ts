/**
 * 訂單「新增菜品」差額計算（2026-09-10 掃碼加單修復）。
 *
 * 【背景】落單（ORDER_CREATED）與**加單**（ORDER_UPDATED）係兩種唔同嘅事件語義：
 *   - ORDER_CREATED：整張單都係新嘅 → 全部菜品要落廚房。
 *   - ORDER_UPDATED：單已經做緊，只有**新加**嘅菜要補落廚房（票種 `addon`）。
 *
 * 收銀台（`pos-app.tsx`）一直有做呢個差值（見 `submitOrder()` 內 `addedItems`），
 * 但**掃碼 / kiosk 加單路徑從來冇** —— 所以自助加單唔會補印廚房單（見 pos-app
 * `onOrderUpsert` 嘅 `isNewSelfOrder` 守門）。呢個 helper 抽出同一口徑，
 * 畀三邊（收銀端補印、kiosk 上送、server 端售罄校驗）共用，避免各自實現再分歧。
 *
 * 【菜品身分口徑】**必須**同 `pos-app.tsx` 嘅 `itemIdentity()` 一致：
 *   `${menuItemId}|${groupId:optionId 排序後以 | 連接}|${price}|${note}`
 * 唔一致會令同一碟菜被判成「兩款唔同菜」→ 重複出單 / 漏出單。
 *
 * 純函式、無副作用，可直接單元測試（見 `order-item-diff.test.ts`）。
 */

import type { OrderItem } from "@/lib/types";

/** 菜品身分 key。同 `pos-app.tsx` `itemIdentity()` 同口徑。 */
export function orderItemKey(item: OrderItem): string {
  const specs = (item.selectedSpecs ?? [])
    .map((spec) => `${spec.groupId}:${spec.optionId}`)
    .sort()
    .join("|");
  return `${item.menuItemId}|${specs}|${item.price}|${item.note ?? ""}`;
}

/**
 * 由 `base`（舊版本）→ `next`（新版本）之間**新增**嘅菜品，數量取差額。
 *
 * - 只回 `delta > 0` 嘅項目（減菜 / 改數量唔會出現喺結果）。
 * - 同一 key 喺兩邊都有時，用數量相減（例如原本 x1、之後 x3 → 回 x2）。
 * - 回傳嘅 item 保留 `next` 版本嘅資料（名稱 / 規格 / 備註），只改 `quantity`。
 *
 * @param base 舊版本 items（例如本機已知嘅版本 / resume 返嚟嘅原單）
 * @param next 新版本 items（例如 realtime 推落嚟嘅更新 / 今次落單嘅購物車）
 */
export function diffAddedItems(base: OrderItem[] | undefined, next: OrderItem[] | undefined): OrderItem[] {
  const baseQty = new Map<string, number>();
  for (const item of base ?? []) {
    const key = orderItemKey(item);
    baseQty.set(key, (baseQty.get(key) ?? 0) + (item.quantity ?? 0));
  }

  const added: OrderItem[] = [];
  for (const item of next ?? []) {
    const key = orderItemKey(item);
    const delta = (item.quantity ?? 0) - (baseQty.get(key) ?? 0);
    if (delta > 0) added.push({ ...item, quantity: delta });
  }
  return added;
}

/** 加總 items 嘅總件數（做「有冇新增」快速判斷、去重比對用）。 */
export function totalItemQuantity(items: OrderItem[] | undefined): number {
  return (items ?? []).reduce((sum, item) => sum + (item.quantity ?? 0), 0);
}

/**
 * 新增菜品嘅穩定簽名（用嚟去重：同一批新增菜唔應該補印兩次）。
 * 排序後串接，所以 items 次序唔影響結果。
 */
export function addedItemsSignature(items: OrderItem[] | undefined): string {
  return (items ?? [])
    .map((item) => `${orderItemKey(item)}#${item.quantity ?? 0}`)
    .sort()
    .join("||");
}
