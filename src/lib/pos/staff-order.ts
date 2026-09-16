import { computeOrderTotals } from "@/lib/kiosk-cart";
import type { OrderItem, PosOrder, PrinterGroup } from "@/lib/types";

/**
 * 店員手機落單（`/staff`）嘅**純函式**建構器（2026-09-16）。
 *
 * ## 點解要一個獨立 builder，唔直接叫 `buildKioskOrder()`
 *
 * 兩者嘅**語意唔同**，混用會出三種難查嘅 bug：
 *
 * 1. **`source`**：`pos_orders.source` 有 CHECK 約束
 *    （`0015_pos_self_order.sql:19` ⇒ `CHECK (source IN ('pos','kiosk','scan'))`）。
 *    店員落單語意上就係**員工落單** ⇒ 一定要用 `"pos"`。
 *    如果硬塞 `"kiosk"`，除咗寫入會被 DB 拒（500）之外，即使寫得入都會令
 *    收銀端當佢係「自助單」→ 觸發 `isSelfOrder()` 嘅補印邏輯 →
 *    同一張單出兩次廚房紙。
 *
 * 2. **狀態起點**：`buildKioskOrder()` 嘅狀態由「自動接單」開關決定
 *    （`draft` vs `sent_to_kitchen`）。店員落單係**店員親手確認**咗嘅，
 *    唔應該受客人自助單嘅開關影響 ⇒ 一律直接 `sent_to_kitchen`。
 *
 * 3. **必填枱號**：店員一定係為**某一張枱**落單。冇枱號就係程式錯誤，
 *    唔可以靜靜 fallback 去 `"counter"`（會變成一張冇人認得嘅快餐單）。
 *
 * ## 同客人掃碼單嘅分別
 *
 * | | 客人掃碼 `scan` | 店員手機 `staff` |
 * |---|---|---|
 * | `source` | `"scan"` | `"pos"` |
 * | 單號 | 無（以枱號做標識） | **有**（店內同日序號） |
 * | 店休閘 | 擋 | 唔擋（同收銀台） |
 * | 廚房單 | 收銀端補建 | **落單時即建**（唔靠收銀機在線） |
 */

/** 店員單喺 DB 嘅來源值。⚠️ 一定要係 CHECK 約束允許嘅三個值之一。 */
export const STAFF_POS_ORDER_SOURCE = "pos" as const;

export type StaffCartItem = {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  printerGroup: PrinterGroup;
  selectedSpecs?: OrderItem["selectedSpecs"];
  note?: string;
};

export type BuildStaffOrderInput = {
  /** 一定要有：店員單必須綁定一張真枱。 */
  tableId: string;
  tableName: string;
  items: StaffCartItem[];
  taxRate: number;
  serviceRate: number;
  orderNote?: string;
  /** 店內同日序號（`/api/pos/sequence` 嘅 `display`）；欠奉就由呼叫方 fallback。 */
  localOrderNo: string;
  /** 加單：重用現有單嘅 id（**必要**，否則會變第二張單 → 重複出紙）。 */
  id?: string;
  /** 開桌人數（僅展示／對帳）。 */
  partySize?: number;
};

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 新店員單 id。
 *
 * ⚠️ 呼叫方要**喺同一輪送出內重用**呢個 id（放 ref，唔好每次 render 重新叫）：
 * server upsert 靠 id 做冪等 —— 網絡抖動重試時如果換咗 id，
 * 同一張單會變成兩張（廚房重複出紙）。
 */
export function newStaffOrderId(): string {
  return uid("staff");
}

/** 購物車行 → 訂單行（兩條路徑共用，避免兩份映射邏輯漂移）。 */
function toOrderItems(items: StaffCartItem[]): OrderItem[] {
  return items.map((it) => ({
    menuItemId: it.menuItemId,
    name: it.name,
    quantity: it.quantity,
    price: it.price,
    printerGroup: it.printerGroup,
    selectedSpecs: it.selectedSpecs,
    note: it.note,
  }));
}

type StaffTotals = {
  subtotal: number;
  taxAmount: number;
  serviceChargeAmount: number;
  total: number;
};

function computeStaffTotals(items: StaffCartItem[], taxRate: number, serviceRate: number): StaffTotals {
  return computeOrderTotals(items, { taxRate, serviceChargeRate: serviceRate });
}

/**
 * 建構店員手機落單嘅 `PosOrder`。
 *
 * ⚠️ 刻意**唔**喺度做「狀態覆寫」：加單（`id` 有值）時狀態由呼叫方決定，
 * 因為加單可能係喺一張 `paid`（已收款）嘅單上面加菜 —— 見 MEMORY
 * 「已收款單加菜必須保留 `paid`，否則雲端拒收整條 ORDER_UPDATED」。
 */
export function buildStaffOrder(input: BuildStaffOrderInput): PosOrder {
  if (!input.tableId) {
    throw new Error("店員落單必須指定枱號（tableId 唔可以為空）。");
  }
  if (input.items.length === 0) {
    throw new Error("購物車係空嘅，唔可以落單。");
  }

  const timestamp = new Date().toISOString();
  const totals = computeStaffTotals(input.items, input.taxRate, input.serviceRate);

  return {
    id: input.id ?? uid("staff"),
    localOrderNo: input.localOrderNo,
    tableId: input.tableId,
    tableName: input.tableName,
    partySize: input.partySize,
    // 店員親手確認 → 直接出廚房。唔受「自動接自助單」開關影響。
    status: "sent_to_kitchen",
    fulfillmentStatus: "preparing",
    items: toOrderItems(input.items),
    orderNote: input.orderNote,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    serviceChargeAmount: totals.serviceChargeAmount,
    discountAmount: 0,
    total: totals.total,
    prepaidAmount: 0,
    source: STAFF_POS_ORDER_SOURCE,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export type StaffAddOnInput = {
  items: StaffCartItem[];
  taxRate: number;
  serviceRate: number;
  orderNote?: string;
};

/**
 * 加菜：喺**既有訂單**上換 items / 金額，其餘欄位（**尤其 `status`**）一律保留。
 *
 * 🔴 點解一定要保留 `status` 而唔可以重新 `buildStaffOrder()`：
 * 加菜可能發生喺一張**已收款（`paid`）**嘅單上面（客人食完一輪想再加）。
 * 如果重建訂單會把狀態打返 `sent_to_kitchen` → 雲端見到「終態降級」
 * 會**拒收整條 `ORDER_UPDATED`** → 加菜靜默消失（本地有、雲端冇）。
 */
export function applyStaffAddOn(existing: PosOrder, input: StaffAddOnInput): PosOrder {
  const totals = computeStaffTotals(input.items, input.taxRate, input.serviceRate);
  return {
    ...existing,
    items: toOrderItems(input.items),
    orderNote: input.orderNote,
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    serviceChargeAmount: totals.serviceChargeAmount,
    total: totals.total,
    updatedAt: new Date().toISOString(),
  };
}

