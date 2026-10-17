"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { clearAuthSession, loadAuthSession } from "@/lib/storage";
import { decodeAdminSessionToken, isAdminSessionTokenExpired } from "@/lib/admin-session-token-client";

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
    const token = session?.adminSessionToken;
    // 🔴 2026-10-17 修（J 拍板）：admin panel 身份必須以「登入嗰陣輸入嘅 admin 帳號」為準，
    // 唔可以繼承 POS 收銀登入嘅 account。之前 admin 登入做咗 { ...existing, adminSessionToken }，
    // 會保留 POS 收銀嘅 account，令 admin 頂部顯示成收銀戶口，仲以為「用咗之前個戶口入嚟」。
    // 呢度由 token payload 解碼出真正嘅 admin account（token 本身 encode 咗 account + role），
    // 同時驗 expiry：過期／解唔到就彈返登入頁。真正授權仍由 server 端 HMAC 驗簽把關
    //（每個 admin API route 都會再 verify 一次，客戶端解密唔等於放行）。
    const claims = token ? decodeAdminSessionToken(token) : null;
    if (!claims || isAdminSessionTokenExpired(claims)) {
      router.replace("/admin");
      return;
    }
    setAccount(claims.account);
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
    // 2026-09-22：POS 工作階段總覽（migration 0047）。
    // 背景：商家唔為意開咗幾個分頁，舊分頁靜靜燒 egress（實測佔 97%）⇒
    // 需要一個「睇得到、關得掉」嘅地方。
    { href: "/admin/sessions", label: "POS 工作階段" },
    // 2026-09-22：雲端用量（migration 0048）。
    // 背景：Supabase Dashboard 只俾專案總數，答唔到「邊間店食咗幾多」、
    // 「加多一間店會唔會爆 5 GB」⇒ 由自己 route 記帳，呢度睇得到。
    { href: "/admin/traffic", label: "雲端用量" },
    // 2026-09-23：版本控制（migration 0050）。
    // 背景：登入頁要派「下載 APK / 下載安裝包」⇒ 派邊個版本唔應該寫死喺代碼
    // （改連結要改代碼 + 重新部署，出事時退唔返）。
    { href: "/admin/versions", label: "版本控制" },
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
