import type { MenuItem, MenuSpecGroup, OrderItem } from "@/lib/types";

/**
 * 規格選擇嘅**純函式**轉換（2026-09-16 由 `pos-app.tsx` 抽出）。
 *
 * ## 為咩要抽
 *
 * 呢兩個函式本來係 `pos-app.tsx` 嘅 local function（`priceWithSpecs` /
 * `buildSelectedSpecs`）。店員手機落單（`/staff`）都需要一模一樣嘅換算 ——
 * **加錢規格**嘅價錢算法一定要同收銀台完全一致，否則同一道菜
 * 「手機落單 $58、收銀落單 $62」。
 *
 * 抄一份落新檔 = 兩處各寫一半，日後改折扣邏輯必然走樣。
 * 所以抽成單一真源，兩邊都用呢份。
 *
 * 純函式、零 runtime 依賴（只 `import type`）→ 可以被 `node --test` 直接覆蓋。
 */

/**
 * 由規格選擇計出該菜式嘅單價。
 *
 * ⚠️ 折扣處理（同 pos-app 原實作完全一致，唔可以隨意改）：
 * 若菜品層有折扣，揀菜價（`item.price`）已經係**折後**；`OrderItem.price`
 * 要寫**原價** + 另存 `discountRate`，令收據／對帳分得出「原價合計」同「折後價」。
 * 規格加價一律加落**原價** base —— 規格加錢屬菜品本身，**唔再二次打折**。
 */
export function priceWithSpecs(
  item: Pick<MenuItem, "price" | "originalPrice" | "discountRate">,
  selectedSpecs: OrderItem["selectedSpecs"] = [],
): number {
  const specDelta = selectedSpecs.reduce((sum, spec) => sum + spec.priceDelta, 0);
  if (item.discountRate != null && item.discountRate > 0 && item.discountRate < 100) {
    const basePrice = item.originalPrice ?? item.price;
    return basePrice + specDelta;
  }
  return item.price + specDelta;
}

/**
 * `Record<groupId, optionId[]>`（`ItemSpecModal` 嘅輸出形狀）
 * → `OrderItem["selectedSpecs"]`（訂單持久化形狀）。
 *
 * 保留 `groupName` / `optionLabel`：出單（廚房單／收據）直接顯示文字，
 * 如果只存 id，打印端就要再查一次菜單，離線時會印唔到規格名。
 */
export function buildSelectedSpecs(
  specGroups: MenuSpecGroup[],
  selectedMap: Record<string, string[]>,
): OrderItem["selectedSpecs"] {
  return specGroups
    .flatMap((group) => {
      const selectedIds = selectedMap[group.id] ?? [];
      return group.options
        .filter((candidate) => selectedIds.includes(candidate.id))
        .map((option) => ({
          groupId: group.id,
          groupName: group.name,
          optionId: option.id,
          optionLabel: option.label,
          priceDelta: option.priceDelta,
        }));
    })
    .filter((spec): spec is NonNullable<OrderItem["selectedSpecs"]>[number] => Boolean(spec));
}

/**
 * 菜品層折扣 → `OrderItem.discountRate`。`undefined` = 冇折扣。
 * 已下單嘅菜由 `order-note-lock` 守住，呢個 helper 只用嚟 commit 新 cart line。
 */
export function menuItemDiscountRate(
  item: Pick<MenuItem, "discountRate">,
): number | undefined {
  if (item.discountRate != null && item.discountRate > 0 && item.discountRate < 100) {
    return item.discountRate;
  }
  return undefined;
}
