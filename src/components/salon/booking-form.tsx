"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type {
  SalonBooking,
  SalonServiceItem,
  SalonStaff,
  SalonStation,
  SalonServiceCategory,
} from "@/lib/salon/types";
import { loadSalonBootstrap } from "@/lib/salon/storage";
import {
  pushMockBooking,
  ensureSalonCustomer,
  updateMockBooking,
} from "@/lib/salon/mock-realtime";

interface BookingFormProps {
  initialStaffId?: string;
  initialDate?: string; // ISO
  initialHour?: number;
  initialMinute?: number;
  onClose?: () => void;
  onSuccess?: (booking: SalonBooking) => void;
}

export function BookingForm({
  initialStaffId,
  initialDate,
  initialHour,
  initialMinute,
  onClose,
  onSuccess,
}: BookingFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Resolve defaults from URL or props
  const defaultStaffId = initialStaffId ?? searchParams.get("staffId") ?? "";
  const defaultDate = initialDate ?? searchParams.get("date") ?? new Date().toISOString();
  const defaultHour = initialHour ?? Number(searchParams.get("hour") ?? new Date().getHours());
  const defaultMinute = initialMinute ?? Number(searchParams.get("minute") ?? 0);

  const [bootstrap, setBootstrap] = useState<ReturnType<typeof loadSalonBootstrap>>(null);
  const [staffList, setStaffList] = useState<SalonStaff[]>([]);
  const [items, setItems] = useState<SalonServiceItem[]>([]);
  const [stations, setStations] = useState<SalonStation[]>([]);
  const [categories, setCategories] = useState<SalonServiceCategory[]>([]);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [source, setSource] = useState<"walk_in" | "phone">("walk_in");
  const [staffId, setStaffId] = useState(defaultStaffId);
  const [stationId, setStationId] = useState("");
  const [dateStr, setDateStr] = useState(() => {
    const d = new Date(defaultDate);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [hour, setHour] = useState(defaultHour);
  const [minute, setMinute] = useState(defaultMinute);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const b = loadSalonBootstrap();
    setBootstrap(b);
    if (b) {
      setStaffList(b.staff.filter((s) => s.active));
      setItems(b.serviceItems.filter((i) => i.active));
      setStations(b.stations.filter((s) => s.active));
      setCategories(b.serviceCategories.filter((c) => c.active));
      if (!defaultStaffId && b.staff[0]) {
        setStaffId(b.staff[0].id);
      }
    }
  }, [defaultStaffId]);

  // Auto-select station based on first selected service
  useEffect(() => {
    if (selectedServiceIds.length === 0) {
      setStationId("");
      return;
    }
    const firstItem = items.find((i) => i.id === selectedServiceIds[0]);
    if (!firstItem?.stationTypes?.length) return;
    const compatible = stations.filter((s) => firstItem.stationTypes!.includes(s.type));
    if (compatible.length > 0 && !compatible.find((s) => s.id === stationId)) {
      setStationId(compatible[0].id);
    }
  }, [selectedServiceIds, items, stations, stationId]);

  const selectedServices = useMemo(
    () => items.filter((i) => selectedServiceIds.includes(i.id)),
    [items, selectedServiceIds]
  );

  const totalDuration = useMemo(
    () => selectedServices.reduce((sum, s) => sum + s.durationMinutes, 0),
    [selectedServices]
  );

  const totalPrice = useMemo(
    () => selectedServices.reduce((sum, s) => sum + s.price, 0),
    [selectedServices]
  );

  const validate = useCallback((): boolean => {
    const next: Record<string, string> = {};
    if (!customerName.trim()) next.name = "請輸入客戶姓名";
    if (!/^\d{8}$/.test(customerPhone.replace(/\D/g, ""))) next.phone = "請輸入 8 位數字電話";
    if (!staffId) next.staff = "請選擇技師";
    if (selectedServiceIds.length === 0) next.services = "請選擇至少一項服務";
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [customerName, customerPhone, staffId, selectedServiceIds]);

  const handleSubmit = useCallback(() => {
    if (!validate()) return;
    setSubmitting(true);

    const [y, m, d] = dateStr.split("-").map(Number);
    const startAt = new Date(y, m - 1, d, hour, minute, 0).toISOString();

    const services = selectedServices.map((s) => ({
      serviceItemId: s.id,
      name: s.name,
      price: s.price,
      durationMinutes: s.durationMinutes,
      staffId,
    }));

    const booking = pushMockBooking({
      id: "booking-" + Math.random().toString(36).slice(2, 10),
      source,
      customerName: customerName.trim(),
      customerPhone: customerPhone.replace(/\D/g, ""),
      staffId,
      stationId: stationId || undefined,
      startAt,
      services,
      status: "confirmed",
      notes: notes.trim() || undefined,
    });

    // Phase 4：walk-in / 電話開單自動 upsert 客戶檔案並連結 customerId
    const customer = ensureSalonCustomer(customerName.trim(), customerPhone);
    updateMockBooking(booking.id, { customerId: customer.id });

    setSubmitting(false);
    onSuccess?.(booking);
    // 導航到工作台而非詳情頁（sidebar 已提供導航）
    router.push("/salon");
  }, [
    validate,
    dateStr,
    hour,
    minute,
    selectedServices,
    staffId,
    stationId,
    source,
    customerName,
    customerPhone,
    notes,
    onSuccess,
    router,
  ]);

  const toggleService = useCallback((id: string) => {
    setSelectedServiceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }, []);

  const timeOptions = useMemo(() => {
    const opts: Array<{ value: number; label: string }> = [];
    for (let h = 6; h < 22; h++) {
      for (let m = 0; m < 60; m += 30) {
        opts.push({ value: h * 60 + m, label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` });
      }
    }
    return opts;
  }, []);

  const selectedTimeValue = hour * 60 + minute;

  return (
    <div className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">開立新預約</h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-slate-100 px-3 py-1 text-sm font-semibold text-slate-700 hover:bg-slate-200"
          >
            ✕ 關閉
          </button>
        )}
      </div>

      <div className="grid gap-4">
        {/* Source */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">來源</label>
          <div className="flex gap-2">
            {(["walk_in", "phone"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                  source === s
                    ? "bg-orange-500 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {s === "walk_in" ? "走進客戶" : "電話預約"}
              </button>
            ))}
          </div>
        </div>

        {/* Customer */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-500">
              客戶姓名 <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => {
                setCustomerName(e.target.value);
                setErrors((prev) => ({ ...prev, name: "" }));
              }}
              className={`w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 ${
                errors.name ? "border-rose-300 focus:ring-rose-200" : "border-slate-200 focus:ring-orange-200"
              }`}
              placeholder="姓名"
            />
            {errors.name && <p className="mt-1 text-xs text-rose-500">{errors.name}</p>}
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-500">
              電話 <span className="text-rose-500">*</span>
            </label>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={8}
              value={customerPhone}
              onChange={(e) => {
                setCustomerPhone(e.target.value.replace(/\D/g, "").slice(0, 8));
                setErrors((prev) => ({ ...prev, phone: "" }));
              }}
              className={`w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 ${
                errors.phone ? "border-rose-300 focus:ring-rose-200" : "border-slate-200 focus:ring-orange-200"
              }`}
              placeholder="8 位數字"
            />
            {errors.phone && <p className="mt-1 text-xs text-rose-500">{errors.phone}</p>}
          </div>
        </div>

        {/* Date + Time */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-500">日期</label>
            <input
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-500">時間</label>
            <select
              value={selectedTimeValue}
              onChange={(e) => {
                const v = Number(e.target.value);
                setHour(Math.floor(v / 60));
                setMinute(v % 60);
              }}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
            >
              {timeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Staff */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">
            技師 <span className="text-rose-500">*</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {staffList.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setStaffId(s.id);
                  setErrors((prev) => ({ ...prev, staff: "" }));
                }}
                className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                  staffId === s.id
                    ? "bg-orange-500 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {s.nickname ?? s.name}
                <span className="ml-1 text-[10px] opacity-70">({s.role})</span>
              </button>
            ))}
          </div>
          {errors.staff && <p className="mt-1 text-xs text-rose-500">{errors.staff}</p>}
        </div>

        {/* Station */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">房型 / 椅</label>
          <select
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
          >
            <option value="">自動分配</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.type}) · {s.location}
              </option>
            ))}
          </select>
        </div>

        {/* Services */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">
            服務項目 <span className="text-rose-500">*</span>
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {categories.map((cat) => {
              const catItems = items.filter((i) => i.categoryId === cat.id);
              if (catItems.length === 0) return null;
              return (
                <div key={cat.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-2 text-xs font-bold" style={{ color: cat.color }}>
                    {cat.name}
                  </div>
                  <div className="grid gap-1.5">
                    {catItems.map((item) => {
                      const selected = selectedServiceIds.includes(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => toggleService(item.id)}
                          className={`flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition ${
                            selected
                              ? "bg-orange-500 text-white"
                              : "bg-white text-slate-700 hover:bg-slate-100"
                          }`}
                        >
                          <span className="font-medium">{item.name}</span>
                          <span className="text-xs opacity-80">
                            ${item.price} · {item.durationMinutes}分
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          {errors.services && <p className="mt-1 text-xs text-rose-500">{errors.services}</p>}
        </div>

        {/* Summary */}
        {selectedServices.length > 0 && (
          <div className="rounded-xl bg-orange-50 p-3 text-sm">
            <div className="flex items-center justify-between font-semibold text-orange-800">
              <span>已選 {selectedServices.length} 項</span>
              <span>合計 ${totalPrice} · {totalDuration} 分鐘</span>
            </div>
            <div className="mt-1 text-xs text-orange-700">
              預計結束：{(() => {
                const [y, m, d] = dateStr.split("-").map(Number);
                const end = new Date(y, m - 1, d, hour, minute + totalDuration);
                return `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
              })()}
            </div>
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-500">備註</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
            placeholder="客戶特殊需求、過敏史等"
          />
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 rounded-xl bg-orange-500 py-3 text-sm font-bold text-white shadow-sm hover:bg-orange-600 disabled:opacity-50"
          >
            {submitting ? "建立中…" : "確認開單"}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-slate-100 px-6 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-200"
            >
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
