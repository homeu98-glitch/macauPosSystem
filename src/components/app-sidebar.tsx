"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { loadOfflineMode, saveOfflineMode } from "@/lib/storage";

const navItems = [
  { href: "/", label: "點餐", short: "點" },
  { href: "/orders", label: "訂單", short: "單" },
  { href: "/members", label: "會員", short: "會" },
  { href: "/reports", label: "報表", short: "報" },
];

export function AppSidebar() {
  const pathname = usePathname();
  const [offlineMode, setOfflineMode] = useState(() => loadOfflineMode());

  useEffect(() => {
    function onOfflineModeChanged(event: Event) {
      const detail = (event as CustomEvent<{ offlineMode?: boolean }>).detail;
      if (typeof detail?.offlineMode === "boolean") {
        setOfflineMode(detail.offlineMode);
      } else {
        setOfflineMode(loadOfflineMode());
      }
    }

    window.addEventListener("pos-offline-mode-changed", onOfflineModeChanged as EventListener);
    return () => window.removeEventListener("pos-offline-mode-changed", onOfflineModeChanged as EventListener);
  }, []);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[72px] flex-col justify-between bg-slate-900 px-2 py-3 text-white lg:flex">
      <div className="grid gap-2">
        {navItems.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              className={`flex flex-col items-center gap-2 rounded-2xl px-2 py-3 text-xs font-semibold transition ${
                active ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"
              }`}
              href={item.href}
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10">{item.short}</span>
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="grid gap-2">
        <button
          className={`rounded-2xl px-2 py-2 text-xs font-semibold transition ${
            offlineMode ? "bg-amber-500 text-white" : "bg-emerald-600 text-white"
          }`}
          onClick={() => {
            const next = !offlineMode;
            setOfflineMode(next);
            saveOfflineMode(next);
            window.dispatchEvent(new CustomEvent("pos-offline-mode-changed", { detail: { offlineMode: next } }));
          }}
          type="button"
        >
          {offlineMode ? "離線模式" : "在線"}
        </button>

        <Link
          className={`rounded-2xl px-2 py-2 text-center text-xs font-semibold transition ${
            pathname === "/settings" ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"
          }`}
          href="/settings"
        >
          設置
        </Link>
      </div>
    </aside>
  );
}
