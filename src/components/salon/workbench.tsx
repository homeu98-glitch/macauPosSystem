"use client";

import { useEffect, useMemo, useState } from "react";

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
import { signOutLedgerSession } from "@/lib/ledger/session";
import type { SalonBootstrap, SalonBooking } from "@/lib/salon/types";

type Phase1Status = "loading" | "ready";

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
  const [status, setStatus] = useState<Phase1Status>("loading");
  const [bootstrap, setBootstrap] = useState<SalonBootstrap | null>(null);
  const [bookings, setBookings] = useState<SalonBooking[]>([]);
  const [orderCount, setOrderCount] = useState(0);
  const [nowText, setNowText] = useState("");
  const [terminalIsSalon, setTerminalIsSalon] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    // 首次啟動 seed；active store 用預設 storeId，實際部署再由登入決定。
    const seeded = ensureSalonBootstrap(DEFAULT_SALON_STORE_ID);
    setBootstrap(seeded);
    setBookings(loadBookings());
    setOrderCount(loadSalonOrders().length);
    setTerminalIsSalon(isSalonTerminal());
    setStatus("ready");
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

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOutLedgerSession();
      window.location.replace("/login");
    } catch {
      setSigningOut(false);
    }
  }

  if (status === "loading" || !bootstrap) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center">
        <div>
          <div className="text-base font-semibold text-slate-900">正在載入 salon 工作台…</div>
          <div className="mt-2 text-sm text-slate-500">首次啟動會種入預設服務資料。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">
      {/* 頂部 header */}
      <header className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-orange-500 text-base font-bold text-white">
              院
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                Salon POS · v0.1
              </div>
              <div className="text-lg font-bold text-slate-900">{bootstrap.storeName}</div>
            </div>
            <span className="rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold text-rose-700">
              美容院
            </span>
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
              Phase 1 骨架
            </span>
          </div>
          <div className="text-right text-sm text-slate-500">
            <div className="font-semibold text-slate-700">{nowText}</div>
            <div className="text-xs">storeId：{bootstrap.storeId}</div>
          </div>
        </div>
      </header>

      {/* Phase 1 banner */}
      <section className="border-b border-amber-200 bg-amber-50 px-6 py-3 text-sm text-amber-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="font-semibold">
            Phase 1 — 行業分流骨架已就緒。後續功能（預約看板 / 服務執行 / 結帳）見 docs/26-beauty-salon-vertical.md §13。
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
      <section className="grid grid-cols-2 gap-3 px-6 py-4 md:grid-cols-4">
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
          hint="從 Ledger Realtime 接收 + 電話/walk-in 開單（Phase 2）"
          emptyMessage="尚無預約資料（Phase 1 骨架）"
        >
          <ul className="grid gap-2">
            {todayBookings.length === 0 ? null : (
              todayBookings.slice(0, 5).map((b) => (
                <li
                  key={b.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span>{b.customerName}</span>
                    <span className="text-xs text-slate-500">
                      {new Date(b.startAt).toLocaleTimeString("zh-HK", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {b.services.map((s) => s.name).join("、")}
                  </div>
                </li>
              ))
            )}
          </ul>
        </Panel>

        <Panel
          title="走進客戶"
          hint="walk-in 開單入口（Phase 2）"
          emptyMessage="點此開新 walk-in"
        >
          <button
            type="button"
            disabled
            className="w-full rounded-2xl border-2 border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm font-semibold text-slate-400"
          >
            （Phase 2 上線）
          </button>
        </Panel>

        <Panel
          title="服務中"
          hint="進行中服務（Phase 3）"
          emptyMessage="無進行中服務"
        >
          <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
            空
          </div>
        </Panel>

        <Panel
          title="待結帳"
          hint="服務完成，等候結帳（Phase 5）"
          emptyMessage="無待結帳"
          trailing={
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
              {orderCount} 筆訂單
            </span>
          }
        >
          <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
            空
          </div>
        </Panel>
      </section>

      {/* 底部導航 */}
      <footer className="border-t border-slate-200 bg-white px-6 py-3 text-sm shadow-inner">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>
              員工 {bootstrap.staff.length} 位
            </span>
            <span>·</span>
            <span>
              服務類目 {bootstrap.serviceCategories.length} 類
            </span>
            <span>·</span>
            <span>
              服務項目 {bootstrap.serviceItems.length} 項
            </span>
            <span>·</span>
            <span>
              房型 {bootstrap.stations.length} 個
            </span>
          </div>
          <div className="flex gap-2">
            <a
              href="/"
              className="rounded-2xl bg-slate-800 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700"
            >
              回餐飲主頁
            </a>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className="rounded-2xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {signingOut ? "登出中…" : "登出"}
            </button>
          </div>
        </div>
      </footer>
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
  children?: React.ReactNode;
}

function Panel({ title, hint, emptyMessage, trailing, children }: PanelProps) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-slate-900">{title}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
        </div>
        {trailing}
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
