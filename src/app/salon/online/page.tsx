"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { SalonSidebar } from "@/components/salon/salon-sidebar";
import { updateMockBooking } from "@/lib/salon/mock-realtime";
import { loadBookings, loadSalonBootstrap } from "@/lib/salon/storage";
import { MOCK_REALTIME_EVENT } from "@/lib/salon/mock-realtime";
import type { SalonBooking, SalonBookingServiceEntry, SalonBookingStatus } from "@/lib/salon/types";
import { formatMoney, formatDateTime } from "@/lib/format";

// 過濾分頁：線上訂單嘅處理階段
type FilterKey = "pending" | "confirmed" | "checked_in" | "done";

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "pending", label: "待處理" },
  { key: "confirmed", label: "已確認" },
  { key: "checked_in", label: "已到店 / 服務中" },
  { key: "done", label: "已完成 / 取消" },
];

function inFilter(status: SalonBookingStatus, f: FilterKey): boolean {
  switch (f) {
    case "pending":
      return status === "pending";
    case "confirmed":
      return status === "confirmed";
    case "checked_in":
      return status === "checked_in" || status === "in_service";
    case "done":
      return status === "completed" || status === "cancelled" || status === "no_show";
  }
}

const STATUS_LABEL: Record<SalonBookingStatus, string> = {
  pending: "待處理",
  confirmed: "已確認",
  checked_in: "已到店",
  in_service: "服務中",
  completed: "已完成",
  settled: "已結算",
  cancelled: "已取消",
  no_show: "未到店",
};

