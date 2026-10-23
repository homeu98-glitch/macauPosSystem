"use client";

import { usePathname, useRouter } from "next/navigation";
import { PropsWithChildren, useEffect, useRef, useState } from "react";

import { restoreLedgerSession } from "@/lib/ledger/session";
import {
  isDeviceSignedOut,
  loadDeviceBinding,
  restoreDeviceSession,
} from "@/lib/pos/device-binding";
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

  /**
   * 裝置授權自動開機（2026-10-23，docs/160 §10）。
   *
   * 店主授權過呢部機之後，冇 L1 session 都唔應該踢去 `/login` ——
   * 先試用本機裝置憑證換返 session，成功就直接去 `/operator` 簽到。
   *
   * 🔴 `restoreStarted` 係必須嘅：下面個 effect 嘅 deps 包住 `session`（每次 render
   *    都係新 object），冇呢個閂就會連環 POST `/api/pos/device/session`。
   */
  const restoreStarted = useRef(false);
  const [restoring, setRestoring] = useState(false);
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

  /**
   * bfcache 防護（2026-10-23，docs/161 §5.3）。
   *
   * 症狀：店主登入 → 店員登入 → 撳瀏覽器「上一頁」⇒ 見到**店主**嘅畫面。
   * 成因：瀏覽器由 bfcache 還原舊 DOM，React 完全冇重新 render，
   *       所以 `session` 係還原嗰一刻嘅舊值（甚至係另一個帳號嘅）。
   *       JS heap 都係舊嘅 —— 唔 reload 冇辦法補救。
   *
   * ⇒ 由 bfcache 還原（`event.persisted === true`）一律整頁重載，
   *   令 AuthGuard 重新由 storage 讀當前 session。
   */
  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) window.location.reload();
    }
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    if (!session && pathname !== "/login") {
      // 先試「裝置授權自動開機」：店主授權過呢部機就唔需要再打店主帳密。
      if (!restoreStarted.current && loadDeviceBinding() && !isDeviceSignedOut()) {
        restoreStarted.current = true;
        setRestoring(true);
        void restoreDeviceSession().then((result) => {
          if (result.ok) {
            // 直接去簽到頁：呢部機而家係「店舖終端」，要知邊個員工操作
            window.location.replace("/operator");
            return;
          }
          window.location.replace("/login");
        });
        return;
      }
      if (restoreStarted.current) return; // 還原中：等上面 promise 決定去向
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

  if (restoring) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 px-6 text-center">
        <div>
          <div className="text-base font-semibold text-slate-900">正在還原裝置授權…</div>
          <div className="mt-2 text-sm text-slate-500">
            呢部機已由店主授權，唔需要輸入店主帳號密碼。
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
