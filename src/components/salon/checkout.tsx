"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import type { ReactNode } from "react";
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
  SalonCustomerProfile,
  SalonLoyaltySettings,
} from "@/lib/salon/types";
import {
  loadBookings,
  saveBookings,
  loadSalonOrders,
  saveSalonOrders,
  loadSalonBootstrap,
  loadSalonCustomerPackages,
  saveSalonCustomerPackages,
  loadCustomers,
  saveCustomers,
} from "@/lib/salon/storage";
import { updateMockBooking } from "@/lib/salon/mock-realtime";
import {
  getMockLedgerMember,
  applyMockLedgerPayment,
  applyMockLedgerPointsPayment,
  applyMockLedgerBonus,
} from "@/lib/salon/mock-ledger";
import { DEFAULT_SALON_LOYALTY } from "@/lib/salon/mock-data";
import { computeStaffWage } from "@/lib/salon/wages";
import { describePrintFailures, dispatchSalonReceipt } from "@/lib/salon/print";
import { reopenSalonOrder } from "@/lib/salon/orders";
import { playSuccessBeep } from "@/lib/salon/sound";
import { formatMoney } from "@/lib/format";
import { loadAuthSession } from "@/lib/storage";
import { NumericKeypad } from "@/components/numeric-keypad";
import { FixedNumberPad } from "@/components/fixed-number-pad";

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
  return formatMoney(n);
}

/**
 * 取得 ISO 週序（1-53）。用於「生日當週」判斷。
 */
function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // 週一 = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // 移到本週四
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d.getTime() - firstThursday.getTime()) / 86400000 -
      3 +
      ((firstThursday.getUTCDay() + 6) % 7)) /
      7,
  );
  return week;
}

/**
 * 判斷生日是否落在指定窗口內（當月 / 當週）。
 * 跨年生日視為「今年」的生日，與今天比週序 / 月序。
 */
