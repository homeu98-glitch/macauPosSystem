export type ConnectionType = "lan" | "usb" | "bluetooth";
export type UserRole = "admin" | "manager" | "cashier";

export interface UserPermissions {
  refundOrder: boolean;
  voidItem: boolean;
  /** 返結權位（保留，現階段唔做門控：任何員工可返結，只強制揀原因） */
  reopenOrder?: boolean;
  manageAccounts?: boolean;
}

export interface AccountStore {
  id: string;
  name: string;
  active: boolean;
  code?: string;
  city?: string;
  industry?: "restaurant" | "salon";
  sourceStoreId?: string;
  sourceActive?: boolean;
  manualDeactivated?: boolean;
  effectiveActive?: boolean;
  syncStatus?: "ok" | "error" | "pending";
  lastSyncedAt?: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

export interface AccountPermissionGroup {
  id: string;
  code: string;
  name: string;
  role: UserRole;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

export interface AccountUser {
  id: string;
  account: string;
  pin: string;
  name: string;
  role: UserRole;
  active: boolean;
  sourceAccountId?: string;
  sourceActive?: boolean;
  manualDeactivated?: boolean;
  effectiveActive?: boolean;
  lastSyncedAt?: string;
  storeIds: string[];
  permissionGroupId?: string;
  permissions: UserPermissions;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
  note?: string;
}

export interface BackofficeSyncJob {
  id: string;
  jobType: "stores" | "accounts" | "bindings" | "full";
  scope: string;
  status: "success" | "failed" | "running";
  startedAt: string;
  finishedAt?: string;
  pulledCount: number;
  upsertedCount: number;
  failedCount: number;
  summary: string;
  error?: string;
}

export type PrinterGroup = string;
export type PrinterRole = "zone" | "receipt" | "label";

// 支付方式為自由文字（由「設置」頁配置），用於交易記錄標記
export type PaymentMethod = string;

export type QueueEventType =
  | "ORDER_CREATED"
  | "ORDER_UPDATED"
  | "ORDER_ITEM_VOIDED"
  | "ORDER_SETTLED"
  | "ORDER_DELETED"
  | "DEVICE_CONFIG_UPDATED"
  | "PRINT_JOB_CREATED"
  | "PRINT_JOB_DELETED"
  | "TEST_PRINT_REQUESTED";

export interface MenuSpecOption {
  id: string;
  label: string;
  priceDelta: number;
}

export interface MenuSpecGroup {
  id: string;
  name: string;
  selectionMode: "single" | "multi";
  required: boolean;
  options: MenuSpecOption[];
}

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  price: number;
  printerGroup: PrinterGroup;
  specGroups?: MenuSpecGroup[];
  /** 時價菜：落單時強制彈窗輸入當次價錢（用於海鮮 / 每日特色菜等價格浮動項） */
  isMarketPrice?: boolean;
  /** 掃碼點餐 / Kiosk 客人可點：false 時該項唔會出現喺客人介面（預設 true） */
  customerOrderable?: boolean;
  /** 菜品圖片 URL（由 Ledger 線上點餐菜單同步過來；可空，前端有圖先 render） */
  image?: string;
}

export interface MenuCategory {
  id: string;
  name: string;
}

export interface StoreTable {
  id: string;
  name: string;
  area: string;
  floorId?: string;
  /** 該桌可容納座位數（人數）；桌台設置新增／編輯桌時填寫 */
  capacity?: number;
  /** 返結 temp 枱標記（結帳／取消後由 removeReopenTempTable 清除） */
  isReopenTemp?: boolean;
  /** 關聯嘅返結訂單 id（供移除 temp 枱用） */
  reopenOrderId?: string;
}

export interface FloorConfig {
  id: string;
  name: string;
  tables: StoreTable[];
}

export interface PosRules {
  orderFlow: "send_then_pay";
  allowSplitBill: boolean;
  allowMemberLookup: boolean;
  taxRate: number;
  serviceChargeRate: number;
  paymentMethods: PaymentMethod[];
}

export interface PosBootstrap {
  sourceVersion: number;
  storeId: string;
  storeName: string;
  currency: string;
  categories: MenuCategory[];
  menuItems: MenuItem[];
  tables: StoreTable[];
  rules: PosRules;
  printerGroups: PrinterGroup[];
  lastUpdatedAt: string;
}

export interface DevicePrinterConfig {
  id: string;
  role: PrinterRole;
  zoneId?: string;
  connectionType: ConnectionType;
  name: string;
  model?: string;
  paperSize?: string;
  ipAddress?: string;
  /** Raw TCP port for LAN ESC/POS (default 9100) */
  lanPort?: number;
  /** ESC/POS 編碼（每台可配；預設 GB18030。可選: gb18030 / gbk / big5 / utf-8） */
  charset?: string;
  /** 中文（Kanji）倍大指令：商頌 POS-80 等機要用 GS ! n；標準 ESC/POS 機用 FS ! n。
   *  空缺 = 渲染器預設 GS ! n（即「接上就用」嘅安全值，已喺商頌 POS-80 實機對照測試證實）。 */
  kanjiEnlarge?: "FS!" | "GS!";
  /** 行距覆寫（docs/74 §8.2）：ESC/POS `ESC 3 n`，單位 1/180"。
   *  渲染器預設 s/m=30、l=60（l 雙高 → 行距 double，避免大字上下行重疊變扁）。
   *  個別機型實測若仍微微重疊 → l 試 64–66；太疏 → 試 50–54（安全 range 30–72）。
   *  填空缺 = 用渲染器預設。改呢度唔使 rebuild APK / Companion（經 job payload 帶過去）。 */
  lineSpacing?: { s?: number; m?: number; l?: number };
  /** A 通道（OS spooler RAW）打印端口：driverless USB Printer Class（如商頌 POS-80 / Windows USB001 虛擬埠）
   *  填 "USB001"（Windows）/ CUPS 隊列名（macOS·Linux）。有值時 Companion 優先用 OS spooler 打，
   *  失敗再回落 node-usb B 通道。空缺 = 直接用 B 通道。 */
  usbPort?: string;
  /** USB 打印機 VID（自動偵測，商家唔使手填；Meituan 式型號表對照） */
  usbVendorId?: string;
  /** USB 打印機 PID（自動偵測） */
  usbProductId?: string;
  /** 藍牙打印機名稱 / 配對位址 */
  bluetoothName?: string;
  /** 每次打單打印份數（1–9）；未設定或 ≤1 視為 1 份 */
  copies?: number;
  /** true = 由 Companion 自動偵測加入（唔經手動輸入 VID/PID） */
  autoDetected?: boolean;
  // ── USB 連接（connectionType === "usb" 時使用）──
  /** USB vendor id（hex string，例如 "0x1234"） */
  /** USB product id（hex string，例如 "0x5678"） */
  // ── Bluetooth 連接（connectionType === "bluetooth" 時使用）──
  /** Bluetooth MAC / 裝置地址（例如 "AA:BB:CC:DD:EE:FF"） */
  bluetoothAddress?: string;
  /** Bluetooth 裝置名（配對/列舉顯示用） */
  enabled: boolean;
}

export interface DeviceConfig {
  deviceId: string;
  terminalName: string;
  storeId: string;
  printers: DevicePrinterConfig[];
  updatedAt: string;
}

// ── ESC/POS 模板（真實可打印子集） ──
// 熱敏機：單色、字型有限、無 CSS 顏色 / 邊框 / 絕對定位。
// 所以模板只攜帶「開關 + 字型大小 + 粗體 + 對齊」呢啲 ESC/POS 真係印到嘅設定，
// 設計介面同實際輸出 100% 一致（見 escpos-template.ts / escpos-render.ts）。
export type EscPosAlign = "left" | "center" | "right";
export type EscPosSize = "s" | "m" | "l";
/** 菜品明細（items）區塊嘅清單排版：inline=品名+數量左右排列（舊式）；card=分層卡片（品名加粗→名下虛線→規格成組縮排）；stacked=完全直向。預設 "card"（見 docs/67）。 */
export type EscPosItemsLayout = "inline" | "card" | "stacked";

export interface EscPosBlockStyle {
  visible: boolean;
  size: EscPosSize;
  bold: boolean;
  align: EscPosAlign;
  /** 次級 sub-line（菜品規格 / 備註）字型大小；預設 "s"。ESC/POS 只有 3 檔，避免規格細到睇唔到。可選——舊模板缺省當 "s"。 */
  subSize?: EscPosSize;
  /** 菜品明細清單排版；只有 items 區塊有意義。可選——舊模板缺省當 "card"。 */
  layout?: EscPosItemsLayout;
}

export type ReceiptSectionId =
  | "store_name"
  | "order_no"
  | "table_name"
  | "items"
  | "total"
  | "payment_method"
  | "order_note"
  | "footer";
export type LabelSectionId =
  | "header"
  | "item_name"
  | "temperature"
  | "cup_type"
  | "sugar"
  | "ice"
  | "sugar_tag"
  | "ice_tag"
  | "addons"
  | "specs"
  | "item_note"
  | "order_no"
  | "footer";
export type KitchenSectionId =
  | "store_name"
  | "order_no"
  | "table_name"
  | "order_type"
  | "time"
  | "server"
  | "items"
  | "customer_count"
  | "order_note"
  | "footer";

export interface ReceiptTemplate {
  blocks: Record<ReceiptSectionId, EscPosBlockStyle>;
  order: ReceiptSectionId[];
  footerText: string;
}
export interface LabelTemplate {
  blocks: Record<LabelSectionId, EscPosBlockStyle>;
  order: LabelSectionId[];
  headerText: string;
  footerText: string;
}
export interface KitchenTemplate {
  blocks: Record<KitchenSectionId, EscPosBlockStyle>;
  order: KitchenSectionId[];
  headerText: string;
  footerText: string;
}

export interface PrintTemplates {
  receipt: ReceiptTemplate;
  label: LabelTemplate;
  kitchen: KitchenTemplate;
  /**
   * 自助點餐機模版（商家喺「打印」頁第四個分頁設定）。
   *
   * 結構同 `receipt` 一樣（`ReceiptTemplate`），但係**獨立槽位**：商家改佢唔會影響收銀台收據。
   * 預設內容係 `DEFAULT_RECEIPT_TEMPLATE` 嘅深拷貝（規格 8：小票格式同現有小票完全一致，無需額外設計）。
   *
   * ⚠️ 渲染時 `buildSnapshot()` 嘅 kind **必須傳 `"receipt"`**，唔可以傳 `"kiosk"`：
   * 三個 repo 嘅 TITLE map（`src/lib/escpos-render.ts`、`companion-server.mjs`、
   * print-agent-android `EscPosRenderer.kt`）只認 receipt / label / kitchen，
   * 傳 `"kiosk"` 會 fall through 去空字串 → 冇咗「＊＊＊ 收據 ＊＊＊」抬頭，格式就同收據唔一致。
   * 用 `"receipt"` 嘅話三個 repo 全部原封不動，零跨 repo 改動。見 docs/87 §2.3。
   */
  kiosk: ReceiptTemplate;
}

export type PrintTemplateKind = "receipt" | "label" | "kitchen";

// 拼接落每張 PrintJob 嘅自包含、可序列化快照；renderer 印嗰時直接讀佢，唔使回頭查 settings。
export interface EscPosTemplateSnapshot {
  kind: PrintTemplateKind;
  blocks: Array<{ id: string; visible: boolean; size: EscPosSize; bold: boolean; align: EscPosAlign; subSize?: EscPosSize; layout?: EscPosItemsLayout }>;
}

export interface PosLocalSettings {
  floors: FloorConfig[];
  paymentMethods: string[];
  menuPrinterOverrides: Record<string, PrinterGroup>;
  printZones: Array<{
    id: string;
    name: string;
  }>;
  specTemplates: Array<{
    id: string;
    name: string;
    specGroups: MenuSpecGroup[];
  }>;
  printTemplates: PrintTemplates;
  notePresets: string[];
  cancelNotePresets: string[];
  /** 返結（反結賬）可選原因清單，設置 → 備註 可增刪 */
  reopenReasons: string[];
  fullVoidBehavior: "cancelled" | "refunded";
  onlineOrderSettings: {
    autoAccept: boolean;
  };
  /**
   * 「自動接自助單」開關（取代舊嘅 `kioskKitchenMode`，見 docs/87 §4.1）。
   * 堂食與快餐共用同一粒開關；外賣（Ledger 線上訂單）唔受影響，繼續用 `onlineOrderSettings.autoAccept`。
   *
   * - `true`（**預設**，規格 5）：免確認，客人落單後直接出廚房單
   * - `false`：自助點餐單排入「待確認」，等收銀台撳「確認」先用代客下單流程出單
   *
   * ⚠️ 真源喺 DB（`pos_kiosk_settings.self_order_auto_accept`，按 `store_id`），
   * 本機呢個值只係快取 —— Kiosk 落單時會向 server 讀一次。
   * 因為舊嘅 `kioskKitchenMode` 係由 Kiosk 自己嘅 localStorage 讀，而 Kiosk 從來冇設定 UI，
   * 結果永遠係 `"auto"` → 開關係死 code。見 docs/87 §9 P0 #4。
   */
  autoAcceptSelfOrder: boolean;
}

export interface OrderItem {
  menuItemId: string;
  name: string;
  quantity: number;
  price: number;
  printerGroup: PrinterGroup;
  selectedSpecs?: Array<{
    groupId: string;
    groupName: string;
    optionId: string;
    optionLabel: string;
    priceDelta: number;
  }>;
  note?: string;
  /** 已退菜標記（訂單明細保留記錄用，不計費、不可再操作） */
  voided?: boolean;
  /** 退菜時間（ISO） */
  voidedAt?: string;
  /** 退菜原因 */
  voidedReason?: string;
  /** 操作人帳號 */
  voidedBy?: string;
}

export interface PosOrder {
  id: string;
  localOrderNo: string;
  tableId: string;
  tableName: string;
  /** 開桌入座人數（開桌彈窗揀選；僅作展示／對帳用） */
  partySize?: number;
  status: "draft" | "sent_to_kitchen" | "paid" | "settled" | "reopened" | "cancelled" | "partially_refunded" | "refunded";
  fulfillmentStatus?: "preparing" | "ready";
  items: OrderItem[];
  orderNote?: string;
  subtotal: number;
  taxAmount: number;
  serviceChargeAmount: number;
  discountAmount: number;
  total: number;
  prepaidAmount?: number;
  onlineOrderId?: string;
  /**
   * 訂單來源（docs/87 §5.2 · 規格 7）。三處 UI 會顯示對應標記：訂單頁 / 收銀台快餐單卡片 / 結帳畫面。
   * - `"pos"`：員工喺收銀台落單（預設，舊單全部係呢個值）
   * - `"kiosk"`：自助點餐機（設備有 kioskDeviceBinding）
   * - `"scan"`：客人掃碼自點（QR 連結帶 `?store=` / `?tableId=`）
   */
  source?: "pos" | "kiosk" | "scan";
  paymentMethod?: PaymentMethod;
  cancelledAt?: string;
  cancelledReason?: string;
  refundedAt?: string;
  refundedAmount?: number;
  refundedReason?: string;
  refundRecords?: Array<{
    id: string;
    amount: number;
    reason: string;
    employeeAccount?: string;
    employeeName?: string;
    items?: Array<{
      itemKey: string;
      name: string;
      quantity: number;
      amount: number;
    }>;
    createdAt: string;
  }>;

