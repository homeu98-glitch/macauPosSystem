import { FloorConfig, StoreTable } from "@/lib/types";

/**
 * 返結 temp 枱嘅 id 前綴（`createReopenTempTable` 用嚟建立 temp 枱）。
 * 放喺度做共用常數，避免判斷邏輯散落各處各自寫死字串。
 */
export const TEMP_REOPEN_ID_PREFIX = "temp-reopen-";

/**
 * 返結 temp 枱判定 —— 全 repo 唯一真源（同 `order-note-lock.ts` 一樣嘅共用 predicate 模式）。
 *
 * ## 點解要有呢個 predicate
 *
 * temp 枱設計上**只喺「返結單編輯期間」存在**：
 * `createReopenTempTable()` 建立 → `removeReopenTempTable()` 喺結帳／取消後清除
 * （見 `types.ts` `StoreTable.isReopenTemp` 嘅註釋：`結帳／取消後由 removeReopenTempTable 清除`）。
 *
 * 但佢實際係 **push 入 `localSettings.floors[].tables[]`，同真實枱共用同一個 collection**。
 * 即係話任何「讀枱」嘅代碼都預設會見到 temp 枱，而 temp 枱唔屬於嗰度。
 *
 * ## 唔 filter 會點（已實際發生嘅 bug）
 *
 * | 使用點 | 後果 |
 * | --- | --- |
 * | `device-settings` `saveTablesLocal()` | temp 枱寫上 server `pos_bootstrap_config.tables` → **永久升級做真實枱** |
 * | `device-settings` 樓層管理 render | admin 見到 temp 枱、可改名 / 改座位數 |
 * | `device-settings` `syncConfig()` | temp 枱寫上 server `pos_device_configs.local_settings.floors` |
 * | `kiosk-qr-panel` | 為 temp 枱產生掃碼點餐 QR → 客人掃到「返結 A03」落單 |
 * | `online-orders` 派枱 | 職員可將線上單派去 temp 枱 → 結帳後張枱消失 |
 *
 * ## 鐵律
 *
 * **每一個 `floors[].tables[]` 嘅讀取點，只要目的地唔係「枱面 view」，都必須 filter 走 temp 枱。**
 * 「枱面 view」（`pos-app.tsx` `buildDisplayFloors`）係**唯一**應該見到 temp 枱嘅地方——
 * 因為嗰度要用「返結·<樓層>」分區做返結單嘅編輯入口。
 *
 * 唔可以靠 caller 自己記得 filter：呢個 predicate 就係為咗令 filter 有單一寫法。
 *
 * `id` 前綴係安全網：萬一有 temp 枱喺舊版本丟失咗 `isReopenTemp` flag 都認得返。
 */
export function isReopenTempTable(table: Pick<StoreTable, "id" | "isReopenTemp">): boolean {
  return table.isReopenTemp === true || table.id.startsWith(TEMP_REOPEN_ID_PREFIX);
}

/** 由一層 floor 剝走返結 temp 枱。無 temp 枱時原物返回（保持 reference 穩定，免無謂 re-render）。 */
export function stripReopenTempTablesFromFloor(floor: FloorConfig): FloorConfig {
  const tables = floor.tables.filter((table) => !isReopenTempTable(table));
  return tables.length === floor.tables.length ? floor : { ...floor, tables };
}

/** 由所有 floors 剝走返結 temp 枱（唔改動原物件）。推上 server 前必須用。 */
export function stripReopenTempTables(floors: FloorConfig[]): FloorConfig[] {
  return floors.map(stripReopenTempTablesFromFloor);
}

/**
 * 由一條已攤平嘅枱 list 剝走返結 temp 枱。
 *
 * **重要**：連 `bootstrap.tables` 都要filter。若果 temp 枱曾經喺修復前漏咗上
 * bootstrap（server `pos_bootstrap_config.tables` 或本地 bootstrap cache），
 * 單單 filter 本地枱係唔夠——合併邏輯（`[...本地枱, ...bootstrap獨有枱]`）會
 * 由 bootstrap 嗰邊**復活**返 temp 枱。filter 埋 bootstrap 先做到 self-healing，
 * 用戶下次撳保存就自動清走舊有污染。
 */
export function filterReopenTempTables(tables: StoreTable[]): StoreTable[] {
  return tables.filter((table) => !isReopenTempTable(table));
}
