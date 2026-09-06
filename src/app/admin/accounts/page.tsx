"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { AdminAccountsPage } from "@/components/admin-accounts-page";
import { loadAuthSession } from "@/lib/storage";

/**
 * /admin/accounts — 帳戶管理主頁（admin 管理頁面核心）。
 *
 * 由 /admin 登入後跳入呢度；AdminAccountsPage 自帶 PIN 雙重驗證 gate
 * （無 token 時彈 modal 攞 12h admin session token）。呢層只負責：
 * 未登入（完全無 auth session）時踢返去 /admin 登入頁。
 */
export default function AdminAccountsRoute() {
  const router = useRouter();

  useEffect(() => {
    const session = loadAuthSession();
    if (!session) {
      router.replace("/admin");
    }
  }, [router]);

  return <AdminAccountsPage />;
}
