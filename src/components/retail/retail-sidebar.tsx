"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { loadAuthSession } from "@/lib/storage";
import { signOutLedgerSession } from "@/lib/ledger/session";
import { useNetworkOnline } from "@/lib/use-network-online";

/**
 * 零售專屬左側導航欄（參考 `app-sidebar.tsx` / `salon-sidebar.tsx`，
 * 但**獨立實現、唔改既有** —— 同 salon 當年嘅做法一致）。
 *
 * ⚠️ 只放**已經起好嘅頁面**：連去唔存在嘅路由會變成死連結（比少一個入口更差）。
 * 報表 / 交班會隨對應畫面逐步加返（見 docs/124 §9.6）。
 */

const retailNavItems = [
  { href: "/retail", label: "收銀台", short: "收" },
  { href: "/retail/products", label: "商品", short: "品" },
  { href: "/retail/inventory", label: "庫存", short: "庫" },
  { href: "/retail/returns", label: "退換", short: "退" },
  { href: "/retail/settings", label: "設定", short: "設" },
] as const;

export function RetailSidebar() {
  const pathname = usePathname();
  const networkOnline = useNetworkOnline();
  const [session] = useState(() => loadAuthSession());
  const [busy, setBusy] = useState(false);

  const roleLabel =
    session?.role === "admin" ? "總部" : session?.role === "manager" ? "店長" : "收銀";

  async function signOut() {
    setBusy(true);
    try {
      await signOutLedgerSession();
    } finally {
      // 跟 `app-sidebar.tsx` 一致：登出後用 `replace()` 全頁重載，
      // 確保所有 client state / cache 都清乾淨（`href =` 唔會清 state）。
      if (typeof window !== "undefined") window.location.replace("/login");
    }
  }

  return (
    <>
      {/* Desktop：固定 72px（同餐飲／沙龍一致，唔另創一套寬度） */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[72px] flex-col bg-slate-900 px-2 py-3 text-white md:flex">
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          <div className="grid gap-2">
            {retailNavItems.map((item) => {
              const active =
                pathname === item.href || (item.href !== "/retail" && pathname.startsWith(item.href));
              return (
                <Link
                  key={item.href}
                  className={`relative flex flex-col items-center gap-1 rounded-2xl px-2 py-3 text-xs font-semibold transition ${
                    active ? "bg-orange-500 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"
                  }`}
                  href={item.href}
                  title={item.label}
                >
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-sm">
                    {item.short}
                  </span>
                  <span className="whitespace-pre-line text-center leading-tight">{item.label}</span>
                  {!networkOnline ? (
                    <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-amber-400" />
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="mt-2 grid shrink-0 gap-2 border-t border-slate-700 pt-2">
          {session ? (
            <div className="rounded-2xl bg-slate-800 px-2 py-2 text-center text-[11px] font-semibold text-slate-200">
              <div className="truncate" title={session.name}>
                {session.name}
              </div>
              <div className="mt-1 text-slate-400">{roleLabel}</div>
            </div>
          ) : null}
          <button
            className="rounded-2xl bg-slate-800 px-2 py-2 text-[11px] font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => void signOut()}
            type="button"
          >
            {busy ? "登出中…" : "登出"}
          </button>
        </div>
      </aside>

      {/* Mobile：底部橫向條（同 salon 一致：唔用抽屜，減少一層狀態） */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex bg-slate-900 px-2 py-2 text-white md:hidden">
        {retailNavItems.map((item) => {
          const active =
            pathname === item.href || (item.href !== "/retail" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              className={`flex flex-1 flex-col items-center gap-1 rounded-xl py-2 text-[11px] font-semibold ${
                active ? "bg-orange-500 text-white" : "text-slate-300"
              }`}
              href={item.href}
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-sm">
                {item.short}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
