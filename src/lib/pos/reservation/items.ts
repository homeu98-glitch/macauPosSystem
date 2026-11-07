/**
 * 預點菜的計價與入座映射 —— 純函數，零 UI 依賴。
 *
 * ## 三條不能動的規則
 *
 * 1. **單品會員價優先**：`memberPrice` 有值就用，否則 `原價 × discountRate / 100`。
 *    同 POS 收銀台 `lib/pos/member-price.ts` 完全一致 —— 唔可以兩套。
 * 2. **快照價只作顯示**：入座開枱時一律按「當日菜牌」重算（`mapItemsForSeat`）。
 * 3. **金額永遠由伺服器算**：客人端傳上嚟嘅價一律唔信（`sanitizeReservationItems` 會剝走）。
 */

import type { ReservationItem } from "./types.ts";

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function toPositiveInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i > 0 ? i : fallback;
}

/** 單品折後價（會員價優先，其次全店折扣率）。 */
export function itemNetPrice(item: Pick<ReservationItem, "unitPrice" | "memberPrice" | "discountRate">): number {
  const base = Number(item.unitPrice) || 0;
  const memberPrice = item.memberPrice;
  if (typeof memberPrice === "number" && Number.isFinite(memberPrice) && memberPrice >= 0) {
    return round2(memberPrice);
  }
  const rate = item.discountRate;
  if (typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate < 100) {
    return round2((base * rate) / 100);
  }
  return round2(base);
}

export type ReservationTotals = {
  /** 原價合計。 */
  subtotal: number;
  /** 會員折扣（正數，= subtotal − payable）。 */
  discount: number;
  /** 應付。 */
  payable: number;
  /** 總件數。 */
  qty: number;
};

/** 合計（用快照價）。 */
export function computeReservationTotals(items: readonly ReservationItem[]): ReservationTotals {
  let subtotal = 0;
  let payable = 0;
  let qty = 0;
  for (const item of items) {
    const q = toPositiveInt(item.qty);
    if (q <= 0) continue;
    subtotal += (Number(item.unitPrice) || 0) * q;
    payable += itemNetPrice(item) * q;
    qty += q;
  }
  return {
    subtotal: round2(subtotal),
    discount: round2(Math.max(0, subtotal - payable)),
    payable: round2(payable),
    qty,
  };
}

/**
 * 收斂外來輸入（客人端 API / 前端表單）。
 *
 * 🔴 只保留白名單欄位，**價錢一律不採用外來值** ——
 *    呼叫方要用菜單現價重新填 `unitPrice` / `memberPrice` / `discountRate`。
 *    呢個函數只負責結構同數量，不負責核價。
 */
export function sanitizeReservationItems(raw: unknown): Array<{
  menuItemId: string;
  qty: number;
  specs: Record<string, string[]>;
  specText: string;
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    menuItemId: string;
    qty: number;
    specs: Record<string, string[]>;
    specText: string;
  }> = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const menuItemId = typeof row.menuItemId === "string" ? row.menuItemId.trim() : "";
    if (!menuItemId) continue;

    const qty = Math.min(99, toPositiveInt(row.qty, 0));
    if (qty <= 0) continue;

    const specs: Record<string, string[]> = {};
    if (row.specs && typeof row.specs === "object" && !Array.isArray(row.specs)) {
      for (const [group, value] of Object.entries(row.specs as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0).slice(0, 20);
        if (ids.length > 0) specs[group] = ids;
      }
    }

    const specText = typeof row.specText === "string" ? row.specText.slice(0, 120) : "";
    out.push({ menuItemId, qty, specs, specText });
  }

  return out.slice(0, 60);
}

/** 菜單查價介面（呼叫方提供，通常在 route 內用 bootstrap 菜單建立）。 */
export type MenuPriceLookup = (menuItemId: string) =>
  | { name: string; price: number; memberPrice?: number | null; soldOut?: boolean }
  | null;

export type SeatLine = {
  menuItemId: string;
  name: string;
  qty: number;
  /** 當日單價（未打折）。 */
  unitPrice: number;
  /** 當日折後單價。 */
  netPrice: number;
  /**
   * 折價來源：單品會員價（絕對值）或全店折扣率。
   * 帶入 `OrderItem` 時要原樣保留，否則收銀台重算會同訂位價對唔上。
   */
  memberPrice: number | null;
  discountRate: number | null;
  specs: Record<string, string[]>;
  specText: string;
};

export type SeatPlan = {
  /** 可帶入的菜（按當日價）。 */
  lines: SeatLine[];
  /** 不可帶入的菜（下架 / 沽清）。 */
  unavailable: Array<{ menuItemId: string; name: string; reason: "gone" | "soldout" }>;
  /** 當日重算的原價合計。 */
  subtotal: number;
  /** 當日重算的應付（已套折扣）。 */
  payable: number;
  /** 與已預付的差額（正數 = 要向客人補收）。 */
  delta: number;
};

/**
 * 入座開枱時，把訂位快照按**當日菜牌**重算。
 *
 * - 菜單找不到 → `gone`；`soldOut` → `soldout`；兩者都列入 `unavailable` 讓店員確認。
 * - **不要靜默丟棄**：店員要知道哪幾道帶不進去。
 * - `paidAmount` 傳入已預付金額，用於算差額。
 */
export function mapItemsForSeat(params: {
  items: readonly ReservationItem[];
  discountRate: number | null;
  lookup: MenuPriceLookup;
  paidAmount: number;
}): SeatPlan {
  const lines: SeatLine[] = [];
  const unavailable: SeatPlan["unavailable"] = [];
  let subtotal = 0;
  let payable = 0;

  for (const item of params.items) {
    const qty = toPositiveInt(item.qty);
    if (qty <= 0) continue;

    const current = params.lookup(item.menuItemId);
    if (!current) {
      unavailable.push({ menuItemId: item.menuItemId, name: item.name, reason: "gone" });
      continue;
    }
    if (current.soldOut) {
      unavailable.push({ menuItemId: item.menuItemId, name: current.name || item.name, reason: "soldout" });
      continue;
    }

    const unitPrice = round2(Number(current.price) || 0);
    const netPrice = itemNetPrice({
      unitPrice,
      memberPrice: typeof current.memberPrice === "number" ? current.memberPrice : null,
      discountRate: params.discountRate,
    });

    const memberPrice =
      typeof current.memberPrice === "number" && Number.isFinite(current.memberPrice)
        ? current.memberPrice
        : null;

    lines.push({
      menuItemId: item.menuItemId,
      name: current.name || item.name,
      qty,
      unitPrice,
      netPrice,
      memberPrice,
      discountRate: memberPrice === null ? params.discountRate : null,
      specs: item.specs ?? {},
      specText: item.specText ?? "",
    });

    subtotal += unitPrice * qty;
    payable += netPrice * qty;
  }

  const payableRounded = round2(payable);
  return {
    lines,
    unavailable,
    subtotal: round2(subtotal),
    payable: payableRounded,
    delta: round2(payableRounded - (Number(params.paidAmount) || 0)),
  };
}

/** 時長顯示：`90 分鐘` → `1 小時 30 分`。 */
export function formatTurnDuration(minutes: number): string {
  const m = Math.max(0, Math.trunc(minutes || 0));
  if (m < 60) return `${m} 分鐘`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} 小時` : `${h} 小時 ${rest} 分`;
}
