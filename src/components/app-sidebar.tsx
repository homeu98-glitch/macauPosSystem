"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { clearAuthSession, loadAuthSession, loadOfflineMode, saveOfflineMode } from "@/lib/storage";

const navItems = [
  { href: "/", label: "點餐" },
  { href: "/orders", label: "線上\n訂單" },
  { href: "/members", label: "會員" },
  { href: "/prints", label: "打印" },
  { href: "/reports", label: "報表" },
  { href: "/soldout", label: "沽清" },
  { href: "/shift", label: "交班" },
];

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

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[128px] flex-col justify-between bg-slate-950 px-3 py-4 text-white lg:flex">
      <div className="grid gap-2">
        {navItems.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              className={`flex min-h-[72px] items-center justify-center rounded-2xl px-3 py-3 text-center text-base font-semibold transition ${
                active ? "bg-orange-500 text-white shadow-lg shadow-orange-900/30" : "bg-slate-800 text-slate-100 hover:bg-slate-700"
              }`}
              href={item.href}
            >
              <span className="whitespace-pre-line text-center leading-tight">{item.label}</span>
            </Link>
          );
        })}
      </div>

      <div className="grid gap-2">
        {session ? (
          <div className="rounded-2xl bg-slate-800 px-3 py-3 text-center text-xs font-semibold text-slate-200">
            <div>{session.name}</div>
            <div className="mt-1 text-slate-400">{session.role === "manager" ? "店長" : "收銀"}</div>
          </div>
        ) : null}
        <button
          className={`min-h-[56px] rounded-2xl px-3 py-3 text-sm font-semibold transition ${
            offlineMode ? "bg-amber-500 text-white shadow-lg shadow-amber-900/30" : "bg-emerald-600 text-white shadow-lg shadow-emerald-900/30"
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
            className="min-h-[56px] rounded-2xl bg-slate-800 px-3 py-3 text-sm font-semibold text-slate-100 hover:bg-slate-700"
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
          className={`flex min-h-[56px] items-center justify-center rounded-2xl px-3 py-3 text-center text-sm font-semibold transition ${
            pathname === "/settings"
              ? "bg-orange-500 text-white shadow-lg shadow-orange-900/30"
              : "bg-slate-800 text-slate-100 hover:bg-slate-700"
          }`}
          href="/settings"
        >
          設置
        </Link>
      </div>
    </aside>
  );
}
