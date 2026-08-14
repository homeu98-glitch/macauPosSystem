// Salon 縱向類型定義（新增於 src/lib/salon/types.ts）
// ❗ 不修改既有 src/lib/types.ts；所有 salon 專屬類型集中於此檔。

// 復用既有類型（僅 type import，不修改）
import type { MenuSpecGroup } from "@/lib/types";

// ────────────────────────────────────────────────────────────────────
// 行業分流
// ────────────────────────────────────────────────────────────────────

export type SalonIndustry = "salon";

export type TerminalIndustry = "salon" | "restaurant";

// ────────────────────────────────────────────────────────────────────
// 列印分區（salon 命名約定，與餐飲 PrinterGroup 共享 storage 結構）
// ────────────────────────────────────────────────────────────────────

export type SalonPrinterGroup =
  | "station_face"
  | "station_body"
  | "station_nails"
  | "station_wash"
  | "station_lashes"
  | "receipt"
  | "label";

// ────────────────────────────────────────────────────────────────────
// 服務類目（臉部/身體/SPA/美甲/美睫/…）
// ────────────────────────────────────────────────────────────────────

export interface SalonServiceCategory {
  id: string;
  name: string;
  printerGroup: SalonPrinterGroup;
  sortOrder: number;
  color?: string;
  active: boolean;
}

// ────────────────────────────────────────────────────────────────────
// 服務項目
// ────────────────────────────────────────────────────────────────────

export interface SalonServiceItem {
  id: string;
  categoryId: string;
  name: string;
  description?: string;
  price: number;
  cost?: number;
  durationMinutes: number;
  stationTypes?: Array<"chair" | "bed" | "room" | "wash" | "nail_table">;
  staffRoles?: string[];
  specGroups?: MenuSpecGroup[];
  /** v1：用品消耗為自由文字備註，不扣庫存 */
  consumableNotes?: string;
  active: boolean;
  imageUrl?: string;
  sortOrder: number;
}

// ────────────────────────────────────────────────────────────────────
// 員工（label-only，不登入 POS）
// ────────────────────────────────────────────────────────────────────

export type SalonStaffRole =
  | "stylist"
  | "colorist"
  | "therapist"
  | "assistant"
  | "receptionist";

export interface SalonStaff {
  id: string;
  name: string;
  nickname?: string;
  role: SalonStaffRole;
  /** 可執行服務類目白名單 */
  serviceCategoryIds: string[];
  phone?: string;
  active: boolean;
  hiredAt?: string;
  terminatedAt?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────
// 房型 / 椅 / 床
// ────────────────────────────────────────────────────────────────────

export type SalonStationType =
  | "chair"
  | "bed"
  | "room"
  | "wash"
  | "nail_table";

export interface SalonStation {
  id: string;
  name: string;
  type: SalonStationType;
  capacity: number;
  location?: string;
  active: boolean;
  sortOrder: number;
}

// ────────────────────────────────────────────────────────────────────
// 預約狀態機
// ────────────────────────────────────────────────────────────────────

export type SalonBookingStatus =
  | "pending"
  | "confirmed"
  | "checked_in"
  | "in_service"
  | "completed"
  | "settled"
  | "cancelled"
  | "no_show";

export interface SalonBookingServiceEntry {
  serviceItemId: string;
  name: string;
  price: number;
  durationMinutes: number;
  /** 此項服務的執行人（可能與 booking.staffId 不同） */
  staffId: string;
}

// ────────────────────────────────────────────────────────────────────
// 預約 Booking
// ────────────────────────────────────────────────────────────────────

export interface SalonBooking {
  id: string;
  bookingNo: string;
  /** 來源：線上（Ledger）/ 電話 / walk-in */
  source: "online_ledger" | "phone" | "walk_in";
  ledgerBookingId?: string;
  ledgerOrderId?: string;

  customerId?: string;
  customerName: string;
  customerPhone: string;

  staffId: string;
  stationId?: string;

  startAt: string;
  endAt: string;

  services: SalonBookingServiceEntry[];

  depositAmount?: number;
  depositPaid?: boolean;
  depositLedgerTxnId?: string;

  status: SalonBookingStatus;

  orderId?: string;

  notes?: string;
  internalNotes?: string;

  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────
// 訂單狀態機（結帳單 lifecycle）
// ────────────────────────────────────────────────────────────────────

export type SalonOrderStatus =
  | "draft"
  | "in_service"
  | "ready_to_pay"
  | "settled"
  | "cancelled"
  | "no_show";

// ────────────────────────────────────────────────────────────────────
// 訂單項目
// ────────────────────────────────────────────────────────────────────

export interface SalonOrderItemSpec {
  groupId: string;
  groupName: string;
  optionId: string;
  optionLabel: string;
  priceDelta: number;
}

export interface SalonOrderItem {
  kind: "service" | "product";
  itemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  serviceItemId?: string;
  staffId?: string;
  staffName?: string;
  specSelections?: SalonOrderItemSpec[];
  consumableNotes?: string;
  note?: string;
}

// ────────────────────────────────────────────────────────────────────
// 小費 / 付款
// ────────────────────────────────────────────────────────────────────

export interface SalonTip {
  staffId: string;
  staffName: string;
  amount: number;
  method: "cash" | "ledger_balance";
}

export type SalonPaymentMethod =
  | "cash"
  | "card"
  | "ledger_balance"
  | "external";

export interface SalonPayment {
  method: SalonPaymentMethod;
  amount: number;
  ledgerTransactionId?: string;
  note?: string;
  createdAt: string;
}

// ────────────────────────────────────────────────────────────────────
// 結帳訂單
// ────────────────────────────────────────────────────────────────────

export interface SalonPosOrder {
  id: string;
  orderNo: string;
  bookingId?: string;
  customerId?: string;
  customerName: string;
  customerPhone: string;
  staffId: string;
  stationId?: string;

