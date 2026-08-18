"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import type {
  SalonStaff,
  SalonBooking,
  SalonStaffLeave,
  SalonStaffShift,
  SalonBootstrap,
} from "@/lib/salon/types";
import {
  loadSalonStaff,
  saveSalonStaff,
  loadBookings,
  loadSalonOrders,
  loadSalonProductSales,
  loadSalonStaffLeaves,
  saveSalonStaffLeaves,
  loadSalonStaffShifts,
  saveSalonStaffShifts,
  loadSalonBootstrap,
} from "@/lib/salon/storage";
import {
  getSalonStaffRoleLabels,
  getSalonStaffLevelLabels,
  SALON_STAFF_STATUS_LABELS,
  SALON_STAFF_STATUS_ORDER,
  SALON_STAFF_STATUS_BADGE,
} from "@/lib/salon/salon-labels";

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-3 text-sm font-bold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

export function StaffDetail() {
  const params = useParams<{ id: string }>();
  const staffId = typeof params.id === "string" ? params.id : "";
  const [staff, setStaff] = useState<SalonStaff | null>(null);
  const [leaves, setLeaves] = useState<SalonStaffLeave[]>([]);
  const [shifts, setShifts] = useState<SalonStaffShift[]>([]);
  const [bootstrap, setBootstrap] = useState<SalonBootstrap | null>(null);

  // 表單態
  const [leaveStart, setLeaveStart] = useState("");
  const [leaveEnd, setLeaveEnd] = useState("");
  const [leaveReason, setLeaveReason] = useState("");
  const [shiftDate, setShiftDate] = useState("");
  const [shiftStart, setShiftStart] = useState("09:00");
  const [shiftEnd, setShiftEnd] = useState("18:00");

  useEffect(() => {
    const all = loadSalonStaff();
    setStaff(all.find((s) => s.id === staffId) ?? null);
    setLeaves(loadSalonStaffLeaves().filter((l) => l.staffId === staffId));
    setShifts(loadSalonStaffShifts().filter((s) => s.staffId === staffId));
    setBootstrap(loadSalonBootstrap());
  }, [staffId]);

  // 可配置角色 / 級別標籤（依 bootstrap；缺省回退預設，再回退 id）
  const roleLabels = useMemo(() => getSalonStaffRoleLabels(bootstrap), [bootstrap]);
  const levelLabels = useMemo(() => getSalonStaffLevelLabels(bootstrap), [bootstrap]);

  const bookings = useMemo(() => loadBookings(), [staff, leaves, shifts]);
  const orders = useMemo(() => loadSalonOrders(), [staff, leaves, shifts]);
  const productSales = useMemo(() => loadSalonProductSales(), [staff, leaves, shifts]);

  // 工作記錄：booking 主員工 或 任一服務細項執行人 = 此員工
  const workRecords = useMemo(
    () =>
      bookings
        .filter(
          (b) =>
            b.staffId === staffId ||
            b.services.some((sv) => sv.staffId === staffId),
        )
        .sort((a, b) => (a.startAt < b.startAt ? 1 : -1)),
    [bookings, staffId],
  );

  // 工錢匯總：訂單中 kind=service 且 staffId=此員工 的 wageAmount 加總
  const wageSummary = useMemo(() => {
    let total = 0;
    let count = 0;
    for (const o of orders) {
      for (const it of o.items) {
        if (it.kind === "service" && it.staffId === staffId && it.wageAmount) {
          total += it.wageAmount;
          count += 1;
        }
      }
    }
    return { total, count };
  }, [orders, staffId]);

  // 產品佣金匯總（R4：兼計快速開單併入同單的產品佣金，與舊 SalonProductSale 歷史紀錄）
  const commissionSummary = useMemo(() => {
    let total = 0;
    let count = 0;
    for (const s of productSales) {
      if (s.staffId === staffId) {
        total += s.commissionAmount;
        count += 1;
      }
    }
    for (const o of orders) {
      for (const it of o.items) {
        if (it.kind === "product" && it.staffId === staffId && it.commissionAmount) {
          total += it.commissionAmount;
          count += 1;
        }
      }
    }
    return { total, count };
  }, [productSales, orders, staffId]);

  if (!staff) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-center text-sm text-slate-400">
        找不到此員工。<Link href="/salon/staff" className="text-rose-600 hover:underline">返回員工列表</Link>
      </div>
    );
  }

  const setStatus = (status: SalonStaff["status"]) => {
    const next = { ...staff, status, updatedAt: new Date().toISOString() };
    saveSalonStaff(loadSalonStaff().map((s) => (s.id === staff.id ? next : s)));
    setStaff(next);
  };

  const addLeave = () => {
    if (!leaveStart || !leaveEnd) {
      alert("請選擇開始與結束日");
      return;
    }
    const rec: SalonStaffLeave = {
      id: genId("leave"),
      staffId,
      start: leaveStart,
      end: leaveEnd,
      reason: leaveReason.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    const next = [...loadSalonStaffLeaves().filter((l) => l.staffId !== staffId), rec];
    saveSalonStaffLeaves(next);
    setLeaves(next);
    setLeaveStart("");
    setLeaveEnd("");
    setLeaveReason("");
  };

  const addShift = () => {
    if (!shiftDate) {
      alert("請選擇上班日");
      return;
    }
    const rec: SalonStaffShift = {
      id: genId("shift"),
      staffId,
      date: shiftDate,
      start: shiftStart,
      end: shiftEnd,
      createdAt: new Date().toISOString(),
    };
    const next = [...loadSalonStaffShifts().filter((s) => s.staffId !== staffId), rec];
    saveSalonStaffShifts(next);
    setShifts(next);
    setShiftDate("");
  };

  const deleteLeave = (id: string) => {
    const next = loadSalonStaffLeaves().filter((l) => l.id !== id);
    saveSalonStaffLeaves(next);
    setLeaves(next);
  };

  const deleteShift = (id: string) => {
    const next = loadSalonStaffShifts().filter((s) => s.id !== id);
    saveSalonStaffShifts(next);
    setShifts(next);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-24 md:p-6 md:pb-6">
      <div className="flex items-center justify-between">
        <Link href="/salon/staff" className="text-sm text-slate-500 hover:text-slate-700">
          ← 員工列表
        </Link>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${SALON_STAFF_STATUS_BADGE[staff.status]}`}
        >
          {SALON_STAFF_STATUS_LABELS[staff.status]}
        </span>
      </div>

      {/* Profile */}
      <Section title="員工資料">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <div className="text-xs text-slate-400">姓名</div>
            <div className="font-semibold text-slate-800">{staff.name}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">暱稱</div>
            <div className="font-semibold text-slate-800">{staff.nickname || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">角色</div>
            <div className="font-semibold text-slate-800">
              {staff.roles.map((r) => roleLabels[r] ?? r).join(" / ") || "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-400">級別</div>
            <div className="font-semibold text-slate-800">{levelLabels[staff.level] ?? staff.level}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">電話</div>
            <div className="font-semibold text-slate-800">{staff.phone || "—"}</div>
          </div>
          <div>
            <div className="text-xs text-slate-400">入職日</div>
            <div className="font-semibold text-slate-800">{staff.hiredAt || "—"}</div>
          </div>
        </div>
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium text-slate-500">狀態操作</div>
          <div className="flex flex-wrap gap-1.5">
            {SALON_STAFF_STATUS_ORDER.map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatus(st)}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  staff.status === st
                    ? "bg-rose-500 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {SALON_STAFF_STATUS_LABELS[st]}
              </button>
            ))}
          </div>
        </div>
      </Section>

      {/* 工錢 / 佣金匯總 */}
      <div className="grid grid-cols-2 gap-4">
        <Section title="工錢匯總">
          <div className="text-2xl font-bold text-slate-900">MOP {wageSummary.total}</div>
          <div className="text-xs text-slate-500">
            共 {wageSummary.count} 項服務（依結帳單工錢計算）
          </div>
        </Section>
        <Section title="產品佣金匯總">
          <div className="text-2xl font-bold text-emerald-600">MOP {commissionSummary.total}</div>
          <div className="text-xs text-slate-500">共 {commissionSummary.count} 筆產品銷售</div>
        </Section>
      </div>

      {/* 工作記錄 */}
      <Section title="工作記錄（預約 / 服務）">
        {workRecords.length === 0 ? (
          <p className="text-xs text-slate-400">尚無工作記錄。</p>
        ) : (
          <ul className="grid gap-1.5">
            {workRecords.slice(0, 30).map((b: SalonBooking) => (
              <li key={b.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-800">{b.customerName}</div>
                  <div className="truncate text-[11px] text-slate-500">
                    {b.services.map((s) => s.name).join("、")}
                  </div>
                </div>
                <div className="ml-2 shrink-0 text-right text-[11px] text-slate-500">
                  <div>{b.startAt.slice(0, 10)}</div>
                  <div>{b.status}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 放假記錄 */}
      <Section title="放假記錄">
        <div className="mb-3 grid grid-cols-2 gap-2">
          <input type="date" value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          <input type="date" value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          <input
            type="text"
            value={leaveReason}
            onChange={(e) => setLeaveReason(e.target.value)}
            placeholder="原因（可選）"
            className="col-span-2 rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={addLeave}
          className="mb-3 rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200"
        >
          + 加放假
        </button>
        {leaves.length === 0 ? (
          <p className="text-xs text-slate-400">尚無放假記錄。</p>
        ) : (
          <ul className="grid gap-1.5">
            {[...leaves].sort((a, b) => (a.start < b.start ? 1 : -1)).map((l) => (
              <li key={l.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <div>
                  <span className="font-medium text-slate-800">
                    {l.start} ~ {l.end}
                  </span>
                  {l.reason ? <span className="ml-2 text-[11px] text-slate-500">{l.reason}</span> : null}
                </div>
                <button type="button" onClick={() => deleteLeave(l.id)} className="text-xs text-rose-600 hover:underline">
                  刪除
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Shift 記錄 */}
      <Section title="上班時段記錄">
        <div className="mb-3 grid grid-cols-3 gap-2">
          <input type="date" value={shiftDate} onChange={(e) => setShiftDate(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          <input type="time" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          <input type="time" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} className="rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        </div>
        <button
          type="button"
          onClick={addShift}
          className="mb-3 rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200"
        >
          + 加上班時段
        </button>
        {shifts.length === 0 ? (
          <p className="text-xs text-slate-400">尚無上班時段記錄。</p>
        ) : (
          <ul className="grid gap-1.5">
            {[...shifts].sort((a, b) => (a.date < b.date ? 1 : -1)).map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <div>
                  <span className="font-medium text-slate-800">{s.date}</span>
                  <span className="ml-2 text-[11px] text-slate-500">
                    {s.start} ~ {s.end}
                  </span>
                  {s.note ? <span className="ml-2 text-[11px] text-slate-500">{s.note}</span> : null}
                </div>
                <button type="button" onClick={() => deleteShift(s.id)} className="text-xs text-rose-600 hover:underline">
                  刪除
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
