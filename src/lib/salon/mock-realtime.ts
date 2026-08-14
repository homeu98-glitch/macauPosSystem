// Mock Realtime — client-side helper for Phase 2 development.
// Simulates Ledger Realtime by writing to localStorage + dispatching custom events.
// When Ledger RPC (L1/L2/L3) is ready, swap this layer for real Supabase Realtime.

import type { SalonBooking, SalonBookingStatus } from "@/lib/salon/types";
import { loadBookings, saveBookings } from "@/lib/salon/storage";

export const MOCK_REALTIME_EVENT = "salon:booking-update";

function dispatchUpdate() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MOCK_REALTIME_EVENT, { detail: { source: "mock" } }));
}

function nextBookingNo(): string {
  const prefix = "BK" + new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const existing = loadBookings();
  const todayCount =
    existing.filter((b) => b.bookingNo.startsWith(prefix)).length + 1;
  return `${prefix}-${String(todayCount).padStart(4, "0")}`;
}

function makeEndAt(startAt: string, durationMinutes: number): string {
  const d = new Date(startAt);
  d.setMinutes(d.getMinutes() + durationMinutes);
  return d.toISOString();
}

// ────────────────────────────────────────────────────────────────────
// CRUD
// ────────────────────────────────────────────────────────────────────

export function pushMockBooking(booking: Omit<SalonBooking, "bookingNo" | "endAt" | "createdAt" | "updatedAt">): SalonBooking {
  const now = new Date().toISOString();
  const services = booking.services;
  const totalDuration = services.reduce((sum, s) => sum + s.durationMinutes, 0);

  const full: SalonBooking = {
    ...booking,
    bookingNo: nextBookingNo(),
    endAt: makeEndAt(booking.startAt, totalDuration),
    createdAt: now,
    updatedAt: now,
  };

  const existing = loadBookings();
  saveBookings([...existing, full]);
  dispatchUpdate();
  return full;
}

export function updateMockBooking(
  id: string,
  patch: Partial<Omit<SalonBooking, "id" | "createdAt">>
): SalonBooking | null {
  const existing = loadBookings();
  const idx = existing.findIndex((b) => b.id === id);
  if (idx === -1) return null;

  const updated: SalonBooking = {
    ...existing[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  // recompute endAt if services changed
  if (patch.services) {
    const totalDuration = updated.services.reduce((sum, s) => sum + s.durationMinutes, 0);
    updated.endAt = makeEndAt(updated.startAt, totalDuration);
  }

  const next = [...existing];
  next[idx] = updated;
  saveBookings(next);
  dispatchUpdate();
  return updated;
}

export function deleteMockBooking(id: string): boolean {
  const existing = loadBookings();
  const next = existing.filter((b) => b.id !== id);
  if (next.length === existing.length) return false;
  saveBookings(next);
  dispatchUpdate();
  return true;
}

export function advanceBookingStatus(id: string, nextStatus: SalonBookingStatus): SalonBooking | null {
  return updateMockBooking(id, { status: nextStatus });
}

// ────────────────────────────────────────────────────────────────────
// Seed — 5 demo bookings for first-time load
// ────────────────────────────────────────────────────────────────────

function todayAt(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function makeId(): string {
  return "mock-" + Math.random().toString(36).slice(2, 10);
}

export function seedMockBookingsIfEmpty(): SalonBooking[] {
  const existing = loadBookings();
  if (existing.length > 0) return existing;

  const staffIds = ["staff-001", "staff-002", "staff-003"];
  const serviceMap: Record<string, { name: string; price: number; durationMinutes: number }> = {
    "srv-hydrating-facial": { name: "保濕臉部護理", price: 480, durationMinutes: 60 },
    "srv-aroma-spa": { name: "香薰 SPA 90 分", price: 980, durationMinutes: 90 },
    "srv-manicure": { name: "基礎手部美甲", price: 180, durationMinutes: 45 },
    "srv-lash-extension": { name: "美睫嫁接", price: 580, durationMinutes: 90 },
    "srv-shoulder-massage": { name: "肩頸按摩 30 分", price: 280, durationMinutes: 30 },
  };

  const seeds: Array<Omit<SalonBooking, "bookingNo" | "endAt" | "createdAt" | "updatedAt">> = [
    {
      id: makeId(),
      source: "phone",
      customerName: "王小姐",
      customerPhone: "66881111",
      staffId: staffIds[0],
      stationId: "station-chair-1",
      startAt: todayAt(9, 30),
      services: [
        { serviceItemId: "srv-manicure", ...serviceMap["srv-manicure"], staffId: staffIds[0] },
      ],
      status: "confirmed",
    },
    {
      id: makeId(),
      source: "walk_in",
      customerName: "陳先生",
      customerPhone: "66882222",
      staffId: staffIds[1],
      stationId: "station-bed-2",
      startAt: todayAt(10, 0),
      services: [
        { serviceItemId: "srv-aroma-spa", ...serviceMap["srv-aroma-spa"], staffId: staffIds[1] },
      ],
      status: "in_service",
    },
    {
      id: makeId(),
      source: "online_ledger",
      customerName: "林小姐",
      customerPhone: "66883333",
      staffId: staffIds[2],
      stationId: "station-bed-1",
      startAt: todayAt(11, 0),
      services: [
        { serviceItemId: "srv-hydrating-facial", ...serviceMap["srv-hydrating-facial"], staffId: staffIds[2] },
      ],
      status: "completed",
    },
    {
      id: makeId(),
      source: "phone",
      customerName: "張小姐",
      customerPhone: "66884444",
      staffId: staffIds[0],
      stationId: "station-room-vip",
      startAt: todayAt(14, 0),
      services: [
        { serviceItemId: "srv-lash-extension", ...serviceMap["srv-lash-extension"], staffId: staffIds[0] },
      ],
      status: "confirmed",
    },
    {
      id: makeId(),
      source: "walk_in",
      customerName: "黃先生",
      customerPhone: "66885555",
      staffId: staffIds[1],
      stationId: undefined,
      startAt: todayAt(15, 30),
      services: [
        { serviceItemId: "srv-shoulder-massage", ...serviceMap["srv-shoulder-massage"], staffId: staffIds[1] },
      ],
      status: "cancelled",
    },
  ];

  const created: SalonBooking[] = [];
  for (const s of seeds) {
    created.push(pushMockBooking(s));
  }
  return created;
}