  // ── 返結（反結賬）審計欄位 ──
  /** 最近一次返結時間（ISO） */
  reopenedAt?: string;
  /** 操作人帳號（餐飲為登入員工；美容為店長） */
  reopenedBy?: string;
  /** 返結原因（來自設置 reopenReasons 或自填） */
  reopenReason?: string;
  /** 累計返結次數 */
  reopenCount?: number;
  /** 首次結帳（settled）時間，重結後保留以便對帳 */
  originalSettledAt?: string;
  /** 返結時原枱 id（temp 枱結帳後還原用） */
  reopenOriginalTableId?: string;
  /** 返結時原枱名（temp 枱結帳後還原用） */
  reopenOriginalTableName?: string;

  // ── 返結會員扣款快照（供反向回滾 / 重結用）──
  /** 上次結帳透過會員餘額扣減的 avos（不含券），供返結反向回滾 */
  memberDeductionAvos?: number;
  /** 上次結帳扣款的會員電話（Ledger phone），供返結反向回滾 */
  ledgerMemberPhone?: string;

  // ── 出餐時間儀器化（Phase B，模塊 4）──
  /** 首次送入廚房時間（ISO）。出餐時間 = servedAt − sentToKitchenAt。 */
  sentToKitchenAt?: string;
  /** 出餐（交到客人手上）時間（ISO）。堂食＝結帳 settled；快餐 counter＝標記 ready（可取餐／交付）。 */
  servedAt?: string;

