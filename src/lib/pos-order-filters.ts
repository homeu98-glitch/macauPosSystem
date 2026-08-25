import { PosOrder } from "@/lib/types";
import { quickCompletionLabel } from "@/lib/quick-order-fulfillment";

export function isLocalPosOrder(order: PosOrder): boolean {
  return !order.onlineOrderId;
}

/**
 * 本地面板可見範圍：本地單 + 「已轉到堂食枱」嘅線上堂食單。
 * 純線上快餐 / 自取 / 外賣（counter / 無枱）屬上游 Ledger 對賬，唔喺本地面板管理，亦唔可以返結。
 * 美容同其他本地單無 onlineOrderId，一律當本地單。
 */
export function isLocalOrTransferredDineIn(order: PosOrder): boolean {
  if (!order.onlineOrderId) return true; // 本地單
  // 線上堂食單，已轉到枱（tableId 唔係 counter）→ 當本地單管理
  return !!order.tableId && order.tableId !== "counter";
}

/** 快餐 counter 單（先收款、後出餐流程） */
export function isQuickCounterOrder(order: PosOrder): boolean {
  return isLocalPosOrder(order) && order.tableId === "counter";
}

export function orderTimestamp(order: PosOrder): number {
  return Date.parse(order.updatedAt || order.createdAt || "") || 0;
}

/**
 * 合併多份訂單列表，同 id 保留 updatedAt 較新者（防止雲端拉取覆蓋本機剛寫入的單）。
 *
 * B4（docs/56）：`localOrderNo` 係單號嘅本地真源（下單嗰陣由 server 序號或本地每日序號 stamped）。
 * realtime / backfill 合併時，若 server 版嘅 `localOrderNo` 同本機版唔同（例如 server 用緊
 * `row.id` fallback、本機用緊真正序號），唔可以讓 server 版覆寫本機版，否則 UI 同打印單會對唔上
 * （見「訂單8 vs 訂單84」bug）。所以當以 server 版取代本機版時，優先保留本機 `localOrderNo`。
 */
export function mergeOrderLists(...sources: PosOrder[][]): PosOrder[] {
  const byId = new Map<string, PosOrder>();
  for (const list of sources) {
    for (const order of list) {
      const existing = byId.get(order.id);
      if (!existing || orderTimestamp(order) >= orderTimestamp(existing)) {
        // 以 server 版（較新）取代本機版時，保留本機 localOrderNo（B4）。
        const merged =
          existing && existing.localOrderNo && existing.localOrderNo !== order.localOrderNo
            ? { ...order, localOrderNo: existing.localOrderNo }
            : order;
        byId.set(order.id, merged);
      }
    }
  }
  return Array.from(byId.values()).sort((a, b) => orderTimestamp(b) - orderTimestamp(a));
}

export function isWithinLastMinutes(order: PosOrder, minutes: number, nowMs = Date.now()): boolean {
  const ts = orderTimestamp(order);
  if (!ts) return false;
  return ts >= nowMs - minutes * 60 * 1000;
}

function isTerminalLocalOrder(order: PosOrder): boolean {
  return (
    order.status === "cancelled" ||
    order.status === "refunded" ||
    order.status === "partially_refunded" ||
    order.status === "settled"
  );
}

/** 匯出：終態訂單狀態（已取消 / 已退款 / 部分退款 / 已完成）。backfill / realtime 合併時，
 * 伺服器單邊嘅終態單唔可以復活入活躍工作列表（見 docs/52）。 */
export function isTerminalOrderStatus(status: string | undefined): boolean {
  return (
    status === "cancelled" ||
    status === "refunded" ||
    status === "partially_refunded" ||
    status === "settled"
  );
}

/**
 * backfill / realtime 合併後嘅「防復活」過濾（見 docs/52）：
 *  - 本機已真刪除嘅訂單（deletedOrderIds tombstone）一律唔顯示；
 *  - 伺服器單邊嘅終態單（cancelled / refunded / partially_refunded / settled）唔可以復活入活躍列表，
 *    除非本機 localStorage 已經有佢（留返本地對賬 tab 睇）。
 * localOrders = 本地持久化 store（loadOrders()），用嚟判斷「本機已有」。
 */
export function filterResurrectedOrders(
  orders: PosOrder[],
  deletedOrderIds: string[],
  localOrders: PosOrder[],
): PosOrder[] {
  const deleted = new Set(deletedOrderIds);
  const localIds = new Set(localOrders.map((o) => o.id));
  return orders.filter(
    (o) => !deleted.has(o.id) && !(isTerminalOrderStatus(o.status) && !localIds.has(o.id)),
  );
}

/** 快餐點餐頁底部：所有未完成的 counter 單（不限時間） */
export function isActionableQuickOrder(order: PosOrder): boolean {
  if (!isQuickCounterOrder(order)) return false;
  if (isTerminalLocalOrder(order)) return false;
  if (order.status === "paid" && order.fulfillmentStatus === "ready") return true;
  return order.status === "draft" || order.status === "sent_to_kitchen" || order.status === "paid";
}

