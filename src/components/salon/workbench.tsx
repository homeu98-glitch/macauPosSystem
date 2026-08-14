"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import {
  DEFAULT_SALON_STORE_ID,
} from "@/lib/salon/mock-data";
import {
  ensureSalonBootstrap,
  loadBookings,
  loadSalonOrders,
} from "@/lib/salon/storage";
import {
  isSalonTerminal,
  setTerminalIndustry,
} from "@/lib/salon/industry-config";
import { seedMockBookingsIfEmpty, MOCK_REALTIME_EVENT } from "@/lib/salon/mock-realtime";
import type { SalonBootstrap, SalonBooking } from "@/lib/salon/types";
import { SalonSidebar } from "@/components/salon/salon-sidebar";

type PhaseStatus = "loading" | "ready";

function formatDateTime(date: Date) {
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}（週${weekday}）${hh}:${mi}`;
}

function isSameDay(isoA: string, isoB: Date) {
  const a = new Date(isoA);
  return (
    a.getFullYear() === isoB.getFullYear() &&
    a.getMonth() === isoB.getMonth() &&
    a.getDate() === isoB.getDate()
  );
}

export function SalonWorkbench() {
  const [status, setStatus] = useState<PhaseStatus>("loading");
  const [bootstrap, setBootstrap] = useState<SalonBootstrap | null>(null);
  const [bookings, setBookings] = useState<SalonBooking[]>([]);
  const [orderCount, setOrderCount] = useState(0);
  const [nowText, setNowText] = useState("");
  const [terminalIsSalon, setTerminalIsSalon] = useState(false);

  useEffect(() => {
    const seeded = ensureSalonBootstrap(DEFAULT_SALON_STORE_ID);
    setBootstrap(seeded);
    seedMockBookingsIfEmpty();
    setBookings(loadBookings());
    setOrderCount(loadSalonOrders().length);
    setTerminalIsSalon(isSalonTerminal());
    setStatus("ready");
  }, []);

  useEffect(() => {
    function handler() {
      setBookings(loadBookings());
      setOrderCount(loadSalonOrders().length);
    }
    if (typeof window !== "undefined") {
      window.addEventListener(MOCK_REALTIME_EVENT, handler);
      return () => window.removeEventListener(MOCK_REALTIME_EVENT, handler);
    }
  }, []);

  useEffect(() => {
    function tick() {
      setNowText(formatDateTime(new Date()));
    }
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const todayBookings = useMemo(() => {
    const today = new Date();
    return bookings.filter((b) => isSameDay(b.startAt, today));
  }, [bookings]);

  const todayCounts = useMemo(() => {
    const by = {
      confirmed: 0,
      in_service: 0,
      completed: 0,
      settled: 0,
    };
    for (const b of todayBookings) {
      if (b.status === "confirmed" || b.status === "pending") by.confirmed += 1;
      else if (b.status === "in_service" || b.status === "checked_in") by.in_service += 1;
      else if (b.status === "completed") by.completed += 1;
      else if (b.status === "settled") by.settled += 1;
    }
    return by;
  }, [todayBookings]);

  function handleMarkSalonTerminal() {
    setTerminalIndustry("salon");
    setTerminalIsSalon(true);
  }

  if (status === "loading" || !bootstrap) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center md:pl-[88px]">
        <div>
          <div className="text-base font-semibold text-slate-900">正在載入 salon 工作台…</div>
          <div className="mt-2 text-sm text-slate-500">首次啟動會種入預設服務資料。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-slate-100 text-slate-900 md:pl-[72px]">
      <SalonSidebar />

      <div className="flex flex-1 flex-col">
        {/* 頂部 header */}
        <header className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-rose-500 text-base font-bold text-white">
                院
              </div>
              <div>
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                  Salon POS · v0.2
                </div>
                <div className="text-lg font-bold text-slate-900">{bootstrap.storeName}</div>
              </div>
              <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-700">
                美容院
              </span>
            </div>
            <div className="text-right text-sm text-slate-500">
              <div className="font-semibold text-slate-700">{nowText}</div>
              <div className="text-xs">storeId：{bootstrap.storeId}</div>
            </div>
          </div>
        </header>

        {/* Phase banner */}
        <section className="border-b border-amber-200 bg-amber-50 px-6 py-3 text-sm text-amber-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="font-semibold">
              Phase 2 — 預約看板 + Walk-in 開單。點擊左側導航欄切換功能。
            </div>
            {!terminalIsSalon ? (
              <button
                type="button"
                onClick={handleMarkSalonTerminal}
                className="rounded-xl bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-700"
              >
                把此終端標記為 salon
              </button>
            ) : (
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                本終端已標記為 salon
              </span>
            )}
          </div>
        </section>

        {/* KPI 列 */}
        <section className="grid grid-cols-2 gap-3 px-6 py-3 md:grid-cols-4">
          <KpiCard
            label="今日預約"
            value={todayCounts.confirmed}
            sub="confirmed + pending"
            accent="bg-orange-500"
          />
          <KpiCard
            label="服務中"
            value={todayCounts.in_service}
            sub="checked_in + in_service"
            accent="bg-blue-500"
          />
          <KpiCard
            label="待結帳"
            value={todayCounts.completed}
            sub="completed"
            accent="bg-violet-500"
          />
          <KpiCard
            label="已結帳"
            value={todayCounts.settled}
            sub="settled"
            accent="bg-emerald-500"
          />
        </section>

        {/* 區段：四個面板 */}
        <section className="grid flex-1 grid-cols-1 gap-4 px-6 pb-6 md:grid-cols-2 lg:grid-cols-4">
          <Panel
            title="今日預約"
            hint="點擊進入預約詳情"
            emptyMessage="尚無預約"
            action={
              <Link
                href="/salon/calendar"
                className="rounded-lg bg-orange-100 px-2 py-1 text-xs font-semibold text-orange-700 hover:bg-orange-200"
              >
                看板
              </Link>
            }
          >
            <ul className="grid gap-2">
              {todayBookings.length === 0 ? (
                <li className="text-center text-xs text-slate-400">尚無預約</li>
              ) : (
                todayBookings.slice(0, 8).map((b) => (
                  <li key={b.id}>
                    <Link
                      href={`/salon/booking/${b.id}`}
                      className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm transition hover:bg-orange-50"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{b.customerName}</div>
                        <div className="mt-0.5 truncate text-xs text-slate-500">
                          {b.services.map((s) => s.name).join("、")}
                        </div>
                      </div>
                      <div className="ml-2 shrink-0 text-right">
                        <div className="text-xs font-semibold text-slate-700">
                          {new Date(b.startAt).toLocaleTimeString("zh-HK", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </div>
                        <div className="text-[10px] text-slate-400">{b.status}</div>
                      </div>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          </Panel>

          <Panel
            title="走進客戶"
            hint="walk-in 開單"
            emptyMessage="點此開新 walk-in"
            action={
              <Link
                href="/salon/booking/new"
                className="rounded-lg bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-700 hover:bg-violet-200"
              >
                + 開單
              </Link>
            }
          >
            <Link
              href="/salon/booking/new"
              className="grid h-full place-items-center rounded-2xl border-2 border-dashed border-violet-300 bg-violet-50 px-4 py-6 text-center text-sm font-semibold text-violet-600 transition hover:bg-violet-100"
            >
              + 新 walk-in 預約
            </Link>
          </Panel>

          <Panel
            title="服務中"
            hint="進行中服務"
            emptyMessage="無進行中服務"
          >
            <ul className="grid gap-2">
              {todayBookings.filter((b) => b.status === "in_service" || b.status === "checked_in").length === 0 ? (
                <li className="text-center text-xs text-slate-400">無進行中服務</li>
              ) : (
                todayBookings
                  .filter((b) => b.status === "in_service" || b.status === "checked_in")
                  .map((b) => (
                    <li key={b.id}>
                      <Link
                        href={`/salon/booking/${b.id}`}
                        className="flex items-center justify-between rounded-xl border border-slate-200 bg-blue-50 px-3 py-2 text-sm transition hover:bg-blue-100"
                      >
                        <span className="font-semibold">{b.customerName}</span>
                        <span className="text-xs text-slate-500">{b.status}</span>
                      </Link>
                    </li>
                  ))
              )}
            </ul>
          </Panel>

          <Panel
            title="待結帳"
            hint="服務完成，等候結帳"
            emptyMessage="無待結帳"
            trailing={
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                {orderCount} 筆訂單
              </span>
            }
          >
            <ul className="grid gap-2">
              {todayBookings.filter((b) => b.status === "completed").length === 0 ? (
                <li className="text-center text-xs text-slate-400">無待結帳</li>
              ) : (
                todayBookings
                  .filter((b) => b.status === "completed")
                  .map((b) => (
                    <li key={b.id}>
                      <Link
                        href={`/salon/booking/${b.id}`}
                        className="flex items-center justify-between rounded-xl border border-slate-200 bg-violet-50 px-3 py-2 text-sm transition hover:bg-violet-100"
                      >
                        <span className="font-semibold">{b.customerName}</span>
                        <span className="text-xs font-semibold text-violet-700">待結帳</span>
                      </Link>
                    </li>
                  ))
              )}
            </ul>
          </Panel>
        </section>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// 子元件
// ────────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: number;
  sub: string;
  accent: string;
}

function KpiCard({ label, value, sub, accent }: KpiCardProps) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          {label}
        </div>
        <span className={`h-2 w-2 rounded-full ${accent}`} aria-hidden />
      </div>
      <div className="mt-2 text-3xl font-bold text-slate-900">{value}</div>
      <div className="mt-1 text-xs text-slate-500">{sub}</div>
    </div>
  );
}

interface PanelProps {
  title: string;
  hint: string;
  emptyMessage: string;
  trailing?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
}

function Panel({ title, hint, emptyMessage, trailing, action, children }: PanelProps) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
        </div>
        <div className="flex items-center gap-2">
          {action}
          {trailing}
        </div>
      </div>
      <div className="mt-3 flex-1">
        {children ?? (
          <div className="grid h-full place-items-center rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-xs text-slate-400">
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}
