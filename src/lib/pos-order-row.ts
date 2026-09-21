/**
 * `pos_orders` 資料表 row（snake_case）→ 領域物件嘅共享映射。
 *
 * 之前呢個映射只存在於 `/api/pos/state`（收銀工作台嘅單一真源）。
 * admin panel（`/api/admin/orders`）需要同樣嘅映射嚟讀跨店訂單，
 * 所以抽出嚟共享——兩個 route 必須保持同一份映射，避免欄位漂移。
 */

export type PosOrderDbRow = {
  id: string;
  store_id?: string | null;
  local_order_no: string | null;
  table_id: string | null;
  table_name: string | null;
  status: string;
  fulfillment_status: string | null;
  sent_to_kitchen_at: string | null;
  served_at: string | null;
  items: unknown;
  order_note: string | null;
  subtotal: number;
  tax_amount: number;
  service_charge_amount: number;
  discount_amount: number;
  total: number;
  prepaid_amount: number;
  online_order_id: string | null;
  source?: string | null;
  party_size?: number | null;
  comp_note?: string | null;
  comped_at?: string | null;
  /** 全單折扣備註（0034 migration）。未跑 migration 嘅環境會係 undefined。 */
  discount_note?: string | null;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
  /**
   * 寫入嗰部裝置嘅鐘（方案 B，2026-09-09）。`updated_at` 係 server 蓋章（收件時間）
   * —— 兩者鐘域唔同，client 端 LWW 一定要用呢個（見 `PosOrder.clientUpdatedAt`）。
   * 舊 row / 未跑 migration 嘅環境會係 null / undefined。
   */
  client_updated_at?: string | null;
  /**
   * 返結審計（0043 migration，2026-09-18）。未跑 migration 嘅環境會係 undefined。
   *
   * 🔴 為咩一定要 map 返出嚟：交班頁靠 `/api/pos/state` → 呢個 `mapOrderRow()`，
   *    漏抄 = 交班訂單明細永遠唔會出「已返結 ×N」標籤。
   *    同 0034 `discount_note` 一樣係「逐欄顯式複製」漏抄，唔係被 RLS 擋。
   *
   * `reopen_count` 單調遞增、重結後唔清零（「返結過」係歷史事實）。
   */
  reopen_count?: number | null;
  reopened_at?: string | null;
  reopen_reason?: string | null;
};

/**
 * `pos_orders` 需要讀嘅**全部** DB 欄位（PostgREST 投影用，逗號分隔）。
 *
 * ## 為咩要抽一個常數出嚟（2026-09-21 egress 優化）
 *
 * `select("*")` 會連一啲 mapper 完全唔讀嘅欄位都送出嚟；改成明確投影可以省 bytes
 * （PostgREST egress 係按 Supabase → Vercel Function 嘅 bytes 計）。
 *
 * ## 🔴 鐵律（同 docs/113「四條讀取路徑」同一型陷阱）
 *
 * 呢份清單**必須**同上面 `PosOrderDbRow` 完全一致：
 *   · 漏一欄 = 該欄靜默變 `undefined` → mapper 用 `?? 0` / `?? undefined` 兜底
 *     → **唔會報錯、只會靜默唔出**（歷史上中過兩次：`discount_note`、`reopen_*`）。
 *   · 多一欄 = 該欄唔存在時 PostgREST 回 42703 → 整個查詢失敗。
 *     （所以下面有 42703 自動降級回 `select("*")` 嘅保險，見 pos-orders-range.ts。）
 *
 * 呢兩條都由 `pos-order-row.test.ts` 自動核對（type 同清單雙向比對），
 * 所以**新增欄位時只需要改 `PosOrderDbRow` 同呢個陣列兩處**，測試會捉漏。
 */
