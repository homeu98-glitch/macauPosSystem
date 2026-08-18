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
  /** 積分價：以多少 Ledger 積分全額兌換本服務（替代現金價 price）；支持與現金 mix 抵扣（P-積分兌換） */
  pointsPrice?: number;
  cost?: number;
  durationMinutes: number;
  stationTypes?: Array<"chair" | "bed" | "room" | "wash" | "nail_table">;
  staffRoles?: string[];
  specGroups?: MenuSpecGroup[];
  /** v1：用品消耗為自由文字備註，不扣庫存 */
  consumableNotes?: string;
  /** 各職位基礎工錢（MOP）。執行該項時工錢 = wages[員工職位] × 級別倍率；無該職位 → 0（F1） */
  wages?: Partial<Record<SalonStaffRole, number>>;
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

/** 員工級別：影響工錢倍率（junior 1.0 / senior 1.3 / master 1.6，見 SalonBootstrap.staffLevelMultipliers） */
export type SalonStaffLevel = "junior" | "senior" | "master";

/** 員工狀態：在職 / 放假 / 離職（取代舊 active:boolean + terminatedAt 的歧義） */
export type SalonStaffStatus = "active" | "on_leave" | "terminated";

export interface SalonStaff {
  id: string;
  name: string;
  nickname?: string;
  /** 角色（可多選；染色 / 療師 / 助理等可兼任） */
  roles: SalonStaffRole[];
  /** 級別（預設 junior） */
  level: SalonStaffLevel;
  /** 狀態（預設 active） */
  status: SalonStaffStatus;
  /** 可執行服務類目白名單 */
  serviceCategoryIds: string[];
  phone?: string;
  hiredAt?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  /** 舊欄位：保留做遷移用（active 舊值）；新邏輯一律讀 status */
  active?: boolean;
  /** 舊欄位：保留做遷移用（離職日）；新邏輯一律讀 status */
  terminatedAt?: string;
}

// ────────────────────────────────────────────────────────────────────
// 員工放假 / shift 記錄（F2：log 形式記錄，先唔做週排班 grid）
// ────────────────────────────────────────────────────────────────────

export interface SalonStaffLeave {
  id: string;
  staffId: string;
  /** 開始日（ISO date YYYY-MM-DD） */
  start: string;
  /** 結束日（ISO date YYYY-MM-DD） */
  end: string;
  reason?: string;
  createdAt: string;
}

export interface SalonStaffShift {
  id: string;
  staffId: string;
  /** 上班日（ISO date YYYY-MM-DD） */
  date: string;
  /** 上班開始時段 "HH:MM" */
  start: string;
  /** 上班結束時段 "HH:MM" */
  end: string;
  note?: string;
  createdAt: string;
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

/** 預約中選購的產品（F-產品；快速開單「產品」tab 加入，併入同一張單結帳） */
export interface SalonBookingProductSelection {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  /** 銷售員工（計佣金用） */
  staffId?: string;
  /** 佣金率%（快照） */
  commissionRate: number;
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

  /** 選購產品（快速開單「產品」tab；併入同一張單結帳，結帳時轉 order item kind=product） */
  productSelections?: SalonBookingProductSelection[];

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
  /** 該次服務工錢（MOP，已乘級別倍率、取整）。僅 kind:"service" 且有 staffId 時有意義（F1） */
  wageAmount?: number;
  /** 產品佣金（MOP，= round(price × quantity × commissionRate / 100)）。僅 kind:"product" 且有 staffId 時有意義（F4 併入同單） */
  commissionAmount?: number;
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
  /** 套票抵扣總額（P2：以套票次數抵扣的服務金額，從應收減除） */
  packageDeduction?: number;
  /** 積分兌換抵扣總額（MOP 等值的現金減免，由 pointsRedeemed 換算的消費額，P-積分兌換） */
  pointsDeduction?: number;
  /** 本次交易兌換所扣 Ledger 積分總數（P-積分兌換） */
  pointsRedeemed?: number;
  serviceChargeAmount?: number;
  taxAmount?: number;
  total: number;

  /** 本次結帳賺取積分（依 pointsPerDollar 計算，生日窗口內乘倍率） */
  pointsEarned?: number;
  /** 本次結帳是否套用生日折扣 */
  birthdayDiscount?: boolean;

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

