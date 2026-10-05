/**
 * 「返結帳」清單 —— 桌台總覽跨機返結入口嘅**唯一真源**（2026-10-05）。
 *
 * ## 點解要有呢個檔（背景）
 *
 * 商家喺**一部機**撳返結，另一部機嘅桌台總覽**完全見唔到重結入口**：
 * `createReopenTempTable()`（`pos-orders.ts`）會建一張 `temp-reopen-<orderId>` 枱，
 * 但佢**只寫入本機** `localSettings.floors`；`device-settings.tsx` 推上 server 前會
 * `stripReopenTempTables()` 剝走（寫入 `pos_bootstrap_config.tables` 會令假枱
 * **永久升級做真實枱** —— 呢個係刻意取捨，唔係 bug）。
 *
 * ⇒ 另一部機由雲端 backfill 到 `status === "reopened"` 嘅單，但本機 `floors`
 * 冇對應嘅枱 ⇒ 桌台 grid `tableOrderMap` 對唔上任何枱 ⇒ **冇入口**。
 * 商家喺該機冇辦法完成重結（原枱 A01 反而顯示「空閒」）。
 *
 * ## 解法
 *
 * 桌台總覽另開一個**唔依賴枱**嘅「返結帳（N）」區塊，直接由 `reopened` 單砌出嚟。
 * 零新增 API、零新增 DB 查詢（只讀現成 `openOrders`）⇒ egress 零影響。
 *
 * ## ⚠️ 同 temp 枱并存（唔會重複）
 *
 * 下單機既有「返結 A01」枱**照樣顯示**（temp 枱機制完全唔動）。
 * 兩者指向**同一張單**（`tableOrderMap` 同本清單都係由 `order.id`／`order.tableId` 對應），
 * 所以係「同一張單有兩個入口」，唔係「兩張單」—— 重結後兩邊都係同一個 `order.id`。
 *
 * ## 為咩獨立成檔（純函式、零 import）
 *
 * `npm test` ＝ `node --test`，唔認 `@/` 別名、唔支援 `.tsx`。
 * 呢個模組要可以被單元測試直接載入，所以**零 import**、只用 structural typing。
 * 同 `reopen-badge.ts` / `table-order-badge.ts` 同一個套路。
 */

/** 區塊只需要嘅欄位（structural typing —— 唔綁死 `PosOrder`，因為 `node --test` 唔認 `@/`）。 */
export type ReopenListOrder = {
  id: string;
  localOrderNo?: string | null;
  /** 返結後已被搬去 temp 枱；跨機時該枱唔存在於本機。 */
  tableId?: string | null;
  tableName?: string | null;
  /** 0063：返結當刻嘅原枱（跨機重結靠佢還原；未跑 migration 時 undefined）。 */
  reopenOriginalTableId?: string | null;
  reopenOriginalTableName?: string | null;
  status?: string | null;
  total?: number | null;
  reopenCount?: number | null;
  reopenedAt?: string | null;
  reopenReason?: string | null;
};

/** 區塊一行的展示資料。 */
export interface ReopenAccountRow {
  id: string;
  /** 單號；冇 stamped 就退回 id（避免顯示空白）。 */
  orderNo: string;
  /**
   * 顯示用嘅枱名。
   *
   * 優先順序刻意咁排：
   *   ① `reopenOriginalTableName`（0063，原枱，例如「A01」）—— 跨機最有意義；
   *   ② 原枱 id（`reopenOriginalTableId`，有 id 通常已由 `tableName` 帶到枱名）；
   *   ③ `tableName`（下單機 temp 枱名，例如「返結 A01」）；
   *   ④ `tableId`；
   *   ⑤ `—`（真係乜都冇，唔可以顯示空白）。
   */
  tableLabel: string;
  /** 原枱係咪淨靠雲端欄位（0063 未跑 / 未有值）。UI 用嚟決定加唔加「跨機」註記。 */
  hasOriginalTable: boolean;
  total: number;
  /** 返結次數（`已返結 ×N` 標籤）。0／缺 → undefined。 */
  reopenCount?: number;
  /** 返結時間 ISO；冇 → `""`（UI 自行隱藏時間欄）。 */
  reopenedAt: string;
  /** 返結原因；冇 → `""`。 */
  reopenReason: string;
}

function text(value: string | null | undefined, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 由訂單清單抽出「返結帳」嘅行（只認 `status === "reopened"`）。
 *
 * 排序：**最近返結嘅排前面**（同收銀「最新事件優先」直覺一致）。
 * 時間相同 / 都冇時間 → 用單號做穩定次序，避免每次 render 順序跳動。
 *
 * ⚠️ **唔會**過濾「本機有 temp 枱」嘅單 —— 咁做會令下單機嘅返結單喺區塊消失，
 * 反而製造「同一張單喺呢部機見到、另一部機唔見」嘅不一致。下單機見到兩張卡
 * （枱 + 區塊）係可接受嘅，因為區塊係跨機嘅唯一入口。
 */
export function reopenAccountRows(orders: ReopenListOrder[] | null | undefined): ReopenAccountRow[] {
  const rows: Array<{ row: ReopenAccountRow; ts: number }> = [];
  for (const o of orders ?? []) {
    if (o?.status !== "reopened") continue;

    const originalName = text(o.reopenOriginalTableName);
    const originalId = text(o.reopenOriginalTableId);
    const currentName = text(o.tableName);
    const currentId = text(o.tableId);

    const tableLabel = originalName || originalId || currentName || currentId || "—";
    const hasOriginalTable = Boolean(originalName || originalId);

    rows.push({
      row: {
        id: o.id,
        orderNo: text(o.localOrderNo) || o.id,
        tableLabel,
        hasOriginalTable,
        total: round2(Number(o.total ?? 0)),
        reopenCount: Number.isFinite(Number(o.reopenCount)) && Number(o.reopenCount) > 0
          ? Number(o.reopenCount)
          : undefined,
        reopenedAt: text(o.reopenedAt),
        reopenReason: text(o.reopenReason),
      },
      ts: Date.parse(text(o.reopenedAt)) || 0,
    });
  }

  return rows
    .sort((a, b) => (b.ts - a.ts) || a.row.orderNo.localeCompare(b.row.orderNo))
    .map((entry) => entry.row);
}

/** 區塊標題嘅數字（`返結帳（N）`）。冇單回 0 —— 嗰陣整卡唔 render。 */
export function reopenAccountCount(orders: ReopenListOrder[] | null | undefined): number {
  return reopenAccountRows(orders).length;
}
