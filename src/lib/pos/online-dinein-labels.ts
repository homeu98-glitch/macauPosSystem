/**
 * 線上訂單（Ledger）嘅**枱位 / 付款**派生標籤 —— 零依賴純函式。
 *
 * ## 為咩要有呢個模組
 *
 * 需求（2026-09-12 商家）：線上訂單可能**已經付款**，同本地堂食單（落單→結帳）唔同，
 * 但又**唔可以**為咗顯示而新增 `PosOrder.status` 值 —— `status` 係狀態機真源，
 * 牽扯 LWW 單向閘、收入認列（`isSaleCountable`）、返結、快餐雙標籤，加一個新值要全鏈路改。
 *
 * 所以一律用**派生標籤**（同 docs/113 快餐「出餐階段 + 付款階段雙標籤」同一做法）：
 *   - 付款維度：「已結帳（綠）」← `paymentStatus === "paid"`
 *   - 枱位維度：「待安排座位（橙）」/ 枱名 / 「出餐口自取」/「自取」/「外賣」
 *
 * ## 兩邊 use case 唔一樣（商家明確要求）
 *
 *   - **堂食模式**：`dine_in` 線上單 → 要「排位」，未有枱要顯示「待安排座位」。
 *   - **快餐模式**：`dine_in` 線上單 → 當平常快餐 POS 單（出餐口自取、客人自己搵位），
 *     **唔會排位**，所以標籤一律「出餐口自取」而唔係「待安排座位」。
 *
 * ⚠️ 呢個檔唔可以 import 任何 runtime 依賴（`node --test` 要直接載入）。
 * 要加功能前先諗清楚。
 *
 * @see src/lib/pos/quick-labels.ts（同一做法嘅先例）
 * @see docs/online-dinein-table-assign-plan-2026-09-12.md
 */

/** 同 `OrderStatusBadge`（pos-order-filters.ts）結構一致；刻意本地定義保持零依賴。 */
export type OnlineBadge = {
  label: string;
  bgClass: string;
  textClass: string;
  dotClass: string;
};

/** 判斷標籤所需嘅最小欄位（Ledger 線上單一定有；本地 PosOrder 都有同名欄）。 */
export type OnlineTableInfo = {
  tabType?: string | null;
  tableId?: string | null;
  tableName?: string | null;
  paymentMode?: string | null;
  paymentStatus?: string | null;
};

/**
 * 已排位嘅線上堂食單（＝已被 POS「已結帳、待收尾」管理）。
 *
 * 🔴 判準同 `isLocalOrTransferredDineIn()`（`pos-order-filters.ts`）一致：
 * **有 `onlineOrderId` ＋ 真枱號（≠ counter）**。快餐模式採納嘅 counter 單唔算。
 *
 * ⚠️ 呢個係「結帳入口放寬」同「排位自動推 Ledger 狀態」**兩者共用**嘅唯一邊界 ——
 * 本地堂食單（冇 `onlineOrderId`）完全唔會行到呢兩條路，所以舊口徑零改動。
 */
export type SettleableOrderInfo = OnlineTableInfo & {
  status?: string | null;
  onlineOrderId?: string | null;
};

/**
 * 線上單係唔係「堂食流程」（2026-09-13）。
 *
 * 🔴 兩個功能嘅**共同隔離閘**，一定要收埋一份：
 *   1. 結帳入口放寬（`isSettleableOrder()` 第 2 條）；
 *   2. 排位時自動推 Ledger 狀態（`syncOnlineDineInCompletion()`）。
 *
 * 條件：**有 Ledger 單 id**（`onlineOrderId`）＋ **真枱號**（`tableId` 非空且 ≠ `"counter"`）。
 * 唔符合嘅一律唔關事：本地堂食單、快餐 counter 單、自取 / 外賣單。
 *
 * ⚠️ 純欄位判定，同 `tabType` 無關 —— 排位之後本地單嘅 `tabType` 未必仍係 `dine_in`。
 */
export function isOnlineDineInOrder(order: {
  onlineOrderId?: string | null;
  tableId?: string | null;
}): boolean {
  return Boolean(order.onlineOrderId) && hasTableAssigned(order);
}

/** 未收款、待收尾嘅狀態（一向可以結帳）。 */
function isOpenSettleableStatus(status: string | undefined | null): boolean {
  return status === "sent_to_kitchen" || status === "reopened";
}

/**
 * 呢張單可唔可以入結帳流程（2026-09-13）。
 *
 * 兩條路：
 *   1. 未收款嘅活躍單：`sent_to_kitchen` / `reopened`（本地堂食 + 快餐都係咁，口徑不變）；
 *   2. 🔴 **已付款嘅線上堂食單**（已排位）：`onlineOrderId` ＋ 真枱號 ＋ `status === "paid"`。
 *
 * ## 為何要第 2 條（實案 bug）
 *
 * `assignLedgerOrderToTable()` 對「線上已付」單寫入 `status: "paid"` +
 * `prepaidAmount = 全額`（`ledger-pos-bridge.ts`）。但結帳入口舊寫法只認
 * `sent_to_kitchen` / `reopened` → 撳「去結帳」彈「目前沒有待結帳訂單」，
 * 而枱面因為 `openOrders` 包含 `paid` 而永遠被佔用 → **張單卡死冇出路**。
 *
 * `prepaidAmount` 本來就係為呢個場景設計（`payableBeforeMember = max(0, total − prepaid)`
 * ＝只收加菜差額），所以放寬入口係補返設計缺口，唔係新加能力。
 *
 * ⚠️ 只認「真枱」：快餐模式嘅線上 counter 單（`tableId === "counter"`）唔屬堂食流程，
 * 佢行快餐 strip 嘅「可取餐 → 完成」，唔應該經呢度結帳。
 */
