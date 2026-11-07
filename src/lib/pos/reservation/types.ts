/**
 * 訂位（reservation）型別定義 —— 純型別 + 零 runtime 依賴。
 *
 * 表結構見 `supabase/migrations/0077_pos_reservations.sql`。
 * 業務規則見 `deliverables/gstack/feature-dev-reservation-2026-11-06.md`。
 *
 * ⚠️ 呢個檔唔可以 import 任何 runtime 依賴（`node --test` 要直接載入）。
 */

/** 訂位狀態。`seated` 之後不可取消（走訂單流程）。 */
export type ReservationStatus =
  | "pending"
  | "confirmed"
  | "arrived"
  | "seated"
  | "completed"
  | "canceled"
  | "no_show"
  | "waitlist";

/** 來源：店員代訂 / 會員通 / 電話 / 現場。 */
export type ReservationSource = "pos" | "ledger" | "phone" | "walkin";

/** 預付範圍。 */
export type PrepayMode = "full" | "deposit";

/** 每週營業時段（key = 1..7，1 = 週一）。close < open 代表跨日。 */
export type ServiceSlot = { open: string; close: string };
export type ServiceHours = Record<string, ServiceSlot>;

/** 訂位設置（DB row 投影，camelCase）。 */
export type ReservationSettings = {
  storeId: string;
  enabled: boolean;
  notice: string;
  leadDaysMax: number;
  leadMinutesMin: number;
  slotIntervalMinutes: number;
  slotQuota: number;
  turnMinutes: number;
  minPartySize: number;
  maxPartySize: number;
  largePartyThreshold: number;
  autoConfirm: boolean;
  graceMinutes: number;
  cancelCutoffMinutes: number;
  depositRequired: boolean;
  prepayEnabled: boolean;
  prepayMode: PrepayMode;
  depositAmount: number;
  refundCutoffMinutes: number;
  serviceHours: ServiceHours;
  updatedAt: string;
};

/** 後台預設值 —— 未設定過嘅店用呢份。 */
export function defaultReservationSettings(storeId: string): ReservationSettings {
  return {
    storeId,
    enabled: false,
    notice: "",
    leadDaysMax: 14,
    leadMinutesMin: 30,
    slotIntervalMinutes: 30,
    slotQuota: 5,
    turnMinutes: 90,
    minPartySize: 1,
    maxPartySize: 20,
    largePartyThreshold: 8,
    autoConfirm: true,
    graceMinutes: 15,
    cancelCutoffMinutes: 120,
    depositRequired: false,
    prepayEnabled: false,
    prepayMode: "full",
    depositAmount: 0,
    refundCutoffMinutes: 120,
    serviceHours: {
      "1": { open: "17:30", close: "22:30" },
      "2": { open: "17:30", close: "22:30" },
      "3": { open: "17:30", close: "22:30" },
      "4": { open: "17:30", close: "22:30" },
      "5": { open: "17:30", close: "22:30" },
      "6": { open: "11:30", close: "22:30" },
      "7": { open: "11:30", close: "22:30" },
    },
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * 預點菜快照（存進 `pos_reservations.items`）。
 *
 * 🔴 全部係**下單那一刻**的值，到店開枱時會按當日菜牌重算，
 *    所以 `unitPrice` 只作顯示與對帳，**不可**當結帳價。
 */
export type ReservationItem = {
  /** 菜單項 id；到店時用它查「仍在售 / 現價」。 */
  menuItemId: string;
  /** 下單時的菜名（顯示用）。 */
  name: string;
  /** 規格顯示文字，例如「少冰 · 少甜」。 */
  specText: string;
  /** 規格選擇（group id → option id[]），帶入訂單時原樣用。 */
  specs: Record<string, string[]>;
  qty: number;
  /** 下單時的原價（未套會員折扣）。 */
  unitPrice: number;
  /** 單品會員價（有值優先）。 */
  memberPrice: number | null;
  /** 全店會員折扣率（90 = 9 折）；null = 無折扣。 */
  discountRate: number | null;
  /** 快照時間（ISO）。 */
  snapshotAt: string;
};

/** 訂位單（camelCase 投影，供 UI 用）。 */
export type PosReservation = {
  id: string;
  storeId: string;
  code: string;
  bizDate: string;
  slotAt: string;
  partySize: number;
  guestName: string;
  guestPhone: string;
  guestNote: string;
  status: ReservationStatus;
  source: ReservationSource;
  tableId: string | null;
  tableName: string | null;
  orderId: string | null;
  orderNo: string | null;
  items: ReservationItem[];
  itemsSubtotal: number;
  discountAmount: number;
  payableAmount: number;
  paidAmount: number;
  paidAt: string | null;
  paymentRef: string | null;
  paymentMethod: string | null;
  refundAmount: number;
  refundedAt: string | null;
  memberId: string | null;
  memberDiscountRate: number | null;
  createdAt: string;
  confirmedAt: string | null;
  arrivedAt: string | null;
  seatedAt: string | null;
  canceledAt: string | null;
  cancelReason: string | null;
  updatedAt: string;
};

/** 時段餘量（來自 `reservation_slot_usage` RPC）。 */
export type SlotUsage = { slotAt: string; used: number; guests: number };

/** 列表時間範圍（對應五檔篩選）。 */
export type ReservationRange = "today" | "tomorrow" | "7d" | "30d" | "all";

export const RESERVATION_RANGE_LABELS: Record<ReservationRange, string> = {
  today: "今天",
  tomorrow: "明天",
  "7d": "7 天內",
  "30d": "30 天內",
  all: "全部",
};
