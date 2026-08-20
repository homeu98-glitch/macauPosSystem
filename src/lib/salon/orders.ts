"use client";

import { applyMockLedgerDelta } from "@/lib/salon/mock-ledger";
import { dispatchSalonReopenTicket } from "@/lib/salon/print";
import {
  loadSalonBootstrap,
  loadSalonCustomerPackages,
  loadSalonOrders,
  loadBookings,
  loadCustomers,
  saveCustomers,
  saveSalonCustomerPackages,
  saveSalonOrders,
} from "@/lib/salon/storage";
import { updateMockBooking } from "@/lib/salon/mock-realtime";
import { SalonBooking, SalonPosOrder } from "@/lib/salon/types";

/** 可返結：預約 settled 且存在 settled 單。refunded / cancelled 禁止。 */
export function isSalonReopenable(booking: SalonBooking | null, order: SalonPosOrder | null): boolean {
  return (
    !!booking &&
    booking.status === "settled" &&
    !!order &&
    order.status === "settled"
  );
}

export type SalonReopenResult = {
  ok: boolean;
  error?: string;
  /** 會員餘額 / 積分是否成功反向回滾（best-effort） */
  ledgerReversed?: boolean;
  ledgerReverseError?: string;
};

/** 把套票扣次加返對應套票卡的 remaining（返結反向回滾）。 */
function revertPackageDeductions(
  entries: NonNullable<SalonPosOrder["packageDeductionEntries"]>,
) {
  if (entries.length === 0) return;
  const all = loadSalonCustomerPackages();
  const byId = new Map(all.map((p) => [p.id, p]));
  for (const e of entries) {
    const pkg = byId.get(e.planId);
    if (!pkg) continue;
    pkg.remaining = pkg.remaining.map((r) =>
      r.serviceItemId === e.serviceItemId
        ? { ...r, sessionsLeft: r.sessionsLeft + e.sessionsUsed }
        : r,
    );
    let anyLeft = false;
    for (const r of pkg.remaining) if (r.sessionsLeft > 0) anyLeft = true;
    if (anyLeft && pkg.status === "used_up") pkg.status = "active";
  }
  saveSalonCustomerPackages(all);
}

/**
 * 美容返結（反結賬）：把已結預約退回可編輯狀態。
 *
 * 1. 強制原因（reason 不可空白）。
 * 2. 反向回滾會員餘額 / 兌換積分 / 消費賺分 / 推薦獎勵（best-effort，本地 mock）。
 * 3. 反向回滾套票扣次。
 * 4. 訂單切 `reopened` + 寫審計；預約改回 `completed`（可重新編輯結帳）。
 * 5. 印「返結單」到 salon 隔離列印佇列。
 *
 * 重結由 checkout 頁針對同一 booking.orderId 重新落單結帳（就地更新 order，勿新增）。
 */
export function reopenSalonOrder(params: {
  bookingId: string;
  reason: string;
  operator: string;
}): SalonReopenResult {
  const reason = (params.reason ?? "").trim();
  if (!reason) return { ok: false, error: "必須揀返結原因" };

  const bookings = loadBookings();
  const booking = bookings.find((b) => b.id === params.bookingId);
  if (!booking) return { ok: false, error: "找不到預約" };
  if (booking.status !== "settled") return { ok: false, error: "此預約狀態不可返結" };

  const orders = loadSalonOrders();
  const order = orders
    .filter((o) => o.bookingId === params.bookingId && o.status === "settled")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (!order) return { ok: false, error: "找不到已結帳單" };

  const phone = (order.customerPhone || booking.customerPhone || "").replace(/\D/g, "");

  // ① 反向回滾會員 Ledger（best-effort）
  let ledgerReversed = false;
  let ledgerReverseError: string | undefined;
  try {
    if (order.ledgerPaymentAmount && order.ledgerPaymentAmount > 0 && phone) {
      applyMockLedgerDelta(phone, { balanceDelta: order.ledgerPaymentAmount });
    }
    if (order.pointsRedeemed && order.pointsRedeemed > 0 && phone) {
      applyMockLedgerDelta(phone, { pointsDelta: order.pointsRedeemed });
    }
    if (order.pointsEarned && order.pointsEarned > 0 && phone) {
      applyMockLedgerDelta(phone, { pointsDelta: -order.pointsEarned });
    }
    // 推薦獎勵回滾：扣返推薦人積分並重置標記，重結時可再發（避免雙倍）
    const customers = loadCustomers();
    const cust = customers.find(
      (c) => c.id === order.customerId || c.phone === order.customerPhone,
    );
    if (cust?.referrerId) {
      const loyalty = loadSalonBootstrap()?.loyalty;
      if (loyalty?.referralEnabled && loyalty.referralPoints > 0) {
        applyMockLedgerDelta(cust.referrerId, { pointsDelta: -loyalty.referralPoints });
      }
      const next = customers.map((c) =>
        c.id === cust.id ? { ...c, referralRewarded: false } : c,
      );
      saveCustomers(next);
    }
    ledgerReversed = true;
  } catch (err) {
    ledgerReverseError = err instanceof Error ? err.message : String(err);
  }

  // ② 反向回滾套票扣次
  if (order.packageDeductionEntries && order.packageDeductionEntries.length > 0) {
    revertPackageDeductions(order.packageDeductionEntries);
  }

  // ③ 訂單切 reopened + 審計
  const now = new Date().toISOString();
  const updatedOrder: SalonPosOrder = {
    ...order,
    status: "reopened",
    reopenedAt: now,
    reopenedBy: params.operator,
    reopenReason: reason,
    reopenCount: (order.reopenCount ?? 0) + 1,
    originalSettledAt: order.originalSettledAt ?? order.settledAt ?? order.updatedAt,
    updatedAt: now,
  };
  saveSalonOrders(orders.map((o) => (o.id === updatedOrder.id ? updatedOrder : o)));

  // ④ 預約改回 completed（可重新編輯結帳）
  updateMockBooking(booking.id, { status: "completed" });

  // ⑤ 印返結單
  try {
    void dispatchSalonReopenTicket(updatedOrder, reason, params.operator);
  } catch {
    // 列印失敗不阻塞返結
  }

  return { ok: true, ledgerReversed, ledgerReverseError };
}
