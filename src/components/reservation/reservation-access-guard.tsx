"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { isSidebarModuleAvailable } from "@/lib/pos/module-catalog";
import { loadAuthSession } from "@/lib/storage";

/**
 * 訂位台存取閘（2026-11-07）。
 *
 * 平台要喺 Admin panel「商戶管理 → 模組授權 → B. 側欄模組」為呢間店勾選
 * 「訂位」並儲存，商家先至見到入口。側欄 `AppSidebar` 已經唔會出掣，
 * 呢度係第二道：直接打 `/reservations`（書籤、上一頁、人手改 URL）都只會見提示頁。
 *
 * ## 點解唔喺 server component 讀
 *
 * 授權跟登入 session（localStorage）行，server component 拎唔到。
 * 初始 state 刻意係 `"checking"`：SSR 同 hydration 都輸出「載入中…」，
 * useEffect 之後先判，避免一閃「未開通」再變返內容，亦避免 hydration mismatch。
 *
 * ## ⚠️ 唔好用 `useT()`
 *
 * 呢頁喺 `AuthGuard` 入面，但提示文案係平台後台口徑（同 Admin 彈窗一致），
 * 直接寫繁中，唔加 i18n key 契約負擔。
 */
export function ReservationAccessGuard({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "allowed" | "denied">("checking");

  useEffect(() => {
    const granted = loadAuthSession()?.allowedModules?.sidebarModules;
    setState(isSidebarModuleAvailable("reservation", granted) ? "allowed" : "denied");
  }, []);

  if (state === "checking") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500">
        載入中…
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="text-base font-bold text-slate-900">訂位功能尚未開通</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            呢間店仲未開通「訂位」模組。請聯絡平台管理員喺後台
            「商戶管理 → 模組授權 → B. 側欄模組」勾選「訂位」並儲存，
            之後本機重新登入 POS 就會生效。
          </p>
          <Link
            href="/pos"
            className="mt-5 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-orange-500 px-5 text-sm font-semibold text-white hover:bg-orange-600"
          >
            返回收銀台
          </Link>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
