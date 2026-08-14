"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { useNetworkOnline } from "@/lib/use-network-online";
import { signOutLedgerSession } from "@/lib/ledger/session";
import { loadAuthSession } from "@/lib/storage";

/** Salon 專屬左側導航欄（參考餐飲 app-sidebar.tsx，但獨立實現不動既有） */

const salonNavItems = [
  { href: "/salon", label: "工作台", short: "台" },
  { href: "/salon/calendar", label: "預約看板", short: "約" },
  { href: "/salon/booking/new", label: "快速開單", short: "單" },
  { href: "/salon/customers", label: "客戶檔案", short: "客" },
  { href: "/salon/reports", label: "報表", short: "報" },
  { href: "/salon/prints", label: "打印", short: "印" },
  { href: "/salon/settings", label: "設置", short: "設" },
] as const;

export function SalonSidebar() {
  const pathname = usePathname();
  const networkOnline = useNetworkOnline();
  const [loggedIn, setLoggedIn] = useState(() => Boolean(loadAuthSession()));
  const [session] = useState(() => loadAuthSession());

  const roleLabel = session?.role === "admin" ? "總部" : session?.role === "manager" ? "店長" : "管理";

  return (
    <>
      {/* Desktop sidebar — 固定寬度 72px，可滾動 */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[72px] flex-col bg-slate-900 px-2 py-3 text-white md:flex">
        {/* 頂部：可滾動導航區 */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          <div className="grid gap-2">
            {salonNavItems.map((item) => {
              const active =
                pathname === item.href ||
                (item.href !== "/salon" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  className={`relative flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-xs font-semibold transition ${
                    active
                      ? "bg-rose-500 text-white"
                      : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                  }`}
                  href={item.href}
                  title={item.label}
                >
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-sm">
                    {item.short}
                  </span>
                  <span className="whitespace-pre-line text-center leading-tight">
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* 底部：固定資訊區 */}
        <div className="mt-2 grid shrink-0 gap-2 border-t border-slate-700 pt-2">
          {session ? (
            <div className="rounded-2xl bg-slate-800 px-2 py-2 text-center text-[11px] font-semibold text-slate-200">
              <div>{session.name}</div>
              <div className="mt-1 text-slate-400">{roleLabel}</div>
            </div>
          ) : null}

          <div
            className={`rounded-2xl px-2 py-2 text-center text-xs font-semibold ${
              networkOnline ? "bg-emerald-600/90 text-white" : "bg-amber-500 text-white"
            }`}
            title={networkOnline ? "網絡已連接" : "網絡已斷開"}
          >
            {networkOnline ? "在線" : "離線"}
          </div>

          {loggedIn ? (
            <button
              className="rounded-2xl bg-slate-800 px-2 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
              onClick={() => {
                setLoggedIn(false);
                void signOutLedgerSession().then(() => {
                  window.location.replace("/login");
                });
              }}
              type="button"
            >
              登出
            </button>
          ) : null}
        </div>
      </aside>

      {/* Mobile bottom nav — 可橫向滾動 */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-2 py-2 backdrop-blur md:hidden">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {[...salonNavItems].map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/salon" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                className={`relative flex min-w-[64px] shrink-0 flex-col items-center gap-1 rounded-2xl px-2 py-2 text-[11px] font-semibold ${
                  active ? "bg-rose-500 text-white" : "bg-slate-100 text-slate-700"
                }`}
                href={item.href}
              >
                <span className="grid h-6 w-6 place-items-center rounded-full bg-black/5 text-sm">
                  {item.short}
                </span>
                <span className="leading-tight">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
