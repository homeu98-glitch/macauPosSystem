"use client";

import { isReopenTempTable } from "@/lib/pos/table-scope";
import { loadBootstrapCache, loadPosLocalSettings } from "@/lib/storage";
import type { PosBootstrap, PosLocalSettings } from "@/lib/types";

/**
 * 枱面／排位彈窗嘅**唯一真源**（2026-09-12 抽離）。
 *
 * ## 為咩要抽一個檔
 *
 * 呢條合併規則原本只住喺 `pos-app.tsx`（`buildDisplayFloors`），只有桌台總覽用。
 * 結果「排位」彈窗（`online-orders.tsx`）自己讀 `localSettings.floors` ——
 * 但商家嘅真枱係喺**伺服器 bootstrap**（後台／另一部機建立），本機 per-terminal 嘅
 * `floors` 可能淨係出廠預設（`1樓 A01-A03`、`2樓 B01-B02`）
 * → **彈窗顯示 default 桌台，同店內實際情況唔一致**（商家 2026-09-12 實案）。
 *
 * ⇒ 任何要列枱嘅地方（桌台總覽、排位彈窗、開桌）一律用呢個模組，唔可以自己讀
 * `localSettings.floors`。
 *
 * ## ⚠️ 2026-09-13 補記：同一個坑中咗第二次
 *
 * 2026-09-12 只改咗 `pos-app.tsx`（POS 主頁），但 **`online-orders.tsx`（`/orders` 頁）
 * 冇跟住改**，仍然自己讀 `localSettings.floors` → 商家再次實案投訴
 * 「**排位後出來的又不是店內的桌台**」（彈窗顯示 `1樓 A01-A03 / 2樓 B01-B02` 出廠預設，
 * 而店內真枱係 `A01/A03/A04/外賣自取1`）。已於 2026-09-13 改用
 * `buildDisplayFloors(bootstrapTables, localSettings.floors)` ＋ 訂閱
 * `pos-bootstrap-changed`。
 *
 * ⇒ **新增任何「列枱／選枱」UI 時，一定要搜一次 `localSettings.floors`，
 *    確認冇漏（呢個坑已經中過兩次）。**
 */

/** 一個可揀嘅枱（排位彈窗用）。 */
export type AssignableTable = { id: string; name: string; floorName: string };

/**
 * 桌台總覽用嘅樓層／枱清單 = **bootstrap 真源 + 本地 overlay**。
 *
 * - 枱嘅 **ID 存在性**由 `bootstrapTables` 話事（kiosk / 掃碼落單共享真源）；
 * - 枱嘅 **name / area / capacity** 以 `localFloors` 為準（per-terminal 編輯真源）；
 * - 本地獨有枱（唔喺 bootstrap，例如返結 temp 枱）按 area 併入同層，
 *   floor id 固定 `area:<名>`，確保「一個樓層名 = 一個 floor」唔會重複。
 */
export function buildDisplayFloors(
  bootstrapTables: PosBootstrap["tables"],
  localFloors: PosLocalSettings["floors"],
): PosLocalSettings["floors"] {
  const bootstrapIds = new Set(bootstrapTables.map((t) => t.id));
  const localTableById = new Map<string, PosLocalSettings["floors"][number]["tables"][number]>();
  for (const lf of localFloors) {
    for (const t of lf.tables) localTableById.set(t.id, t);
  }

  const byArea = new Map<string, PosLocalSettings["floors"][number]["tables"]>();

  const addTable = (
    table: PosLocalSettings["floors"][number]["tables"][number],
    area: string | undefined,
  ) => {
    const key = area && area.trim() ? area.trim() : table.area && table.area.trim() ? table.area.trim() : "未分區";
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key)!.push(table);
  };

  // 1) 共享真源：bootstrap.tables 提供枱 ID；有對應本地枱就用本地版本（area 以本地編輯為準）
  for (const t of bootstrapTables) {
    const local = localTableById.get(t.id) ?? t;
    addTable(local, local.area);
  }

  // 2) overlay：本地獨有枱（唔喺 bootstrap）按 area 併入同層，避免重複樓層名
  for (const lf of localFloors) {
    for (const t of lf.tables) {
      if (bootstrapIds.has(t.id)) continue;
      addTable(t, t.area || lf.name);
    }
  }

  return Array.from(byArea.entries()).map(([area, tables]) => ({
    id: `area:${area}`,
    name: area,
    tables,
  }));
}

/**
 * 由 localStorage 直接砌「可排位枱」清單（**同桌台總覽同一真源**）。
 *
 * ⚠️ 一定要剔走**返結 temp 枱**（`isReopenTempTable`）：嗰啲係返結流程臨時搬單用嘅假枱，
 * 唔應該畀人（或線上單）排位揀中，否則會塞入一張唔存在嘅枱。
 */
export function loadAssignableTables(): AssignableTable[] {
  const bootstrapTables = loadBootstrapCache()?.tables ?? [];
  const localFloors = loadPosLocalSettings().floors ?? [];
  return buildDisplayFloors(bootstrapTables, localFloors).flatMap((floor) =>
    floor.tables
      .filter((table) => !isReopenTempTable(table))
      .map((table) => ({ id: table.id, name: table.name, floorName: floor.name })),
  );
}
