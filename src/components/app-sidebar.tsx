"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { clearAuthSession, loadAuthSession, loadOfflineMode, saveOfflineMode } from "@/lib/storage";

const baseNavItems = [
  { href: "/", label: "點餐", short: "點" },
  { href: "/orders", label: "線上\n訂單", short: "單" },
  { href: "/members", label: "會員", short: "會" },
  { href: "/prints", label: "打印", short: "印" },
  { href: "/reports", label: "報表", short: "報" },
  { href: "/soldout", label: "沽清", short: "沽" },
  { href: "/shift", label: "交班", short: "班" },
] as const;

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [offlineMode, setOfflineMode] = useState(() => loadOfflineMode());
  const [loggedIn, setLoggedIn] = useState(() => Boolean(loadAuthSession()));
  const [session] = useState(() => loadAuthSession());

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

  // 不使用 effect 同步 loggedIn，避免 eslint react-hooks/set-state-in-effect；
  // 登出時會在按鈕點擊處更新狀態，登入成功則會跳頁重渲染。
  const navItems = baseNavItems;

  const roleLabel = session?.role === "admin" ? "總部" : session?.role === "manager" ? "店長" : "收銀";

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[72px] flex-col justify-between bg-slate-900 px-2 py-3 text-white md:flex">
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
                <span className="whitespace-pre-line text-center leading-tight">{item.label}</span>
              </Link>
            );
          })}
        </div>

        <div className="grid gap-2">
          {session ? (
            <div className="rounded-2xl bg-slate-800 px-2 py-2 text-center text-[11px] font-semibold text-slate-200">
              <div>{session.name}</div>
              <div className="mt-1 text-slate-400">{roleLabel}</div>
            </div>
          ) : null}
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

          {loggedIn ? (
            <button
              className="rounded-2xl bg-slate-800 px-2 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700"
              onClick={() => {
                clearAuthSession();
                setLoggedIn(false);
                router.replace("/login");
              }}
              type="button"
            >
              登出
            </button>
          ) : null}

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

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-2 py-2 backdrop-blur md:hidden">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {[...navItems, { href: "/settings", label: "設置", short: "設" }].map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                className={`flex min-w-[64px] shrink-0 flex-col items-center gap-1 rounded-2xl px-2 py-2 text-[11px] font-semibold ${
                  active ? "bg-orange-500 text-white" : "bg-slate-100 text-slate-700"
                }`}
                href={item.href}
              >
                <span className="grid h-6 w-6 place-items-center rounded-full bg-black/5">{item.short}</span>
                <span className="leading-tight">{item.label.replace("\n", "")}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