export function filterQuickActionBarOrders(orders: PosOrder[]): PosOrder[] {
  return orders.filter(isActionableQuickOrder).sort((a, b) => orderTimestamp(b) - orderTimestamp(a));
}

export function localOrderStatusLabel(order: PosOrder): string {
  if (isQuickCounterOrder(order)) {
    if (order.status === "paid" && order.fulfillmentStatus === "ready") {
      return quickCompletionLabel(order);
    }
    if (order.status === "paid" || order.status === "sent_to_kitchen") return "製作中";
  }
  if (order.status === "draft") return "點單中";
  if (order.status === "sent_to_kitchen") return "製作中";
  if (order.status === "paid" && order.fulfillmentStatus === "ready") return "待取餐";
  if (order.status === "paid") return "已付款";
  if (order.status === "settled") return "已完成";
  if (order.status === "reopened") return "已返結";
  if (order.status === "cancelled") return "已取消";
  if (order.status === "refunded" || order.status === "partially_refunded") return "已退款";
  return order.status;
}

/**
 * 訂單狀態標籤嘅視覺 token（label + Tailwind classes），統一顏色編碼方便商家一眼辨識。
 * 用法：
 *   const b = getOrderStatusBadge(order);
 *   <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${b.bgClass} ${b.textClass}`}>{b.label}</span>
 * 配色：草稿=slate、製作中=amber、已付=blue、待取餐=sky/cyan、已完成=emerald、已取消=slate-300、
 *      已退款=red、部分退款=orange、已返結=indigo。
 */
export interface OrderStatusBadge {
  label: string;
  bgClass: string;
  textClass: string;
  dotClass: string;
}

export function getOrderStatusBadge(order: PosOrder): OrderStatusBadge {
  // 快餐 counter：paid+ready=待取餐；paid 期間=製作中（待廚出餐）
  if (isQuickCounterOrder(order)) {
    if (order.status === "settled") {
      return { label: "已完成", bgClass: "bg-emerald-50", textClass: "text-emerald-700", dotClass: "bg-emerald-500" };
    }
    if (order.status === "paid" && order.fulfillmentStatus === "ready") {
      return { label: quickCompletionLabel(order), bgClass: "bg-sky-50", textClass: "text-sky-700", dotClass: "bg-sky-500" };
    }
    if (order.status === "paid" || order.status === "sent_to_kitchen") {
      return { label: "製作中", bgClass: "bg-amber-50", textClass: "text-amber-700", dotClass: "bg-amber-500" };
    }
  }
  switch (order.status) {
    case "draft":
      return { label: "點單中", bgClass: "bg-slate-100", textClass: "text-slate-700", dotClass: "bg-slate-500" };
    case "sent_to_kitchen":
      return { label: "製作中", bgClass: "bg-amber-50", textClass: "text-amber-700", dotClass: "bg-amber-500" };
    case "paid":
      if (order.fulfillmentStatus === "ready") {
        return { label: "待取餐", bgClass: "bg-sky-50", textClass: "text-sky-700", dotClass: "bg-sky-500" };
      }
      return { label: "已付款", bgClass: "bg-blue-50", textClass: "text-blue-700", dotClass: "bg-blue-500" };
    case "settled":
      return { label: "已完成", bgClass: "bg-emerald-50", textClass: "text-emerald-700", dotClass: "bg-emerald-500" };
    case "cancelled":
      return { label: "已取消", bgClass: "bg-slate-200", textClass: "text-slate-600", dotClass: "bg-slate-400" };
    case "refunded":
      return { label: "已退款", bgClass: "bg-red-50", textClass: "text-red-700", dotClass: "bg-red-500" };
    case "partially_refunded":
      return { label: "部分退款", bgClass: "bg-orange-50", textClass: "text-orange-700", dotClass: "bg-orange-500" };
    case "reopened":
      return { label: "已返結", bgClass: "bg-indigo-50", textClass: "text-indigo-700", dotClass: "bg-indigo-500" };
    default:
      return { label: String(order.status), bgClass: "bg-slate-100", textClass: "text-slate-700", dotClass: "bg-slate-500" };
  }
}

export type LocalOrderPanelTab = "all" | "preparing" | "ready" | "settled" | "reopened" | "cancelled";

export function matchesLocalOrderPanelTab(order: PosOrder, tab: LocalOrderPanelTab): boolean {
  if (tab === "all") return true;
  if (tab === "settled") return order.status === "settled";
  if (tab === "reopened") return order.status === "reopened";
  if (tab === "cancelled") {
    return order.status === "cancelled" || order.status === "refunded" || order.status === "partially_refunded";
  }
  if (tab === "ready") {
    return isQuickCounterOrder(order) && order.status === "paid" && order.fulfillmentStatus === "ready";
  }
  if (tab === "preparing") {
    if (isQuickCounterOrder(order)) {
      return (
        order.status === "draft" ||
        order.status === "sent_to_kitchen" ||
        (order.status === "paid" && order.fulfillmentStatus !== "ready")
      );
    }
    return order.status === "draft" || order.status === "sent_to_kitchen";
  }
  return true;
}
