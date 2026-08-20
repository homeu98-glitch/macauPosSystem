"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import type {
  SalonPosOrder,
  SalonStaff,
  SalonPaymentMethod,
  SalonCustomerPackage,
  SalonPackageTemplate,
  SalonCustomerProfile,
} from "@/lib/salon/types";
import {
  loadSalonOrders,
  loadSalonBootstrap,
  loadSalonCustomerPackages,
  loadSalonPackageTemplates,
  loadCustomers,
} from "@/lib/salon/storage";
import { formatMoney } from "@/lib/format";

type RangeKey = "today" | "week" | "all";

const RANGE_LABEL: Record<RangeKey, string> = {
  today: "今日",
  week: "近 7 日",
  all: "全部",
};

/** 即將到期催銷視窗（天） */
const EXPIRE_WINDOW_DAYS = 30;

const PAYMENT_LABELS: Record<SalonPaymentMethod, string> = {
  cash: "現金",
  card: "信用卡 / 移動支付",
  ledger_balance: "Ledger 餘額",
  external: "外部平台",
};

function money(n: number): string {
  return formatMoney(n);
}

function inRange(iso: string | undefined, range: RangeKey): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  if (range === "all") return true;
  const now = new Date();
  if (range === "today") {
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  }
  // week
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);
  return d >= sevenDaysAgo;
}

