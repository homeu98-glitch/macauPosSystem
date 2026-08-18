"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import type {
  SalonBooking,
  SalonServiceItem,
  SalonStaff,
  SalonStation,
  SalonServiceCategory,
  SalonProduct,
  SalonCustomerProfile,
  SalonBookingProductSelection,
} from "@/lib/salon/types";
import { loadSalonBootstrap, loadCustomers } from "@/lib/salon/storage";
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

  const [staffList, setStaffList] = useState<SalonStaff[]>([]);
  const [allStaff, setAllStaff] = useState<SalonStaff[]>([]);
  const [items, setItems] = useState<SalonServiceItem[]>([]);
  const [products, setProducts] = useState<SalonProduct[]>([]);
  const [stations, setStations] = useState<SalonStation[]>([]);
  const [categories, setCategories] = useState<SalonServiceCategory[]>([]);
  const [customerList, setCustomerList] = useState<SalonCustomerProfile[]>([]);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
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
  const [selectedProducts, setSelectedProducts] = useState<SalonBookingProductSelection[]>([]);
  const [leftTab, setLeftTab] = useState<"service" | "product">("service");
  const [catFilter, setCatFilter] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const b = loadSalonBootstrap();
    if (b) {
      setStaffList(b.staff.filter((s) => s.active));
      setAllStaff(b.staff);
      setItems(b.serviceItems.filter((i) => i.active));
      setProducts((b.products ?? []).filter((p) => p.active));
      setStations(b.stations.filter((s) => s.active));
      setCategories(b.serviceCategories.filter((c) => c.active));
      setCustomerList(loadCustomers());
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
    [items, selectedServiceIds],
  );

  const totalDuration = useMemo(
    () => selectedServices.reduce((sum, s) => sum + s.durationMinutes, 0),
    [selectedServices],
  );

  const servicePrice = useMemo(
    () => selectedServices.reduce((sum, s) => sum + s.price, 0),
    [selectedServices],
  );

  const productPrice = useMemo(
    () => selectedProducts.reduce((sum, p) => sum + p.price * p.quantity, 0),
    [selectedProducts],
  );

  const totalPrice = servicePrice + productPrice;

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
    if (selectedServiceIds.length === 0 && selectedProducts.length === 0)
      next.services = "請選擇至少一項服務或產品";
    setErrors(next);
    return Object.keys(next).length === 0;
  }, [customerName, customerPhone, staffId, selectedServiceIds, selectedProducts]);

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
      productSelections: selectedProducts.length > 0 ? selectedProducts : undefined,
      status: "confirmed",
      notes: notes.trim() || undefined,
    });

    // Phase 4：walk-in / 電話開單自動 upsert 客戶檔案並連結 customerId；
    // 若已從會員清單選取，優先使用其 id 以保留會員連結。
    const customer = selectedCustomerId
      ? loadCustomers().find((c) => c.id === selectedCustomerId) ??
        ensureSalonCustomer(customerName.trim(), customerPhone)
      : ensureSalonCustomer(customerName.trim(), customerPhone);
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
    selectedProducts,
    staffId,
    stationId,
    source,
    customerName,
    customerPhone,
    selectedCustomerId,
    notes,
    onSuccess,
    router,
  ]);

  const toggleService = useCallback((id: string) => {
    setSelectedServiceIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const toggleProduct = useCallback(
    (p: SalonProduct) => {
      setSelectedProducts((prev) => {
        if (prev.some((x) => x.productId === p.id)) {
          return prev.filter((x) => x.productId !== p.id);
        }
        return [
          ...prev,
          {
            productId: p.id,
            name: p.name,
            price: p.price,
            quantity: 1,
            staffId: staffId || undefined,
            commissionRate: p.commissionRate,
          },
        ];
      });
    },
    [staffId],
  );

  const changeProductQty = useCallback((productId: string, delta: number) => {
    setSelectedProducts((prev) =>
      prev
        .map((x) =>
          x.productId === productId ? { ...x, quantity: Math.max(1, x.quantity + delta) } : x,
        ),
    );
  }, []);

  const setProductStaff = useCallback((productId: string, sid: string) => {
    setSelectedProducts((prev) =>
      prev.map((x) => (x.productId === productId ? { ...x, staffId: sid } : x)),
    );
  }, []);

  const removeProduct = useCallback((productId: string) => {
    setSelectedProducts((prev) => prev.filter((x) => x.productId !== productId));
  }, []);

  const onMemberChange = useCallback(
    (id: string) => {
      setSelectedCustomerId(id);
      if (id) {
        const c = customerList.find((x) => x.id === id);
        if (c) {
          setCustomerName(c.name);
          setCustomerPhone(c.phone);
          setErrors((prev) => ({ ...prev, name: "", phone: "" }));
        }
      }
    },
    [customerList],
  );

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
    [catFilter, items],
  );

  const productSelectedMap = useMemo(
    () => new Map(selectedProducts.map((p) => [p.productId, p])),
    [selectedProducts],
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
                aria-pressed={source === s}
                className={`rounded-xl px-3 py-1.5 text-sm font-semibold ring-1 transition ${
                  source === s
                    ? "bg-orange-500 text-white ring-orange-500"
                    : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50"
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
        {/* 左：目錄（項目 / 產品 切換） */}
        <section className="min-h-0 md:flex-1">
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setLeftTab("service")}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                leftTab === "service"
                  ? "bg-orange-500 text-white"
                  : "bg-slate-200 text-slate-700 hover:bg-slate-300"
              }`}
            >
              項目（服務）
            </button>
            <button
              type="button"
              onClick={() => setLeftTab("product")}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                leftTab === "product"
                  ? "bg-orange-500 text-white"
                  : "bg-slate-200 text-slate-700 hover:bg-slate-300"
              }`}
            >
              產品
            </button>
          </div>

          {leftTab === "service" ? (
            <>
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
            </>
          ) : (
            <>
              {products.length === 0 ? (
                <div className="rounded-2xl bg-slate-50 px-4 py-10 text-center text-sm text-slate-400">
                  尚無產品，請到「設置 → 產品」新增。
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {products.map((p) => {
                    const sel = productSelectedMap.get(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => toggleProduct(p)}
                        className={`flex min-h-[64px] flex-col justify-between rounded-xl px-3 py-2 text-left text-sm transition ${
                          sel
                            ? "bg-orange-500 text-white"
                            : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        <span className="font-medium leading-tight">{p.name}</span>
                        <span className="mt-1 text-xs opacity-80">
                          ${p.price}
                          {sel ? ` · x${sel.quantity}` : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>

        {/* 右：開單摘要（桌面 sticky 常駐） */}
        <aside className="md:w-[360px] md:shrink-0 lg:w-[400px]">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:sticky md:top-[72px] md:self-start">
            <h3 className="mb-3 text-sm font-bold text-slate-900">開單摘要</h3>

            {/* 來源（走進 / 電話）— 明確反饋，R5 */}
            <div className="mb-3 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
              <span className="text-xs font-semibold text-slate-500">來源</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                  source === "walk_in"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-sky-100 text-sky-700"
                }`}
              >
                {source === "walk_in" ? "走進" : "電話"}
              </span>
              <span className="ml-auto text-[11px] text-slate-400">
                {source === "phone" ? "已致電客人確認" : "現場接待"}
              </span>
            </div>

            {/* 會員選擇（R6）：現有會員免重填姓名電話 */}
            <div className="mb-2">
              <label className="mb-1 block text-xs font-semibold text-slate-500">會員（可選，免手動輸入）</label>
              <select
                value={selectedCustomerId}
                onChange={(e) => onMemberChange(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-200"
              >
                <option value="">（手動輸入新客 / 非會員）</option>
                {customerList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.phone}）
                  </option>
                ))}
              </select>
            </div>

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
                    setSelectedCustomerId("");
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
                    setSelectedCustomerId("");
                    setErrors((prev) => ({ ...prev, phone: "" }));
                  }}
                  className={`w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 ${
                    errors.phone ? "border-rose-300 focus:ring-rose-200" : "border-slate-200 focus:ring-orange-200"
                  } ${source === "phone" ? "bg-sky-50" : ""}`}
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

            {/* 已選服務 */}
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>已選服務</span>
                <span>{selectedServices.length} 項</span>
              </div>
              {selectedServices.length === 0 ? (
                <div className="rounded-xl bg-slate-50 px-3 py-3 text-xs text-slate-400">尚未選擇服務</div>
              ) : (
                <div className="max-h-[22vh] space-y-1.5 overflow-y-auto pr-1">
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

            {/* 已選產品（R4：併入同單；銷售員工可選全部員工，R3） */}
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>已選產品</span>
                <span>{selectedProducts.length} 項</span>
              </div>
              {selectedProducts.length === 0 ? (
                <div className="rounded-xl bg-slate-50 px-3 py-3 text-xs text-slate-400">
                  切換左上「產品」tab 選購
                </div>
              ) : (
                <div className="max-h-[26vh] space-y-1.5 overflow-y-auto pr-1">
                  {selectedProducts.map((p) => (
                    <div key={p.productId} className="rounded-lg bg-slate-50 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-sm text-slate-800">{p.name}</span>
                        <span className="shrink-0 text-xs text-slate-500">${p.price}</span>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => changeProductQty(p.productId, -1)}
                            className="rounded-md bg-white px-2 py-0.5 text-xs font-semibold text-slate-600 shadow-sm"
                          >
                            −
                          </button>
                          <span className="px-1 text-xs font-semibold text-slate-700">{p.quantity}</span>
                          <button
                            type="button"
                            onClick={() => changeProductQty(p.productId, 1)}
                            className="rounded-md bg-white px-2 py-0.5 text-xs font-semibold text-slate-600 shadow-sm"
                          >
                            ＋
                          </button>
                          <button
                            type="button"
                            onClick={() => removeProduct(p.productId)}
                            className="rounded-md bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-600 hover:bg-rose-200"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                      <div className="mt-1 flex items-center gap-1">
                        <span className="text-[11px] text-slate-400">銷售</span>
                        <select
                          value={p.staffId ?? ""}
                          onChange={(e) => setProductStaff(p.productId, e.target.value)}
                          className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-orange-200"
                        >
                          <option value="">（未指定）</option>
                          {allStaff.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.nickname ?? s.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {(selectedServices.length > 0 || selectedProducts.length > 0) && (
              <div className="mt-2 rounded-xl bg-orange-50 px-3 py-2 text-sm font-semibold text-orange-800">
                <div className="flex justify-between">
                  <span>合計</span>
                  <span>${totalPrice}</span>
                </div>
                {selectedServices.length > 0 && (
                  <div className="mt-0.5 text-xs font-normal text-orange-700">
                    預計結束 {endTime}
                  </div>
                )}
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
