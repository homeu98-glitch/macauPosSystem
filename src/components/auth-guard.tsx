"use client";

import { usePathname, useRouter } from "next/navigation";
import { PropsWithChildren, useEffect } from "react";

import { restoreLedgerSession } from "@/lib/ledger/session";
import { clearAuthSession, loadAuthSession, prepareStoreStorage } from "@/lib/storage";
import { UserRole } from "@/lib/types";

type AuthGuardProps = PropsWithChildren<{
  allowedRoles?: UserRole[];
}>;

export function AuthGuard({ children, allowedRoles }: AuthGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const session = loadAuthSession();
  const isLedgerSession = Boolean(session?.merchantId && session?.ledgerAccessToken);
  const roleBlocked = Boolean(session && allowedRoles && !allowedRoles.includes(session.role));

  useEffect(() => {
    if (session?.merchantId) {
      prepareStoreStorage(session.merchantId);
    }
  }, [session?.merchantId]);

  useEffect(() => {
    if (session?.ledgerAccessToken && session?.ledgerRefreshToken) {
      void restoreLedgerSession();
    }
  }, [session?.ledgerAccessToken, session?.ledgerRefreshToken]);

  useEffect(() => {
    if (!session && pathname !== "/login") {
      window.location.replace("/login");
      return;
    }
    if (session && !isLedgerSession && pathname !== "/login") {
      clearAuthSession();
      window.location.replace("/login");
      return;
    }
    if (roleBlocked) {
      window.location.replace("/");
      return;
    }
    // 兜底：唔係由 login-screen 嚟嘅 authSession 變更（例如直接在 storage 寫新值、
    // 或者 kiosk binding auto-login），呢度訂閱 `pos-auth-changed` 同樣 force reload。
    function onAuthChanged() {
      if (pathname === "/login") return;
      window.location.reload();
    }
    window.addEventListener("pos-auth-changed", onAuthChanged);
    return () => {
      window.removeEventListener("pos-auth-changed", onAuthChanged);
    };
  }, [isLedgerSession, pathname, roleBlocked, router, session]);

  if ((!session || roleBlocked) && pathname !== "/login") {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center">
        <div>
          <div className="text-base font-semibold text-slate-900">正在跳轉登入頁…</div>
          <div className="mt-2 text-sm text-slate-500">
            如果長時間停留在這裡，請重新整理一次頁面，或直接打開 <span className="font-semibold">/login</span>。
          </div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