export function Reports() {
  const [orders, setOrders] = useState<SalonPosOrder[]>([]);
  const [staffList, setStaffList] = useState<SalonStaff[]>([]);
  const [currency, setCurrency] = useState("MOP");
  const [range, setRange] = useState<RangeKey>("today");

  // P3：套票相關數據
  const [packages, setPackages] = useState<SalonCustomerPackage[]>([]);
  const [templates, setTemplates] = useState<SalonPackageTemplate[]>([]);
  const [customers, setCustomers] = useState<SalonCustomerProfile[]>([]);

  useEffect(() => {
    setOrders(loadSalonOrders());
    const bootstrap = loadSalonBootstrap();
    if (bootstrap) {
      setStaffList(bootstrap.staff);
      setCurrency(bootstrap.currency || "MOP");
    }
    setPackages(loadSalonCustomerPackages());
    setTemplates(loadSalonPackageTemplates());
    setCustomers(loadCustomers());
  }, []);

  const staffMap = useMemo(() => {
    const map: Record<string, SalonStaff> = {};
    for (const s of staffList) map[s.id] = s;
    return map;
  }, [staffList]);

  const settled = useMemo(
    () =>
      orders.filter(
        (o) => o.status === "settled" && inRange(o.settledAt ?? o.createdAt, range),
      ),
    [orders, range],
  );

  const summary = useMemo(() => {
    let grandTotal = 0;
    let discount = 0;
    let deposit = 0;
    let tip = 0;
    const payments: Record<string, number> = {};
    const staffSales: Record<string, number> = {};
    const staffTips: Record<string, number> = {};
    const serviceQty: Record<string, number> = {};

    for (const o of settled) {
      grandTotal += o.grandTotal;
      discount += o.discountAmount;
      deposit += o.depositApplied ?? 0;
      tip += o.tipTotal;

      for (const p of o.payments) {
        payments[p.method] = (payments[p.method] ?? 0) + p.amount;
      }
      for (const it of o.items) {
        const amt = it.unitPrice * it.quantity;
        if (it.staffId) {
          staffSales[it.staffId] = (staffSales[it.staffId] ?? 0) + amt;
        }
        serviceQty[it.name] = (serviceQty[it.name] ?? 0) + it.quantity;
      }
      for (const t of o.tips) {
        staffTips[t.staffId] = (staffTips[t.staffId] ?? 0) + t.amount;
      }
    }

    const staffSalesRank = Object.entries(staffSales)
      .map(([id, amt]) => ({ name: staffMap[id]?.nickname ?? staffMap[id]?.name ?? "未知技師", amt }))
      .sort((a, b) => b.amt - a.amt);

    const staffTipsRank = Object.entries(staffTips)
      .map(([id, amt]) => ({ name: staffMap[id]?.nickname ?? staffMap[id]?.name ?? "未知技師", amt }))
      .sort((a, b) => b.amt - a.amt);

    const serviceRank = Object.entries(serviceQty)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty);

    return { grandTotal, discount, deposit, tip, payments, staffSalesRank, staffTipsRank, serviceRank, count: settled.length };
  }, [settled, staffMap]);

  // ── P3：套票銷售額 / 使用率（受 range 篩選，依 purchasedAt）──
  const packageStats = useMemo(() => {
    const inRangePkgs = packages.filter((p) => inRange(p.purchasedAt, range));
    const salesAmount = inRangePkgs.reduce((s, p) => s + (p.price || 0), 0);

    type TplRow = {
      name: string;
      sold: number;
      sales: number;
      usedSessions: number;
      totalSessions: number;
    };
    const byTemplate = new Map<string, TplRow>();
    for (const p of inRangePkgs) {
      const tpl = templates.find((t) => t.id === p.templateId);
      const originalTotal = tpl ? tpl.items.reduce((s, it) => s + it.sessions, 0) : 0;
      const remainingSum = p.remaining.reduce((s, r) => s + r.sessionsLeft, 0);
      const used = originalTotal > 0 ? Math.max(0, originalTotal - remainingSum) : 0;
      const cur =
        byTemplate.get(p.templateId) ??
        { name: p.templateName, sold: 0, sales: 0, usedSessions: 0, totalSessions: 0 };
      cur.sold += 1;
      cur.sales += p.price || 0;
      cur.usedSessions += used;
      cur.totalSessions += originalTotal;
      byTemplate.set(p.templateId, cur);
    }

    const rows = Array.from(byTemplate.values())
      .map((r) => ({
        ...r,
        usageRate: r.totalSessions > 0 ? r.usedSessions / r.totalSessions : 0,
      }))
      .sort((a, b) => b.sales - a.sales);

    return { salesAmount, rows };
  }, [packages, templates, range]);

  // ── P3：即將到期套票清單（催銷；往前看 EXPIRE_WINDOW_DAYS，不套用 range）──
  const expiring = useMemo(() => {
    const now = Date.now();
    const custMap = new Map(customers.map((c) => [c.id, c.name]));
    return packages
      .filter((p) => p.status === "active" && p.expiresAt)
      .map((p) => ({
        ...p,
        customerName: custMap.get(p.customerId) ?? "未知客戶",
        daysLeft: Math.ceil((new Date(p.expiresAt as string).getTime() - now) / 86400000),
        remainingTotal: p.remaining.reduce((s, r) => s + r.sessionsLeft, 0),
      }))
      .filter((p) => p.daysLeft >= 0 && p.daysLeft <= EXPIRE_WINDOW_DAYS)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [packages, customers]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 pb-24 md:pb-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">報表</h1>
        <div className="flex gap-1.5">
          {(Object.keys(RANGE_LABEL) as RangeKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setRange(k)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold ${
                range === k ? "bg-rose-500 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {RANGE_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      {/* 總覽 */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="訂單數" value={String(summary.count)} />
        <Stat label="營業總額" value={money(summary.grandTotal)} highlight />
        <Stat label="折扣" value={money(summary.discount)} />
        <Stat label="已付定金" value={money(summary.deposit)} />
        <Stat label="小費" value={money(summary.tip)} />
        <Stat label="套票銷售額" value={money(packageStats.salesAmount)} highlight />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* 付款方式拆分 */}
      <Section title="付款方式">
        {Object.keys(summary.payments).length === 0 ? (
          <Empty />
        ) : (
          <div className="grid gap-1.5">
            {(Object.entries(summary.payments) as [SalonPaymentMethod, number][]).map(([m, amt]) => (
              <Row key={m} label={PAYMENT_LABELS[m] ?? m} value={money(amt)} />
            ))}
          </div>
        )}
      </Section>

      {/* 技師業績 */}
      <Section title="技師業績（服務營業額）">
        {summary.staffSalesRank.length === 0 ? (
          <Empty />
        ) : (
          <div className="grid gap-1.5">
            {summary.staffSalesRank.map((r) => (
              <Row key={r.name} label={r.name} value={money(r.amt)} />
            ))}
          </div>
        )}
      </Section>

      {/* 小費排行 */}
      <Section title="小費彙總（技師排行）">
        {summary.staffTipsRank.length === 0 ? (
          <Empty />
        ) : (
          <div className="grid gap-1.5">
            {summary.staffTipsRank.map((r) => (
              <Row key={r.name} label={r.name} value={money(r.amt)} />
            ))}
          </div>
        )}
      </Section>

      {/* 服務銷量 */}
      <Section title="服務銷量">
        {summary.serviceRank.length === 0 ? (
          <Empty />
        ) : (
          <div className="grid gap-1.5">
            {summary.serviceRank.map((r) => (
              <Row key={r.name} label={r.name} value={`${r.qty} 次`} />
            ))}
          </div>
        )}
      </Section>
      </div>

      {/* P3：套票使用率 */}
      <Section title="套票使用率（依購買範圍）">
        {packageStats.rows.length === 0 ? (
          <Empty />
        ) : (
          <div className="grid gap-3">
            {packageStats.rows.map((r) => (
              <div key={r.name} className="rounded-xl bg-slate-50 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-800">{r.name}</span>
                  <span className="text-xs text-slate-500">
                    {r.sold} 張 · {money(r.sales)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-2 rounded-full bg-emerald-500"
                      style={{ width: `${Math.round(r.usageRate * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs font-semibold text-slate-700">
                    {Math.round(r.usageRate * 100)}%
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  已用 {r.usedSessions} / 總 {r.totalSessions} 次
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* P3：即將到期套票（催銷） */}
      <Section title={`即將到期套票（${EXPIRE_WINDOW_DAYS} 日內 · 催銷）`}>
        {expiring.length === 0 ? (
          <Empty />
        ) : (
          <div className="grid gap-2">
            {expiring.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2"
              >
                <div>
                  <div className="text-sm font-semibold text-slate-800">
                    {p.customerName} · {p.templateName}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    餘 {p.remainingTotal} 次 · 效期 {String(p.expiresAt).slice(0, 10)}
                  </div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    p.daysLeft <= 7
                      ? "bg-rose-100 text-rose-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {p.daysLeft} 天後到期
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <div className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">
        <span className="font-semibold">說明：</span>
        報表由本地結帳訂單（status=settled）與套票卡統計，僅供店內參考；積分與會員餘額變動以 Ledger 為準。套票使用率依上方「今日 / 近 7 日 / 全部」範圍的購買紀錄計算；即將到期清單為往前{" "}
        {EXPIRE_WINDOW_DAYS} 日預警，不套用範圍篩選。
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-lg font-bold ${highlight ? "text-rose-600" : "text-slate-900"}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-bold text-slate-900">{title}</h3>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2">
      <span className="text-sm text-slate-700">{label}</span>
      <span className="text-sm font-semibold text-slate-800">{value}</span>
    </div>
  );
}

function Empty() {
  return <div className="text-xs text-slate-400">此範圍暫無資料。</div>;
}
