"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type {
  SalonBooking,
  SalonPosOrder,
  SalonOrderItem,
  SalonTip,
  SalonPayment,
  SalonPaymentMethod,
  SalonStaff,
  SalonCustomerPackage,
} from "@/lib/salon/types";
import {
  loadBookings,
  loadSalonOrders,
  saveSalonOrders,
  loadSalonBootstrap,
  loadSalonCustomerPackages,
  saveSalonCustomerPackages,
} from "@/lib/salon/storage";
import { updateMockBooking, MOCK_REALTIME_EVENT } from "@/lib/salon/mock-realtime";
import { getMockLedgerMember, applyMockLedgerPayment } from "@/lib/salon/mock-ledger";
import { dispatchSalonReceipt } from "@/lib/salon/print";
import { playSuccessBeep } from "@/lib/salon/sound";

function uid(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

function genOrderNo(): string {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `S${ymd}-${rand}`;
}

function money(n: number): string {
  return `MOP ${n.toFixed(0)}`;
}

interface PaymentRow {
  id: string;
  method: SalonPaymentMethod;
  amount: number;
}

interface TipRow {
  staffId: string;
  staffName: string;
  amount: number;
}

// 套票抵扣：每一筆記錄「哪項服務 / 哪張套票卡 / 抵扣多少」
interface SalonPackageDeduction {
  serviceItemId: string;
  serviceName: string;
  packageId: string;
  packageName: string;
  amount: number;
}

/**
 * 結帳時把套票抵扣寫回客戶套票卡：扣減對應 remaining 次數，
 * 若某張卡全部次數歸零則 status 置 "used_up"。走 saveSalonCustomerPackages（sync 上雲）。
 * plan 內每條 (packageId, serviceItemId) 唯一，至多扣 1 次。
 */
function applyCustomerPackageDeductions(plan: SalonPackageDeduction[]) {
  if (plan.length === 0) return;
  const all = loadSalonCustomerPackages();
  const byId = new Map(all.map((p) => [p.id, p]));
  for (const d of plan) {
    const pkg = byId.get(d.packageId);
    if (!pkg) continue;
    let allZero = true;
    pkg.remaining = pkg.remaining.map((r) => {
      if (r.serviceItemId === d.serviceItemId && r.sessionsLeft > 0) {
        return { ...r, sessionsLeft: r.sessionsLeft - 1 };
      }
      return r;
    });
    for (const r of pkg.remaining) if (r.sessionsLeft > 0) allZero = false;
    if (allZero) pkg.status = "used_up";
  }
  saveSalonCustomerPackages(all);
}

const PAYMENT_LABELS: Record<SalonPaymentMethod, string> = {
  cash: "現金",
  card: "信用卡 / 移動支付",
  ledger_balance: "Ledger 會員餘額",
  external: "外部平台",
};

const DISCOUNT_QUICK: Array<{ label: string; rate: number }> = [
  { label: "9 折", rate: 0.9 },
  { label: "85 折", rate: 0.85 },
  { label: "8 折", rate: 0.8 },
];

export function Checkout({ bookingId }: { bookingId: string }) {
  const router = useRouter();

  const [booking, setBooking] = useState<SalonBooking | null>(null);
  const [staffList, setStaffList] = useState<SalonStaff[]>([]);
  const [currency, setCurrency] = useState("MOP");
  const [notFound, setNotFound] = useState(false);
  const [settleError, setSettleError] = useState("");
  const [settled, setSettled] = useState(false);
  const [settledOrderNo, setSettledOrderNo] = useState("");

  const [discountAmount, setDiscountAmount] = useState(0);
  const [tips, setTips] = useState<TipRow[]>([]);
  const [tipPool, setTipPool] = useState(0);
  const [payments, setPayments] = useState<PaymentRow[]>([]);

  // 套票抵扣（P2）：已套用的抵扣計劃；空陣 = 未套用
  const [packagePlan, setPackagePlan] = useState<SalonPackageDeduction[]>([]);

  useEffect(() => {
    const b = loadBookings().find((x) => x.id === bookingId);
    if (!b) {
      setNotFound(true);
      return;
    }
    setBooking(b);

    const bootstrap = loadSalonBootstrap();
    if (bootstrap) {
      setStaffList(bootstrap.staff);
      setCurrency(bootstrap.currency || "MOP");
      // 依預約服務的執行技師初始化小費列（預設 0，可平分 / 手調）
      const seen = new Map<string, string>();
      for (const s of b.services) {
        const staff = bootstrap.staff.find((st) => st.id === s.staffId);
        const name = staff?.nickname ?? staff?.name ?? "未知技師";
        if (!seen.has(s.staffId)) seen.set(s.staffId, name);
      }
      setTips(
        Array.from(seen.entries()).map(([staffId, staffName]) => ({
          staffId,
          staffName,
          amount: 0,
        })),
      );
    }
  }, [bookingId]);

  const staffMap = useMemo(() => {
    const map: Record<string, SalonStaff> = {};
    for (const s of staffList) map[s.id] = s;
    return map;
  }, [staffList]);

  const ledgerMember = useMemo(() => {
    if (!booking) return null;
    return getMockLedgerMember(booking.customerPhone);
  }, [booking]);

  // ── 套票抵扣（P2）──
  // 客戶持有的 active 套票卡（未過期）；無綁定客戶則空陣
  const activePackages = useMemo<SalonCustomerPackage[]>(() => {
    if (!booking?.customerId) return [];
    const now = Date.now();
    return loadSalonCustomerPackages().filter(
      (p) =>
        p.customerId === booking.customerId &&
        p.status === "active" &&
        !(p.expiresAt && new Date(p.expiresAt).getTime() < now),
    );
  }, [booking]);

  // 自動匹配：對每個 booking 服務項，找一張仍有餘次的套票卡扣 1 次；
  // 不夠次數的服務自然不會被抵扣，留待現金 / Ledger 結算。
  const computePlan = useCallback((): SalonPackageDeduction[] => {
    if (!booking) return [];
    const work = new Map<string, Map<string, number>>();
    for (const p of activePackages) {
      const m = new Map<string, number>();
      for (const r of p.remaining) m.set(r.serviceItemId, r.sessionsLeft);
      work.set(p.id, m);
    }
    const plan: SalonPackageDeduction[] = [];
    for (const s of booking.services) {
      for (const p of activePackages) {
        const m = work.get(p.id);
        if (!m) continue;
        const left = m.get(s.serviceItemId) ?? 0;
        if (left > 0) {
          m.set(s.serviceItemId, left - 1);
          plan.push({
            serviceItemId: s.serviceItemId,
            serviceName: s.name,
            packageId: p.id,
            packageName: p.templateName,
            amount: s.price,
          });
          break;
        }
      }
    }
    return plan;
  }, [booking, activePackages]);

  const applyPackage = useCallback(() => {
    setPackagePlan(computePlan());
  }, [computePlan]);

  const cancelPackage = useCallback(() => {
    setPackagePlan([]);
  }, []);

  // 未套用時的預覽（可抵扣多少）；套用後以 packagePlan 為準
  const previewPlan = useMemo(
    () => (packagePlan.length > 0 ? [] : computePlan()),
    [packagePlan, computePlan],
  );
  const previewAmount = previewPlan.reduce((sum, d) => sum + d.amount, 0);
  const deductedAmount = packagePlan.reduce((sum, d) => sum + d.amount, 0);

  // ── 計算 ──
  const subtotal = useMemo(
    () => (booking ? booking.services.reduce((sum, s) => sum + s.price, 0) : 0),
    [booking],
  );
  const afterDiscount = Math.max(0, subtotal - discountAmount);
  const depositApplied = useMemo(() => {
    if (!booking) return 0;
    return booking.depositPaid ? booking.depositAmount ?? 0 : 0;
  }, [booking]);
  const tipTotal = tips.reduce((sum, t) => sum + (t.amount || 0), 0);
  const grandTotal = Math.max(0, afterDiscount + tipTotal - depositApplied - deductedAmount);
  const paidTotal = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  const changeDue = paidTotal > grandTotal ? paidTotal - grandTotal : 0;
  const remaining = Math.max(0, grandTotal - paidTotal);

  const ledgerPaymentAmount = payments
    .filter((p) => p.method === "ledger_balance")
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  const ledgerAvailable = ledgerMember?.ledgerBalance ?? 0;

  const canSettle =
    booking !== null &&
    booking.status !== "settled" &&
    grandTotal >= 0 &&
    remaining <= 0.001 &&
    ledgerPaymentAmount <= ledgerAvailable + 0.001;

  // ── 小費操作 ──
  const splitTipsEvenly = useCallback(() => {
    if (tips.length === 0) return;
    const pool = Math.max(0, Math.round(tipPool));
    const base = Math.floor(pool / tips.length);
    setTips((prev) =>
      prev.map((t, idx) => ({
        ...t,
        amount: idx === prev.length - 1 ? pool - base * (prev.length - 1) : base,
      })),
    );
  }, [tips.length, tipPool]);

  const clearTips = useCallback(() => {
    setTipPool(0);
    setTips((prev) => prev.map((t) => ({ ...t, amount: 0 })));
  }, []);

  const updateTipAmount = useCallback((staffId: string, amount: number) => {
    setTips((prev) => prev.map((t) => (t.staffId === staffId ? { ...t, amount } : t)));
  }, []);

  // ── 付款操作 ──
  const addPayment = useCallback(() => {
    setPayments((prev) => [
      ...prev,
      { id: uid("pay"), method: "cash", amount: 0 },
    ]);
  }, []);

  const updatePayment = useCallback((id: string, patch: Partial<PaymentRow>) => {
    setPayments((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const removePayment = useCallback((id: string) => {
    setPayments((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // ── 折扣快速鍵 ──
  const applyDiscountRate = useCallback(
    (rate: number) => {
      setDiscountAmount(Math.round(subtotal * (1 - rate)));
    },
    [subtotal],
  );

  // ── 結帳 ──
  const handleSettle = useCallback(async () => {
    setSettleError("");
    if (!booking || !canSettle) {
      setSettleError("付款金額不足或資料不完整，無法結帳。");
      return;
    }

    // 1) 先扣 Ledger 餘額（若有用餘額付款），不足即中止並保留訂單
    if (ledgerPaymentAmount > 0) {
      const res = applyMockLedgerPayment(booking.customerPhone, ledgerPaymentAmount);
      if (!res.ok) {
        setSettleError(res.error ?? "Ledger 扣款失敗");
        return;
      }
    }

    const now = new Date().toISOString();
    const orderId = uid("order");
    const orderNo = genOrderNo();

    // 標記被套票抵扣的服務項（同 serviceItemId 可能多行，依 plan 數量遞減）
    const coverLeft = new Map<string, number>();
    for (const d of packagePlan) {
      coverLeft.set(d.serviceItemId, (coverLeft.get(d.serviceItemId) ?? 0) + 1);
    }

    const items: SalonOrderItem[] = booking.services.map((s) => {
      const left = coverLeft.get(s.serviceItemId) ?? 0;
      const covered = left > 0;
      if (covered) coverLeft.set(s.serviceItemId, left - 1);
      return {
        kind: "service",
        itemId: s.serviceItemId,
        name: s.name,
        quantity: 1,
        unitPrice: s.price,
        staffId: s.staffId,
        staffName: staffMap[s.staffId]?.nickname ?? staffMap[s.staffId]?.name ?? "",
        note: covered ? "套票抵扣" : undefined,
      };
    });

    const tipRecords: SalonTip[] = tips
      .filter((t) => (t.amount || 0) > 0)
      .map((t) => ({
        staffId: t.staffId,
        staffName: t.staffName,
        amount: t.amount,
        method: "cash",
      }));

    const paymentRecords: SalonPayment[] = payments
      .filter((p) => (p.amount || 0) > 0)
      .map((p) => ({
        method: p.method,
        amount: p.amount,
        createdAt: now,
      }));

    const order: SalonPosOrder = {
      id: orderId,
      orderNo,
      bookingId: booking.id,
      customerId: booking.customerId,
      customerName: booking.customerName,
      customerPhone: booking.customerPhone,
      staffId: booking.staffId,
      stationId: booking.stationId,
      items,
      subtotal,
      discountAmount,
      packageDeduction: deductedAmount > 0 ? deductedAmount : undefined,
      total: afterDiscount,
      tips: tipRecords,
      tipTotal,
      grandTotal,
      payments: paymentRecords,
      depositApplied: depositApplied > 0 ? depositApplied : undefined,
      changeDue: changeDue > 0 ? changeDue : undefined,
      status: "settled",
      settledAt: now,
      createdAt: now,
      updatedAt: now,
    };

    // 2) 存訂單 + 套票扣次 + 更新預約狀態為 settled
    try {
      saveSalonOrders([...loadSalonOrders(), order]);
      // 套票抵扣：訂單存妥後才寫回客戶套票卡次數（避免訂單失敗卻已扣次）
      applyCustomerPackageDeductions(packagePlan);
    } catch {
      setSettleError("儲存訂單失敗，請重試。");
      return;
    }
    updateMockBooking(booking.id, { status: "settled", orderId });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(MOCK_REALTIME_EVENT, { detail: { source: "checkout" } }));
    }

    // 3) 列印收據（寫入 salon 隔離佇列 + dispatch）
    try {
      await dispatchSalonReceipt(order);
    } catch {
      // 列印失敗不阻塞結帳；收據已入佇列，可於「打印」頁重試
    }

    setSettledOrderNo(orderNo);
    setSettled(true);
    playSuccessBeep();
  }, [
    booking,
    canSettle,
    ledgerPaymentAmount,
    tips,
    payments,
    subtotal,
    discountAmount,
    afterDiscount,
    tipTotal,
    grandTotal,
    depositApplied,
    changeDue,
    deductedAmount,
    packagePlan,
    staffMap,
  ]);

  const reprintReceipt = useCallback(async () => {
    setSettleError("");
    const orders = loadSalonOrders();
    const order = orders.find((o) => o.orderNo === settledOrderNo);
    if (!order) return;
    try {
      await dispatchSalonReceipt(order);
    } catch {
      setSettleError("重印失敗，請到「打印」頁重試。");
    }
  }, [settledOrderNo]);

  // ── 渲染 ──
  if (notFound) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center md:pl-[72px]">
        <div>
          <div className="text-base font-semibold text-slate-900">找不到預約</div>
          <div className="mt-2 text-sm text-slate-500">
            預約 ID <code>{bookingId}</code> 不存在或已被刪除。
          </div>
          <Link
            href="/salon"
            className="mt-4 inline-block rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600"
          >
            回工作台
          </Link>
        </div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center md:pl-[72px]">
        <div className="text-base font-semibold text-slate-900">載入中…</div>
      </div>
    );
  }

  // 已結帳
  if (booking.status === "settled" && !settled) {
    return (
      <div className="min-h-screen bg-slate-100 text-slate-900 md:pl-[72px]">
        <div className="mx-auto max-w-4xl px-4 py-10 pb-24 md:pb-10">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="text-lg font-bold text-emerald-600">此預約已結帳</div>
            <div className="mt-2 text-sm text-slate-500">
              {booking.customerName} · {booking.bookingNo}
            </div>
            <Link
              href="/salon"
              className="mt-6 inline-block rounded-xl bg-rose-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-600"
            >
              回工作台
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // 結帳成功
  if (settled) {
    return (
      <div className="min-h-screen bg-slate-100 text-slate-900 md:pl-[72px]">
        <div className="mx-auto max-w-4xl px-4 py-10 pb-24 md:pb-10">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="text-2xl font-bold text-emerald-600">結帳完成</div>
            <div className="mt-2 text-sm text-slate-500">收據單號 {settledOrderNo}</div>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={reprintReceipt}
                className="rounded-xl bg-slate-100 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-200"
              >
                再列印收據
              </button>
              <Link
                href="/salon"
                className="rounded-xl bg-rose-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-rose-600"
              >
                回工作台
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 md:pl-[72px]">
      <div className="mx-auto max-w-4xl px-4 py-6 pb-24 md:pb-6">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-2xl font-bold text-slate-900">{booking.customerName}</div>
            <div className="mt-1 text-sm text-slate-500">
              {booking.customerPhone} · {booking.bookingNo}
            </div>
          </div>
          {ledgerMember && (
            <div className="rounded-xl bg-amber-50 px-3 py-2 text-right text-xs text-amber-800">
              <div className="font-semibold">{ledgerMember.ledgerTier}</div>
              <div>餘額 {money(ledgerMember.ledgerBalance)}</div>
              <div>積分 {ledgerMember.ledgerPoints}</div>
            </div>
          )}
        </div>

        {/* 服務項目 */}
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-bold text-slate-900">服務項目</h3>
          <div className="grid gap-2">
            {booking.services.map((s, idx) => (
              <div key={idx} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{s.name}</div>
                  <div className="text-xs text-slate-500">
                    技師：{staffMap[s.staffId]?.nickname ?? staffMap[s.staffId]?.name ?? "未知"}
                  </div>
                </div>
                <div className="text-sm font-semibold text-slate-700">{money(s.price)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 折扣 */}
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">折扣</h3>
            <div className="flex gap-1.5">
              {DISCOUNT_QUICK.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  onClick={() => applyDiscountRate(d.rate)}
                  className="rounded-lg bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-100"
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">減免金額</span>
            <input
              type="number"
              min={0}
              value={discountAmount}
              onChange={(e) => setDiscountAmount(Math.max(0, Number(e.target.value) || 0))}
              className="w-32 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
            />
            <span className="text-sm text-slate-400">{currency}</span>
          </div>
        </div>

        {/* 套票抵扣（P2）：自動匹配客戶 active 套票次數抵扣本單服務 */}
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-bold text-slate-900">套票抵扣</h3>
          {!booking.customerId ? (
            <div className="text-xs text-slate-400">
              本預約未綁定客戶，套票抵扣需於預約關聯客戶後使用。
            </div>
          ) : activePackages.length === 0 ? (
            <div className="text-xs text-slate-400">
              此客戶無可用套票（無 active 套票或已用完 / 過期）。
            </div>
          ) : packagePlan.length > 0 ? (
            <div className="grid gap-2">
              {packagePlan.map((d, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-xl bg-emerald-50 px-3 py-2 text-sm"
                >
                  <span className="text-slate-700">{d.serviceName}</span>
                  <span className="text-xs text-emerald-700">
                    以「{d.packageName}」抵扣 {money(d.amount)}
                  </span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-1">
                <span className="text-sm font-semibold text-slate-800">
                  已抵扣合計 {money(deductedAmount)}
                </span>
                <button
                  type="button"
                  onClick={cancelPackage}
                  className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200"
                >
                  取消抵扣
                </button>
              </div>
            </div>
          ) : previewAmount > 0 ? (
            <div className="grid gap-2">
              {previewPlan.map((d, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm"
                >
                  <span className="text-slate-700">{d.serviceName}</span>
                  <span className="text-xs text-slate-500">
                    可用「{d.packageName}」{money(d.amount)}
                  </span>
                </div>
              ))}
              <button
                type="button"
                onClick={applyPackage}
                className="mt-1 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-600"
              >
                套用套票抵扣（省 {money(previewAmount)}）
              </button>
              {booking.services.some(
                (s) => !previewPlan.some((d) => d.serviceItemId === s.serviceItemId),
              ) && (
                <div className="text-[11px] text-slate-400">
                  其餘服務無套票次數，將以現金 / Ledger 結算。
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-400">
              本單服務項目無符合套票（套票內含服務與本單不符）。
            </div>
          )}
        </div>

        {/* 小費（多技師平分） */}
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">小費（按技師）</h3>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={splitTipsEvenly}
                disabled={tips.length === 0}
                className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-40"
              >
                平分
              </button>
              <button
                type="button"
                onClick={clearTips}
                disabled={tips.length === 0}
                className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-40"
              >
                清零
              </button>
            </div>
          </div>
          {tips.length === 0 ? (
            <div className="text-xs text-slate-400">此預約無指定技師，無需分拆小費。</div>
          ) : (
            <div className="grid gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">小費總池</span>
                <input
                  type="number"
                  min={0}
                  value={tipPool}
                  onChange={(e) => setTipPool(Math.max(0, Number(e.target.value) || 0))}
                  className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                />
                <button
                  type="button"
                  onClick={splitTipsEvenly}
                  className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-100"
                >
                  分配到各技師
                </button>
              </div>
              {tips.map((t) => (
                <div key={t.staffId} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
                  <span className="text-sm text-slate-700">{t.staffName}</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      value={t.amount}
                      onChange={(e) => updateTipAmount(t.staffId, Math.max(0, Number(e.target.value) || 0))}
                      className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-right outline-none focus:ring-2 focus:ring-rose-200"
                    />
                    <span className="text-xs text-slate-400">{currency}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 付款方式 */}
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">付款方式</h3>
            <button
              type="button"
              onClick={addPayment}
              className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-200"
            >
              + 新增
            </button>
          </div>
          {payments.length === 0 ? (
            <div className="text-xs text-slate-400">尚未新增付款，請選擇付款方式並輸入金額。</div>
          ) : (
            <div className="grid gap-2">
              {payments.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
                  <select
                    value={p.method}
                    onChange={(e) => updatePayment(p.id, { method: e.target.value as SalonPaymentMethod })}
                    className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                  >
                    {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {p.method === "ledger_balance" && (
                    <span className="text-xs text-amber-700">可用 {money(ledgerAvailable)}</span>
                  )}
                  <input
                    type="number"
                    min={0}
                    value={p.amount}
                    onChange={(e) => updatePayment(p.id, { amount: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-28 rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-right outline-none focus:ring-2 focus:ring-rose-200"
                  />
                  <span className="text-xs text-slate-400">{currency}</span>
                  <button
                    type="button"
                    onClick={() => removePayment(p.id)}
                    className="ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-rose-600 hover:bg-rose-50"
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}
          {ledgerPaymentAmount > ledgerAvailable + 0.001 && (
            <div className="mt-2 text-xs text-rose-600">
              Ledger 餘額不足：已選用餘額付款 {money(ledgerPaymentAmount)}，但可用僅 {money(ledgerAvailable)}。
            </div>
          )}
        </div>

        {/* 結算摘要 */}
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="space-y-1.5 text-sm">
            <Row label="小計" value={money(subtotal)} />
            {discountAmount > 0 && <Row label="折扣" value={`-${money(discountAmount)}`} />}
            {deductedAmount > 0 && <Row label="套票抵扣" value={`-${money(deductedAmount)}`} />}
            {depositApplied > 0 && <Row label="已付定金" value={`-${money(depositApplied)}`} />}
            {tipTotal > 0 && <Row label="小費" value={money(tipTotal)} />}
            <div className="my-1 border-t border-slate-100" />
            <Row label="應收總計" value={money(grandTotal)} bold />
            <Row label="已收" value={money(paidTotal)} />
            {changeDue > 0 && <Row label="找零" value={money(changeDue)} />}
            {remaining > 0.001 && <Row label="尚欠" value={money(remaining)} negative />}
          </div>
        </div>

        {settleError && (
          <div className="mb-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{settleError}</div>
        )}

        <button
          type="button"
          onClick={handleSettle}
          disabled={!canSettle}
          className="w-full rounded-xl bg-rose-500 px-4 py-3.5 text-base font-bold text-white shadow-sm hover:bg-rose-600 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {remaining > 0.001 ? `尚欠 ${money(remaining)}` : "確認結帳"}
        </button>

        <div className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <span className="font-semibold">定金提示：</span>
          若預約已付定金，將於本頁自動抵減。退款請到 Ledger 後台操作；POS 僅顯示記錄。
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  negative,
}: {
  label: string;
  value: string;
  bold?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={bold ? "font-bold text-slate-900" : "text-slate-500"}>{label}</span>
      <span
        className={
          negative
            ? "font-semibold text-rose-600"
            : bold
              ? "font-bold text-slate-900"
              : "text-slate-700"
        }
      >
        {value}
      </span>
    </div>
  );
}
