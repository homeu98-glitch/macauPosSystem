import { PosOrder, PrintJob, PrinterGroup } from "@/lib/types";
import { cloudRowToPrintJobStatus } from "@/lib/pos/print-job-status";

/** `pos_orders` 資料表 row（snake_case）→ `PosOrder` 領域物件。
 *  映射與 `/api/pos/state/route.ts` 保持一致，作為收銀側 Realtime 訂閱嘅單一映射真源。 */
export interface PosOrderRow {
  id: string;
  local_order_no: string | null;
  store_id: string | null;
  table_id: string | null;
  table_name: string | null;
  status: string;
  fulfillment_status: string | null;
  sent_to_kitchen_at: string | null;
  served_at: string | null;
  items: PosOrder["items"];
  order_note: string | null;
  subtotal: number;
  tax_amount: number;
  service_charge_amount: number;
  discount_amount: number;
  /** 外賣平台非菜品費用明細（0056 migration）。未跑 migration / 店內單 → null。 */
  platform_fees?: PosOrder["platformFees"] | null;
  total: number;
  prepaid_amount: number;
  online_order_id: string | null;
  /** 訂單來源（docs/87 §5.2）。舊列 default 'pos'；未跑 migration 嘅環境會冇呢欄。 */
  source?: string | null;
  /**
   * 入座人數（covers）。0017 migration 新增；未跑 migration 嘅環境會冇呢欄 → undefined。
   * 快餐／外賣／自取單一律 NULL（唔好填 1，會污染人均消費分母）。
   * 見 docs/89 §3。
   */
  party_size?: number | null;
  /**
   * 免單備註（原因）。0018 migration 新增；未跑 migration 嘅環境會冇呢欄 → undefined。
   * ⚠️ 唔係 `order_note`（廚房備註，sent_to_kitchen 起鎖死，見 docs/84）。
   * 非免單單一律 NULL。見 docs/91。
   */
  comp_note?: string | null;
  /** 免單操作時間。0018 migration 新增；非免單單一律 NULL。見 docs/91。 */
  comped_at?: string | null;
  /**
   * 全單折扣備註（原因）。0034 migration 新增；未跑 migration 嘅環境會冇呢欄 → undefined。
   * 有 `discount_amount > 0` 就有值；舊單（功能上線前）NULL。
   * 單品折扣原因唔喺呢度 —— 佢逐件存喺 `items` 內（`OrderItem.discountNote`）。
   */
  discount_note?: string | null;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
  /**
   * 寫入嗰部裝置嘅鐘（方案 B，2026-09-09）。`updated_at` 係 server 蓋章（收件時間）
   * —— 兩者鐘域唔同，client 端 Realtime merge 一定要用呢個（見
   * `PosOrder.clientUpdatedAt` + `mergeTimestamp()`）。舊 row / 未跑 migration → null。
   */
  client_updated_at?: string | null;
  /**
   * 會員扣款（0038 migration 新增；未跑 migration 嘅環境會冇呢幾欄 → undefined）。
   *
   * 🔴 個資紅線（Ledger 契約 §7.2）：只有 `customer_id`(uuid)。
   *    DB 亦**刻意冇** member_phone / member_display_name / member_balance_avos ——
   *    嗰啲只准「當次 UI 渲染」。呢度唔好加。
   *
   * ⚠️ 為咩一定要 map 返出嚟：寫入路徑有做、讀取路徑冇做 = 收銀機永遠睇唔到
   *    「客人已經用會員餘額付款」→ 店員有可能再收一次錢（docs/130 §7.1）。
   */
  member_customer_id?: string | null;
  member_deduction_avos?: number | null;
  member_deduct_txn_id?: string | null;
  /**
   * 返結審計（0043 migration 新增；未跑 migration 嘅環境會冇呢幾欄 → undefined）。
   *
   * 🔴 為咩一定要 map 返出嚟：報表同交班**讀雲端**（`pos_orders` 為唯一可信源）。
   *    寫入路徑（sync route `baseRecord`）有做、讀取路徑冇做 = 「已返結 ×N」標籤
   *    永遠唔會出現喺報表 / 交班明細（同 0038 member_* 一模一樣嘅漏抄）。
   *
   * `reopen_count` **單調遞增、重結後唔清零** —— 「返結過」係歷史事實，
   * 前端 `@/lib/pos/reopen-badge` 靠佢決定要唔要出標籤。
   */
  reopen_count?: number | null;
  reopened_at?: string | null;
  reopen_reason?: string | null;
  /**
   * 最近一次結帳時間（0057 migration，2026-09-24）—— **裝置鐘、server 永不覆蓋**。
   * 未跑 migration / 未結帳單 → undefined。
   * 🔴 Realtime echo 係本機單被雲端覆蓋嘅主要途徑：漏 map = 本機 `settledAt`
   *    被 realtime 行（冇呢欄）整唔見 ⇒ 跨日漂移保護失效。
   */
  settled_at?: string | null;
}

