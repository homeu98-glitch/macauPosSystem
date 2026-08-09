"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PropsWithChildren, useMemo } from "react";

import { clearAuthSession, loadAuthSession } from "@/lib/storage";

const navItems = [
  { href: "/backoffice/stores", label: "店舖總覽" },
  { href: "/backoffice/accounts", label: "帳戶總覽" },
  { href: "/backoffice/sync", label: "同步中心" },
];

export function BackofficeShell({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useMemo(() => loadAuthSession(), []);

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="flex min-h-screen">
        <aside className="hidden w-[240px] shrink-0 border-r border-slate-200 bg-slate-950 px-4 py-5 text-white lg:flex lg:flex-col">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">HQ Console</div>
            <div className="mt-2 text-xl font-semibold">Backoffice</div>
            <div className="mt-2 text-sm text-slate-400">總部營運視角，管理全部店舖狀態與同步資料。</div>
          </div>
          <nav className="mt-8 grid gap-2">
            {navItems.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  className={`rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                    active ? "bg-violet-500 text-white" : "bg-slate-900 text-slate-200 hover:bg-slate-800"
                  }`}
                  href={item.href}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto rounded-2xl bg-slate-900 p-4">
            <div className="text-sm font-semibold text-white">{session?.name ?? "管理員"}</div>
            <div className="mt-1 text-xs text-slate-400">帳號 {session?.account ?? "未登入"}</div>
            <button
              className="mt-4 w-full rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-900"
              onClick={() => {
                clearAuthSession();
                router.replace("/login");
              }}
              type="button"
            >
              登出
            </button>
          </div>
        </aside>

        <main className="flex min-h-screen flex-1 flex-col">
          <header className="border-b border-slate-200 bg-white px-4 py-4 lg:px-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-slate-900">
                  {pathname.startsWith("/backoffice/stores/")
                    ? "店舖明細"
                    : pathname.startsWith("/backoffice/accounts")
                      ? "帳戶總覽"
                      : pathname.startsWith("/backoffice/sync")
                        ? "同步中心"
                        : "店舖總覽"}
                </div>
                <div className="mt-1 text-sm text-slate-500">登入入口仍然是同一個頁面，admin 會直接進入總部後台。</div>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
                Admin {session?.account ?? "60000000"}
              </div>
            </div>
          </header>
          <div className="flex-1">{children}</div>
        </main>
      </div>
    </div>
  );
}