  items: SalonOrderItem[];

  subtotal: number;
  discountAmount: number;
  serviceChargeAmount?: number;
  taxAmount?: number;
  total: number;

  tips: SalonTip[];
  tipTotal: number;
  grandTotal: number;

  payments: SalonPayment[];
  depositApplied?: number;
  changeDue?: number;

  status: SalonOrderStatus;

  notes?: string;

  startedAt?: string;
  completedAt?: string;
  settledAt?: string;

  ledgerOrderId?: string;
  createdAt: string;
  updatedAt: string;
}

// ────────────────────────────────────────────────────────────────────
// 客戶檔案
// ────────────────────────────────────────────────────────────────────

export type SalonSkinType = "dry" | "oily" | "combination" | "sensitive";
export type SalonHairType = "fine" | "coarse" | "damaged";

export interface SalonFormulaRecord {
  date: string;
  service: string;
  formula: string;
  staffId: string;
  staffName: string;
}

export interface SalonCustomerProfile {
  id: string;
  name: string;
  phone: string;

  /** 從 Ledger 同步（read-only） */
  ledgerBalance?: number;
  ledgerPoints?: number;
  ledgerTier?: string;

  birthday?: string;
  gender?: "female" | "male" | "other";
  tags?: string[];
  skinType?: SalonSkinType;
  hairType?: SalonHairType;
  allergies?: string[];
  preferences?: string;

  formulaHistory?: SalonFormulaRecord[];

  visitCount: number;
  lastVisitAt?: string;
  totalSpent?: number;
}

// ────────────────────────────────────────────────────────────────────
// Bootstrap 結構（店家資料）
// ────────────────────────────────────────────────────────────────────

export interface SalonBootstrap {
  sourceVersion: number;
  storeId: string;
  storeName: string;
  currency: string;
  serviceCategories: SalonServiceCategory[];
  serviceItems: SalonServiceItem[];
  staff: SalonStaff[];
  stations: SalonStation[];
  /** 預約時間間隔（分鐘），例如 30 表示日曆以 30 分鐘為一格 */
  calendarSlotMinutes: number;
  /** 是否啟用定金機制（顯示欄位用，邏輯以 Ledger 為準） */
  depositEnabled: boolean;
  /** 預設服務時長落點（分鐘），用於新服務預設值 */
  defaultServiceDurationMinutes: number;
  lastUpdatedAt: string;
}

// ────────────────────────────────────────────────────────────────────
// 列隊事件類型（salon 命名空間）
// ────────────────────────────────────────────────────────────────────

export type SalonQueueEventType =
  | "BOOKING_CREATED"
  | "BOOKING_UPDATED"
  | "BOOKING_CANCELLED"
  | "BOOKING_CHECKED_IN"
  | "BOOKING_NO_SHOW"
  | "SERVICE_STARTED"
  | "SERVICE_COMPLETED"
  | "ORDER_DRAFT_CREATED"
  | "ORDER_SETTLED"
  | "TIP_RECORDED"
  | "DEPOSIT_RECEIVED"
  | "STAFF_UPDATED"
  | "STATION_UPDATED"
  | "SERVICE_CATEGORY_UPDATED"
  | "SERVICE_ITEM_UPDATED";

export interface SalonQueueEvent {
  id: string;
  type: SalonQueueEventType;
  entityId: string;
  payload: unknown;
  status: "pending" | "synced" | "failed";
  createdAt: string;
}

// ────────────────────────────────────────────────────────────────────
// localStorage 鍵常數（集中管理，避免 magic string）
// ────────────────────────────────────────────────────────────────────

export const SALON_STORAGE_KEYS = {
  bootstrap: "macau-pos-salon/bootstrap",
  bookings: "macau-pos-salon/bookings",
  orders: "macau-pos-salon/orders",
  staff: "macau-pos-salon/staff",
  stations: "macau-pos-salon/stations",
  serviceCategories: "macau-pos-salon/service-categories",
  serviceItems: "macau-pos-salon/service-items",
  printJobs: "macau-pos-salon/print-jobs",
  syncQueue: "macau-pos-salon/sync-queue",
  shift: "macau-pos-salon/shift",
  shiftHistory: "macau-pos-salon/shift-history",
  customers: "macau-pos-salon/customers",
  activeStore: "macau-pos-salon/active-store",
  terminalIndustry: "macau-pos-salon/terminal-industry",
} as const;

export type SalonStorageKey =
  (typeof SALON_STORAGE_KEYS)[keyof typeof SALON_STORAGE_KEYS];
