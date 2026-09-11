/**
 * KDS 工位（崗位）推導（docs/116 §4.4）。
 *
 * ## 為什麼唔可以寫死工位清單
 *
 * `type PrinterGroup = string` —— 係**自由字串**，唔係 union。
 * 店家可以自己加「炸爐」「蒸櫃」「刺身」任何值。所以工位清單一定要
 * **由實際資料推導**，唔可以喺 code 寫死 `["kitchen","drinks"]`。
 *
 * ## 為什麼一定要剔走 `receipt` / `label`
 *
 * `receipt` 係**收銀機嘅出單打印機**，`label` 係標籤機 —— 兩者都唔係「一個工作崗位」。
 * 如果佢哋出現喺「揀崗位」畫面，師傅會揀到一個永遠冇出品嘅工位。
 * 呢個係最重要嘅過濾，唔可以漏。
 *
 * 純函式、零執行期 import → 可 `node --test`（見 `stations.test.ts`）。
 */

import type { KdsStationOption } from "./types.ts";

/**
 * 唔係工位嘅 printerGroup。
 * - `receipt`：收銀機出單（`PrinterGroup` 預設值之一，全店都用）
 * - `label`：標籤機（杯貼 / 包裝貼）
 */
export const NON_STATION_PRINTER_GROUPS: ReadonlySet<string> = new Set(["receipt", "label"]);

/** 常見工位嘅中文顯示名。冇對應就用返原字串（店家自訂工位唔會被迫改名）。 */
const STATION_LABELS: Record<string, string> = {
  kitchen: "廚房",
  hot: "熱廚",
  wok: "炒鍋",
  grill: "燒味",
  cold: "冷盤",
  drinks: "水吧",
  bar: "水吧",
  beverage: "飲品",
  dessert: "甜品",
};

/** 冇任何可用工位時嘅唯一 fallback（細店 / 菜單未設 printerGroup）。 */
export const FALLBACK_STATION_ID = "kitchen";

/** 排序權重：廚房類行先、水吧其後，未知工位排最後（按字母）。 */
const STATION_ORDER: Record<string, number> = {
  kitchen: 0,
  hot: 1,
  wok: 2,
  grill: 3,
  cold: 4,
  drinks: 10,
  bar: 11,
  beverage: 12,
  dessert: 13,
};

export function stationLabel(id: string): string {
  return STATION_LABELS[id] ?? id;
}

/** 呢個 printerGroup 係唔係一個「工作崗位」。 */
export function isKdsStation(printerGroup: string | null | undefined): boolean {
  if (typeof printerGroup !== "string") return false;
  const trimmed = printerGroup.trim();
  if (!trimmed) return false;
  return !NON_STATION_PRINTER_GROUPS.has(trimmed.toLowerCase());
}

/**
 * 由菜單、打印機群同**實際訂單出現過嘅工位**推導工位清單。
 *
 * 三個來源係**聯集**：
 *   1. `observedStationIds` —— 現時板上訂單真正出現過嘅工位（最權威）
 *   2. `menuItems[].printerGroup` —— 菜單有出品嘅工位
 *   3. `printerGroups[]` —— 店已配置嘅打印機群
 *
 * 點解要第 1 個來源：如果只靠 `printer_groups`，一旦店家未同步餐牌就會**冇工位可揀**；
 * 而且「店員落單夾咗一個新工位」嘅單出現時，屏亦要即時見得到。
 * 反過來只靠第 1 個來源唔得：板上冇單（清晨 / 落場）就會冇工位清單 → 部機開唔到。
 *
 * @param pending 各工位未完成項數（`{ kitchen: 7, drinks: 3 }`）。冇提供就全部 0。
 */
export function deriveKdsStations(input: {
  printerGroups?: Array<string | null | undefined> | null;
  menuItemGroups?: Array<string | null | undefined> | null;
  observedStationIds?: Array<string | null | undefined> | null;
  pending?: Record<string, number> | null;
}): KdsStationOption[] {
  const ids = new Set<string>();
  const add = (group: string | null | undefined) => {
    if (isKdsStation(group)) ids.add(String(group).trim());
  };
  for (const group of input.observedStationIds ?? []) add(group);
  for (const group of input.menuItemGroups ?? []) add(group);
  for (const group of input.printerGroups ?? []) add(group);

  // 一個工位都冇 → fallback 單一「廚房」。
  // 唔回空陣列：空陣列會令「揀崗位」畫面冇嘢揀 = 部機卡死。
  if (ids.size === 0) ids.add(FALLBACK_STATION_ID);

  const pending = input.pending ?? {};
  return [...ids]
    .sort((a, b) => {
      const wa = STATION_ORDER[a] ?? 900;
      const wb = STATION_ORDER[b] ?? 900;
      if (wa !== wb) return wa - wb;
      return a.localeCompare(b);
    })
    .map((id) => ({
      id,
      label: stationLabel(id),
      pending: Math.max(0, Math.trunc(pending[id] ?? 0)),
    }));
}

/**
 * 揀崗位畫面要唔要顯示選擇步驟。
 *
 * 只有一個工位 → **唔應該出選擇步驟**，直接鎖定（docs/116 §4.4 邊界情況）。
 * 多餘嘅一步只會增加誤按機會，同我哋嘅目標相反。
 */
export function needsStationPicker(stations: KdsStationOption[]): boolean {
  return stations.length > 1;
}

/**
 * 校驗一個「已綁定嘅 station」仲係唔係有效工位。
 *
 * 用途：店家改咗菜單 / 換咗打印機之後，綁定嘅工位可能已經唔存在。
 * 呢個時候**唔可以**靜靜當佢係「全部」——要彈返去重揀。
 */
export function isStationAvailable(
  stations: KdsStationOption[],
  station: string | null | undefined,
): boolean {
  if (typeof station !== "string" || !station.trim()) return false;
  return stations.some((s) => s.id === station);
}
