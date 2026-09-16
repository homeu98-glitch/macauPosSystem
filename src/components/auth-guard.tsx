"use client";

import { usePathname, useRouter } from "next/navigation";
import { PropsWithChildren, useEffect } from "react";

import { restoreLedgerSession } from "@/lib/ledger/session";
import { clearAuthSession, loadAuthSession, prepareStoreStorage } from "@/lib/storage";
import { reconcileQueueScope } from "@/lib/pos/queue-outbox";
import {
  isOrderOnlyTerminal,
  isPathAllowedOnOrderOnlyTerminal,
  ORDER_ONLY_FALLBACK_PATH,
} from "@/lib/pos/order-only-terminal";
import { UserRole } from "@/lib/types";

type AuthGuardProps = PropsWithChildren<{
  allowedRoles?: UserRole[];
}>;

export function AuthGuard({ children, allowedRoles }: AuthGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const session = loadAuthSession();
  // 2026-09-06：admin 管理入口（/admin 登入）產生嘅 session 只有 adminSessionToken，
  // 冇 merchantId / ledgerAccessToken。舊邏輯 isLedgerSession 會即刻 clearAuthSession()
  // 踢返去 /login，令 admin 登入永遠入唔到後台 —— 現在 admin token session 同樣放行。
  const isAdminSession = Boolean(session?.adminSessionToken);
  const isLedgerSession = Boolean(session?.merchantId && session?.ledgerAccessToken);
  const roleBlocked = Boolean(session && allowedRoles && !allowedRoles.includes(session.role));

  /**
   * 落單專用終端（2026-09-16）：呢部機揀咗「店員手機」工作台，
   * 唔應該去收銀台路由（避免誤入 `/` 結帳）。
   *
   * ⚠️ **呢個唔係安全邊界** —— 旗標住喺 localStorage，撳 F12 就改得。
   *    佢解決嘅係「店員撳錯書籤／撳返上一頁，結果喺手機結咗張單」。
   *    真權限要有 server 端角色真源（見 `@/lib/pos/order-only-terminal` 頂部）。
   *
   * ⚠️ 白名單一定要包 `/login`（憑證過期要重新登入）同
   *    `/select-workbench`（逃生門）—— 冇逃生門，揀錯工作台部機就廢咗。
   */
  const orderOnlyBlocked =
    Boolean(session?.merchantId) &&
    isOrderOnlyTerminal(session?.merchantId) &&
    !isPathAllowedOnOrderOnlyTerminal(pathname ?? "/");

  useEffect(() => {
    if (session?.merchantId) {
      prepareStoreStorage(session.merchantId);
      // docs/111：切店 / 切帳號後重新對焦同步隊列歸屬 ——
      // 屬於新店嘅 skipped 事件 reset 做 pending（重新排隊推送），
      // 唔屬於新店嘅 pending 轉 skipped（唔好霸住交班畫面個「待同步」數）。
      reconcileQueueScope(session.merchantId);
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
    if (session && !isLedgerSession && !isAdminSession && pathname !== "/login") {
      clearAuthSession();
      window.location.replace("/login");
      return;
    }
    // ⚠️ 落單專用終端攔截要放喺「角色檢查」**之前**：
    //    佢係「呢部機唔應該去呢度」，唔關帳號角色事。
    if (orderOnlyBlocked) {
      window.location.replace(ORDER_ONLY_FALLBACK_PATH);
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
  }, [isAdminSession, isLedgerSession, orderOnlyBlocked, pathname, roleBlocked, router, session]);

  if (orderOnlyBlocked) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center">
        <div>
          <div className="text-base font-semibold text-slate-900">此裝置為落單專用</div>
          <div className="mt-2 text-sm text-slate-500">
            正在返回店員點餐介面…如需改用其他工作台，請到「選擇工作台」。
          </div>
        </div>
      </div>
    );
  }

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
