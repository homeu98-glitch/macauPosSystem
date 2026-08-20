"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";

import type { SalonBooking, SalonStaff, SalonServiceItem, SalonServiceCategory } from "@/lib/salon/types";
import { loadActiveSalonStore, loadBookings, loadSalonBootstrap } from "@/lib/salon/storage";
import { MOCK_REALTIME_EVENT } from "@/lib/salon/mock-realtime";
import { seedMockBookingsIfEmpty } from "@/lib/salon/mock-realtime";

type ViewMode = "day" | "week";

const HOUR_START = 6;
const HOUR_END = 22;
const SLOT_MINUTES = 30;

function formatTimeLabel(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function toMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day;
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekdays(anchor: Date): Date[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function getCategoryColor(categories: SalonServiceCategory[], serviceItemId: string, items: SalonServiceItem[]): string {
  const item = items.find((i) => i.id === serviceItemId);
  if (!item) return "#94a3b8";
  const cat = categories.find((c) => c.id === item.categoryId);
  return cat?.color ?? "#94a3b8";
}

export function CalendarBoard() {
  const [view, setView] = useState<ViewMode>("day");
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [bookings, setBookings] = useState<SalonBooking[]>([]);
  const [staffList, setStaffList] = useState<SalonStaff[]>([]);
  const [items, setItems] = useState<SalonServiceItem[]>([]);
  const [categories, setCategories] = useState<SalonServiceCategory[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<{
    staffId: string;
    date: Date;
    hour: number;
    minute: number;
  } | null>(null);

  // Seed + load on mount
  useEffect(() => {
    const bootstrap = loadSalonBootstrap();
    if (bootstrap) {
      setStaffList(bootstrap.staff.filter((s) => s.active));
      setItems(bootstrap.serviceItems.filter((i) => i.active));
      setCategories(bootstrap.serviceCategories.filter((c) => c.active));
    }
    seedMockBookingsIfEmpty(loadActiveSalonStore());
    setBookings(loadBookings());
  }, []);

  // Listen to mock realtime events
  useEffect(() => {
    function handler() {
      setBookings(loadBookings());
    }
    if (typeof window !== "undefined") {
      window.addEventListener(MOCK_REALTIME_EVENT, handler);
      return () => window.removeEventListener(MOCK_REALTIME_EVENT, handler);
    }
  }, []);

  const timeSlots = useMemo(() => {
    const slots: Array<{ hour: number; minute: number; label: string }> = [];
    for (let h = HOUR_START; h < HOUR_END; h++) {
      for (let m = 0; m < 60; m += SLOT_MINUTES) {
        slots.push({ hour: h, minute: m, label: formatTimeLabel(h, m) });
      }
    }
    return slots;
  }, []);

  const dayBookings = useMemo(() => {
    return bookings.filter((b) => isSameDay(new Date(b.startAt), anchorDate));
  }, [bookings, anchorDate]);

  const weekBookings = useMemo(() => {
    const days = getWeekdays(anchorDate);
    return bookings.filter((b) => {
      const bd = new Date(b.startAt);
      return days.some((d) => isSameDay(bd, d));
    });
  }, [bookings, anchorDate]);

  const handlePrev = useCallback(() => {
    if (view === "day") {
      setAnchorDate((d) => addDays(d, -1));
    } else {
      setAnchorDate((d) => addDays(d, -7));
    }
  }, [view]);

  const handleNext = useCallback(() => {
    if (view === "day") {
      setAnchorDate((d) => addDays(d, 1));
    } else {
      setAnchorDate((d) => addDays(d, 7));
    }
  }, [view]);

  const handleToday = useCallback(() => {
    setAnchorDate(new Date());
  }, []);

  const weekDays = useMemo(() => getWeekdays(anchorDate), [anchorDate]);

  const weekdayNames = ["日", "一", "二", "三", "四", "五", "六"];

  return (
    <div className="flex h-full flex-col bg-slate-100 text-slate-900 md:pl-[72px]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handlePrev}
            className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200"
          >
            ◀
          </button>
          <button
            type="button"
            onClick={handleToday}
            className="rounded-xl bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-600"
          >
            今天
          </button>
          <button
            type="button"
            onClick={handleNext}
            className="rounded-xl bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-200"
          >
            ▶
          </button>
          <div className="ml-2 text-sm font-bold text-slate-800">
            {view === "day"
              ? `${anchorDate.getFullYear()}年${anchorDate.getMonth() + 1}月${anchorDate.getDate()}日 週${weekdayNames[anchorDate.getDay()]}`
              : `${weekDays[0].getFullYear()}年${weekDays[0].getMonth() + 1}月${weekDays[0].getDate()}日 – ${weekDays[6].getMonth() + 1}月${weekDays[6].getDate()}日`}
          </div>
        </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setView("day")}
                className={`rounded-lg px-3 py-1 text-xs font-semibold ${
                  view === "day" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                }`}
              >
                日
              </button>
              <button
                type="button"
                onClick={() => setView("week")}
                className={`rounded-lg px-3 py-1 text-xs font-semibold ${
                  view === "week" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                }`}
              >
                週
              </button>
            </div>
          </div>
      </div>

      {/* Calendar body */}
      <div className="flex-1 overflow-auto px-4 py-3">
        {view === "day" ? (
          <DayView
            date={anchorDate}
            staffList={staffList}
            bookings={dayBookings}
            timeSlots={timeSlots}
            items={items}
            categories={categories}
            onSlotClick={(staffId, hour, minute) =>
              setSelectedSlot({ staffId, date: anchorDate, hour, minute })
            }
          />
        ) : (
          <WeekView
            weekDays={weekDays}
            staffList={staffList}
            bookings={weekBookings}
            timeSlots={timeSlots}
            items={items}
            categories={categories}
            onSlotClick={(staffId, date, hour, minute) =>
              setSelectedSlot({ staffId, date, hour, minute })
            }
          />
        )}
      </div>

      {/* Selected slot hint (placeholder for booking form modal) */}
      {selectedSlot && (
        <div className="border-t border-slate-200 bg-white px-4 py-3 shadow-inner">
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-700">
              <span className="font-semibold">已選時段：</span>
              {selectedSlot.date.getMonth() + 1}月{selectedSlot.date.getDate()}日{" "}
              {formatTimeLabel(selectedSlot.hour, selectedSlot.minute)} ·{" "}
              {staffList.find((s) => s.id === selectedSlot.staffId)?.name ?? "未知技師"}
            </div>
            <div className="flex gap-2">
              <Link
                href={`/salon/booking/new?staffId=${selectedSlot.staffId}&date=${selectedSlot.date.toISOString()}&hour=${selectedSlot.hour}&minute=${selectedSlot.minute}`}
                className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-600"
              >
                開新預約
              </Link>
              <button
                type="button"
                onClick={() => setSelectedSlot(null)}
                className="rounded-xl bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Day View
// ────────────────────────────────────────────────────────────────────

interface DayViewProps {
  date: Date;
  staffList: SalonStaff[];
  bookings: SalonBooking[];
  timeSlots: Array<{ hour: number; minute: number; label: string }>;
  items: SalonServiceItem[];
  categories: SalonServiceCategory[];
  onSlotClick: (staffId: string, hour: number, minute: number) => void;
}

function DayView({ staffList, bookings, timeSlots, items, categories, onSlotClick }: DayViewProps) {
  const slotHeight = 56; // px per 30-min slot

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Header row */}
      <div className="grid" style={{ gridTemplateColumns: `64px repeat(${staffList.length}, minmax(140px, 1fr))` }}>
        <div className="border-b border-r border-slate-200 px-2 py-2 text-xs font-semibold text-slate-400">
          時間
        </div>
        {staffList.map((staff) => (
          <div
            key={staff.id}
            className="border-b border-r border-slate-200 px-2 py-2 text-center text-xs font-semibold text-slate-700"
          >
            {staff.nickname ?? staff.name}
          </div>
        ))}
      </div>

      {/* Time rows */}
      <div className="grid" style={{ gridTemplateColumns: `64px repeat(${staffList.length}, minmax(140px, 1fr))` }}>
        {timeSlots.map((slot) => (
          <div key={slot.label} className="contents">
            <div
              className="border-b border-r border-slate-100 px-2 text-xs text-slate-400"
              style={{ height: slotHeight }}
            >
              {slot.label}
            </div>
            {staffList.map((staff) => {
              const slotStart = slot.hour * 60 + slot.minute;
              const slotEnd = slotStart + SLOT_MINUTES;

              const booking = bookings.find((b) => {
                if (b.staffId !== staff.id) return false;
                const start = toMinutes(new Date(b.startAt));
                const end = toMinutes(new Date(b.endAt));
                return start < slotEnd && end > slotStart;
              });

              const isFirstSlot = booking
                ? toMinutes(new Date(booking.startAt)) >= slotStart &&
                  toMinutes(new Date(booking.startAt)) < slotEnd
                : false;

              return (
                <div
                  key={staff.id + slot.label}
                  className="relative border-b border-r border-slate-100"
                  style={{ height: slotHeight }}
                  onClick={() => {
                    if (!booking) onSlotClick(staff.id, slot.hour, slot.minute);
                  }}
                >
                  {isFirstSlot && booking && (
                    <BookingBlock
                      booking={booking}
                      items={items}
                      categories={categories}
                      slotHeight={slotHeight}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Week View
// ────────────────────────────────────────────────────────────────────

interface WeekViewProps {
  weekDays: Date[];
  staffList: SalonStaff[];
  bookings: SalonBooking[];
  timeSlots: Array<{ hour: number; minute: number; label: string }>;
  items: SalonServiceItem[];
  categories: SalonServiceCategory[];
  onSlotClick: (staffId: string, date: Date, hour: number, minute: number) => void;
}

function WeekView({ weekDays, staffList, bookings, timeSlots, items, categories, onSlotClick }: WeekViewProps) {
  const slotHeight = 48;
  const weekdayNames = ["日", "一", "二", "三", "四", "五", "六"];

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* Day headers */}
      <div className="grid" style={{ gridTemplateColumns: `64px repeat(${weekDays.length}, minmax(100px, 1fr))` }}>
        <div className="border-b border-r border-slate-200 px-2 py-2 text-xs font-semibold text-slate-400">
          時間
        </div>
        {weekDays.map((d) => (
          <div
            key={d.toISOString()}
            className={`border-b border-r border-slate-200 px-2 py-2 text-center text-xs font-semibold ${
              isSameDay(d, new Date()) ? "bg-orange-50 text-orange-700" : "text-slate-700"
            }`}
          >
            <div>{d.getMonth() + 1}/{d.getDate()}</div>
            <div className="text-[10px] text-slate-400">週{weekdayNames[d.getDay()]}</div>
          </div>
        ))}
      </div>

      {/* Time rows */}
      <div className="grid" style={{ gridTemplateColumns: `64px repeat(${weekDays.length}, minmax(100px, 1fr))` }}>
        {timeSlots.map((slot) => (
          <div key={slot.label} className="contents">
            <div
              className="border-b border-r border-slate-100 px-2 text-xs text-slate-400"
              style={{ height: slotHeight }}
            >
              {slot.label}
            </div>
            {weekDays.map((day) => {
              const slotStart = slot.hour * 60 + slot.minute;
              const slotEnd = slotStart + SLOT_MINUTES;

              const dayBookings = bookings.filter((b) => isSameDay(new Date(b.startAt), day));

              const booking = dayBookings.find((b) => {
                const start = toMinutes(new Date(b.startAt));
                const end = toMinutes(new Date(b.endAt));
                return start < slotEnd && end > slotStart;
              });

              const isFirstSlot = booking
                ? toMinutes(new Date(booking.startAt)) >= slotStart &&
                  toMinutes(new Date(booking.startAt)) < slotEnd
                : false;

              return (
                <div
                  key={day.toISOString() + slot.label}
                  className="relative border-b border-r border-slate-100"
                  style={{ height: slotHeight }}
                  onClick={() => {
                    if (!booking) onSlotClick(staffList[0]?.id ?? "", day, slot.hour, slot.minute);
                  }}
                >
                  {isFirstSlot && booking && (
                    <BookingBlock
                      booking={booking}
                      items={items}
                      categories={categories}
                      slotHeight={slotHeight}
                      compact
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Booking Block (colored tile)
// ────────────────────────────────────────────────────────────────────

interface BookingBlockProps {
  booking: SalonBooking;
  items: SalonServiceItem[];
  categories: SalonServiceCategory[];
  slotHeight: number;
  compact?: boolean;
}

function BookingBlock({ booking, items, categories, slotHeight, compact }: BookingBlockProps) {
  const startMin = toMinutes(new Date(booking.startAt));
  const endMin = toMinutes(new Date(booking.endAt));
  const durationSlots = Math.max(1, Math.ceil((endMin - startMin) / SLOT_MINUTES));
  const height = durationSlots * slotHeight - 2;

  const color = getCategoryColor(categories, booking.services[0]?.serviceItemId ?? "", items);
  const statusLabel: Record<string, string> = {
    pending: "待確認",
    confirmed: "已確認",
    checked_in: "已接待",
    in_service: "服務中",
    completed: "已完成",
    settled: "已結帳",
    cancelled: "已取消",
    no_show: "未到店",
  };

  return (
    <Link
      href={booking.status === "settled" ? `/salon/checkout/${booking.id}` : `/salon/booking/${booking.id}`}
      className="absolute inset-x-0.5 top-0.5 z-10 overflow-hidden rounded-lg px-1.5 py-1 text-xs shadow-sm transition hover:brightness-95"
      style={{
        height,
        backgroundColor: color + "20",
        borderLeft: `3px solid ${color}`,
      }}
      title={`${booking.customerName} · ${booking.services.map((s) => s.name).join("、")}`}
    >
      <div className="truncate font-semibold" style={{ color }}>
        {booking.customerName}
      </div>
      {!compact && (
        <div className="mt-0.5 truncate text-[10px] text-slate-600">
          {booking.services.map((s) => s.name).join("、")}
        </div>
      )}
      <div className="mt-0.5 text-[10px] text-slate-500">
        {statusLabel[booking.status] ?? booking.status}
      </div>
    </Link>
  );
}