function StatusBadge({ status }: { status: SalonBookingStatus }) {
  const tone: Record<SalonBookingStatus, string> = {
    pending: "bg-amber-100 text-amber-700",
    confirmed: "bg-sky-100 text-sky-700",
    checked_in: "bg-indigo-100 text-indigo-700",
    in_service: "bg-purple-100 text-purple-700",
    completed: "bg-emerald-100 text-emerald-700",
    settled: "bg-emerald-100 text-emerald-700",
    cancelled: "bg-slate-200 text-slate-500",
    no_show: "bg-rose-100 text-rose-700",
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function money(n: number): string {
  return formatMoney(n);
}

// ────────────────────────────────────────────────────────────────────
// 安排師傅 modal
// ────────────────────────────────────────────────────────────────────
function AssignStaffModal({
  booking,
  staffOptions,
  stationOptions,
  onClose,
  onSave,
}: {
  booking: SalonBooking;
  staffOptions: Array<{ id: string; name: string }>;
  stationOptions: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSave: (patch: {
    staffId: string;
    stationId?: string;
    services: SalonBookingServiceEntry[];
  }) => void;
}) {
  const [primaryStaff, setPrimaryStaff] = useState(booking.staffId ?? "");
  const [stationId, setStationId] = useState(booking.stationId ?? "");
  const [serviceStaff, setServiceStaff] = useState<Record<string, string>>(
    Object.fromEntries(booking.services.map((s) => [s.serviceItemId + s.name, s.staffId])),
  );

  const save = () => {
    const services = booking.services.map((s) => ({
      ...s,
      staffId: serviceStaff[s.serviceItemId + s.name] || primaryStaff || s.staffId,
    }));
    onSave({ staffId: primaryStaff, stationId: stationId || undefined, services });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-900">安排師傅 · {booking.customerName}</h3>
          <button className="text-sm text-slate-400 hover:text-slate-600" onClick={onClose} type="button">
            關閉
          </button>
        </div>

        <label className="mb-1 block text-xs font-semibold text-slate-500">負責師傅（預約主理）</label>
        <select
          className="mb-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
          value={primaryStaff}
          onChange={(e) => setPrimaryStaff(e.target.value)}
        >
          <option value="">未指派</option>
          {staffOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs font-semibold text-slate-500">房間 / 工位</label>
        <select
          className="mb-4 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-rose-200"
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
        >
          <option value="">未安排</option>
          {stationOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <div className="mb-2 text-xs font-semibold text-slate-500">各項服務執行人</div>
        <div className="space-y-2">
          {booking.services.map((s, i) => (
            <div key={i} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-800">{s.name}</div>
                <div className="text-xs text-slate-500">{s.durationMinutes} 分鐘</div>
              </div>
              <select
                className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-rose-200"
                value={serviceStaff[s.serviceItemId + s.name] || primaryStaff}
                onChange={(e) =>
                  setServiceStaff((prev) => ({ ...prev, [s.serviceItemId + s.name]: e.target.value }))
                }
              >
                <option value="">未指派</option>
                {staffOptions.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200"
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-600"
            onClick={save}
            type="button"
          >
            儲存安排
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// 線上訂單卡片
// ────────────────────────────────────────────────────────────────────
function OnlineOrderCard({
  booking,
  staffName,
  onConfirm,
  onReject,
  onAssign,
  onCheckIn,
  onStart,
  onComplete,
}: {
  booking: SalonBooking;
  staffName: (id: string) => string;
  onConfirm: () => void;
  onReject: () => void;
  onAssign: () => void;
  onCheckIn: () => void;
  onStart: () => void;
  onComplete: () => void;
}) {
  const total = useMemo(
    () =>
      booking.services.reduce((sum, s) => sum + s.price, 0) +
      (booking.productSelections ?? []).reduce((sum, p) => sum + p.price * p.quantity, 0),
    [booking],
  );
  const hasStaff = Boolean(booking.staffId);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-bold text-slate-900">{booking.customerName}</div>
          <div className="text-sm text-slate-500">
            {booking.customerPhone || "（未提供電話）"} · 單號 {booking.bookingNo}
          </div>
        </div>
        <StatusBadge status={booking.status} />
      </div>

      <div className="mt-3 grid gap-1 text-sm text-slate-600">
        <div>預約時間：{formatDateTime(booking.startAt)}</div>
        <div>負責師傅：{hasStaff ? staffName(booking.staffId) : <span className="text-amber-600">未安排</span>}</div>
        {booking.stationId ? <div>房間 / 工位：{booking.stationId}</div> : null}
        {booking.depositAmount ? (
          <div>
            定金：{money(booking.depositAmount)} {booking.depositPaid ? "（已付）" : "（未付）"}
          </div>
        ) : null}
      </div>

      <div className="mt-3 space-y-1 border-t border-slate-100 pt-3">
        {booking.services.map((s, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <span className="text-slate-800">
              {s.name} <span className="text-slate-400">· {s.durationMinutes} 分</span>
            </span>
            <span className="text-slate-500">{staffName(s.staffId) || "未派"}</span>
          </div>
        ))}
        {(booking.productSelections ?? []).map((p, i) => (
          <div key={i} className="flex items-center justify-between text-sm">
            <span className="text-slate-800">
              {p.name} × {p.quantity} <span className="text-slate-400">· 產品</span>
            </span>
          </div>
        ))}
      </div>

      {booking.notes ? (
        <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600">備註：{booking.notes}</div>
      ) : null}

      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
        <span className="text-sm font-semibold text-slate-900">預估 {money(total)}</span>
        <div className="flex flex-wrap gap-2">
          {booking.status === "pending" ? (
            <>
              <button
                className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200"
                onClick={onReject}
                type="button"
              >
                拒絕
              </button>
              <button
                className="rounded-xl bg-rose-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-600"
                onClick={onConfirm}
                type="button"
              >
                確認接單
              </button>
            </>
          ) : null}

          {booking.status === "confirmed" ? (
            <>
              <button
                className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200"
                onClick={onReject}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-xl bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                onClick={onAssign}
                type="button"
              >
                安排師傅
              </button>
              <button
                className="rounded-xl bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600"
                onClick={onCheckIn}
                type="button"
              >
                標記到店
              </button>
            </>
          ) : null}

          {booking.status === "checked_in" ? (
            <button
              className="rounded-xl bg-purple-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-purple-600"
              onClick={onStart}
              type="button"
            >
              開始服務
            </button>
          ) : null}

          {booking.status === "in_service" ? (
            <button
              className="rounded-xl bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700"
              onClick={onComplete}
              type="button"
            >
              完成
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// 主頁
// ────────────────────────────────────────────────────────────────────
export default function SalonOnlineOrdersPage() {
  const [bookings, setBookings] = useState<SalonBooking[]>([]);
  const [filter, setFilter] = useState<FilterKey>("pending");
  const [assignTarget, setAssignTarget] = useState<SalonBooking | null>(null);
  const [staffOptions, setStaffOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [stationOptions, setStationOptions] = useState<Array<{ id: string; name: string }>>([]);

  const reload = useCallback(() => {
    const all = loadBookings();
    setBookings(all.filter((b) => b.source === "online_ledger"));
  }, []);

  useEffect(() => {
    reload();
    const bootstrap = loadSalonBootstrap();
    if (bootstrap) {
      setStaffOptions(
        (bootstrap.staff ?? []).filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })),
      );
      setStationOptions(
        (bootstrap.stations ?? []).filter((s) => s.active).map((s) => ({ id: s.id, name: s.name })),
      );
    }
    const onEvent = () => reload();
    window.addEventListener(MOCK_REALTIME_EVENT, onEvent);
    // 未來 Ledger realtime 接入前的輪詢安全網；真實推送到位後可移除。
    const timer = window.setInterval(reload, 5000);
    return () => {
      window.removeEventListener(MOCK_REALTIME_EVENT, onEvent);
      window.clearInterval(timer);
    };
  }, [reload]);

  const staffName = useCallback(
    (id: string) => staffOptions.find((s) => s.id === id)?.name ?? "",
    [staffOptions],
  );

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { pending: 0, confirmed: 0, checked_in: 0, done: 0 };
    for (const b of bookings) {
      for (const f of FILTERS) if (inFilter(b.status, f.key)) c[f.key]++;
    }
    return c;
  }, [bookings]);

  const visible = useMemo(() => bookings.filter((b) => inFilter(b.status, filter)), [bookings, filter]);

  const setStatus = (id: string, status: SalonBookingStatus) => updateMockBooking(id, { status });

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <SalonSidebar />
      <div className="md:pl-[72px]">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100/95 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-900">線上訂單</h2>
            <span className="text-xs text-slate-500">來自 Ledger 線上預約</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  filter === f.key
                    ? "bg-rose-500 text-white"
                    : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                }`}
              >
                {f.label}（{counts[f.key]}）
              </button>
            ))}
          </div>
        </header>

        <main className="mx-auto max-w-3xl px-4 py-4 md:px-6">
          {visible.length === 0 ? (
            <div className="grid place-items-center rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center text-sm text-slate-500">
              此階段暫無線上訂單。
              <br />
              當客人經 Ledger 線上預約後，訂單會即時顯示於此。
            </div>
          ) : (
            <div className="space-y-3">
              {visible.map((b) => (
                <OnlineOrderCard
                  key={b.id}
                  booking={b}
                  staffName={staffName}
                  onConfirm={() => setStatus(b.id, "confirmed")}
                  onReject={() => setStatus(b.id, "cancelled")}
                  onAssign={() => setAssignTarget(b)}
                  onCheckIn={() => setStatus(b.id, "checked_in")}
                  onStart={() => setStatus(b.id, "in_service")}
                  onComplete={() => setStatus(b.id, "completed")}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {assignTarget ? (
        <AssignStaffModal
          booking={assignTarget}
          staffOptions={staffOptions}
          stationOptions={stationOptions}
          onClose={() => setAssignTarget(null)}
          onSave={(patch) => {
            updateMockBooking(assignTarget.id, patch);
            setAssignTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
