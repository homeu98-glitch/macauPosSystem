/**
 * KDS 工位（崗位）推導（docs/116 §4.4 · 2026-09-11 修正）。
 *
 * ## 🔴 工位清單嘅唯一權威來源 = 商家自己設定嘅「打印分區」
 *
 * 商家喺「設定 → 打印機綁定 → 打印分區」自由新增分區（UI 文案都寫「分區可自由新增」），
 * 存喺 `localSettings.printZones: { id, name }[]`，同步上
 * `pos_device_configs.local_settings.printZones`。
 *
 * 典型：一間店可以有 **後廚1 / 後廚2 / 後廚3 / 水吧1 / 水吧2 / 水吧3** 六個分區。
 * 佢哋係**六個獨立工作崗位**（各有各嘅師傅、各有各嘅出餐節奏），
 * **唔可以**合併成「廚房」同「水吧」兩個。
 *
 * ## 為什麼唔可以喺 code 寫死分區名（舊版嘅錯）
 *
 * 舊版有一個 `STATION_LABELS = { kitchen:"廚房", drinks:"水吧", … }` 嘅對照表，
 * 結果係：① 商家改咗分區名，屏上仍然顯示我寫死嗰個；
 * ② 自訂分區（例如「EricTest」「後廚3」）會顯示成 raw id（甚至帶時間戳）。
 * 呢個係**產品概念錯誤** —— 分區係商家嘅商業詞彙，唔係系統嘅固定枚舉。
 *
 * ## 為什麼仍然要保留一個「舊資料」補救來源
 *
 * 舊店 / 未同步嘅環境，訂單上嘅 `printerGroup` 可能係 `kitchen` / `drinks` 之類
 * 唔喺 `printZones` 入面嘅值（歷史資料、或者 mock）。若果完全唔認佢，
 * 嗰啲單會**完全上唔到屏**（師傅見唔到要做嘅菜）—— 比顯示一個怪名嚴重得多。
 * 所以：`printZones` 做**主**，訂單實際觀察到嘅 id 做**補**（名就係 id 本身）。
 *
 * 純函式、零執行期 import → 可 `node --test`（見 `stations.test.ts`）。
 */

import type { KdsStationOption } from "./types.ts";

/** 商家設定嘅一個打印分區。同 `PosLocalSettings["printZones"][number]` 同形狀。 */
export interface PrintZone {
  id: string;
  name: string;
}

/**
 * ⚠️ **只**用嚟過濾「舊資料 / 未同步」嘅 fallback 值，**唔會**套用到商家嘅
 * `printZones`。呢兩個字係打印機 **role**（`printer.role`），唔係分區 ——
 * 正常情況下 `printZones` 根本唔會包含佢哋（`printer-wizard-modal` 入面
 * role === "receipt" 嘅機係**冇** `zoneId` 嘅）。
 * 舊 `printer_groups` / `mock-data` 真係有 `receipt` 呢個值，唔擋就會喺屏上出「收據」。
 */
export const LEGACY_NON_STATION_VALUES: ReadonlySet<string> = new Set(["receipt", "label"]);

function cleanId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 呢個值係唔係「舊資料專用」嘅排除項（唔係分區）。 */
export function isLegacyNonStation(value: string | null | undefined): boolean {
  const id = cleanId(value);
  return Boolean(id) && LEGACY_NON_STATION_VALUES.has(id.toLowerCase());
}

/**
 * 工位清單。
 *
 * @param printZones 商家設定嘅打印分區（**主來源**，名由商家話事）
 * @param observedStationIds 板上訂單實際出現過嘅 `printerGroup`（補舊資料 / 未同步）
 * @param menuItemGroups 菜單 `menuItem.printerGroup`（再兜一層；舊菜單可能仍係 `kitchen`）
 * @param printerGroups 舊 `pos_bootstrap_config.printer_groups`（最後兜底）
 * @param pending 各工位未完成**份數**（`{ "後廚1": 3 }`）。冇提供就全部 0。
 */
export function deriveKdsStations(input: {
  printZones?: PrintZone[] | null;
  observedStationIds?: Array<string | null | undefined> | null;
  menuItemGroups?: Array<string | null | undefined> | null;
  printerGroups?: Array<string | null | undefined> | null;
  pending?: Record<string, number> | null;
}): KdsStationOption[] {
  const pending = input.pending ?? {};
  const out: KdsStationOption[] = [];
  const seen = new Set<string>();

  // ① 主來源：商家設定嘅分區。名 = 商家打嘅名，**一個都唔合併、一個都唔改名**。
  for (const zone of input.printZones ?? []) {
    const id = cleanId(zone?.id);
    if (!id || seen.has(id)) continue;
    const name = cleanId(zone?.name) || id;
    seen.add(id);
    out.push({ id, name, label: name, pending: Math.max(0, Math.trunc(pending[id] ?? 0)) });
  }

  // ② 補救：舊資料 / 未同步嘅 id（只加唔喺 printZones 入面嘅）。
  const addFallback = (raw: string | null | undefined) => {
    const id = cleanId(raw);
    if (!id || seen.has(id) || isLegacyNonStation(id)) return;
    seen.add(id);
    // 冇名可以提供 → 用 id 做名（誠實過亂譯）
    out.push({ id, name: id, label: id, pending: Math.max(0, Math.trunc(pending[id] ?? 0)) });
  };
  for (const id of input.observedStationIds ?? []) addFallback(id);
  for (const id of input.menuItemGroups ?? []) addFallback(id);
  for (const id of input.printerGroups ?? []) addFallback(id);

  return out;
}

/**
 * 揀崗位畫面要唔要顯示選擇步驟。
 *
 * 只有一個分區 → **唔應該出選擇步驟**，直接鎖定（docs/116 §4.4 邊界情況）。
 * 多餘嘅一步只會增加誤按機會，同我哋嘅目標相反。
 */
export function needsStationPicker(stations: KdsStationOption[]): boolean {
  return stations.length > 1;
}

/**
 * 校驗一個「已綁定嘅 station」仲係唔係有效分區。
 *
 * 用途：店家改咗分區之後，綁定嘅分區可能已經唔存在 → 設定卡要出提示。
 * ⚠️ **唔會**自動彈返去揀崗位 —— 掛喺牆上嘅屏無啦啦跳去揀崗位係災難。
 */
export function isStationAvailable(
  stations: KdsStationOption[],
  station: string | null | undefined,
): boolean {
  const id = cleanId(station);
  if (!id) return false;
  return stations.some((s) => s.id === id);
}
