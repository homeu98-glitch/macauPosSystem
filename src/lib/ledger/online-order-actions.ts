import { hasPendingCancelRequest, LedgerOnlineOrder, paymentModeLabel, rawLedgerStatus } from "@/lib/ledger/order-mapper";

export type OnlineOrderActionKey =
  | "accept"
  | "reject"
  | "start_preparing"
  | "mark_ready"
  | "mark_delivering"
  | "complete"
  | "mark_paid_in_store";

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
  if (hasPendingCancelRequest(order)) return null;

  const raw = rawLedgerStatus(order.status);

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
  if (hasPendingCancelRequest(order)) return [];
  if (rawLedgerStatus(order.status) === "pending") {
    return [{ key: "reject", label: "拒單", tone: "slate", nextStatus: "cancelled", successMessage: "已拒絕訂單。" }];
  }
  return [];
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
