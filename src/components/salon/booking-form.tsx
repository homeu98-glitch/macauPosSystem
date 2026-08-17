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
  const [catFilter, setCatFilter] = useState<string | null>(null);
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

  const endTime = useMemo(() => {
    if (selectedServices.length === 0) return "—";
    const [y, m, d] = dateStr.split("-").map(Number);
    const end = new Date(y, m - 1, d, hour, minute + totalDuration);
    return `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
  }, [selectedServices, dateStr, hour, minute, totalDuration]);

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

  const visibleItems = useMemo(
    () => (catFilter ? items.filter((i) => i.categoryId === catFilter) : items),
    [catFilter, items]
  );

  return (
    <div className="flex h-full flex-col">
      {/* 頂部 sticky 標題列 + 來源 */}
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-100/95 px-4 py-3 backdrop-blur md:px-6">
        <h2 className="text-lg font-bold text-slate-900">快速開單</h2>
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            {(["walk_in", "phone"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={`rounded-xl px-3 py-1.5 text-sm font-semibold ${
                  source === s
                    ? "bg-orange-500 text-white"
                    : "bg-slate-200 text-slate-700 hover:bg-slate-300"
                }`}
              >
                {s === "walk_in" ? "走進" : "電話"}
              </button>
            ))}
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-300"
            >
              關閉
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 min-h-0 flex-col gap-4 p-4 md:flex-row md:gap-6 md:px-6">
        {/* 左：服務目錄 */}
        <section className="min-h-0 md:flex-1">
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCatFilter(null)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                catFilter === null
                  ? "bg-orange-500 text-white"
                  : "bg-slate-200 text-slate-700 hover:bg-slate-300"
              }`}
            >
              全部
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCatFilter(cat.id)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  catFilter === cat.id
                    ? "bg-orange-500 text-white"
                    : "bg-slate-200 text-slate-700 hover:bg-slate-300"
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>

          {visibleItems.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 px-4 py-10 text-center text-sm text-slate-400">
              此類目暫無服務項目
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {visibleItems.map((item) => {
                const selected = selectedServiceIds.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => toggleService(item.id)}
                    className={`flex min-h-[64px] flex-col justify-between rounded-xl px-3 py-2 text-left text-sm transition ${
                      selected
                        ? "bg-orange-500 text-white"
                        : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <span className="font-medium leading-tight">{item.name}</span>
                    <span className="mt-1 text-xs opacity-80">
                      ${item.price} · {item.durationMinutes}分
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 右：開單摘要（桌面 sticky 常駐） */}
        <aside className="md:w-[360px] md:shrink-0 lg:w-[400px]">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:sticky md:top-[72px] md:self-start">
            <h3 className="mb-3 text-sm font-bold text-slate-900">開單摘要</h3>

            <div className="grid grid-cols-2 gap-2">
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

            <div className="mt-2">
              <label className="mb-1 block text-xs font-semibold text-slate-500">
                技師 <span className="text-rose-500">*</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {staffList.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setStaffId(s.id);
                      setErrors((prev) => ({ ...prev, staff: "" }));
                    }}
                    className={`rounded-xl px-2.5 py-1.5 text-xs font-semibold transition ${
                      staffId === s.id
                        ? "bg-orange-500 text-white"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {s.nickname ?? s.name}
                  </button>
                ))}
              </div>
              {errors.staff && <p className="mt-1 text-xs text-rose-500">{errors.staff}</p>}
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
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

            <div className="mt-2">
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

            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>已選服務</span>
                <span>{selectedServices.length} 項</span>
              </div>
              {selectedServices.length === 0 ? (
                <div className="rounded-xl bg-slate-50 px-3 py-3 text-xs text-slate-400">尚未選擇服務</div>
              ) : (
                <div className="max-h-[26vh] space-y-1.5 overflow-y-auto pr-1">
                  {selectedServices.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                      <span className="min-w-0 truncate text-sm text-slate-800">{s.name}</span>
                      <span className="shrink-0 text-xs text-slate-500">
                        ${s.price}·{s.durationMinutes}分
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleService(s.id)}
                        className="shrink-0 rounded-md bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-600 hover:bg-rose-200"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selectedServices.length > 0 && (
              <div className="mt-2 rounded-xl bg-orange-50 px-3 py-2 text-sm font-semibold text-orange-800">
                <div className="flex justify-between">
                  <span>合計</span>
                  <span>
                    ${totalPrice} · {totalDuration}分
                  </span>
                </div>
                <div className="mt-0.5 text-xs font-normal text-orange-700">預計結束 {endTime}</div>
              </div>
            )}

            <div className="mt-2">
              <label className="mb-1 block text-xs font-semibold text-slate-500">備註</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
                placeholder="客戶特殊需求、過敏史等"
              />
            </div>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting}
              className="sticky bottom-[76px] z-10 mt-3 w-full rounded-xl bg-orange-500 py-3 text-sm font-bold text-white shadow-sm hover:bg-orange-600 disabled:opacity-50 md:static"
            >
              {submitting ? "建立中…" : "確認開單"}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
