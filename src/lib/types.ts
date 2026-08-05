export type ConnectionType = "lan" | "usb";

export type PrinterGroup = "kitchen" | "drinks" | "receipt";

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
  group: PrinterGroup;
  connectionType: ConnectionType;
  name: string;
  ipAddress?: string;
  usbLabel?: string;
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
  onlineOrderSettings: {
    autoAccept: boolean;
  };
}

export type CouponType = "amount_off" | "percent_off";

export interface MemberCoupon {
  id: string;
  title: string;
  type: CouponType;
  amountOff?: number;
  percentOff?: number;
  maxOff?: number;
  minSpend?: number;
  stackable: boolean;
  expiresAt?: string;
  usedAt?: string;
}

export interface MemberProfile {
  id: string;
  name: string;
  phone: string;
  balance: number;
  coupons: MemberCoupon[];
  level?: string;
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
  status: "draft" | "sent_to_kitchen" | "settled";
  items: OrderItem[];
  subtotal: number;
  taxAmount: number;
  serviceChargeAmount: number;
  discountAmount: number;
  total: number;
  prepaidAmount?: number;
  onlineOrderId?: string;
  paymentMethod?: PaymentMethod;
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
