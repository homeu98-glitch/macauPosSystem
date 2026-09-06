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

  // 認證門（2026-09-07 修）：用獨立嘅 loading view，避免 mount 之前 paint 出 AdminShell layout
  // 引起 hydration mismatch（同時間戶看到一閃而過嘅空白頁）。
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
    // 問題 1（2026-09-07 修）：AdminShell 自己用 `h-[100dvh] overflow-y-auto` 做內部滾動容器。
    // 根因：globals.css 入面有 `body { overflow: hidden }`（POS app 嘅內部滾動行為依賴此，所以
    // 唔可以全局刪除），導致 admin panel 兩個頁面內容超出時冇辦法 body scroll。
    // 修法：admin shell 變成內部 scroll 容器，sticky header 喺呢個容器內繼續 work（sticky
    // 相對於最近嘅 overflow container），POS app 嘅 layout 完全唔受影響。
    <div className="h-[100dvh] overflow-y-auto bg-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <span className="text-sm font-bold text-slate-900">Admin 管理後台</span>
            <nav className="flex items-center gap-1">
              {navItems.map((item) => {
                const active = pathname === item.href;
                // 問題 1（2026-09-06 修）：active 用 inline style 強制白字 + 加 ring 描邊，
                // 避免 Tailwind v4 編譯嘅 `bg-slate-900 text-white` 在某些瀏覽器/快取
                // 場景下出現「黑底黑字」（class 未生效，預設黑色文字 + 深色背景）
                // 影響可訪問性嘅 bug。
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    style={
                      active
                        ? { backgroundColor: "#0f172a", color: "#ffffff", fontWeight: 600 }
                        : undefined
                    }
                    className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "ring-2 ring-orange-400 ring-offset-1"
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
      <main className="mx-auto max-w-7xl px-4 pb-12 pt-6">{children}</main>
    </div>
  );
}
