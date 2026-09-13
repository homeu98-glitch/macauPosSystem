import { hasPendingChangeRequest, LedgerOnlineOrder, paymentModeLabel, rawLedgerStatus } from "@/lib/ledger/order-mapper";

export type OnlineOrderActionKey =
  | "accept"
  | "reject"
  | "start_preparing"
  | "mark_ready"
  | "mark_delivering"
  | "complete"
  | "mark_paid_in_store"
  | "approve_change"
  | "reject_change";

export type OnlineOrderActionTone = "orange" | "slate" | "amber" | "emerald" | "violet" | "sky";

export type OnlineOrderAction = {
  key: OnlineOrderActionKey;
  label: string;
  tone: OnlineOrderActionTone;
  nextStatus?: string;
  successMessage?: string;
};

export function ledgerStatusBadgeLabel(status: string, fulfillmentType: string): string {
  const raw = rawLedgerStatus(status);
  if (raw === "pending") return "新單";
  if (raw === "accepted") return "已接單";
  if (raw === "preparing") return "製作中";
  if (raw === "ready") {
    return fulfillmentType === "takeaway" || fulfillmentType === "merchant_delivery" ? "待取餐" : "待取餐";
  }
  if (raw === "delivering") return "配送中";
  if (raw === "cancelled") return "已取消";
  if (raw === "completed") return "已完成";
  return status;
}

export function getPrimaryOnlineOrderAction(order: LedgerOnlineOrder): OnlineOrderAction | null {
  // 有待確認申請（取消／改單）時，先隱藏一般接單／推進狀態按鈕，避免同審核搶操作。
  if (hasPendingChangeRequest(order)) return null;

  const raw = rawLedgerStatus(order.status);

  // 📌 2026-09-13 商家口徑：線上堂食單**排位之後就冇「開始製作 / 待取餐 / 完成」呢批掣** ——
  // 「排位完成＝已開始製作」，排位嗰刻已自動將 Ledger 推去 `completed`
  //（`assignLedgerOrderToTable()` → `syncOnlineDineInCompletion()`）。
  //
  // ⚠️ 呢個守門**唔喺呢度做**，因為 `LedgerOnlineOrder` 冇 `tableId`（枱係 POS 本機概念，
  // Ledger 側唔知）。實際做法係 `quick-online-orders-panel` 嘅 `visibleOrders` 用
  // `transferredLedgerOrderIds(loadOrders())` 過濾 —— 排位後（本地單帶真枱號）嗰張線上單
  // 即刻由線上列表剔走，改由本地堂食單面板管理，所以呢批掣自然唔會出現。
  // 詳見 `docs/online-dinein-table-assign-plan-2026-09-12.md` §11。

  if (raw === "pending") {
    return {
      key: "accept",
      label: order.tabType === "dine_in" ? "接單" : "接單",
      tone: "orange",
    };
  }
  if (raw === "accepted") {
    return {
      key: "start_preparing",
      label: "開始製作",
      tone: "amber",
      nextStatus: "preparing",
      successMessage: "已開始製作。",
    };
  }
  if (raw === "preparing") {
    const label =
      order.tabType === "pickup"
        ? "待取餐"
        : order.fulfillmentType === "merchant_delivery"
          ? "待交付"
          : order.tabType === "dine_in"
            ? "待取餐"
            : "待取餐";
    return {
      key: "mark_ready",
      label,
      tone: "emerald",
      nextStatus: "ready",
      successMessage: label === "待交付" ? "已標記待交付。" : "已標記待取餐。",
    };
  }
  if (raw === "ready" && order.fulfillmentType === "merchant_delivery") {
    return {
      key: "mark_delivering",
      label: "配送中",
      tone: "violet",
      nextStatus: "delivering",
      successMessage: "已標記配送中。",
    };
  }
  if (raw === "ready" || raw === "delivering") {
    return {
      key: "complete",
      label: "完成",
      tone: "emerald",
      nextStatus: "completed",
      successMessage: "訂單已完成。",
    };
  }
  if (
    order.paymentMode === "in_store" &&
    order.paymentStatus === "unpaid" &&
    raw !== "cancelled" &&
    raw !== "completed" &&
    raw !== "pending"
  ) {
    return {
      key: "mark_paid_in_store",
      label: "標記已收款",
      tone: "sky",
      successMessage: "已標記到店付款。",
    };
  }

  return null;
}

export function getSecondaryOnlineOrderActions(order: LedgerOnlineOrder): OnlineOrderAction[] {
  if (hasPendingChangeRequest(order)) return [];
  if (rawLedgerStatus(order.status) === "pending") {
    return [{ key: "reject", label: "拒單", tone: "slate", nextStatus: "cancelled", successMessage: "已拒絕訂單。" }];
  }
  return [];
}

/**
 * 客人已發出取消／改單申請（`change_request_type` = 'cancel' | 'modify'）時，
 * POS 收銀需要能夠「同意」或「拒絕」。這組按鈕取代原本被隱藏的接單／推進狀態。
 *
 * - approve_change：打 Ledger RPC `merchant_resolve_order_change(p_action: "approve")`。
 *   取消 → 訂單 cancelled（餘額沖正）；改單 → 套用新明細。
 * - reject_change：打同一支 RPC 傳 "reject"，狀態不變、申請清空。
 */
export function getChangeRequestActions(order: LedgerOnlineOrder): OnlineOrderAction[] {
  if (!hasPendingChangeRequest(order)) return [];
  const isCancel = String(order.changeRequestType ?? "").toLowerCase() === "cancel";
  return [
    {
      key: "approve_change",
      label: isCancel ? "同意取消" : "同意修改",
      tone: "slate",
      successMessage: isCancel ? "已同意客人取消，訂單已取消。" : "已同意客人修改，已套用新明細。",
    },
    {
      key: "reject_change",
      label: "拒絕",
      tone: "violet",
      successMessage: "已拒絕申請，訂單繼續處理。",
    },
  ];
}

export function onlineOrderActionButtonClass(tone: OnlineOrderActionTone, compact = false): string {
  const size = compact ? "rounded-xl px-2.5 py-1.5 text-[11px]" : "rounded-xl px-3 py-2 text-xs";
  const colors: Record<OnlineOrderActionTone, string> = {
    orange: "bg-orange-500 text-white",
    slate: "bg-slate-200 text-slate-800",
    amber: "bg-amber-600 text-white",
    emerald: "bg-emerald-600 text-white",
    violet: "bg-violet-600 text-white",
    sky: "bg-sky-600 text-white",
  };
  return `${size} font-semibold disabled:opacity-60 ${colors[tone]}`;
}

export function isActiveOnlineOrder(order: LedgerOnlineOrder): boolean {
  const raw = rawLedgerStatus(order.status);
  return raw !== "cancelled" && raw !== "completed";
}

export function paymentSummaryLabel(order: LedgerOnlineOrder, currency: string): string {
  if (order.paymentStatus === "paid") {
    return `已支付 ${currency} ${order.paidAmount.toFixed(0)}`;
  }
  return paymentModeLabel(order.paymentMode) ?? "未支付";
}
