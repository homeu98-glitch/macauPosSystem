"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { clearAuthSession, loadAuthSession } from "@/lib/storage";

/**
 * Admin panel 外殼（view-only）：
 * - 頂部導航：店鋪總覽 / 營業報表 / 登出
 * - 認證門：mount 後檢查 adminSessionToken，冇就踢返 /admin 登入頁
 *   （hydration-safe：SSR 同 client 首次 render 一致，login 檢查喺 useEffect 做）
 * - 唔包含任何列印 / 寫入 UI（啟用/停用商家按鈕由 dashboard 頁面自帶，嗰個係
 *   admin panel 唯一寫操作）
 */
export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authed, setAuthed] = useState(false);
  const [account, setAccount] = useState<string>("");

  useEffect(() => {
    const session = loadAuthSession();
    if (!session?.adminSessionToken) {
      router.replace("/admin");
      return;
    }
    setAccount(session.account || "admin");
    setAuthed(true);
  }, [router]);

  function handleLogout() {
    clearAuthSession();
    router.replace("/admin");
  }

  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <p className="text-sm text-slate-500">正在驗證管理員身份…</p>
      </div>
    );
  }

  const navItems = [
    { href: "/admin/dashboard", label: "店鋪總覽" },
    { href: "/admin/reports", label: "營業報表" },
  ];

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="text-sm font-bold text-slate-900">Admin 管理後台</span>
            <nav className="flex items-center gap-1">
              {navItems.map((item) => {
                const active = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "bg-slate-900 font-medium text-white"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:inline">{account}</span>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:bg-slate-50"
            >
              登出
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
