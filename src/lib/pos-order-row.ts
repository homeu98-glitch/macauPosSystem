/**
 * `pos_orders` 資料表 row（snake_case）→ 領域物件嘅共享映射。
 *
 * 之前呢個映射只存在於 `/api/pos/state`（收銀工作台嘅單一真源）。
 * admin panel（`/api/admin/orders`）需要同樣嘅映射嚟讀跨店訂單，
 * 所以抽出嚟共享——兩個 route 必須保持同一份映射，避免欄位漂移。
 *
 * ⚠️ 本模組**必須保持零 import**（連 `import type` 都唔用）：
 *    咁樣先可以被 `node --test` 直接載入驗證（`pos-order-row.test.ts`）。
 *    型別一律寫 inline，輔助函式喺本檔內定義。
 */

/**
 * 可選金額欄位 → `number` 或 `undefined`。
 *
 * 🔴 為咩唔用 `Number(x ?? 0)`：`Number(null)` 係 **0**，
 *    「未對帳」會被靜默變成「實收 0.00」—— 店員會去追平台數。
 *    PostgREST 回 `numeric` 有時係**字串**（`"35.11"`），所以一定要經 `Number()` 轉。
 */
function numOrUndef(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

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
  /**
   * 平台／外部系統嘅訂單號（0055 migration 建嘅唯一索引 `(store_id, source, external_order_id)`）。
   *
   * 🔴 為咩要拉入投影層（而唔係只喺 grabber 入庫路徑出現）：
   *    平台結算（0060）係用**平台單號**去配對 POS 訂單嘅
   *    （`settlement/route.ts` 就係 `.select("id,external_order_id")` 再 `.in(...)`）。
   *    同時收銀台／詳情頁要顯示「平台單號」畀店員同平台後台對數。
   *    唔將佢列入 `POS_ORDER_DB_COLUMNS` ⇒ 走 `/api/pos/state` 嘅路徑永遠讀唔到
   *    （PostgREST 唔會送冇投影嘅欄）。
   *
   * 店內單 / 未跑 migration → null / undefined。
   */
  external_order_id?: string | null;
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
  /**
   * 返結當刻嘅**原枱** id（0063 migration，2026-10-05）。
   * 未跑 migration / 未返結單 / 舊 client 寫入嘅單 → undefined。
   *
   * 🔴 為咩一定要 map 返出嚟（跨機返結失聯，2026-10-05 實案）：
   *    返結時 `tableId` 會被搬去 **temp 枱**（`temp-reopen-<orderId>`），
   *    而 temp 枱**刻意唔上雲**（寫入 `pos_bootstrap_config.tables` 會永久升級
   *    做真實枱 ⇒ `device-settings` 推上 server 前會 `stripReopenTempTables()`）。
   *    原本「原枱」只記喺下單機 localStorage → **另一部機重結時完全唔知原枱係邊**
   *    ⇒ `isReopenRestore` 為 false ⇒ 唔會還原 ⇒ 張單永久卡喺 temp 枱
   *    （該機冇呢張枱）＝ 枱面空枱、單懸空。
   *    漏抄呢兩欄 = 呢個跨機 bug 修唔到（同 0043 `reopen_*` 同一型漏抄）。
   */
  reopen_original_table_id?: string | null;
  reopen_original_table_name?: string | null;
  /**
   * 最近一次結帳時間（0057 migration，2026-09-24）—— **裝置鐘、server 永不覆蓋**。
   * 未跑 migration / 未結帳單 / 舊 client 寫入嘅單 → undefined。
   *
   * 🔴 為咩一定要 map 返出嚟：報表／交班嘅日歸屬（`orderEventInstant()`）以佢為準。
   *    漏抄 = 雲端明明有值，client 照樣落返 `updated_at`（server 蓋章、重推會漂）
   *    ⇒ 跨日漂移照舊（同 0043 `reopen_*`／0056 `platform_fees` 一模一樣嘅漏抄）。
   */
  settled_at?: string | null;
  /**
   * 外賣平台（澳覓 / MFOOD）非菜品費用明細（0056 migration，2026-09-24）。
   * 未跑 migration 嘅環境會係 undefined；店內單永遠 NULL。
   *
   * 🔴 為咩一定要 map 返出嚟：**收據同訂單詳情嘅費用明細都靠呢一欄**
   *    （`buildSubtotalBlock()` / `PlatformFeeBreakdown`）。漏咗 = 平台單
   *    「餐盒費／膠袋費／商家優惠／配送費」全部靜默唔出 —— 2026-09-24 實案：
   *    入庫（`/api/integration/grabber/orders`）一直都正確，
   *    但**出庫路徑漏抄**，使用者喺 POS 睇極都冇，白查一輪。
   *
   * 形狀刻意寫 inline（唔 import `PosOrder`）—— 呢個模組要保持**零 import**，
   * 先可以被 `node --test` 直接驗（同 `discount_note` / `reopen_*` 同一個理由）。
   */
  platform_fees?: Array<{ label: string; amount: number; excluded?: boolean }> | null;
  /**
   * 外賣平台**實收**金額（0060 migration，2026-09-26）。
   * ＝ 平台扣服務費後過數嘅錢（mfood `storeReceiveAmtn`）。
   * 未對帳 / 店內單 / 線上單 → NULL。
   *
   * 🔴 為咩一定要 map 返出嚟：訂單詳情同報表 MFOOD 區塊都靠佢。
   *    漏咗 = 抓到都顯示「待對帳」（同 0056 `platform_fees` 一模一樣嘅出庫漏抄型 bug）。
   */
  platform_net_amount?: number | string | null;
  /**
   * 外賣平台**補貼後實收**（0060 migration，2026-09-26）。
   * ＝ 真正過數到商戶嘅金額（mfood `subsidyStoreReceiveAmtn`）。冇補貼時等於上面。
   *
   * ⚠️ 分開存而唔係只存一個：平台補貼係獨立一筆，合併咗就冇得核對平台報表。
   */
  platform_subsidy_net?: number | string | null;
  /**
   * 收到平台結算資料嘅時間（0060 migration，2026-09-26）。
   * 有值 ＝ 已對帳（可計差額率）；NULL ＝ 待對帳（UI 唔可以顯示 0）。
   */
  platform_settled_at?: string | null;
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
  // 平台／外部訂單號（0055 migration）。平台結算配對同店員對數都靠佢 ——
  // 唔投影就係「寫得入、讀唔出」嘅典型（見檔頭鐵律）。
  "external_order_id",
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
  // 返結當刻嘅原枱快照（0063 migration，2026-10-05）。跨機重結靠佢還原原枱；
  // 唔投影 = 寫得入、讀唔出（呢個檔頭鐵律講嘅典型漏抄）。
  "reopen_original_table_id",
  "reopen_original_table_name",
  // 不可變業務時間（0057 migration，2026-09-24）。報表／交班日歸屬嘅唯一可信真源。
  "settled_at",
  // 外賣平台費用明細（0056 migration，2026-09-24）。收據同訂單詳情都靠佢。
  "platform_fees",
  // 外賣平台結算金額（0060 migration，2026-09-26）。訂單詳情同報表 MFOOD 區塊靠佢。
  "platform_net_amount",
  "platform_subsidy_net",
  "platform_settled_at",
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
    // 平台／外部訂單號（0055 migration）。冇欄 / NULL → undefined（店內單零影響）。
    // 🔴 呢個係平台結算配對嘅鑰匙；漏抄 = 收銀台顯示唔到平台單號、
    //    詳情頁亦冇得同平台後台對數（同 platform_fees / settled_at 同一型出庫漏抄）。
    externalOrderId: order.external_order_id ?? undefined,
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
    // 返結原枱快照（0063）：冇欄 / NULL → undefined。
    // 跨機重結靠呢兩個 field 還原原枱（`pos-app.tsx` `isReopenRestore`）。
    // 未跑 migration → undefined → 行為等同現時（唔會還原），屬安全降級。
    reopenOriginalTableId: order.reopen_original_table_id ?? undefined,
    reopenOriginalTableName: order.reopen_original_table_name ?? undefined,
    // 不可變業務時間（0057 migration）：冇欄 / NULL → undefined（orderEventInstant 落返舊鏈）。
    // 🔴 漏抄呢行 = 雲端有 settled_at 都讀唔返 ⇒ 跨日漂移保護即刻失效。
    settledAt: order.settled_at ?? undefined,
    // 外賣平台非菜品費用明細（0056 migration）：冇欄 / NULL → undefined
    // （收據同詳情自動跳過，形同以前；店內單零影響）。
    // 🔴 漏抄呢行 = 平台單嘅費用明細永遠唔會出（2026-09-24 實案）。
    platformFees: Array.isArray(order.platform_fees) ? order.platform_fees : undefined,
    // 外賣平台結算金額（0060 migration，2026-09-26）：冇欄 / NULL → undefined。
    // 🔴 唔可以用 `?? 0` 兜底 —— 「未對帳」同「實收 0」係兩件事，
    //    填 0 會令店員以為平台冇畀錢（報表差額率亦會變 100%）。
    //    型別收 `number | string`：PostgREST 回 numeric 可能係字串，一律經 Number() 轉。
    platformNetAmount: numOrUndef(order.platform_net_amount),
    platformSubsidyNet: numOrUndef(order.platform_subsidy_net),
    platformSettledAt: order.platform_settled_at ?? undefined,
  };
}