  /** 推薦人客戶 id（本客戶由哪位現有客戶推薦而來；留空 = 無推薦） */
  referrerId?: string;
  /** 推薦獎勵是否已發出（防刷分：僅被推薦人首次結帳發一次） */
  referralRewarded?: boolean;
  /** 檔案號碼（free text），供商家與實體文件對照（F5） */
  fileNumber?: string;
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
// 美容院 Package / 套票玩法（P1）
// 設計原則：次數額度（items.remaining）留 salon 本地；儲值 / 積分 / 定金委託 Ledger。
// ────────────────────────────────────────────────────────────────────

export interface SalonPackageItemEntry {
  /** 套票含哪項服務 */
  serviceItemId: string;
  /** 該服務含多少次（例如 10 次面部） */
  sessions: number;
}

export interface SalonPackageTemplate {
  id: string;
  name: string;
  /** 售價（MOP） */
  price: number;
  /** 有效期限（天），自購買日起算；0 / 負數 = 永久 */
  validityDays: number;
  /** 套票內含服務明細（次數額度） */
  items: SalonPackageItemEntry[];
  /** 贈送積分（→ Ledger，P2 才寫入） */
  bonusPoints: number;
  /** 贈送儲值（→ Ledger，P2 才寫入） */
  bonusBalance: number;
  /** 展示用備註（例如「含 1 支精華」） */
  note?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SalonCustomerPackageRemaining {
  serviceItemId: string;
  sessionsLeft: number;
}

export type SalonCustomerPackageStatus = "active" | "used_up" | "expired";

export interface SalonCustomerPackage {
  id: string;
  customerId: string;
  templateId: string;
  templateName: string;
  /** 購買時售價（快照） */
  price: number;
  purchasedAt: string;
  /** 到期日（ISO）；undefined 表示永久 */
  expiresAt?: string;
  /** 剩餘次數額度（視覺化用） */
  remaining: SalonCustomerPackageRemaining[];
  status: SalonCustomerPackageStatus;
  /** 購買付款方式（P1 僅記錄；真扣款委託 Ledger P2） */
  paymentMethod?: SalonPaymentMethod;
  note?: string;
}

// ────────────────────────────────────────────────────────────────────
// 會員忠誠度設定（salon 本地設定，Ledger 主導餘額/積分/等級）
// 設計決策（docs/30-salon-loyalty-referral-birthday.md）：
// - pointsPerDollar：每消費多少 MOP 得 1 分（預設 1 = 1 元 1 分）；每店可自定。
// - 推薦獎勵：被推薦人「首次結帳」才發給推薦人（防刷分），僅推薦人得分。
// - 生日優惠：商家自定窗口（當月/當週）+ 折扣% 與 積分倍率 各自獨立（填 0 = 關閉）。
// ────────────────────────────────────────────────────────────────────

export interface SalonLoyaltySettings {
  /** 每消費多少 MOP 得 1 分（預設 1 = 1 元 1 分） */
  pointsPerDollar: number;
  /** 推薦獎勵開關 */
  referralEnabled: boolean;
  /** 推薦獎勵積分：被推薦人首次結帳時發給推薦人 */
  referralPoints: number;
  /** 生日優惠開關 */
  birthdayEnabled: boolean;
  /** 生日窗口：當月 month / 當週 week */
  birthdayWindow: "month" | "week";
  /** 生日折扣%（0 = 關閉折扣） */
  birthdayDiscountPercent: number;
  /** 生日積分倍率（0 = 關閉多倍積分；1 = 不變；2 = 雙倍；以此類推） */
  birthdayPointsMultiplier: number;
}

// ────────────────────────────────────────────────────────────────────
// 產品目錄 + 產品銷售（F4：獨立產品目錄 + 獨立賣產品流程，無庫存）
// ────────────────────────────────────────────────────────────────────

export interface SalonProduct {
  id: string;
  name: string;
  /** 分類（護膚 / 彩妝 / 髮品…，可選） */
  category?: string;
  /** 售價（MOP） */
  price: number;
  /** 成本（MOP，可選） */
  cost?: number;
  /** 佣金率%（如 10 = 10%） */
  commissionRate: number;
  active: boolean;
  sortOrder: number;
}

export interface SalonProductSale {
  id: string;
  productId: string;
  productName: string;
  /** 成交價（通常 = product.price） */
  price: number;
  /** 佣金率% 快照 */
  commissionRate: number;
  /** 佣金金額 = round(price × commissionRate / 100) */
  commissionAmount: number;
  staffId: string;
  staffName: string;
  customerId?: string;
  customerName: string;
  /** 收錢方式（可選） */
  paymentMethod?: SalonPaymentMethod;
  /** 成交時間（ISO datetime） */
  soldAt: string;
  note?: string;
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
  /** 產品目錄（F4，獨立賣產品流程） */
  products?: SalonProduct[];
  /** 預約時間間隔（分鐘），例如 30 表示日曆以 30 分鐘為一格 */
  calendarSlotMinutes: number;
  /** 是否啟用定金機制（顯示欄位用，邏輯以 Ledger 為準） */
  depositEnabled: boolean;
  /** 預設服務時長落點（分鐘），用於新服務預設值 */
  defaultServiceDurationMinutes: number;
  /** 會員忠誠度設定（推薦獎勵 / 生日優惠 / 每店積分配比） */
  loyalty?: SalonLoyaltySettings;
  /** 員工級別對工錢倍率（預設 junior 1 / senior 1.3 / master 1.6；F1+F3） */
  staffLevelMultipliers?: Record<SalonStaffLevel, number>;
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
  | "SERVICE_ITEM_UPDATED"
  | "BOOTSTRAP_UPDATED"
  | "PACKAGE_TEMPLATE_UPDATED"
  | "CUSTOMER_PACKAGE_UPDATED";

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
  products: "macau-pos-salon/products",
  productSales: "macau-pos-salon/product-sales",
  staffLeaves: "macau-pos-salon/staff-leaves",
  staffShifts: "macau-pos-salon/staff-shifts",
  printJobs: "macau-pos-salon/print-jobs",
  syncQueue: "macau-pos-salon/sync-queue",
  shift: "macau-pos-salon/shift",
  shiftHistory: "macau-pos-salon/shift-history",
  customers: "macau-pos-salon/customers",
  packageTemplates: "macau-pos-salon/package-templates",
  customerPackages: "macau-pos-salon/customer-packages",
  activeStore: "macau-pos-salon/active-store",
  terminalIndustry: "macau-pos-salon/terminal-industry",
} as const;

export type SalonStorageKey =
  (typeof SALON_STORAGE_KEYS)[keyof typeof SALON_STORAGE_KEYS];
