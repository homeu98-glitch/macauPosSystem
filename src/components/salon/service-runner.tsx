"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

import type { SalonBooking, SalonStaff, SalonServiceItem, SalonStation } from "@/lib/salon/types";
import { loadSalonBootstrap, loadBookings } from "@/lib/salon/storage";
import {
  updateMockBooking,
  advanceBookingStatus,
  MOCK_REALTIME_EVENT,
} from "@/lib/salon/mock-realtime";

const STATUS_LABEL: Record<string, string> = {
  pending: "待確認",
  confirmed: "已確認",
  checked_in: "已接待",
  in_service: "服務中",
  completed: "已完成",
  settled: "已結帳",
  cancelled: "已取消",
  no_show: "未到店",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-slate-100 text-slate-600",
  confirmed: "bg-blue-100 text-blue-700",
  checked_in: "bg-amber-100 text-amber-700",
  in_service: "bg-violet-100 text-violet-700",
  completed: "bg-emerald-100 text-emerald-700",
  settled: "bg-orange-100 text-orange-700",
  cancelled: "bg-rose-100 text-rose-700",
  no_show: "bg-gray-100 text-gray-600",
};

export function ServiceRunner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const bookingId = params.id;

  const [booking, setBooking] = useState<SalonBooking | null>(null);
  const [staffList, setStaffList] = useState<SalonStaff[]>([]);
  const [items, setItems] = useState<SalonServiceItem[]>([]);
  const [stations, setStations] = useState<SalonStation[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [actionError, setActionError] = useState("");

  // Load
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
      setItems(bootstrap.serviceItems);
      setStations(bootstrap.stations);
    }
  }, [bookingId]);

  // Listen to realtime updates
  useEffect(() => {
    function handler() {
      const b = loadBookings().find((x) => x.id === bookingId);
      if (b) setBooking(b);
    }
    if (typeof window !== "undefined") {
      window.addEventListener(MOCK_REALTIME_EVENT, handler);
      return () => window.removeEventListener(MOCK_REALTIME_EVENT, handler);
    }
  }, [bookingId]);

  const staffMap = useMemo(() => {
    const map: Record<string, SalonStaff> = {};
    for (const s of staffList) map[s.id] = s;
    return map;
  }, [staffList]);

  const stationMap = useMemo(() => {
    const map: Record<string, SalonStation> = {};
    for (const s of stations) map[s.id] = s;
    return map;
  }, [stations]);

  const itemMap = useMemo(() => {
    const map: Record<string, SalonServiceItem> = {};
    for (const i of items) map[i.id] = i;
    return map;
  }, [items]);

  const handleAdvance = useCallback(
    (nextStatus: SalonBooking["status"]) => {
      setActionError("");
      const updated = advanceBookingStatus(bookingId, nextStatus);
      if (updated) {
        setBooking(updated);
      } else {
        setActionError("更新失敗，請重試。");
      }
    },
    [bookingId]
  );

  const handleAddService = useCallback(() => {
    setActionError("");
    // Phase 3: open service picker modal; for now placeholder
    setActionError("加項功能將於 Phase 3 開放。");
  }, []);

  const handleChangeStaff = useCallback(
    (newStaffId: string) => {
      setActionError("");
      const updated = updateMockBooking(bookingId, { staffId: newStaffId });
      if (updated) setBooking(updated);
    },
    [bookingId]
  );

  const handleChangeStation = useCallback(
    (newStationId: string) => {
      setActionError("");
      const updated = updateMockBooking(bookingId, {
        stationId: newStationId || undefined,
      });
      if (updated) setBooking(updated);
    },
    [bookingId]
  );

  if (notFound) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center md:pl-[88px]">
        <div>
          <div className="text-base font-semibold text-slate-900">找不到預約</div>
          <div className="mt-2 text-sm text-slate-500">
            預約 ID <code>{bookingId}</code> 不存在或已被刪除。
          </div>
          <Link
            href="/salon"
            className="mt-4 inline-block rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600"
          >
            回工作台
          </Link>
        </div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center md:pl-[88px]">
        <div className="text-base font-semibold text-slate-900">載入中…</div>
      </div>
    );
  }

  const status = booking.status;
  const canCheckIn = status === "confirmed" || status === "pending";
  const canStartService = status === "checked_in";
  const canComplete = status === "in_service";
  const canCheckout = status === "completed";
  const canCancel = ["pending", "confirmed", "checked_in"].includes(status);
  const canNoShow = status === "confirmed";

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 md:pl-[72px]">
      <div className="mx-auto max-w-3xl px-4 py-6">
        {/* Header — 移除返回按鈕（sidebar 已提供導航） */}
        <div className="mb-4 flex items-center justify-end">
          <div className="text-sm text-slate-500">{booking.bookingNo}</div>
        </div>

        {/* Status badge */}
        <div className="mb-4">
          <span
            className={`inline-block rounded-full px-3 py-1 text-xs font-bold ${
              STATUS_COLORS[status] ?? "bg-slate-100 text-slate-600"
            }`}
          >
            {STATUS_LABEL[status] ?? status}
          </span>
        </div>

        {/* Customer card */}
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between">
            <div>
              <div className="text-2xl font-bold text-slate-900">{booking.customerName}</div>
              <div className="mt-1 text-sm text-slate-500">
                {booking.customerPhone} · {booking.source === "online_ledger" ? "線上預約" : booking.source === "phone" ? "電話" : "走進"}
              </div>
            </div>
            <div className="text-right text-sm text-slate-500">
              <div>
                {new Date(booking.startAt).toLocaleDateString("zh-HK", {
                  month: "short",
                  day: "numeric",
                  weekday: "short",
                })}
              </div>
              <div className="font-semibold text-slate-700">
                {new Date(booking.startAt).toLocaleTimeString("zh-HK", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {` – `}
                {new Date(booking.endAt).toLocaleTimeString("zh-HK", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Services */}
        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900">服務項目</h3>
            <button
              type="button"
              onClick={handleAddService}
              className="rounded-xl bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-200"
            >
              + 加項
            </button>
          </div>
          <div className="grid gap-2">
            {booking.services.map((s, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"
              >
                <div>
                  <div className="text-sm font-semibold text-slate-800">{s.name}</div>
                  <div className="text-xs text-slate-500">
                    {itemMap[s.serviceItemId]?.description ?? ""} · {s.durationMinutes}分 · ${s.price}
                  </div>
                </div>
                <div className="text-xs text-slate-500">
                  技師：{staffMap[s.staffId]?.nickname ?? staffMap[s.staffId]?.name ?? "未知"}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Staff & Station */}
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 text-xs font-semibold text-slate-500">主技師</div>
            <select
              value={booking.staffId}
              onChange={(e) => handleChangeStaff(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
            >
              {staffList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nickname ?? s.name} ({s.role})
                </option>
              ))}
            </select>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 text-xs font-semibold text-slate-500">房型 / 椅</div>
            <select
              value={booking.stationId ?? ""}
              onChange={(e) => handleChangeStation(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
            >
              <option value="">未分配</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.type})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Notes */}
        {booking.notes && (
          <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-semibold text-slate-500">備註</div>
            <div className="mt-1 text-sm text-slate-700">{booking.notes}</div>
          </div>
        )}

        {/* Action buttons */}
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {canCheckIn && (
            <button
              type="button"
              onClick={() => handleAdvance("checked_in")}
              className="rounded-xl bg-amber-500 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-amber-600"
            >
              已接待
            </button>
          )}
          {canStartService && (
            <button
              type="button"
              onClick={() => handleAdvance("in_service")}
              className="rounded-xl bg-violet-500 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-violet-600"
            >
              開始服務
            </button>
          )}
          {canComplete && (
            <button
              type="button"
              onClick={() => handleAdvance("completed")}
              className="rounded-xl bg-emerald-500 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-emerald-600"
            >
              完成服務
            </button>
          )}
          {canCheckout && (
            <button
              type="button"
              onClick={() => router.push(`/salon/checkout/${booking.id}`)}
              className="rounded-xl bg-orange-500 px-4 py-3 text-sm font-bold text-white shadow-sm hover:bg-orange-600"
            >
              結帳
            </button>
          )}
          {canCancel && (
            <button
              type="button"
              onClick={() => handleAdvance("cancelled")}
              className="rounded-xl bg-rose-100 px-4 py-3 text-sm font-bold text-rose-700 hover:bg-rose-200"
            >
              取消預約
            </button>
          )}
          {canNoShow && (
            <button
              type="button"
              onClick={() => handleAdvance("no_show")}
              className="rounded-xl bg-gray-100 px-4 py-3 text-sm font-bold text-gray-700 hover:bg-gray-200"
            >
              未到店
            </button>
          )}
        </div>

        {actionError && (
          <div className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {actionError}
          </div>
        )}

        {/* Ledger hint */}
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <span className="font-semibold">定金 / 退款提示：</span>
          若涉及定金扣款或退款，請到 Ledger 後台操作。POS 僅顯示記錄。
        </div>
      </div>
    </div>
  );
}
