<<<<<<< HEAD
=======
// 跨平台雙路徑打印合約（Phase 0 骨架，見 docs/43-cross-platform-print-dual-path.md）
// 三個平台（Android / desktop / iOS）共用同一份 connectionType 列舉。
>>>>>>> 3e35bda0ada861ee6fd26497e72a3f326554dfe8
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
  | "DEVICE_CONFIG_UPDATED"
  | "PRINT_JOB_CREATED"
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
<<<<<<< HEAD
  /** USB 打印機 VID（自動偵測，商家唔使手填；Meituan 式型號表對照） */
  usbVendorId?: string;
  /** USB 打印機 PID（自動偵測） */
  usbProductId?: string;
  /** 藍牙打印機名稱 / 配對位址 */
  bluetoothName?: string;
  /** true = 由 Companion 自動偵測加入（唔經手動輸入 VID/PID） */
  autoDetected?: boolean;
=======
  // ── USB 連接（connectionType === "usb" 時使用）──
  /** USB vendor id（hex string，例如 "0x1234"） */
  usbVendorId?: string;
  /** USB product id（hex string，例如 "0x5678"） */
  usbProductId?: string;
  // ── Bluetooth 連接（connectionType === "bluetooth" 時使用）──
  /** Bluetooth MAC / 裝置地址（例如 "AA:BB:CC:DD:EE:FF"） */
  bluetoothAddress?: string;
  /** Bluetooth 裝置名（配對/列舉顯示用） */
  bluetoothName?: string;
>>>>>>> 3e35bda0ada861ee6fd26497e72a3f326554dfe8
  enabled: boolean;
}

export interface DeviceConfig {
  deviceId: string;
  terminalName: string;
  storeId: string;
  printers: DevicePrinterConfig[];
  updatedAt: string;
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
  printTemplates: {
    receipt: {
      showRuler: boolean;
      snapToGrid: boolean;
      canvas: {
        width: number;
        height: number;
        zoom: number;
      };
      sectionStyles: Record<
        "store_name" | "order_no" | "table_name" | "items" | "total" | "payment_method" | "order_note" | "footer",
        {
          fontSize: number;
          fontWeight: 400 | 500 | 600 | 700;
          textAlign: "left" | "center" | "right";
          padding: number;
          textColor: string;
          borderColor: string;
          backgroundColor: string;
        }
      >;
      sectionLayouts: Record<
        "store_name" | "order_no" | "table_name" | "items" | "total" | "payment_method" | "order_note" | "footer",
        { x: number; y: number; width: number; height: number }
      >;
      sectionOrder: Array<
        "store_name" | "order_no" | "table_name" | "items" | "total" | "payment_method" | "order_note" | "footer"
      >;
      showStoreName: boolean;
      showOrderNo: boolean;
      showTableName: boolean;
      showPaymentMethod: boolean;
      showOrderNote: boolean;
      footerText: string;
    };
    label: {
      showRuler: boolean;
      snapToGrid: boolean;
      canvas: {
        width: number;
        height: number;
        zoom: number;
      };
      sectionStyles: Record<
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
        | "footer",
        {
          fontSize: number;
          fontWeight: 400 | 500 | 600 | 700;
          textAlign: "left" | "center" | "right";
          padding: number;
          textColor: string;
          borderColor: string;
          backgroundColor: string;
        }
      >;
      sectionLayouts: Record<
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
        | "footer",
        { x: number; y: number; width: number; height: number }
      >;
      sectionOrder: Array<
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
        | "footer"
      >;
      showOrderNo: boolean;
      showSpecs: boolean;
      showItemNote: boolean;
      headerText: string;
      footerText: string;
    };
  };
  notePresets: string[];
  cancelNotePresets: string[];
  /** 返結（反結賬）可選原因清單，設置 → 備註 可增刪 */
  reopenReasons: string[];
  fullVoidBehavior: "cancelled" | "refunded";
  dineInQuickActionOrder: Array<
    "view_order" | "send_kitchen" | "checkout" | "back_tables" | "prints" | "online_orders" | "shift" | "settings"
  >;
  onlineOrderSettings: {
    autoAccept: boolean;
  };
  /**
   * Kiosk 掃碼點餐落單模式：
   * - "auto"：堂食單落單後自動出廚房（同線上訂單 autoAccept 行為）
   * - "dine_in_confirm"：堂食單落單後排入「待確認」，等收銀 / 樓面確認才出廚房
   */
  kioskKitchenMode: "auto" | "dine_in_confirm";
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
}

// ── 跨平台雙路徑打印：統一傳輸層合約（Phase 0 骨架） ──
//
// 三個平台各自實作一套 Transport（Android=Kotlin Socket/UsbManager/BluetoothSocket；
// desktop=Node/Rust net+node-usb+COM；iOS=Swift Network.framework/BLE·MFi），
// POS 網頁只靠呢個介面溝通，唔使知底層 OS 差異。見 docs/43。

export type PrintKind = "receipt" | "kitchen" | "test";

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