function isBirthdayInWindow(birthday: string | undefined, window: "month" | "week"): boolean {
  if (!birthday) return false;
  const b = new Date(birthday);
  if (Number.isNaN(b.getTime())) return false;
  const now = new Date();
  if (window === "month") return now.getMonth() === b.getMonth();
  const thisYearBday = new Date(now.getFullYear(), b.getMonth(), b.getDate());
  return isoWeek(thisYearBday) === isoWeek(now);
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

// 付款方式顯示順序（對齊餐飲高亮按鈕組）
const PAYMENT_ORDER: SalonPaymentMethod[] = ["cash", "card", "ledger_balance", "external"];

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
  /**
   * 結帳後收據列印失敗嘅原因（多行，每行一張失敗嘢）。
   * 冇咗呢個，收據印唔到只會喺入面 beep 一聲，跟住結帳流程照播
   * playSuccessBeep() + 顯示「結帳完成」—— 收銀員完全唔知收據冇印到。
   */
  const [printError, setPrintError] = useState("");

  // 返結（反結賬）狀態
  const [reopenReason, setReopenReason] = useState("");
  const [reopenSubmitting, setReopenSubmitting] = useState(false);

  const [discountAmount, setDiscountAmount] = useState(0);
  const [tips, setTips] = useState<TipRow[]>([]);
  const [tipPool, setTipPool] = useState(0);
  const [payments, setPayments] = useState<PaymentRow[]>([]);

  // 結帳會員電話（預設為預約客戶電話；店員可輸入 8 位查餘額 / 積分，對齊餐飲會員側欄）
  const [memberPhone, setMemberPhone] = useState("");

  // 折扣「精確輸入」大鍵盤開關
  const [discountPadOpen, setDiscountPadOpen] = useState(false);

  // 套票抵扣（P2）：已套用的抵扣計劃；空陣 = 未套用
  const [packagePlan, setPackagePlan] = useState<SalonPackageDeduction[]>([]);

  // 積分兌換（P-積分兌換）：每個服務項目分配的兌換積分數（key = booking.services 索引）
  const [pointsByIndex, setPointsByIndex] = useState<Record<string, number>>({});

  // 生日優惠逐單開關（結帳時自動套用，店員可關掉本單生日優惠）
  const [birthdayApplied, setBirthdayApplied] = useState(true);

  useEffect(() => {
    const b = loadBookings().find((x) => x.id === bookingId);
    if (!b) {
      setNotFound(true);
      return;
    }
    setBooking(b);

    // 切換預約時重置生日優惠開關（每單預設套用）
    setBirthdayApplied(true);
    // 結帳會員電話預設為預約客戶電話
    setMemberPhone(b.customerPhone ?? "");
    // 付款方式重置為一筆現金（金額 0，待店員輸入）
    setPayments([{ id: uid("pay"), method: "cash", amount: 0 }]);
    // 清空折扣 / 套票 / 積分，避免跨單殘留
    setDiscountAmount(0);
    setPackagePlan([]);
    setPointsByIndex({});
    setDiscountPadOpen(false);

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
    const phone = memberPhone.replace(/\D/g, "");
    if (!phone) return null;
    return getMockLedgerMember(phone);
  }, [memberPhone]);

  // ── 會員優惠（Phase 8：推薦獎勵 / 生日優惠 / 每店積分配比）──
  // loyalty 設定來自 bootstrap（舊店家經 storage 遷移補預設）；無則用全域預設。
  const loyalty: SalonLoyaltySettings = useMemo(
    () => loadSalonBootstrap()?.loyalty ?? DEFAULT_SALON_LOYALTY,
    [booking],
  );

  // 本單客戶檔案（用於讀 referrerId / birthday；依 customerId 或 phone 解析）
  const customer = useMemo<SalonCustomerProfile | null>(() => {
    if (!booking) return null;
    const list = loadCustomers();
    return (
      list.find((c) => c.id === booking.customerId) ??
      list.find((c) => c.phone === booking.customerPhone) ??
      null
    );
  }, [booking]);

  // 生日窗口是否命中（未計本單開關）
  const birthdayMatched = useMemo(() => {
    if (!loyalty.birthdayEnabled || !customer?.birthday) return false;
    return isBirthdayInWindow(customer.birthday, loyalty.birthdayWindow);
  }, [loyalty, customer]);

  // 生日優惠是否實際套用（命中且未被本單關閉）
  const birthdayActive = birthdayMatched && birthdayApplied;

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

  // ── 積分兌換（P-積分兌換）──
  // 取每個 booking 服務項的「積分價」（pointsPrice），僅有設定且 > 0 者才可兌換。
  // 每位客戶可逐項 mix：分配部分積分 → 現金等值 = price * (points / pointsPrice)，餘額走現金 / Ledger。
  const pointsEligible = useMemo(() => {
    if (!booking) return [];
    const bootstrap = loadSalonBootstrap();
    const itemMap = new Map((bootstrap?.serviceItems ?? []).map((s) => [s.id, s]));
    return booking.services
      .map((s, idx) => {
        const cfg = itemMap.get(s.serviceItemId);
        const pointsPrice = cfg?.pointsPrice ?? 0;
        return { index: idx, serviceItemId: s.serviceItemId, name: s.name, price: s.price, pointsPrice };
      })
      .filter((x) => x.pointsPrice > 0);
  }, [booking]);

  const pointsAlloc = useMemo(() => {
    return pointsEligible.map((e) => {
      const allocated = Math.min(pointsByIndex[String(e.index)] ?? 0, e.pointsPrice);
      const cashEquiv = e.pointsPrice > 0 ? Math.round((e.price * allocated) / e.pointsPrice) : 0;
      const cashLeft = Math.max(0, e.price - cashEquiv);
      return { ...e, allocated, cashEquiv, cashLeft };
    });
  }, [pointsEligible, pointsByIndex]);

  const totalPointsAllocated = pointsAlloc.reduce((sum, x) => sum + x.allocated, 0);
  const pointsDeduction = pointsAlloc.reduce((sum, x) => sum + x.cashEquiv, 0);
  const availablePoints = ledgerMember?.ledgerPoints ?? 0;
  const pointsOverflow = totalPointsAllocated > availablePoints + 0.001;

  const setPointsFor = useCallback((idx: number, points: number) => {
    setPointsByIndex((prev) => {
      const next = { ...prev };
      if (points <= 0) delete next[String(idx)];
      else next[String(idx)] = points;
      return next;
    });
  }, []);

  // ── 計算 ──
  const subtotal = useMemo(() => {
    if (!booking) return 0;
    const svc = booking.services.reduce((sum, s) => sum + s.price, 0);
    const prod = (booking.productSelections ?? []).reduce((sum, p) => sum + p.price * p.quantity, 0);
    return svc + prod;
  }, [booking]);
  const birthdayDiscountAmount = useMemo(() => {
    if (!birthdayActive || loyalty.birthdayDiscountPercent <= 0) return 0;
    return Math.round(subtotal * (loyalty.birthdayDiscountPercent / 100));
  }, [birthdayActive, loyalty.birthdayDiscountPercent, subtotal]);
  const afterDiscount = Math.max(0, subtotal - discountAmount - birthdayDiscountAmount);
  const depositApplied = useMemo(() => {
    if (!booking) return 0;
    return booking.depositPaid ? booking.depositAmount ?? 0 : 0;
  }, [booking]);
  const tipTotal = tips.reduce((sum, t) => sum + (t.amount || 0), 0);
  const grandTotal = Math.max(
    0,
    afterDiscount + tipTotal - depositApplied - deductedAmount - pointsDeduction,
  );
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
    ledgerPaymentAmount <= ledgerAvailable + 0.001 &&
    !pointsOverflow;

  // 本次結帳預計賺取積分 = floor(grandTotal / pointsPerDollar) ×（生日窗口內積分倍率）
  const pointsEarned = useMemo(() => {
    if (!customer || loyalty.pointsPerDollar <= 0) return 0;
    const base = Math.floor(grandTotal / loyalty.pointsPerDollar);
    if (base <= 0) return 0;
    const mult = birthdayActive && loyalty.birthdayPointsMultiplier > 0 ? loyalty.birthdayPointsMultiplier : 1;
    return Math.floor(base * mult);
  }, [customer, loyalty, grandTotal, birthdayActive]);

  // 主付款方式（payments[0]）；可選一筆分拆（payments[1]）
  const primary = payments[0];

  // 服務項目按 serviceItemId 分組顯示（支援步進器加減 → 增刪同名服務行）
  const serviceGroups = useMemo(() => {
    if (!booking) return [];
    const map = new Map<
      string,
      {
        serviceItemId: string;
        name: string;
        price: number;
        staffId: string;
        durationMinutes: number;
        count: number;
        staffName: string;
      }
    >();
    for (const s of booking.services) {
      const existing = map.get(s.serviceItemId);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(s.serviceItemId, {
          serviceItemId: s.serviceItemId,
          name: s.name,
          price: s.price,
          staffId: s.staffId,
          durationMinutes: s.durationMinutes,
          count: 1,
          staffName: staffMap[s.staffId]?.nickname ?? staffMap[s.staffId]?.name ?? "未知技師",
        });
      }
    }
    return Array.from(map.values());
  }, [booking, staffMap]);

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

  // ── 結帳頁內聯編輯（對齊餐飲購物車：服務 / 產品可加減、移除）──
  const persistBooking = useCallback((next: SalonBooking) => {
    saveBookings(loadBookings().map((x) => (x.id === next.id ? next : x)));
    setBooking(next);
  }, []);

  const addServiceLine = useCallback(
    (s: { serviceItemId: string; name: string; price: number; staffId: string; durationMinutes: number }) => {
      if (!booking) return;
      persistBooking({ ...booking, services: [...booking.services, { ...s }] });
    },
    [booking, persistBooking],
  );

  const removeOneService = useCallback(
    (serviceItemId: string) => {
      if (!booking) return;
      const idx = booking.services.map((s) => s.serviceItemId).lastIndexOf(serviceItemId);
      if (idx < 0) return;
      persistBooking({
        ...booking,
        services: booking.services.filter((_, i) => i !== idx),
      });
    },
    [booking, persistBooking],
  );

  const changeProductQty = useCallback(
    (productId: string, delta: number) => {
      if (!booking) return;
      const sel = (booking.productSelections ?? []).map((p) =>
        p.productId === productId ? { ...p, quantity: Math.max(1, p.quantity + delta) } : p,
      );
      persistBooking({ ...booking, productSelections: sel });
    },
    [booking, persistBooking],
  );

  const removeProductLine = useCallback(
    (productId: string) => {
      if (!booking) return;
      const sel = (booking.productSelections ?? []).filter((p) => p.productId !== productId);
      persistBooking({ ...booking, productSelections: sel.length ? sel : undefined });
    },
    [booking, persistBooking],
  );

  // ── 付款方式：單一主方式（高亮）+ 可選一筆分拆 ──
  const setPrimaryMethod = useCallback(
    (method: SalonPaymentMethod) => {
      setPayments((prev) => {
        const next = [...prev];
        if (next.length === 0) next.push({ id: uid("pay"), method, amount: 0 });
        else next[0] = { ...next[0], method };
        if (method === "ledger_balance") {
          next[0] = { ...next[0], amount: Math.min(grandTotal, ledgerAvailable) };
        }
        return next;
      });
    },
    [grandTotal, ledgerAvailable],
  );

  const addSplitPayment = useCallback(() => {
    setPayments((prev) =>
      prev.length >= 2 ? prev : [...prev, { id: uid("pay"), method: "cash", amount: 0 }],
    );
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

    const settlePhone = memberPhone.replace(/\D/g, "");

    // 1) 先扣 Ledger 餘額（若有用餘額付款），不足即中止並保留訂單
    if (ledgerPaymentAmount > 0) {
      const res = applyMockLedgerPayment(settlePhone, ledgerPaymentAmount);
      if (!res.ok) {
        setSettleError(res.error ?? "Ledger 扣款失敗");
        return;
      }
    }

    // 1b) 扣 Ledger 積分（若有用積分兌換），不足即中止並保留訂單
    if (totalPointsAllocated > 0) {
      const res = applyMockLedgerPointsPayment(settlePhone, totalPointsAllocated);
      if (!res.ok) {
        setSettleError(res.error ?? "Ledger 積分扣減失敗");
        return;
      }
    }

    // 1c) 推薦獎勵：被推薦人「首次結帳」才發給推薦人（防刷分），僅推薦人得分
    if (
      customer?.referrerId &&
      !customer.referralRewarded &&
      loyalty.referralEnabled &&
      loyalty.referralPoints > 0
    ) {
      const referrer = loadCustomers().find((c) => c.id === customer.referrerId);
      if (referrer) {
        applyMockLedgerBonus(referrer.phone || referrer.id, { points: loyalty.referralPoints });
        // 標記已發，避免同一被推薦人重複發分
        const all = loadCustomers().map((c) =>
          c.id === customer!.id ? { ...c, referralRewarded: true } : c,
        );
        saveCustomers(all);
      }
    }

    // 1d) 消費賺分：floor(grandTotal / pointsPerDollar) ×（生日窗口內積分倍率）
    if (pointsEarned > 0 && customer) {
      applyMockLedgerBonus(customer.phone || customer.id, { points: pointsEarned });
    }

    const now = new Date().toISOString();
    // 重結（re-settle）：若 booking.orderId 已指向一張單（返結後重結），就地更新；否則新增
    const existingOrder = booking.orderId
      ? loadSalonOrders().find((o) => o.id === booking.orderId)
      : undefined;
    const orderId = existingOrder?.id ?? uid("order");
    const orderNo = existingOrder?.orderNo ?? genOrderNo();

    // 標記被套票抵扣的服務項（同 serviceItemId 可能多行，依 plan 數量遞減）
    const coverLeft = new Map<string, number>();
    for (const d of packagePlan) {
      coverLeft.set(d.serviceItemId, (coverLeft.get(d.serviceItemId) ?? 0) + 1);
    }
    // 標記被積分兌換的服務項（依 booking.services 索引）
    const pointLeft = new Map<number, number>();
    for (const a of pointsAlloc) pointLeft.set(a.index, a.allocated);

    // 工錢計算：讀 bootstrap（含級別倍率）與服務細項工錢表
    const settleBootstrap = loadSalonBootstrap();
    const svcMap = new Map((settleBootstrap?.serviceItems ?? []).map((s) => [s.id, s]));

    const serviceItems: SalonOrderItem[] = booking.services.map((s, idx) => {
      const left = coverLeft.get(s.serviceItemId) ?? 0;
      const covered = left > 0;
      if (covered) coverLeft.set(s.serviceItemId, left - 1);
      const usedPoints = pointLeft.get(idx) ?? 0;
      const notes: string[] = [];
      if (covered) notes.push("套票抵扣");
      if (usedPoints > 0) notes.push(`積分兌換 ${usedPoints}分`);
      return {
        kind: "service",
        itemId: s.serviceItemId,
        name: s.name,
        quantity: 1,
        unitPrice: s.price,
        staffId: s.staffId,
        staffName: staffMap[s.staffId]?.nickname ?? staffMap[s.staffId]?.name ?? "",
        wageAmount: computeStaffWage(svcMap.get(s.serviceItemId), staffMap[s.staffId], settleBootstrap),
        note: notes.length > 0 ? notes.join(" · ") : undefined,
      };
    });

    // 產品（R4：併入同一張單結帳；佣金按快照 commissionRate 計）
    const productItems: SalonOrderItem[] = (booking.productSelections ?? []).map((p) => {
      const staffName = p.staffId
        ? staffMap[p.staffId]?.nickname ?? staffMap[p.staffId]?.name ?? ""
        : undefined;
      const commissionAmount = p.staffId
        ? Math.round((p.price * p.quantity * p.commissionRate) / 100)
        : 0;
      return {
        kind: "product",
        itemId: p.productId,
        name: p.name,
        quantity: p.quantity,
        unitPrice: p.price,
        staffId: p.staffId,
        staffName,
        commissionAmount: commissionAmount > 0 ? commissionAmount : undefined,
      };
    });

    const items: SalonOrderItem[] = [...serviceItems, ...productItems];

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
      pointsDeduction: pointsDeduction > 0 ? pointsDeduction : undefined,
      pointsRedeemed: totalPointsAllocated > 0 ? totalPointsAllocated : undefined,
      pointsEarned: pointsEarned > 0 ? pointsEarned : undefined,
      birthdayDiscount: birthdayDiscountAmount > 0 ? true : undefined,
      total: afterDiscount,
      tips: tipRecords,
      tipTotal,
      grandTotal,
      payments: paymentRecords,
      depositApplied: depositApplied > 0 ? depositApplied : undefined,
      changeDue: changeDue > 0 ? changeDue : undefined,
      // ── 會員扣款快照：供返結反向回滾 ──
      ledgerPaymentAmount: ledgerPaymentAmount > 0 ? ledgerPaymentAmount : undefined,
      packageDeductionEntries:
        packagePlan.length > 0
          ? packagePlan.map((d) => ({
              planId: d.packageId,
              planName: d.packageName,
              serviceItemId: d.serviceItemId,
              sessionsUsed: 1,
            }))
          : undefined,
      status: "settled",
      settledAt: now,
      createdAt: existingOrder?.createdAt ?? now,
      updatedAt: now,
    };

    // 保留返結審計（重結不重置；originalSettledAt 鎖定首次結帳時間）
    const finalOrder: SalonPosOrder = {
      ...order,
      originalSettledAt: order.originalSettledAt ?? (existingOrder?.originalSettledAt ?? order.settledAt),
      reopenCount: existingOrder?.reopenCount ?? 0,
      reopenedAt: existingOrder?.reopenedAt,
      reopenedBy: existingOrder?.reopenedBy,
      reopenReason: existingOrder?.reopenReason,
    };

    // 2) 存訂單（就地更新或新增）+ 套票扣次 + 更新預約狀態為 settled
    try {
      const allOrders = loadSalonOrders();
      const nextOrders = allOrders.some((o) => o.id === finalOrder.id)
        ? allOrders.map((o) => (o.id === finalOrder.id ? finalOrder : o))
        : [...allOrders, finalOrder];
      saveSalonOrders(nextOrders);
      // 套票抵扣：訂單存妥後才寫回客戶套票卡次數（避免訂單失敗卻已扣次）
      applyCustomerPackageDeductions(packagePlan);
    } catch {
      setSettleError("儲存訂單失敗，請重試。");
      return;
    }
    updateMockBooking(booking.id, { status: "settled", orderId: finalOrder.id });

    // 3) 列印收據（寫入 salon 隔離佇列 + dispatch）
    //    列印失敗唔阻塞結帳，但**一定要講出嚟**：以前淨係入面 beep 一聲，跟住
    //    照播 playSuccessBeep() + 顯示「結帳完成」，收銀員當冇事發生。
    //    收據冇印到 = 客人冇單 = 之後對數一定出事。
    try {
      const printed = await dispatchSalonReceipt(finalOrder);
      setPrintError(describePrintFailures(printed));
    } catch (error) {
      setPrintError(
        `列印時發生錯誤：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    setSettledOrderNo(orderNo);
    setSettled(true);
    playSuccessBeep();
  }, [
    booking,
    customer,
    loyalty,
    canSettle,
    ledgerPaymentAmount,
    tips,
    payments,
    subtotal,
    discountAmount,
    afterDiscount,
    birthdayDiscountAmount,
    tipTotal,
    grandTotal,
    depositApplied,
    changeDue,
    deductedAmount,
    packagePlan,
    pointsAlloc,
    pointsDeduction,
    totalPointsAllocated,
    pointsEarned,
    staffMap,
    memberPhone,
  ]);

  const reprintReceipt = useCallback(async () => {
    setSettleError("");
    const orders = loadSalonOrders();
    const order = orders.find((o) => o.orderNo === settledOrderNo);
    if (!order) return;
    try {
      const printed = await dispatchSalonReceipt(order);
      // 重印成功要清走結帳時嗰個警告，唔好留低誤導。
      setPrintError(describePrintFailures(printed));
    } catch {
      setSettleError("重印失敗，請到「打印」頁重試。");
    }
  }, [settledOrderNo]);

  // 返結（反結賬）：把已結預約退回可編輯狀態，改正後重新結帳
  const handleReopen = useCallback(async () => {
    if (!booking || !reopenReason.trim()) {
      setSettleError("請先揀返結原因");
      return;
    }
    setReopenSubmitting(true);
    setSettleError("");
    try {
      const session = loadAuthSession();
      const operator = session?.name ?? session?.account ?? "店長";
      const result = await reopenSalonOrder({ bookingId: booking.id, reason: reopenReason, operator });
      if (!result.ok) {
        setSettleError(result.error ?? "返結失敗");
        return;
      }
      setReopenReason("");
      // 重新載入預約（狀態已改回 completed），讓結帳頁回到可編輯狀態
      const refreshed = loadBookings().find((b) => b.id === booking.id) ?? booking;
      setBooking(refreshed);
    } finally {
      setReopenSubmitting(false);
    }
  }, [booking, reopenReason]);

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
    const reopenReasons = loadSalonBootstrap()?.reopenReasons ?? [];
    return (
      <div className="min-h-screen bg-slate-100 text-slate-900 md:pl-[72px]">
        <div className="mx-auto max-w-4xl px-4 py-10 pb-24 md:pb-10">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="text-lg font-bold text-emerald-600">此預約已結帳</div>
            <div className="mt-2 text-sm text-slate-500">
              {booking.customerName} · {booking.bookingNo}
            </div>

            <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left">
              <div className="text-sm font-semibold text-amber-800">返結帳（反結賬）</div>
              <p className="mt-1 text-xs text-amber-700">
                把此單退回可編輯，改正後重新結帳。會員餘額 / 積分 / 套票將自動退回，重結時重新扣。必須揀返結原因。
              </p>
              <select
                className="mt-3 w-full rounded-lg border border-amber-300 bg-white px-2 py-2 text-sm"
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
              >
                <option value="" disabled>
                  揀返結原因…
                </option>
                {reopenReasons.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="mt-3 w-full rounded-xl bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                disabled={!reopenReason || reopenSubmitting}
                onClick={handleReopen}
              >
                {reopenSubmitting ? "處理中…" : "返結帳"}
              </button>
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
            {pointsEarned > 0 && (
              <div className="mt-1 text-sm font-semibold text-amber-600">本單賺取 {pointsEarned} 分</div>
            )}
            {/* 收據冇印到一定要喺呢度講：否則收銀員淨係見到「結帳完成」，
                以為搞掂，其實客人冇收到單，之後對數一定出事。
                長文字用 whitespace-pre-wrap break-words（項目約定），唔好 truncate。 */}
            {printError ? (
              <div className="mt-4 whitespace-pre-wrap break-words rounded-xl bg-rose-50 px-4 py-3 text-left text-sm text-rose-700">
                <div className="font-semibold">⚠ 收據列印失敗</div>
                <div className="mt-1 text-xs leading-relaxed">{printError}</div>
                <div className="mt-2 text-xs text-rose-500">
                  可撳「再列印收據」重試，或去「打印」頁查睇。
                </div>
              </div>
            ) : null}
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

  const currentOrder = loadSalonOrders().find((o) => o.id === booking.orderId);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-100 text-slate-900 md:pl-[72px]">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 md:px-6">
        <div className="min-w-0">
          <div className="truncate text-xl font-bold text-slate-900">{booking.customerName}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            {booking.customerPhone} · {booking.bookingNo}
          </div>
        </div>
        <Link
          href="/salon"
          className="shrink-0 rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-200"
        >
          ← 工作台
        </Link>
      </header>

      {currentOrder?.status === "reopened" ? (
        <div className="px-4 py-2 md:px-6">
          <div className="flex items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3">
            <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[11px] font-bold text-white">返結帳</span>
            <span className="text-xs font-semibold text-amber-800">此單為返結單，可改價／加服務後重新結帳</span>
            {currentOrder.reopenReason ? (
              <span className="ml-auto text-[11px] text-amber-700">返結原因：{currentOrder.reopenReason}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* 左欄：訂單內容（可滾動） */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 md:px-6">
          {/* 服務項目（步進器加減 / 移除，對齊餐飲購物車） */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h3 className="mb-3 text-sm font-bold text-slate-900">服務項目</h3>
            <div className="grid gap-2">
              {serviceGroups.map((g) => (
                <div
                  key={g.serviceItemId}
                  className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-800">{g.name}</div>
                    <div className="text-xs text-slate-500">
                      技師：{g.staffName}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Stepper
                      count={g.count}
                      onDec={() => removeOneService(g.serviceItemId)}
                      onInc={() =>
                        addServiceLine({
                          serviceItemId: g.serviceItemId,
                          name: g.name,
                          price: g.price,
                          staffId: g.staffId,
                          durationMinutes: g.durationMinutes,
                        })
                      }
                    />
                    <div className="text-right">
                      <div className="text-sm font-semibold text-slate-700">{money(g.price * g.count)}</div>
                      <div className="text-[11px] text-slate-400">
                        {money(g.price)} × {g.count}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 產品 */}
          {booking.productSelections && booking.productSelections.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="mb-3 text-sm font-bold text-slate-900">產品</h3>
              <div className="grid gap-2">
                {booking.productSelections.map((p) => (
                  <div
                    key={p.productId}
                    className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">{p.name}</div>
                      <div className="text-xs text-slate-500">
                        銷售：
                        {p.staffId
                          ? staffMap[p.staffId]?.nickname ?? staffMap[p.staffId]?.name ?? "未知"
                          : "未指定"}
                        {p.commissionRate > 0 ? ` · 佣金 ${p.commissionRate}%` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Stepper
                        count={p.quantity}
                        onDec={() => changeProductQty(p.productId, -1)}
                        onInc={() => changeProductQty(p.productId, 1)}
                        onRemove={() => removeProductLine(p.productId)}
                      />
                      <div className="text-right">
                        <div className="text-sm font-semibold text-slate-700">
                          {money(p.price * p.quantity)}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 折扣 */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
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
                <button
                  type="button"
                  onClick={() => setDiscountPadOpen((o) => !o)}
                  className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200"
                >
                  精確
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span>減免金額</span>
              <span className="text-base font-semibold text-slate-800">{money(discountAmount)}</span>
            </div>

            {discountPadOpen && (
              <div className="mt-3 overflow-hidden rounded-xl border border-slate-200">
                <FixedNumberPad
                  title="折扣減免金額"
                  subtitle={`小計 ${money(subtotal)}`}
                  value={String(discountAmount)}
                  onChange={(v) => setDiscountAmount(Math.max(0, Number(v) || 0))}
                  showDisplay
                  confirmLabel="完成"
                  onConfirm={() => setDiscountPadOpen(false)}
                />
              </div>
            )}

            {/* 生日優惠（命中窗口才顯示；可逐單關閉） */}
            {birthdayMatched && (
              <div className="mt-3 rounded-xl bg-pink-50 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-pink-700">
                    生日優惠（{loyalty.birthdayWindow === "month" ? "當月生日" : "當週生日"}）
                  </div>
                  <button
                    type="button"
                    onClick={() => setBirthdayApplied(!birthdayApplied)}
                    className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                      birthdayApplied ? "bg-pink-200 text-pink-800" : "bg-slate-200 text-slate-500"
                    }`}
                  >
                    {birthdayApplied ? "套用中" : "已關閉"}
                  </button>
                </div>
                <div className="mt-1 text-xs text-pink-600">
                  {loyalty.birthdayDiscountPercent > 0
                    ? `享 ${loyalty.birthdayDiscountPercent}% 折扣（-${money(birthdayDiscountAmount)}）`
                    : "不打折"}
                  {loyalty.birthdayPointsMultiplier > 0
                    ? ` · 賺分 ×${loyalty.birthdayPointsMultiplier}`
                    : " · 不加倍"}
                </div>
              </div>
            )}
          </div>

          {/* 套票抵扣（P2） */}
          <CollapsibleSection
            title="套票抵扣"
            defaultOpen={packagePlan.length > 0 || previewAmount > 0}
          >
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
          </CollapsibleSection>

          {/* 積分兌換（P-積分兌換） */}
          <CollapsibleSection
            title="積分兌換"
            defaultOpen={pointsEligible.length > 0}
            subtitle={
              booking.customerId && ledgerMember ? `可用積分 ${ledgerMember.ledgerPoints}` : undefined
            }
          >
            {!booking.customerId ? (
              <div className="text-xs text-slate-400">本預約未綁定客戶，積分兌換需關聯 Ledger 會員。</div>
            ) : !ledgerMember ? (
              <div className="text-xs text-slate-400">此客戶無 Ledger 會員資料，無法兌換積分。</div>
            ) : pointsEligible.length === 0 ? (
              <div className="text-xs text-slate-400">本單服務項目無設定積分價，無法以積分兌換。</div>
            ) : (
              <div className="grid gap-2">
                {pointsAlloc.map((a) => {
                  const on = a.allocated > 0;
                  return (
                    <div key={a.index} className="rounded-xl bg-slate-50 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-slate-800">{a.name}</span>
                        <span className="text-xs text-slate-500">
                          {money(a.price)} / {a.pointsPrice} 分
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-slate-600">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => setPointsFor(a.index, e.target.checked ? a.pointsPrice : 0)}
                            className="h-4 w-4"
                          />
                          用積分兌換
                        </label>
                        {on && (
                          <>
                            <input
                              type="number"
                              min={0}
                              max={a.pointsPrice}
                              value={a.allocated}
                              onChange={(e) =>
                                setPointsFor(
                                  a.index,
                                  Math.max(0, Math.min(a.pointsPrice, Number(e.target.value) || 0)),
                                )
                              }
                              className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-right outline-none focus:ring-2 focus:ring-rose-200"
                            />
                            <span className="text-xs text-slate-400">分（可少於 {a.pointsPrice} 以 mix）</span>
                            <span className="ml-auto text-xs font-semibold text-emerald-700">
                              抵 {money(a.cashEquiv)} · 餘 {money(a.cashLeft)} 現金
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
                {totalPointsAllocated > 0 && (
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-sm font-semibold text-slate-800">
                      已兌換 {totalPointsAllocated} 分（抵 {money(pointsDeduction)}）
                    </span>
                    <button
                      type="button"
                      onClick={() => setPointsByIndex({})}
                      className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200"
                    >
                      全部取消
                    </button>
                  </div>
                )}
                {pointsOverflow && (
                  <div className="text-xs text-rose-600">
                    積分不足：已分配 {totalPointsAllocated} 分，但可用僅 {availablePoints} 分。
                  </div>
                )}
              </div>
            )}
          </CollapsibleSection>

          {/* 小費（多技師平分） */}
          <CollapsibleSection title="小費（按技師）" defaultOpen={false}>
            <div className="mb-2 flex items-center justify-end gap-1.5">
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
                  <div
                    key={t.staffId}
                    className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"
                  >
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
          </CollapsibleSection>
        </div>

        {/* 右欄：收銀與支付（sticky） */}
        <aside className="flex min-h-0 w-full shrink-0 flex-col border-t border-slate-200 bg-white md:w-[400px] md:border-l md:border-t-0">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {/* 應收大字 */}
            <div className="rounded-2xl bg-rose-500 px-4 py-4 text-white shadow-sm">
              <div className="text-xs font-medium opacity-90">應收總計</div>
              <div className="text-3xl font-extrabold tracking-tight">{money(grandTotal)}</div>
              <div className="mt-1 flex justify-between text-xs opacity-90">
                <span>小計 {money(subtotal)}</span>
                {(discountAmount + birthdayDiscountAmount + deductedAmount + pointsDeduction + depositApplied) > 0 && (
                  <span>
                    已減{" "}
                    {money(
                      discountAmount + birthdayDiscountAmount + deductedAmount + pointsDeduction + depositApplied,
                    )}
                  </span>
                )}
              </div>
            </div>

            {/* 會員（輸入 8 位電話查餘額 / 積分） */}
            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="mb-2 text-xs font-semibold text-slate-500">
                會員（輸入 8 位電話查餘額 / 積分）
              </div>
              <NumericKeypad
                value={memberPhone}
                onChange={(v) => setMemberPhone(v.replace(/\D/g, "").slice(0, 8))}
                maxLength={8}
                showConfirm={false}
              />
              {ledgerMember ? (
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-amber-50 px-2 py-2">
                    <div className="text-[11px] text-amber-700">級別</div>
                    <div className="text-sm font-bold text-amber-800">{ledgerMember.ledgerTier}</div>
                  </div>
                  <div className="rounded-xl bg-amber-50 px-2 py-2">
                    <div className="text-[11px] text-amber-700">餘額</div>
                    <div className="text-sm font-bold text-amber-800">{money(ledgerMember.ledgerBalance)}</div>
                  </div>
                  <div className="rounded-xl bg-amber-50 px-2 py-2">
                    <div className="text-[11px] text-amber-700">積分</div>
                    <div className="text-sm font-bold text-amber-800">{ledgerMember.ledgerPoints}</div>
                  </div>
                </div>
              ) : memberPhone.replace(/\D/g, "").length === 8 ? (
                <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-400">
                  無 Ledger 會員資料
                </div>
              ) : null}
              {pointsEarned > 0 && (
                <div className="mt-2 text-center text-xs font-semibold text-rose-600">
                  本單預計賺 {pointsEarned} 分
                </div>
              )}
            </div>

            {/* 付款方式（單一主方式高亮 + 可選分拆） */}
            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="mb-2 text-xs font-semibold text-slate-500">付款方式</div>
              <div className="grid grid-cols-2 gap-2">
                {PAYMENT_ORDER.map((m) => {
                  const selected = primary?.method === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setPrimaryMethod(m)}
                      className={`rounded-xl px-2 py-2.5 text-xs font-semibold transition ${
                        selected
                          ? "bg-rose-500 text-white shadow-sm"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      {PAYMENT_LABELS[m]}
                    </button>
                  );
                })}
              </div>

              {primary?.method === "ledger_balance" && (
                <div className="mt-2 flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <span>可用餘額 {money(ledgerAvailable)}</span>
                  <button
                    type="button"
                    onClick={() => primary && updatePayment(primary.id, { amount: Math.min(grandTotal, ledgerAvailable) })}
                    className="rounded-lg bg-amber-200 px-2 py-1 font-semibold text-amber-900 hover:bg-amber-300"
                  >
                    全額抵扣
                  </button>
                </div>
              )}
              {ledgerPaymentAmount > ledgerAvailable + 0.001 && (
                <div className="mt-2 text-xs text-rose-600">
                  Ledger 餘額不足：已選用餘額付款 {money(ledgerPaymentAmount)}，但可用僅 {money(ledgerAvailable)}。
                </div>
              )}

              {payments.length > 1 && (
                <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2">
                  <div className="mb-1 text-[11px] font-semibold text-slate-500">分拆付款</div>
                  {payments.slice(1).map((p) => (
                    <div key={p.id} className="flex items-center gap-2 py-1">
                      <select
                        value={p.method}
                        onChange={(e) => updatePayment(p.id, { method: e.target.value as SalonPaymentMethod })}
                        className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-rose-200"
                      >
                        {PAYMENT_ORDER.map((m) => (
                          <option key={m} value={m}>
                            {PAYMENT_LABELS[m]}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={0}
                        value={p.amount}
                        onChange={(e) => updatePayment(p.id, { amount: Math.max(0, Number(e.target.value) || 0) })}
                        className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-right outline-none focus:ring-2 focus:ring-rose-200"
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
              {payments.length < 2 && primary?.method !== "ledger_balance" && (
                <button
                  type="button"
                  onClick={addSplitPayment}
                  className="mt-3 w-full rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200"
                >
                  ＋ 分拆付款
                </button>
              )}
            </div>

            {/* 實收金額（非 Ledger 時用大鍵盤輸入，自動計找零） */}
            {primary?.method !== "ledger_balance" && (
              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <FixedNumberPad
                  title="實收金額"
                  subtitle={`應收 ${money(grandTotal)}`}
                  value={String(primary?.amount ?? 0)}
                  onChange={(v) => primary && updatePayment(primary.id, { amount: Math.max(0, Number(v) || 0) })}
                  showDisplay
                  confirmLabel="結帳"
                  onConfirm={handleSettle}
                />
              </div>
            )}

            {/* 結算摘要 */}
            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="space-y-1.5 text-sm">
                <Row label="小計" value={money(subtotal)} />
                {discountAmount > 0 && <Row label="折扣" value={`-${money(discountAmount)}`} />}
                {birthdayDiscountAmount > 0 && <Row label="生日折扣" value={`-${money(birthdayDiscountAmount)}`} />}
                {deductedAmount > 0 && <Row label="套票抵扣" value={`-${money(deductedAmount)}`} />}
                {pointsDeduction > 0 && <Row label="積分兌換" value={`-${money(pointsDeduction)}`} />}
                {depositApplied > 0 && <Row label="已付定金" value={`-${money(depositApplied)}`} />}
                {tipTotal > 0 && <Row label="小費" value={money(tipTotal)} />}
                <div className="my-1 border-t border-slate-100" />
                <Row label="應收總計" value={money(grandTotal)} bold />
                {pointsEarned > 0 && (
                  <Row
                    label="預計賺分"
                    value={`+${pointsEarned} 分${birthdayActive && loyalty.birthdayPointsMultiplier > 1 ? `（生日 ×${loyalty.birthdayPointsMultiplier}）` : ""}`}
                  />
                )}
                <Row label="已收" value={money(paidTotal)} />
                {changeDue > 0 && <Row label="找零" value={money(changeDue)} />}
                {remaining > 0.001 && <Row label="尚欠" value={money(remaining)} negative />}
              </div>
            </div>

            {settleError && (
              <div className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{settleError}</div>
            )}

            <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">
              <span className="font-semibold">定金提示：</span>
              若預約已付定金，將於本頁自動抵減。退款請到 Ledger 後台操作；POS 僅顯示記錄。
            </div>
          </div>

          {/* 底部大字「確認結帳」 */}
          <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 md:px-6">
            <button
              type="button"
              onClick={handleSettle}
              disabled={!canSettle}
              className="w-full rounded-xl bg-rose-500 py-4 text-lg font-bold text-white shadow-sm hover:bg-rose-600 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {remaining > 0.001 ? `尚欠 ${money(remaining)}` : "確認結帳"}
            </button>
          </div>
        </aside>
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

function Stepper({
  count,
  onDec,
  onInc,
  onRemove,
}: {
  count: number;
  onDec: () => void;
  onInc: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onDec}
        className="grid h-7 w-7 place-items-center rounded-lg bg-white text-base font-bold text-slate-700 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
      >
        −
      </button>
      <span className="w-5 text-center text-sm font-semibold text-slate-800">{count}</span>
      <button
        type="button"
        onClick={onInc}
        className="grid h-7 w-7 place-items-center rounded-lg bg-rose-500 text-base font-bold text-white shadow-sm hover:bg-rose-600"
      >
        ＋
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="ml-1 grid h-7 w-7 place-items-center rounded-lg bg-rose-100 text-xs font-bold text-rose-600 hover:bg-rose-200"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = true,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-2xl px-5 py-3 text-left"
      >
        <span className="text-sm font-bold text-slate-900">
          {title}
          {subtitle ? <span className="ml-2 text-xs font-normal text-amber-700">{subtitle}</span> : null}
        </span>
        <span className="text-xs text-slate-400">{open ? "收起 ▲" : "展開 ▼"}</span>
      </button>
      {open ? <div className="px-5 pb-5 pt-0">{children}</div> : null}
    </div>
  );
}
