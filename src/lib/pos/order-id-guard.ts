/**
 * 訂單 id 命名空間守衛 —— **零依賴純函式**（刻意唔 import 任何嘢，令 `node --test` 可以直接載入）。
 *
 * ## 為何要守（2026-09-22 實案：隔離區 111 張）
 *
 * 商家 iPad 嘅「同步健康 → 已隔離訂單」出現 **111 張**，全部長成咁：
 *
 * ```
 * print-8d940feb   MFOOD1   MOP 0.00   自動隔離（手動更新） · 17/9/2026 上午11:16:04
 * ```
 *
 * 佢哋**唔係訂單**，係 **`PrintJob` 物件漏入 `orders`（localStorage）**：
 *
 * | 顯示欄位 | 來源 |
 * |---|---|
 * | `print-8d940feb` | `PrintJob.id`（`uid("print")`）→ 經 `mapPosOrderRow()` 嘅 `local_order_no ?? row.id` fallback 變成 `localOrderNo` |
 * | `MFOOD1` | `PrintJob.table_name`（打印 job 本身有枱名） |
 * | `MOP 0.00` | PrintJob 冇 `total` → `Number(undefined ?? 0)` |
 * | 被判定「孤兒」 | PrintJob 嘅 `status`（`pending` / `sent` / `printed`）**唔屬**終態訂單狀態 ⇒ 孤兒對賬當佢係「未結帳單」 |
 *
 * ⇒ 佢哋永遠上唔到雲（雲端 `pos_orders` 根本冇呢個 id）⇒ 每次全量拉取都會被「隔離」
 * 一次，永遠清唔完；累積到 111 張。
 *
 * ## 契約
 *
 * `orders` store **只准**放訂單 id。呢個模組負責隔走「明顯屬於其他實體」嘅 id。
 *
 * ⚠️ 刻意用**黑名單**（已知非訂單命名空間）而唔係白名單：
 *   白名單會因為日後新加一個合法訂單前綴（例如零售／美容）而**靜默隱藏真訂單**，
 *   成本太高；黑名單只會漏（漏 = 維持現狀），唔會誤刪。
 */

/** 已知「唔係訂單」嘅 id 命名空間（同 `uid(prefix)` 嘅 prefix 對齊）。 */
export const NON_ORDER_ID_PREFIXES: readonly string[] = ["print-", "evt-", "q-"];

/** 已知**合法**訂單 id 命名空間（只作診斷／文件用途，唔用嚟過濾）。 */
export const ORDER_ID_PREFIXES: readonly string[] = ["order-", "staff-", "kiosk-", "ledger-"];

/** 呢個 id 係唔係「明顯唔屬於訂單」實體。 */
export function isNonOrderId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const value = id.trim();
  if (!value) return false;
  return NON_ORDER_ID_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * 由一堆 row 分出「真訂單」同「明顯唔係訂單」。
 *
 * @returns `orders` = 可以安全保留嘅；`junk` = 應該丟棄（連 localStorage 都要清）。
 */
export function splitNonOrderRows<T extends { id?: unknown }>(
  rows: readonly T[] | null | undefined,
): { orders: T[]; junk: T[] } {
  const orders: T[] = [];
  const junk: T[] = [];
  for (const row of rows ?? []) {
    if (isNonOrderId(row?.id)) junk.push(row);
    else orders.push(row);
  }
  return { orders, junk };
}
