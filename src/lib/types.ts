export type ConnectionType = "lan" | "usb" | "webusb" | "browser";
export type UserRole = "admin" | "manager" | "cashier";

export interface UserPermissions {
  refundOrder: boolean;
  voidItem: boolean;
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
  usbLabel?: string;
  /** WebUSB：授權設備嘅 serialNumber（用嚟配對已授予嘅 USB 設備，唔使手工 set 名） */
  webusbSerial?: string;
  /** ESC/POS 編碼（每台可配；預設 GB18030。可選: gb18030 / gbk / big5 / utf-8） */
  charset?: string;
  enabled: boolean;
}

export interface DeviceConfig {
  deviceId: string;
  terminalName: string;
  storeId: string;
  /** 覆蓋 NEXT_PUBLIC_PRINT_BRIDGE_URL（例如 Android POS 橋接地址） */
  printBridgeUrl?: string;
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
  fullVoidBehavior: "cancelled" | "refunded";
  dineInQuickActionOrder: Array<
    "view_order" | "send_kitchen" | "checkout" | "back_tables" | "prints" | "online_orders" | "shift" | "settings"
  >;
  onlineOrderSettings: {
    autoAccept: boolean;
  };
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
}

export interface PosOrder {
  id: string;
  localOrderNo: string;
  tableId: string;
  tableName: string;
  status: "draft" | "sent_to_kitchen" | "paid" | "settled" | "cancelled" | "partially_refunded" | "refunded";
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
  createdAt: string;
  updatedAt: string;
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
}
