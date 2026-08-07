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

  if ((!session || accountDisabled || roleBlocked) && pathname !== "/login") return null;
  return <>{children}</>;
}
