"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import type { SalonStaff, SalonBooking, SalonBootstrap } from "@/lib/salon/types";
import { loadSalonStaff, loadBookings, loadSalonBootstrap } from "@/lib/salon/storage";
import {
  getSalonStaffRoleTypes,
  getSalonStaffRoleLabels,
  getSalonStaffLevelLabels,
  SALON_STAFF_STATUS_LABELS,
  SALON_STAFF_STATUS_BADGE,
} from "@/lib/salon/salon-labels";

function isSameDay(iso: string, d: Date): boolean {
  const dt = new Date(iso);
  return dt.getFullYear() === d.getFullYear() && dt.getMonth() === d.getMonth() && dt.getDate() === d.getDate();
}

export function StaffList() {
  const [staff, setStaff] = useState<SalonStaff[]>([]);
  const [bookings, setBookings] = useState<SalonBooking[]>([]);
  const [bootstrap, setBootstrap] = useState<SalonBootstrap | null>(null);

  useEffect(() => {
    setStaff(loadSalonStaff());
    setBookings(loadBookings());
    setBootstrap(loadSalonBootstrap());
  }, []);

  // 可配置角色 / 級別標籤（依 bootstrap；缺省回退預設，再回退 id）
  const roleLabels = useMemo(() => getSalonStaffRoleLabels(bootstrap), [bootstrap]);
  const levelLabels = useMemo(() => getSalonStaffLevelLabels(bootstrap), [bootstrap]);
  const roleOrder = useMemo(
    () => getSalonStaffRoleTypes(bootstrap).map((t) => t.id),
    [bootstrap],
  );

  const today = useMemo(() => new Date(), []);

  // 每位員工今日相關預約（主員工 或 任一服務細項執行人）
  const staffToday = useMemo(() => {
    const map = new Map<string, SalonBooking[]>();
    for (const b of bookings) {
      if (!isSameDay(b.startAt, today)) continue;
      const ids = new Set<string>([b.staffId, ...b.services.map((s) => s.staffId)]);
      for (const id of ids) {
        if (!map.has(id)) map.set(id, []);
        map.get(id)!.push(b);
      }
    }
    return map;
  }, [bookings, today]);

  const statusOf = (s: SalonStaff): { busy: boolean; current?: SalonBooking } => {
    if (s.status !== "active") return { busy: false };
    const list = staffToday.get(s.id) ?? [];
    const current = list.find((b) => b.status === "in_service" || b.status === "checked_in");
    return {
      busy: Boolean(current) || list.some((b) => b.status === "confirmed" || b.status === "pending"),
      current,
    };
  };

  // 依角色分組（可兼任多角色，故同一人可能出現於多組）
  const grouped = useMemo(() => {
    const g: Record<string, SalonStaff[]> = {};
    for (const r of roleOrder) g[r] = [];
    for (const s of staff) {
      for (const r of s.roles) {
        if (!g[r]) g[r] = [];
        g[r].push(s);
      }
    }
    return g;
  }, [staff, roleOrder]);

  return (
    <div className="mx-auto max-w-3xl p-4 pb-24 md:p-6 md:pb-6">
      <h1 className="mb-4 text-xl font-bold text-slate-900">員工管理</h1>

      {roleOrder.map((role) => {
        const list = grouped[role] ?? [];
        if (list.length === 0) return null;
        return (
          <section key={role} className="mb-5">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-bold text-slate-700">{roleLabels[role] ?? role}</h2>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                {list.length}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {list.map((s) => {
                const st = statusOf(s);
                const todayCount = (staffToday.get(s.id) ?? []).length;
                return (
                  <Link
                    key={s.id}
                    href={`/salon/staff/${s.id}`}
                    className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-rose-300"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-bold text-slate-900">{s.nickname ?? s.name}</span>
                        <span className="text-xs text-slate-400">{s.name}</span>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${SALON_STAFF_STATUS_BADGE[s.status]}`}
                      >
                        {SALON_STAFF_STATUS_LABELS[s.status]}
                      </span>
                    </div>

                    <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-slate-500">
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
                        {levelLabels[s.level] ?? s.level}
                      </span>
                      {/* 其餘兼任角色（除當前組別） */}
                      {s.roles
                        .filter((r) => r !== role)
                        .map((r) => (
                          <span key={r} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">
                            {roleLabels[r] ?? r}
                          </span>
                        ))}
                    </div>

                    {/* 今日動態 + 在忙 / 空閒 */}
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[11px] text-slate-500">今日 {todayCount} 單</span>
                      {s.status !== "active" ? (
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                          未上班
                        </span>
                      ) : st.current ? (
                        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-600">
                          在忙 · {st.current.customerName}
                        </span>
                      ) : todayCount > 0 ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                          有預約
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                          空閒
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}

      {staff.length === 0 && (
        <p className="py-10 text-center text-sm text-slate-400">尚無員工，請到「設置 → 員工」新增。</p>
      )}
    </div>
  );
}
