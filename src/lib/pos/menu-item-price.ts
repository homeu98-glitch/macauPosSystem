/**
 * 菜品價格輸入 → 實際存檔價格（2026-10-20）。
 *
 * ## 為咩要抽成純函式
 * 舊版寫法喺 `saveMenuItemModal()` 入面：
 * ```ts
 * let price = 0;
 * if (!menuItemModal.isMarketPrice) { price = Number(trimmedPrice); }
 * ```
 * —— 即係**只要「時價菜」勾住，商家打咗 70 都會靜靜存成 0**，列表事後顯示
 * 「價格 MOP 0.00」，商家以為價錢被清零（實際係時價菜冇參考價）。
 * 呢個係**靜默資料丟失**：UI 有顯示 70、DB 存 0、冇任何提示。
 *
 * 正確語義：
 * - 非時價菜：價格必填（`>= 0`，可以係 0 元菜）。
 * - 時價菜：價格可留空（落單時由店員輸入當次價錢）；但**填咗就要照存**，
 *   當「參考價」顯示喺菜品列表，唔可以丟。
 *
 * 零 import → 可以被 `node --test` 直接覆蓋（同 `member-price.ts` 同一做法）。
 */
export type MenuItemPriceResolution = { ok: true; price: number } | { ok: false; error: string };

export function resolveMenuItemPriceInput(
  rawInput: string,
  isMarketPrice: boolean,
): MenuItemPriceResolution {
  const trimmed = String(rawInput ?? "").trim();
  if (!trimmed) {
    // 時價菜可以冇參考價；非時價菜一定要有價
    if (isMarketPrice) return { ok: true, price: 0 };
    return { ok: false, error: "請填寫價格（時價菜可留空價格）。" };
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, error: "價格格式唔正確，請填 0 或以上嘅數字。" };
  }
  return { ok: true, price: parsed };
}