  createdAt: string;
  updatedAt: string;
  /** 已退菜明細（保留記錄，不計費；結帳 / 退菜後仍留在單上以便追蹤） */
  voidedItems?: OrderItem[];
}

export type OnlinePaymentStatus = "paid" | "unpaid";

export interface QueueEvent {
  id: string;
  type: QueueEventType;
  entityId: string;
  payload: unknown;
  status: "pending" | "synced" | "failed";
  createdAt: string;
}

export interface PrintJob {
  id: string;
  orderId: string;
  orderNo?: string;
  tableName?: string;
  ticketType: "normal" | "addon" | "void";
  printerGroup: PrinterGroup;
  printerId?: string;
  printerName: string;
  items?: Array<{
    name: string;
    quantity: number;
    specs?: string[];
    note?: string;
  }>;
  status: "pending" | "sent" | "failed";
  createdAt: string;
  /** 雙路徑：所屬店 ID（relay 路由用；LAN 直打可由終端補） */
  storeId?: string;
  /** 雙路徑：job 過期時間（epoch millis）；relay 丟棄過期 job，POS 側超時轉 fallback */
  ttl?: number;
  /** 商家 ESC/POS 模板快照（自包含、可序列化）；renderer 強制套用，缺位 fallback 舊格式 */
  template?: EscPosTemplateSnapshot;
  /** 靜態區塊文字（key = section id），renderer 按 block.style 印；items 區塊除外 */
  content?: Record<string, string>;
  /**
   * 呢張單要印幾份。落單端寫死，優先於打印機層級嘅 `DevicePrinterConfig.copies`。
   *
   * 點解要 job 層面：份數而家係**跟打印機**唔係跟訂單（`dispatch.ts` 讀 `printer.copies`），
   * 若廚房機設咗 2 份而自助點餐用同一部機，就會印 2 份。
   * 自助點餐單固定 1 張（規格），所以一定要喺 job 帶 `copies: 1` 落去。見 docs/87 §6.1。
   */
  copies?: number;
}

// ── 跨平台雙路徑打印：統一傳輸層合約（Phase 0 骨架） ──
//
// 三個平台各自實作一套 Transport（Android=Kotlin Socket/UsbManager/BluetoothSocket；
// desktop=Node/Rust net+node-usb+COM；iOS=Swift Network.framework/BLE·MFi），
// POS 網頁只靠呢個介面溝通，唔使知底層 OS 差異。見 docs/43。

/** 派發通道用嘅票種。label 原本長期缺位，搞到杯標籤被當 kitchen 出單（印咗「＊＊＊ 廚房 ＊＊＊」抬頭）。 */
export type PrintKind = "receipt" | "kitchen" | "label" | "test";

export interface PrintSendOptions {
  kind: PrintKind;
  storeName?: string;
  paymentMethod?: string;
  total?: number;
}

export interface PrintSendResult {
  ok: boolean;
  /** 已 queue 但未出單（終端 local agent 接受咗） */
  queued?: boolean;
  error?: string;
  /** 錯誤碼（同 window.__posNativePrintResult 嘅 code，見 docs/45 §5） */
  code?: string;
  /** 非同步結果會經 native bridge / relay 回傳呢個 id（對應 PrintJob.id） */
  ticketId?: string;
}

/** 統一列印傳輸層。LanTransport（path A）/ RelayTransport（path B）都實作佢。 */
export interface PrintTransport {
  /** 呢個 transport 能否處理某部打印機（按 connectionType） */
  supports(printer: DevicePrinterConfig): boolean;
  /** 發送一個 job；resolve 表示「已 queue / 已送出」，唔等物理出單 */
  send(job: PrintJob, printer: DevicePrinterConfig, opts: PrintSendOptions): Promise<PrintSendResult>;
  /** 可選：探測打印機 availability（LAN socket / USB 列舉 / BT 配對） */
  probe?(printer: DevicePrinterConfig): Promise<boolean>;
}