export const POS_ORDER_DB_COLUMNS = [
  "id",
  "store_id",
  "local_order_no",
  "table_id",
  "table_name",
  "status",
  "fulfillment_status",
  "sent_to_kitchen_at",
  "served_at",
  "items",
  "order_note",
  "subtotal",
  "tax_amount",
  "service_charge_amount",
  "discount_amount",
  "total",
  "prepaid_amount",
  "online_order_id",
  "source",
  "party_size",
  "comp_note",
  "comped_at",
  "discount_note",
  "payment_method",
  "created_at",
  "updated_at",
  "client_updated_at",
  "reopen_count",
  "reopened_at",
  "reopen_reason",
] as const;

/** PostgREST `.select()` 用嘅投影字串（＝ 上面清單 join）。 */
export const POS_ORDER_DB_SELECT = POS_ORDER_DB_COLUMNS.join(",");

/**
 * 對賬守護「只核實狀態」用嘅最小投影（2026-09-21 egress 優化）。
 *
 * 守護只做 `server.status === local.status` 嘅比對，完全唔讀 `items`／金額／備註
 * ⇒ 一行由 1 469 B 降到 91 B（16×），而**判斷結果完全等價**。
 * 同時帶住 `updated_at` / `client_updated_at`，令將來想加「時間戳一齊比對」都唔使再拉大 payload。
 */
export const POS_ORDER_VERIFY_SELECT = "id,status,updated_at,client_updated_at";

/**
 * `pos_orders` row → 領域物件。與 `/api/pos/state` 既有映射保持一致。
 */
export function mapOrderRow(order: PosOrderDbRow) {
  return {
    id: order.id,
    storeId: order.store_id ?? undefined,
    localOrderNo: order.local_order_no,
    tableId: order.table_id,
    tableName: order.table_name,
    status: order.status,
    fulfillmentStatus: order.fulfillment_status ?? undefined,
    sentToKitchenAt: order.sent_to_kitchen_at ?? undefined,
    servedAt: order.served_at ?? undefined,
    items: Array.isArray(order.items) ? order.items : [],
    orderNote: order.order_note ?? undefined,
    subtotal: Number(order.subtotal ?? 0),
    taxAmount: Number(order.tax_amount ?? 0),
    serviceChargeAmount: Number(order.service_charge_amount ?? 0),
    discountAmount: Number(order.discount_amount ?? 0),
    total: Number(order.total ?? 0),
    prepaidAmount: Number(order.prepaid_amount ?? 0),
    onlineOrderId: order.online_order_id ?? undefined,
    // docs/87 §5.2：訂單來源（kiosk / scan / pos）。舊 migration 冇呢欄 → fallback "pos"。
    source: order.source ?? "pos",
    partySize: order.party_size == null ? undefined : Number(order.party_size),
    // 免單審計（docs/91 · 0018 migration）。未跑 migration 嘅環境會冇呢兩欄 → undefined。
    compNote: order.comp_note ?? undefined,
    compedAt: order.comped_at ?? undefined,
    // 全單折扣備註（0034 migration）。同 comp_note 一樣係結帳期審計欄位，
    // 唔落 items（單品折扣原因喺 items 內逐件存）。
    discountNote: order.discount_note ?? undefined,
    paymentMethod: order.payment_method ?? undefined,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    // 🔴 LWW 同鐘域（2026-09-12）：`updated_at` 係 server 蓋章，唔可以用嚟同本機
    // （client 鐘）嘅 `updatedAt` 比新舊 —— 一定要帶埋 `client_updated_at` 出去，
    // 否則一條「舊狀態 + server 時間較新」嘅 snapshot 會蓋走本機啱寫入嘅狀態
    // （實案：快餐單已結帳閃回未結帳）。睇 `mergeTimestamp()`。
    clientUpdatedAt: order.client_updated_at ?? undefined,
    // 返結審計（0043 migration）：冇欄 / NULL / 0 一律當「從未返結」→ undefined。
    // 交班「訂單明細」靠 `reopenCount` 出「已返結 ×N」標籤
    //（見 `@/lib/pos/reopen-badge` 同 `OrderDetailList`）。
    reopenCount: order.reopen_count ? Number(order.reopen_count) : undefined,
    reopenedAt: order.reopened_at ?? undefined,
    reopenReason: order.reopen_reason ?? undefined,
  };
}
