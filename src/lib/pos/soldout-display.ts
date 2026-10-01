/**
 * 沽清狀態 ↔ 菜單對照（2026-10-01）。
 *
 * ## 為咩要有
 *
 * 報表「沽清菜品」卡曾經直接倒出原始 UUID（J 截圖實案）：
 *
 *   ledger-074cf1d4-2390-4921-b22e-68e5e335d739
 *   ledger-e4295eb9-26a9-4be8-ac31-19ef11d31292
 *   ⋯（同卡另有正常顯示嘅菜名）
 *
 * 根因有兩個：
 *   1. **顯示層**：`names.get(k) ?? k` —— 搵唔到名就直接顯示原始 key。
 *   2. **資料層**：沽清狀態存喺本機 localStorage，**只增不減**。菜品被刪、換機、
 *      清快取後重新同步，舊 ID 就變成孤兒，永遠留在記錄內。
 *
 * ## 呢個模組負責咩
 *
 * 把「本機沽清狀態」+「目前菜單」對照一次，拆出：
 *   - `items`   : 真實仍在賣、且已沽清嘅菜品名（可以安全顯示）
 *   - `orphans` : 對唔上任何菜品嘅 key（應該被清除）
 *
 * ⚠️ **零 import** —— 專案用 `node --test`，唔認 `@/` alias，所以純邏輯必須
 *    獨立成檔才可以被測試直接 import（見 `src/lib/pos/` 其他同類模組）。
 */

/** 單一沽清記錄（同 `storage.ts` 嘅 `SoldOutState` 值結構一致）。 */
export type SoldOutEntry = {
  initialQty: number;
  remainingQty: number;
  updatedAt: string;
};

/** 沽清狀態：key ＝ menuItemId（或 `specopt:<optionId>`）。 */
export type SoldOutMap = Record<string, SoldOutEntry>;

export type ResolveSoldOutResult = {
  /**
   * 真實仍在賣、且 `remainingQty <= 0` 嘅菜品**名**。
   * ⚠️ 同名菜品只會出現一次（去重）—— 卡面用名做 React key，重名會撞 key。
   */
  items: string[];
  /**
   * 對唔上任何菜品嘅沽清 key（孤兒）。應該由本機狀態清除。
   * 包含唔喺菜單嘅 `menuItemId`；`specopt:` 前綴嘅規格key唔會計入（另有一套 UI）。
   */
  orphans: string[];
  /** 有沽清（`remainingQty <= 0`）嘅菜品 ID，按輸入順序，方便偵錯。 */
  soldOutIds: string[];
};

/**
 * 由沽清狀態 + 菜單（id → 名）拆出「可顯示嘅沽清菜品」同「孤兒 key」。
 *
 * @param map       本機沽清狀態（`loadSoldOutState()`）。
 * @param menuItems 目前菜單；只需要 `id` 同 `name` 兩個欄位。
 *
 * 規則：
 *   - 只考慮 `remainingQty <= 0` 嘅項目（同上線前口徑一致）。
 *   - 跳過 `specopt:` 前綴嘅規格沽清（規格唔係菜品）。
 *   - **搵唔到名 ⇒ 歸入 `orphans`，唔會出現喺 `items`**（唔倒 UUID 出街）。
 */
export function resolveSoldOutDisplay(
  map: SoldOutMap | null | undefined,
  menuItems: ReadonlyArray<{ id: string; name?: string }> | null | undefined,
): ResolveSoldOutResult {
  const names = new Map<string, string>();
  for (const m of menuItems ?? []) {
    if (m && typeof m.id === "string" && m.id) names.set(m.id, String(m.name ?? ""));
  }

  const items: string[] = [];
  const seen = new Set<string>();
  const orphans: string[] = [];
  const soldOutIds: string[] = [];

  for (const [key, entry] of Object.entries(map ?? {})) {
    if (!key || key.startsWith("specopt:")) continue;
    if ((entry?.remainingQty ?? 1) > 0) continue; // 有剩 ⇒ 未沽清

    soldOutIds.push(key);
    const name = names.get(key);
    if (name) {
      if (!seen.has(name)) {
        seen.add(name);
        items.push(name);
      }
    } else {
      orphans.push(key);
    }
  }

  return { items, orphans, soldOutIds };
}

/**
 * 由現有沽清狀態移除一批孤兒 key（唔改動原物件）。
 *
 * @returns 清乾淨嘅新狀態；若冇任何改動則回**原本嗰個**參照（方便呼叫端判斷要唔要寫入）。
 */
export function dropSoldOutKeys(
  map: SoldOutMap | null | undefined,
  keysToDrop: ReadonlyArray<string>,
): SoldOutMap {
  const base = map ?? {};
  if (!keysToDrop || keysToDrop.length === 0) return base;
  const next: SoldOutMap = { ...base };
  let touched = false;
  for (const k of keysToDrop) {
    if (Object.prototype.hasOwnProperty.call(next, k)) {
      delete next[k];
      touched = true;
    }
  }
  return touched ? next : base;
}