export function mapPosOrderRow(row: PosOrderRow): PosOrder {
  return {
    id: row.id,
    localOrderNo: row.local_order_no ?? row.id,
    tableId: row.table_id ?? "counter",
    tableName: row.table_name ?? "",
    status: (row.status as PosOrder["status"]) ?? "draft",
    fulfillmentStatus: (row.fulfillment_status as PosOrder["fulfillmentStatus"]) ?? undefined,
    sentToKitchenAt: row.sent_to_kitchen_at ?? undefined,
    servedAt: row.served_at ?? undefined,
    items: Array.isArray(row.items) ? row.items : [],
    orderNote: row.order_note ?? undefined,
    subtotal: Number(row.subtotal ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    serviceChargeAmount: Number(row.service_charge_amount ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    // 非菜品費用明細：冇欄 / NULL → undefined（收據自動跳過，形同以前）。
    platformFees: Array.isArray(row.platform_fees) ? row.platform_fees : undefined,
    total: Number(row.total ?? 0),
    prepaidAmount: Number(row.prepaid_amount ?? 0),
    onlineOrderId: row.online_order_id ?? undefined,
    // 未跑 migration / 舊列會冇 source → fallback "pos"（收銀台落單，唔顯示來源標記）
    source: (row.source as PosOrder["source"]) ?? "pos",
    // 入座人數：冇欄 / NULL → undefined（前端「--」可改）。見 docs/89 §3。
    partySize: row.party_size == null ? undefined : Number(row.party_size),
    // 免單備註 / 免單時間：冇欄 / NULL → undefined。見 docs/91。
    compNote: row.comp_note ?? undefined,
    compedAt: row.comped_at ?? undefined,
    // 全單折扣備註：冇欄 / NULL → undefined。見 0034 migration。
    discountNote: row.discount_note ?? undefined,
    paymentMethod: (row.payment_method as PosOrder["paymentMethod"]) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 🔴 LWW 同鐘域（2026-09-12）：帶埋 client 鐘出去，令 realtime merge 唔會用
    // server 蓋章嘅 `updated_at` 去同本機（client 鐘）嘅 `updatedAt` 比新舊。
    clientUpdatedAt: row.client_updated_at ?? undefined,
    // 會員扣款（0038）：0 / NULL 一律當「冇用會員餘額」→ undefined。
    memberCustomerId: row.member_customer_id ?? undefined,
    memberDeductionAvos: row.member_deduction_avos ? Number(row.member_deduction_avos) : undefined,
    memberDeductTxnId: row.member_deduct_txn_id ?? undefined,
    // 返結審計（0043）：冇欄 / NULL / 0 一律當「從未返結」→ undefined。
    // 見 migration 0043 + `@/lib/pos/reopen-badge`（標籤文案真源）。
    reopenCount: row.reopen_count ? Number(row.reopen_count) : undefined,
    reopenedAt: row.reopened_at ?? undefined,
    reopenReason: row.reopen_reason ?? undefined,
    // 不可變業務時間（0057）：冇欄 / NULL → undefined（orderEventInstant 落返舊鏈）。
    settledAt: row.settled_at ?? undefined,
  };
}

/** `pos_print_jobs` 資料表 row → `PrintJob`。 */
export interface PosPrintJobRow {
  id: string;
  store_id: string | null;
  order_id: string | null;
  order_no: string | null;
  table_name: string | null;
  ticket_type: string;
  printer_group: string;
  printer_name: string | null;
  items: PrintJob["items"];
  status: string;
  created_at: string;
  /**
   * 0015 migration 新增。呢三欄冇咗嘅話，job 同步去第二部機會退化做硬編 fallback 渲染
   * （冇店名／時間／單據類型／頁尾，亦唔理商家設嘅字型大小）→ 兩端印出嚟唔一致。
   * 見 docs/87 §7。
   */
  template?: PrintJob["template"] | null;
  content?: PrintJob["content"] | null;
  printer_id?: string | null;
}

export function mapPosPrintJobRow(row: PosPrintJobRow): PrintJob {
  return {
    id: row.id,
    orderId: row.order_id ?? "",
    orderNo: row.order_no ?? undefined,
    tableName: row.table_name ?? undefined,
    ticketType: (row.ticket_type as PrintJob["ticketType"]) ?? "normal",
    printerGroup: (row.printer_group as PrinterGroup) ?? "kitchen",
    printerName: row.printer_name ?? row.printer_group ?? "kitchen",
    items: Array.isArray(row.items) ? row.items : [],
    /**
     * 🔴 2026-09-24：一定要經白名單（`cloudRowToPrintJobStatus`），唔可以裸 cast。
     *
     * 雲端 claim RPC 會寫 `status = 'printing'`（過渡態）。舊寫法直接 `as PrintJob["status"]`
     * ⇒ 型別上「睇落合法」但 runtime 係非法值 ⇒ 落到打印中心被
     * `normalizePrintJobStatus()` 標成「失敗（狀態欄位異常）」，令一張其實正常嘅單出假紅標
     *（商家 2026-09-24 實案）。未知值一律當 `pending`（＝仲要跟），唔可以當 `failed`。
     */
    status: cloudRowToPrintJobStatus(row.status),
    createdAt: row.created_at,
    printerId: row.printer_id ?? undefined,
    template: row.template ?? undefined,
    content: row.content ?? undefined,
  };
}

/** `pos_soldout` 資料表 row（Kiosk 售罄即時標記）。 */
export interface PosSoldoutRow {
  id: string;
  store_id: string | null;
  menu_item_id: string;
  sold_out: boolean;
  updated_at: string;
}

export function mapPosSoldoutRow(row: PosSoldoutRow): PosSoldoutRow {
  return {
    id: row.id,
    store_id: row.store_id,
    menu_item_id: row.menu_item_id,
    sold_out: Boolean(row.sold_out),
    updated_at: row.updated_at,
  };
}
