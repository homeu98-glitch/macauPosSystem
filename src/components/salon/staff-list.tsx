"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import type { SalonStaff } from "@/lib/salon/types";
import { loadSalonStaff } from "@/lib/salon/storage";
import {
  SALON_STAFF_ROLE_LABELS,
  SALON_STAFF_LEVEL_LABELS,
  SALON_STAFF_STATUS_LABELS,
  SALON_STAFF_STATUS_BADGE,
} from "@/lib/salon/salon-labels";

export function StaffList() {
  const [staff, setStaff] = useState<SalonStaff[]>([]);

  useEffect(() => {
    setStaff(loadSalonStaff());
  }, []);

  return (
    <div className="mx-auto max-w-3xl p-4 pb-24 md:p-6 md:pb-6">
      <h1 className="mb-4 text-xl font-bold text-slate-900">員工管理</h1>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {staff.map((s) => (
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
              <span className="rounded-full bg-rose-50 px-2 py-0.5 font-semibold text-rose-600">
                {SALON_STAFF_ROLE_LABELS[s.role]}
              </span>
              <span className="rounded-full bg-amber-50 px-2 py-0.5 font-semibold text-amber-700">
                {SALON_STAFF_LEVEL_LABELS[s.level]}
              </span>
              {s.phone ? <span>電話 {s.phone}</span> : null}
            </div>
          </Link>
        ))}
        {staff.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">尚無員工，請到「設置 → 員工」新增。</p>
        )}
      </div>
    </div>
  );
}
