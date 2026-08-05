"use client";

import { usePathname, useRouter } from "next/navigation";
import { PropsWithChildren, useEffect } from "react";

import { loadAuthSession } from "@/lib/storage";

export function AuthGuard({ children }: PropsWithChildren) {
  const router = useRouter();
  const pathname = usePathname();
  const session = loadAuthSession();

  useEffect(() => {
    if (!session && pathname !== "/login") {
      router.replace("/login");
    }
  }, [pathname, router, session]);

  if (!session && pathname !== "/login") return null;
  return <>{children}</>;
}