export function isSettleableOrder(order: SettleableOrderInfo): boolean {
  if (isOpenSettleableStatus(order.status)) return true;
  return (
    Boolean(order.onlineOrderId) && hasTableAssigned(order) && order.status === "paid"
  );
}

const BADGE_EMERALD: OnlineBadge = {
  label: "",
  bgClass: "bg-emerald-50",
  textClass: "text-emerald-700",
  dotClass: "bg-emerald-500",
};
const BADGE_AMBER: OnlineBadge = {
  label: "",
  bgClass: "bg-amber-50",
  textClass: "text-amber-700",
  dotClass: "bg-amber-500",
};
const BADGE_SLATE: OnlineBadge = {
  label: "",
  bgClass: "bg-slate-100",
  textClass: "text-slate-600",
  dotClass: "bg-slate-400",
};

function badge(base: OnlineBadge, label: string): OnlineBadge {
  return { ...base, label };
}

/** 線上堂食單（`tabType === "dine_in"`）。 */
export function isOnlineDineIn(order: OnlineTableInfo): boolean {
  return order.tabType === "dine_in";
}

/**
 * 已經排到真枱（`counter` 唔算枱 —— 快餐／自取／外賣都用 `counter`）。
 */
export function hasTableAssigned(order: OnlineTableInfo): boolean {
  return Boolean(order.tableId && order.tableId !== "counter");
}

/**
 * 「未排位」＝ 堂食模式 + 線上堂食單 + 仲未有真枱。
 *
 * ⚠️ 快餐模式一定 `false`：嗰邊唔排位（出餐口自取）。
 */
export function needsTableAssignment(
  order: OnlineTableInfo,
  options: { quickMode: boolean },
): boolean {
  if (options.quickMode) return false;
  return isOnlineDineIn(order) && !hasTableAssigned(order);
}

/**
 * 枱位維度標籤。
 *
 * - 快餐模式 → 「出餐口自取」（唔排位）
 * - 自取 / 外賣 → 「自取」/「外賣」
 * - 已排位 → 枱名（例如 `A01`）
 * - 未排位（堂食模式）→ **「待安排座位」**
 */
export function onlineTableBadge(
  order: OnlineTableInfo,
  options: { quickMode: boolean },
): OnlineBadge {
  if (options.quickMode) return badge(BADGE_SLATE, "出餐口自取");
  if (order.tabType === "pickup") return badge(BADGE_SLATE, "自取");
  if (order.tabType === "self_delivery") return badge(BADGE_SLATE, "外賣");
  if (hasTableAssigned(order)) {
    return badge(BADGE_EMERALD, order.tableName?.trim() || "已排位");
  }
  return badge(BADGE_AMBER, "待安排座位");
}

/**
 * 付款維度標籤。
 *
 * 線上單只有兩條路：
 *   - 線上已付（餘額扣點 / 線上支付）→ **「已結帳（綠）」**
 *   - 到店付款（`in_store`）未收錢 → 「未結帳」
 */
export function onlinePaymentBadge(order: OnlineTableInfo): OnlineBadge {
  const paid = String(order.paymentStatus ?? "").toLowerCase() === "paid";
  if (paid) return badge(BADGE_EMERALD, "已結帳");
  // ⚠️ 文案一定要短：呢粒藥丸出現喺 280px 闊嘅「快捷操作」欄（卡片內淨 ~190px），
  // 「未結帳（到店付款）」9 個字會逼爆卡片 → 出現橫向滾動、按鈕被切（2026-09-12 實案）。
  // 「到店付款」嘅資訊喺列表嘅「支付」欄同查看彈窗已經有，唔使重複。
  return badge(BADGE_SLATE, "未結帳");
}

/** 「排位」掣文案：未排位 = 排位；已排位 = 改枱。 */
export function onlineTableAssignLabel(order: OnlineTableInfo): string {
  return hasTableAssigned(order) ? "改枱" : "排位";
}

/**
 * 呢張枱揀唔揀得。
 *
 * 🔴 商家要求（2026-09-12）：**已經有人坐嘅位一律唔可以揀**（唔係「提示後仍可強制」）。
 * 排位介面係彈窗，已佔用嘅枱要 disable 並顯示「使用中」。
 */
export function isTableSelectable(
  tableId: string,
  occupiedTableIds: readonly string[],
): boolean {
  return !occupiedTableIds.includes(tableId);
}

/**
 * 排位彈窗入面「使用中」嘅枱要唔要標示。
 * （同 `isTableSelectable()` 成對；UI 直接讀呢個做文案。）
 */
export function occupiedTableHint(): string {
  return "使用中";
}
