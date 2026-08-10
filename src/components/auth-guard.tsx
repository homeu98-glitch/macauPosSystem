"use client";

import { usePathname, useRouter } from "next/navigation";
import { PropsWithChildren, useEffect } from "react";

import { clearAuthSession, loadAccountUsers, loadAuthSession } from "@/lib/storage";
import { UserRole } from "@/lib/types";

type AuthGuardProps = PropsWithChildren<{
  allowedRoles?: UserRole[];
}>;

export function AuthGuard({ children, allowedRoles }: AuthGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const session = loadAuthSession();
  const accounts = loadAccountUsers();
  const matchedAccount = session ? accounts.find((item) => item.account === session.account) : null;
  const roleBlocked = Boolean(session && allowedRoles && !allowedRoles.includes(session.role));
  const accountDisabled = Boolean(session && matchedAccount && !matchedAccount.active);

  useEffect(() => {
    if (!session && pathname !== "/login") {
      router.replace("/login");
      return;
    }
    if (accountDisabled) {
      clearAuthSession();
      router.replace("/login");
      return;
    }
    if (roleBlocked) {
      router.replace("/");
    }
  }, [accountDisabled, pathname, roleBlocked, router, session]);

  if ((!session || accountDisabled || roleBlocked) && pathname !== "/login") {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center">
        <div>
          <div className="text-base font-semibold text-slate-900">正在跳轉登入頁…</div>
          <div className="mt-2 text-sm text-slate-500">如果長時間停留在這裡，請重新整理一次頁面。</div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
